// POST /api/stripe/create-portal-session
//
// Generates a Stripe Customer Portal session URL for a centre that already
// has a Stripe customer on file. The portal lets the centre owner update
// their card, see invoices, switch plan, or cancel — all on Stripe-hosted
// pages, no extra UI work for us.
//
// Requires the centre's billing.stripeCustomerId to be populated (which
// happens automatically when their first Checkout Session completes).
//
// Auth: super-admin only, via Firebase ID token in Authorization header.
//
// Request body:  { centerId: 'langley' }
// Response:      200 { url: 'https://billing.stripe.com/p/session/...' }

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

  const session = await authenticateRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (session.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super-admin only' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const centerId = String(body.centerId || '').trim();
  if (!centerId) return res.status(400).json({ error: 'centerId required' });

  const db = getFirestore();
  const centerSnap = await db.collection('centers').doc(centerId).get();
  if (!centerSnap.exists) return res.status(404).json({ error: 'Center not found' });
  const customerId = centerSnap.data()?.billing?.stripeCustomerId;
  if (!customerId) {
    return res.status(400).json({
      error: 'This centre has no Stripe customer yet — send them a Checkout link first to set one up.',
    });
  }

  const origin = req.headers.origin || req.headers.referer || '';
  const returnUrl = origin
    ? origin.replace(/\/$/, '') + '/platform-revenue'
    : `https://${req.headers.host || 'example.com'}/platform-revenue`;

  try {
    const portal = await stripeClient().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return res.status(200).json({ url: portal.url });
  } catch (err) {
    console.error('[create-portal-session]', err);
    return res.status(500).json({ error: err?.raw?.message || err.message || 'Stripe error' });
  }
}
