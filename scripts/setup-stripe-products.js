// One-shot Stripe setup — creates the three paid Ratio products and their
// monthly + annual prices in your Stripe account. Idempotent: re-running it
// only adds what's missing, never duplicates.
//
// HOW TO RUN
//   1. Grab your Stripe Secret Key from https://dashboard.stripe.com/apikeys
//      (start in Test mode — use sk_test_… first, then re-run with sk_live_…
//      when you're ready to take real payments).
//   2. From the project root:
//        npm install --no-save stripe
//        export STRIPE_SECRET_KEY='<paste-your-stripe-secret-key>'
//        node scripts/setup-stripe-products.js
//   3. Copy the printed Price IDs into your Vercel environment variables
//      (we'll wire them into Checkout Sessions in Phase 2.1).
//
// PRICING (matches the public ratiosolved.com marketing site)
//   Founder — $79  CAD / month  or  $760  CAD / year  ($63/mo equivalent, 20% off)   · LAUNCH ONLY, capped at 10 active seats · no setup fee
//   Starter — $99  CAD / month  or  $950  CAD / year  ($79/mo equivalent, 20% off)   · $500   one-time setup fee
//   Growth  — $149 CAD / month  or  $1,430 CAD / year ($119/mo equivalent, 20% off)  · $1,000 one-time setup fee
//   Pro     — $299 CAD / month  or  $2,870 CAD / year ($239/mo equivalent, 20% off)  · $2,500 one-time setup fee
//
// MIGRATING FROM OLD PRICES ($29 / $49 / $79)
//   Stripe Products are kept active; this script creates NEW Prices at the
//   new amounts. After running, copy the printed Price IDs into Vercel —
//   the OLD env-var values can be left in Stripe (you don't delete old
//   Prices) but the new Price IDs become the source of truth.

import Stripe from 'stripe';

const SECRET = process.env.STRIPE_SECRET_KEY;
if (!SECRET) {
  console.error('✖  STRIPE_SECRET_KEY is not set.');
  console.error('   Run:  STRIPE_SECRET_KEY=sk_test_xxx node scripts/setup-stripe-products.js');
  process.exit(1);
}
const stripe = new Stripe(SECRET, { apiVersion: '2024-06-20' });

const CURRENCY = 'cad';

// Each entry becomes one Stripe Product + two recurring Prices (monthly +
// annual) + optionally a one-time Price for the setup fee.
//
// `setupFeeCents` of 0 = no separate setup-fee Price gets created.
const PLANS = [
  {
    key:         'founder',
    name:        'Ratio Founder',
    description: 'Founding 10 launch program. Locked-in $79/mo for life. No setup fee. Limited to 10 active seats.',
    monthlyCents: 7900,   // $79
    annualCents:  76000,  // $760 ($63/mo equivalent, 20% off)
    setupFeeCents: 0,
    features: [
      'Locked-in rate for life',
      'No setup fee',
      'Everything in Growth',
      'Founding-customer Slack channel',
      'Priority feature requests',
    ],
  },
  {
    key:         'starter',
    name:        'Ratio Starter',
    description: 'Up to 15 instructors. Single centre. Everything you need to stop using a spreadsheet.',
    monthlyCents: 9900,    // $99
    annualCents:  95000,   // $950 ($79/mo equivalent)
    setupFeeCents: 50000,  // $500 one-time
    features: [
      'Smart scheduling + drag-and-drop',
      'Availability & time-off',
      'Instructor mobile portal',
      'Standard support · email',
    ],
  },
  {
    key:         'growth',
    name:        'Ratio Growth',
    description: 'Up to 50 instructors. Multi-centre ready. Where most Mathnasium franchises land.',
    monthlyCents: 14900,    // $149
    annualCents:  143000,   // $1,430 ($119/mo equivalent)
    setupFeeCents: 100000,  // $1,000 one-time
    features: [
      'Everything in Starter',
      'Payroll automation + exports',
      'Centre analytics dashboard',
      'Roles & permissions',
      'Priority support · 4h SLA',
    ],
  },
  {
    key:         'pro',
    name:        'Ratio Pro',
    description: 'Unlimited instructors and centres. Built for franchises and regional operators.',
    monthlyCents: 29900,    // $299
    annualCents:  287000,   // $2,870 ($239/mo equivalent)
    setupFeeCents: 250000,  // $2,500 one-time
    features: [
      'Everything in Growth',
      'Multi-centre rollups',
      'API access + integrations',
      'SSO + audit logs',
      'Dedicated success manager',
    ],
  },
];

// Look up an existing product by its name (so we don't duplicate on re-run).
async function findProductByName(name) {
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.name === name) return product;
  }
  return null;
}

// Look up an existing recurring price for a product at a given amount + interval.
async function findPrice(productId, unitAmount, interval) {
  for await (const price of stripe.prices.list({ product: productId, active: true, limit: 100 })) {
    if (
      price.unit_amount === unitAmount &&
      price.currency    === CURRENCY &&
      price.recurring?.interval === interval
    ) {
      return price;
    }
  }
  return null;
}

// Look up an existing one-time (non-recurring) price for a product at a
// given amount. Used for the setup-fee Prices.
async function findOneTimePrice(productId, unitAmount) {
  for await (const price of stripe.prices.list({ product: productId, active: true, limit: 100 })) {
    if (
      price.unit_amount === unitAmount &&
      price.currency    === CURRENCY &&
      !price.recurring
    ) {
      return price;
    }
  }
  return null;
}

async function ensurePlan(plan) {
  // Product
  let product = await findProductByName(plan.name);
  if (!product) {
    product = await stripe.products.create({
      name:        plan.name,
      description: plan.description,
      metadata:    { tier: plan.key, source: 'ratio-setup-script' },
    });
    console.log(`  + Created product  ${plan.name}  (${product.id})`);
  } else {
    console.log(`  · Product exists   ${plan.name}  (${product.id})`);
  }

  // Monthly price
  let monthly = await findPrice(product.id, plan.monthlyCents, 'month');
  if (!monthly) {
    monthly = await stripe.prices.create({
      product:     product.id,
      unit_amount: plan.monthlyCents,
      currency:    CURRENCY,
      recurring:   { interval: 'month' },
      nickname:    `${plan.name} · Monthly`,
      metadata:    { tier: plan.key, billing: 'monthly' },
    });
    console.log(`     + Monthly price   $${(plan.monthlyCents / 100).toFixed(2)} CAD  (${monthly.id})`);
  } else {
    console.log(`     · Monthly exists  $${(plan.monthlyCents / 100).toFixed(2)} CAD  (${monthly.id})`);
  }

  // Annual price (20% off equivalent)
  let annual = await findPrice(product.id, plan.annualCents, 'year');
  if (!annual) {
    annual = await stripe.prices.create({
      product:     product.id,
      unit_amount: plan.annualCents,
      currency:    CURRENCY,
      recurring:   { interval: 'year' },
      nickname:    `${plan.name} · Annual (−20%)`,
      metadata:    { tier: plan.key, billing: 'annual' },
    });
    console.log(`     + Annual price    $${(plan.annualCents / 100).toFixed(2)} CAD  (${annual.id})`);
  } else {
    console.log(`     · Annual exists   $${(plan.annualCents / 100).toFixed(2)} CAD  (${annual.id})`);
  }

  // One-time setup fee (added to first invoice via add_invoice_items in the
  // create-checkout-session route). Only created if the plan defines one.
  let setupFee = null;
  if (plan.setupFeeCents && plan.setupFeeCents > 0) {
    setupFee = await findOneTimePrice(product.id, plan.setupFeeCents);
    if (!setupFee) {
      setupFee = await stripe.prices.create({
        product:     product.id,
        unit_amount: plan.setupFeeCents,
        currency:    CURRENCY,
        nickname:    `${plan.name} · Setup Fee (one-time)`,
        metadata:    { tier: plan.key, billing: 'setup_fee' },
      });
      console.log(`     + Setup fee       $${(plan.setupFeeCents / 100).toFixed(2)} CAD  (${setupFee.id})`);
    } else {
      console.log(`     · Setup fee exists $${(plan.setupFeeCents / 100).toFixed(2)} CAD  (${setupFee.id})`);
    }
  }

  return { plan, product, monthly, annual, setupFee };
}

(async () => {
  const mode = SECRET.startsWith('sk_live_') ? 'LIVE' : 'TEST';
  console.log(`\nRatio · Stripe product setup  (${mode} mode)\n`);

  const results = [];
  for (const plan of PLANS) {
    console.log(`Plan: ${plan.name}`);
    const r = await ensurePlan(plan);
    results.push(r);
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Done. Paste these IDs into your Vercel environment variables:\n');
  for (const r of results) {
    const KEY = r.plan.key.toUpperCase();
    console.log(`  STRIPE_PRICE_${KEY}_MONTHLY=${r.monthly.id}`);
    console.log(`  STRIPE_PRICE_${KEY}_ANNUAL=${r.annual.id}`);
    if (r.setupFee) {
      console.log(`  STRIPE_PRICE_${KEY}_SETUP=${r.setupFee.id}`);
    }
  }
  console.log(`\n  STRIPE_PUBLISHABLE_KEY=pk_${mode === 'LIVE' ? 'live' : 'test'}_…   (from dashboard.stripe.com/apikeys)`);
  console.log(`  STRIPE_SECRET_KEY=${SECRET.slice(0, 8)}…   (do NOT commit; use Vercel env)`);
  console.log(`  STRIPE_WEBHOOK_SECRET=whsec_…              (we'll set this when wiring webhooks)\n`);
})().catch(err => {
  console.error('\n✖  Failed:', err?.raw?.message || err.message);
  process.exit(1);
});
