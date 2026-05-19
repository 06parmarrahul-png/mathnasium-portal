// Stripe → Firestore webhook handler.
//
// Verifies the Stripe signature on each incoming event and writes the
// matching centre's billing fields in Firestore. This is what makes the
// Platform Revenue page auto-update — once Stripe charges a card, the
// status / lastPaidAt / currentPeriodEnd / lastPaidAmount on the centre's
// `billing` doc update without anybody touching anything.
//
// SETUP
//   1. Deploy this with the rest of the app to Vercel.
//   2. Stripe Dashboard → Developers → Webhooks → Add endpoint
//        URL:     https://<your-vercel-domain>/api/stripe/webhook
//        Events:  checkout.session.completed
//                 invoice.paid
//                 invoice.payment_failed
//                 customer.subscription.updated
//                 customer.subscription.deleted
//   3. Copy the "Signing secret" (starts with whsec_) and set it as
//      STRIPE_WEBHOOK_SECRET in Vercel env vars.

import Stripe from 'stripe';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from '../_lib/firebase-admin.js';

// Lazy Stripe client. Constructing at module load with an empty key throws
// in newer SDK versions, which kills the whole function before our handler
// even runs (manifests as a 500 / FUNCTION_INVOCATION_FAILED on Vercel).
// Init on first use instead so missing env vars surface as a clear 500
// inside the request, not a cold-start crash.
let _stripe = null;
function stripeClient() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY env var is not set in Vercel');
  _stripe = new Stripe(key);
  return _stripe;
}

// Vercel-style raw-body reader. Stripe signature verification needs the
// exact bytes Stripe sent, not a JSON-parsed object.
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Map Stripe subscription statuses to the values the UI knows about.
function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':              return 'active';
    case 'trialing':            return 'trial';
    case 'past_due':            return 'past_due';
    case 'unpaid':              return 'past_due';
    case 'incomplete':          return 'past_due';
    case 'incomplete_expired':  return 'cancelled';
    case 'canceled':            return 'cancelled';
    default:                    return 'active';
  }
}

function unixToDateStr(seconds) {
  if (!seconds) return null;
  const d = new Date(seconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Find the centre this event belongs to. Tries metadata first (set when we
// create the Checkout Session), falls back to subscription metadata, then
// to a lookup by customer ID.
async function resolveCenterId(obj, db) {
  if (obj?.metadata?.centerId) return obj.metadata.centerId;
  if (obj?.subscription) {
    try {
      const sub = await stripeClient().subscriptions.retrieve(obj.subscription);
      if (sub.metadata?.centerId) return sub.metadata.centerId;
    } catch { /* ignore */ }
  }
  const customerId = obj?.customer;
  if (customerId) {
    const snap = await db.collection('centers')
      .where('billing.stripeCustomerId', '==', customerId)
      .limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }
  return null;
}

async function applyBillingUpdate(db, centerId, patch) {
  const ref = db.collection('centers').doc(centerId);
  const billing = { ...patch, updatedAt: FieldValue.serverTimestamp() };
  await ref.set({ billing }, { merge: true });
}

async function processEvent(event, db) {
  const obj = event.data.object;
  const centerId = await resolveCenterId(obj, db);
  if (!centerId) {
    console.warn('[stripe webhook] no centerId for event', event.type, obj.id);
    return;
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      // First payment captured — link Customer + Subscription IDs.
      await applyBillingUpdate(db, centerId, {
        stripeCustomerId:     obj.customer || null,
        stripeSubscriptionId: obj.subscription || null,
        status:               'active',
      });
      break;
    }
    case 'invoice.paid': {
      const amount = (obj.amount_paid || 0) / 100;
      const periodEnd = obj.lines?.data?.[0]?.period?.end;
      await applyBillingUpdate(db, centerId, {
        status:           'active',
        lastPaidAt:       todayStr(),
        lastPaidAmount:   amount,
        currentPeriodEnd: unixToDateStr(periodEnd),
      });
      break;
    }
    case 'invoice.payment_failed': {
      await applyBillingUpdate(db, centerId, { status: 'past_due' });
      break;
    }
    case 'customer.subscription.updated': {
      await applyBillingUpdate(db, centerId, {
        status:               mapStripeStatus(obj.status),
        currentPeriodEnd:     unixToDateStr(obj.current_period_end),
        stripeSubscriptionId: obj.id,
      });
      break;
    }
    case 'customer.subscription.deleted': {
      await applyBillingUpdate(db, centerId, { status: 'cancelled' });
      break;
    }
    default:
      console.log('[stripe webhook] ignored event', event.type);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // .trim() guards against accidental trailing newlines / spaces when the
  // secret was pasted into Vercel's env-var UI — a very common gotcha.
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const raw = await getRawBody(req);
    event = stripeClient().webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error('[stripe webhook] signature verify failed:', err.message);
    return res.status(400).json({ error: `Signature verification failed: ${err.message}` });
  }

  try {
    const db = getFirestore();
    await processEvent(event, db);
    return res.status(200).json({ received: true, type: event.type });
  } catch (err) {
    console.error('[stripe webhook] handling error:', err);
    // Return 200 even on errors so Stripe doesn't retry indefinitely for
    // bugs that won't be fixed by retrying. Real failures are logged.
    return res.status(200).json({ received: true, error: err.message });
  }
}
