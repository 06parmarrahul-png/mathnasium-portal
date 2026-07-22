// POST /api/stripe/billing
//
// Combined Stripe billing endpoint. Routes on `action` in the request body:
//   { action: 'checkout', centerId, tier, billing }  → hosted Checkout URL
//   { action: 'portal',   centerId }                  → Customer Portal URL
//
// (Merged from the former create-checkout-session + create-portal-session
// routes to stay within the Hobby-plan 12-function limit — same logic, one
// file.)
//
// Auth: super-admin only, via a Firebase ID token in the Authorization
// header. The webhook that flips billing.status stays in api/stripe/webhook.js.
//
// CHECKOUT — Request body:
//   { action:'checkout', centerId, tier:'founder'|'starter'|'growth'|'pro',
//     billing:'monthly'|'annual' }
//   Response: 200 { url, sessionId }
//   Setup fees (Starter/Growth/Pro) are added to the first invoice via
//   add_invoice_items when STRIPE_PRICE_{TIER}_SETUP is configured. A 14-day
//   trial means the customer pays subscription + setup together on day 15.
//
// PORTAL — Request body:
//   { action:'portal', centerId }   (centre must already have a Stripe customer)
//   Response: 200 { url }

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

// Map (tier, billing) → Stripe Price ID env var name. Set in Vercel after
// running scripts/setup-stripe-products.js.
const PRICE_ENV = {
  founder_monthly: 'STRIPE_PRICE_FOUNDER_MONTHLY',
  founder_annual:  'STRIPE_PRICE_FOUNDER_ANNUAL',
  starter_monthly: 'STRIPE_PRICE_STARTER_MONTHLY',
  starter_annual:  'STRIPE_PRICE_STARTER_ANNUAL',
  growth_monthly:  'STRIPE_PRICE_GROWTH_MONTHLY',
  growth_annual:   'STRIPE_PRICE_GROWTH_ANNUAL',
  pro_monthly:     'STRIPE_PRICE_PRO_MONTHLY',
  pro_annual:      'STRIPE_PRICE_PRO_ANNUAL',
};

// Map tier → one-time Setup-Fee Price ID env var name. Tiers without a setup
// fee (founder) intentionally have no entry.
const SETUP_FEE_ENV = {
  starter: 'STRIPE_PRICE_STARTER_SETUP',
  growth:  'STRIPE_PRICE_GROWTH_SETUP',
  pro:     'STRIPE_PRICE_PRO_SETUP',
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

function baseUrlFrom(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  return origin ? origin.replace(/\/$/, '') : `https://${req.headers.host || 'example.com'}`;
}

// ── action: checkout ──────────────────────────────────────────────────────
async function handleCheckout(req, res, body, db) {
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

  const centerSnap = await db.collection('centers').doc(centerId).get();
  if (!centerSnap.exists) return res.status(404).json({ error: 'Center not found' });
  const existing = (centerSnap.data().billing) || {};

  const baseUrl = baseUrlFrom(req);

  const setupFeeEnvKey = SETUP_FEE_ENV[tier];
  const setupFeePriceId = setupFeeEnvKey ? process.env[setupFeeEnvKey] : null;

  const params = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/platform-revenue?subscribed=${encodeURIComponent(centerId)}`,
    cancel_url:  `${baseUrl}/platform-revenue?cancelled=${encodeURIComponent(centerId)}`,
    metadata: { centerId, tier, billing, hasSetupFee: setupFeePriceId ? 'yes' : 'no' },
    subscription_data: {
      metadata: { centerId, tier, billing },
      trial_period_days: 14,
    },
    allow_promotion_codes: true,
  };
  if (setupFeePriceId) {
    params.subscription_data.add_invoice_items = [{ price: setupFeePriceId, quantity: 1 }];
  }
  if (existing.stripeCustomerId) {
    params.customer = existing.stripeCustomerId;
  } else if (existing.customerEmail) {
    params.customer_email = existing.customerEmail;
  }

  try {
    const checkout = await stripeClient().checkout.sessions.create(params);
    return res.status(200).json({ url: checkout.url, sessionId: checkout.id });
  } catch (err) {
    console.error('[stripe/billing:checkout]', err);
    return res.status(500).json({ error: err?.raw?.message || err.message || 'Stripe error' });
  }
}

// ── action: portal ────────────────────────────────────────────────────────
async function handlePortal(req, res, body, db) {
  const centerId = String(body.centerId || '').trim();
  if (!centerId) return res.status(400).json({ error: 'centerId required' });

  const centerSnap = await db.collection('centers').doc(centerId).get();
  if (!centerSnap.exists) return res.status(404).json({ error: 'Center not found' });
  const customerId = centerSnap.data()?.billing?.stripeCustomerId;
  if (!customerId) {
    return res.status(400).json({
      error: 'This centre has no Stripe customer yet — send them a Checkout link first to set one up.',
    });
  }

  const returnUrl = baseUrlFrom(req) + '/platform-revenue';
  try {
    const portal = await stripeClient().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return res.status(200).json({ url: portal.url });
  } catch (err) {
    console.error('[stripe/billing:portal]', err);
    return res.status(500).json({ error: err?.raw?.message || err.message || 'Stripe error' });
  }
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

  // Default to 'checkout' for backwards-compatibility with any caller that
  // still posts a tier without an explicit action.
  const action = String(body.action || (body.tier ? 'checkout' : '')).trim().toLowerCase();
  const db = getFirestore();

  if (action === 'checkout') return handleCheckout(req, res, body, db);
  if (action === 'portal')   return handlePortal(req, res, body, db);
  return res.status(400).json({ error: "action must be 'checkout' or 'portal'" });
}
