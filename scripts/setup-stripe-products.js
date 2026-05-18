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
// PRICING (matches the public ratio.app marketing site)
//   Starter — $29 CAD / month  or  $276 CAD / year  ($23/mo equivalent, 20% off)
//   Growth  — $49 CAD / month  or  $468 CAD / year  ($39/mo equivalent, 20% off)
//   Pro     — $79 CAD / month  or  $756 CAD / year  ($63/mo equivalent, 20% off)

const Stripe = require('stripe');

const SECRET = process.env.STRIPE_SECRET_KEY;
if (!SECRET) {
  console.error('✖  STRIPE_SECRET_KEY is not set.');
  console.error('   Run:  STRIPE_SECRET_KEY=sk_test_xxx node scripts/setup-stripe-products.js');
  process.exit(1);
}
const stripe = new Stripe(SECRET, { apiVersion: '2024-06-20' });

const CURRENCY = 'cad';

// Each entry becomes one Stripe Product + two Prices (monthly + annual).
const PLANS = [
  {
    key:         'starter',
    name:        'Ratio Starter',
    description: 'Up to 10 instructors. Single centre. Everything you need to stop using a spreadsheet.',
    monthlyCents: 2900,   // $29
    annualCents:  27600,  // $276 ($23/mo equivalent)
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
    description: 'Up to 18 instructors. Multi-centre ready. Where most Mathnasium franchises land.',
    monthlyCents: 4900,   // $49
    annualCents:  46800,  // $468 ($39/mo equivalent)
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
    monthlyCents: 7900,   // $79
    annualCents:  75600,  // $756 ($63/mo equivalent)
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

  return { plan, product, monthly, annual };
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
  }
  console.log(`\n  STRIPE_PUBLISHABLE_KEY=pk_${mode === 'LIVE' ? 'live' : 'test'}_…   (from dashboard.stripe.com/apikeys)`);
  console.log(`  STRIPE_SECRET_KEY=${SECRET.slice(0, 8)}…   (do NOT commit; use Vercel env)`);
  console.log(`  STRIPE_WEBHOOK_SECRET=whsec_…              (we'll set this when wiring webhooks)\n`);
})().catch(err => {
  console.error('\n✖  Failed:', err?.raw?.message || err.message);
  process.exit(1);
});
