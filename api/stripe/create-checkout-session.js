// POST /api/stripe/create-checkout-session
//
// Creates a Stripe Checkout Session for a centre to subscribe to a plan,
// returns the hosted Checkout URL. The super-admin (who calls this) sends
// the URL to the centre's owner; the owner clicks, pays, and Stripe fires
// the webhook back to /api/stripe/webhook which flips the centre's
// billing.status to 'active' and stamps the lastPaidAt / currentPeriodEnd.
//
// Auth: requires a Firebase ID token in the Authorization header. The
// caller must have role === 'super_admin' in their Firestore profile.
//
// Request body:
//   { centerId: 'langley', tier: 'starter' | 'growth' | 'pro',
//     billing: 'monthly' | 'annual' }
//
// Response:
//   200 { url: 'https://checkout.stripe.com/c/pay/...', sessionId: '...' }

import Stripe from 'stripe';
import { authenticateRequest, getFirestore } from '../_lib/firebase-admin.js';

// Lazy Stripe init — see note in api/stripe/webhook.js.
let _stripe = null;
function stripeClient() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY env var is not set in Vercel');
  _stripe = new Stripe(key);
  return _stripe;
}

// Map (tier, billing) → Stripe Price ID env var name. These are set in
// Vercel after running scripts/setup-stripe-products.js.
const PRICE_ENV = {
  starter_monthly: 'STRIPE_PRICE_STARTER_MONTHLY',
  starter_annual:  'STRIPE_PRICE_STARTER_ANNUAL',
  growth_monthly:  'STRIPE_PRICE_GROWTH_MONTHLY',
  growth_annual:   'STRIPE_PRICE_GROWTH_ANNUAL',
  pro_monthly:     'STRIPE_PRICE_PRO_MONTHLY',
  pro_annual:      'STRIPE_PRICE_PRO_ANNUAL',
};

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authn / authz — super-admin only.
  const session = await authenticateRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (session.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super-admin only' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const centerId = String(body.centerId || '').trim();
  const tier     = String(body.tier     || '').trim().toLowerCase();
  const billing  = String(body.billing  || 'monthly').trim().toLowerCase();
  if (!centerId) return res.status(400).json({ error: 'centerId required' });
  if (!tier)     return res.status(400).json({ error: 'tier required' });
  if (billing !== 'monthly' && billing !== 'annual') {
    return res.status(400).json({ error: 'billing must be monthly or annual' });
  }
  const envKey = PRICE_ENV[`${tier}_${billing}`];
  if (!envKey)  return res.status(400).json({ error: `Unknown tier: ${tier}` });
  const priceId = process.env[envKey];
  if (!priceId) return res.status(500).json({ error: `Price not configured: ${envKey}` });

  // Look up the centre so we can reuse its Stripe customer (if it has one)
  // and pre-fill the email field on the Checkout page.
  const db = getFirestore();
  const centerSnap = await db.collection('centers').doc(centerId).get();
  if (!centerSnap.exists) return res.status(404).json({ error: 'Center not found' });
  const center = centerSnap.data();
  const existing = center.billing || {};

  const origin = req.headers.origin || req.headers.referer || '';
  const baseUrl = origin
    ? origin.replace(/\/$/, '')
    : `https://${req.headers.host || 'example.com'}`;

  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/platform-revenue?subscribed=${encodeURIComponent(centerId)}`,
    cancel_url:  `${baseUrl}/platform-revenue?cancelled=${encodeURIComponent(centerId)}`,
    // metadata flows through to the webhook so we know which centre paid.
    metadata: { centerId, tier, billing },
    // 14-day trial so the centre pays nothing on activation — matches the
    // pricing page's "14-day free trial" promise. Trial config has to live
    // on the subscription_data object, not at the top level.
    subscription_data: {
      metadata: { centerId, tier, billing },
      trial_period_days: 14,
    },
    allow_promotion_codes: true,
  };

  if (existing.stripeCustomerId) {
    params.customer = existing.stripeCustomerId;
  } else if (existing.customerEmail) {
    params.customer_email = existing.customerEmail;
  }

  try {
    const checkout = await stripeClient().checkout.sessions.create(params);
    return res.status(200).json({ url: checkout.url, sessionId: checkout.id });
  } catch (err) {
    console.error('[create-checkout-session]', err);
    return res.status(500).json({ error: err?.raw?.message || err.message || 'Stripe error' });
  }
}
