// Public marketing landing page at ratiosolved.com root for
// unauthenticated visitors. Shown via App.jsx — authenticated users still
// land on /Home as before.
//
// Strategy: this is the "front door" for the sales motion. A franchisee
// who hears about Ratio through a WhatsApp / FB group lands here, gets
// the value prop in 5 seconds, sees real screenshots of the running
// Langley dashboard, picks a plan, signs up.

import { Link } from 'react-router-dom';
import {
  ClipboardList, CalendarDays, Users, BarChart3, Printer, Bot,
  Check, ArrowRight, Building2,
} from 'lucide-react';
import RatioLogo from '../components/RatioLogo';
import { VENDOR_CATEGORIES, VENDOR_STATUS, vendorCounts } from '../lib/vendors';

const TAGLINE = 'More time with students. More time with family. Less time on everything else.';

// Pricing model — the differentiators are STAFF USER COUNT (instructors,
// admins, owners — not students) plus a couple of premium add-ons:
//   - Starter: everything except the AI Assistant
//   - Growth: Starter + AI Owner Assistant
//   - Pro:    Growth + priority support + custom integrations
//   - Founder: same as Pro, but locked at $12/mo + $50/yr, first 15 centres only.
const PLANS = [
  {
    name: 'Founder',
    price: '$12',
    period: '/month',
    extra: '+ $50/year · locked forever',
    tag: 'LIMITED · FIRST 15 CENTRES',
    highlight: true,
    cta: 'Claim founder pricing',
    features: [
      'Everything in Pro, forever',
      'Price locked at $12/mo as long as you stay',
      'Direct line to the founder',
      'Roadmap input on new features',
      'First 15 centres only — then it\'s gone',
    ],
  },
  {
    name: 'Starter',
    price: '$29',
    period: '/month',
    extra: 'Up to 12 staff users',
    cta: 'Start free trial',
    features: [
      'Daily schedule dashboard',
      'Staff check-ins & roles',
      'Acuity / Radius / Guardian iCal import',
      'Student tracker auto-categorization',
      'Staffing forecast (1:4 ratio math)',
      'Centre Analytics',
      'Print-ready daily sheets',
      'Everything Pro owners get — without the AI Assistant',
    ],
  },
  {
    name: 'Growth',
    price: '$59',
    period: '/month',
    extra: '13–20 staff users',
    cta: 'Start free trial',
    features: [
      'Everything in Starter',
      'AI Owner Assistant',
      'Auto-drafted parent emails',
      '"Am I understaffed Thursday?" answers in chat',
      'For mid-sized centres scaling up',
    ],
  },
  {
    name: 'Pro',
    price: '$79',
    period: '/month',
    extra: '21+ staff users',
    cta: 'Start free trial',
    features: [
      'Everything in Growth (incl. AI Assistant)',
      'Priority support — direct Slack channel',
      'Custom integrations built for you',
      'Multi-centre / franchise rollups',
      'For large or multi-location operators',
    ],
  },
];

const FEATURES = [
  {
    icon: ClipboardList,
    title: 'Daily Schedule Dashboard',
    body: 'High School and Elementary side-by-side. Click a name to check students in. Tag assessments, free trials, and high-maintenance students. Print one clean page for the front desk.',
  },
  {
    icon: CalendarDays,
    title: 'Built for Mathnasium',
    body: 'Reads your Acuity or Radius schedule, recognizes the Student Assessment Tracker spreadsheet you already use, handles sibling bookings under one parent account.',
  },
  {
    icon: Users,
    title: 'Smart Instructor Pool',
    body: 'Pulls instructor names from your Manage Staff list. Drop them into time slots with one click. Watch the 1:4 ratio math turn red when you\'re understaffed before students arrive.',
  },
  {
    icon: BarChart3,
    title: 'Staffing Forecast',
    body: 'See the next 7, 14, or 30 days at a glance. Catch the Thursday-evening squeeze on Monday, not Thursday afternoon.',
  },
  {
    icon: Printer,
    title: 'Paper-Ready in One Click',
    body: 'Print HS or Elementary on its own clean letter page. Auto-fits a 60-student day to one sheet. Borders, dividers, and durations all readable from across the room.',
  },
  {
    icon: Bot,
    title: 'AI Owner Assistant (Pro)',
    body: 'Ask "Am I understaffed Thursday?" or "Draft a parent email about Friday\'s closure." The assistant knows your centre and writes in your voice.',
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-white text-gray-900">

      {/* ───── Top nav ───── */}
      <nav className="sticky top-0 z-10 border-b border-gray-100 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <RatioLogo size={28} alt="Ratio" />
            <span className="text-lg font-bold tracking-tight">Ratio</span>
            <span className="ml-2 hidden sm:inline text-xs uppercase tracking-widest text-gray-400">
              for Mathnasium
            </span>
          </div>
          <div className="flex items-center gap-1 sm:gap-2">
            <a href="#integrations"
              className="hidden md:inline-block rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900">
              Integrations
            </a>
            <a href="#pricing"
              className="hidden md:inline-block rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900">
              Pricing
            </a>
            <Link to="/login"
              className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 hover:text-gray-900">
              Sign in
            </Link>
            <Link to="/signup"
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-red-700">
              Start free
            </Link>
          </div>
        </div>
      </nav>

      {/* ───── Hero ───── */}
      <header className="relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
          <div className="max-w-3xl">
            <span className="inline-block rounded-full bg-red-50 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-red-700">
              Built by a Mathnasium owner, for Mathnasium owners
            </span>
            <h1 className="mt-4 text-4xl md:text-6xl font-bold leading-[1.05] tracking-tight text-gray-900">
              The daily ops system <br className="hidden md:block" />
              every Mathnasium centre needed.
            </h1>
            <p className="mt-6 text-xl md:text-2xl text-gray-600 leading-snug">
              {TAGLINE}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/signup"
                className="inline-flex items-center gap-2 rounded-md bg-red-600 px-5 py-3 text-base font-semibold text-white shadow-md hover:bg-red-700">
                Start your 30-day free trial <ArrowRight size={18} />
              </Link>
              <a href="#pricing"
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-5 py-3 text-base font-semibold text-gray-700 hover:bg-gray-50">
                See pricing
              </a>
              <span className="text-sm text-gray-500">No credit card. Cancel anytime.</span>
            </div>
          </div>
        </div>
        <div aria-hidden className="pointer-events-none absolute -right-40 -top-20 hidden md:block opacity-10">
          <RatioLogo size={420} alt="" />
        </div>
      </header>

      {/* ───── Trust bar ───── */}
      <section className="border-y border-gray-100 bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-8 grid grid-cols-1 md:grid-cols-3 gap-6 text-center text-sm">
          <div><b className="text-gray-900">Replaces:</b> spreadsheets, paper schedules, Acuity scraping scripts</div>
          <div><b className="text-gray-900">Reads:</b> Acuity, Radius, Guardian Portal, your Student Tracker CSV</div>
          <div><b className="text-gray-900">Used live at:</b> Mathnasium Langley, every shift since June 2026</div>
        </div>
      </section>

      {/* ───── The story / problem ───── */}
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-24 text-center">
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
          Stop running your centre on paper printouts and 4 browser tabs.
        </h2>
        <p className="mt-5 text-lg text-gray-600 leading-relaxed">
          Most centre owners still juggle Acuity for bookings, a Google Sheet for the student
          tracker, a printed paper for who's coming today, and a group chat to figure out who's on shift.
          Ratio pulls all of that into <b>one page</b> your front desk reloads every shift.
        </p>
      </section>

      {/* ───── Feature grid ───── */}
      <section id="features" className="bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-center text-gray-900">
            Everything your centre needs, in one place.
          </h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(f => (
              <div key={f.title} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="rounded-lg bg-red-50 text-red-700 p-3 inline-flex">
                  <f.icon size={22} />
                </div>
                <h3 className="mt-4 text-lg font-bold text-gray-900">{f.title}</h3>
                <p className="mt-2 text-sm text-gray-600 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───── How it works ───── */}
      <section className="mx-auto max-w-6xl px-4 py-16 md:py-24">
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-center text-gray-900">
          Up and running in under 10 minutes.
        </h2>
        <div className="mt-12 grid gap-8 md:grid-cols-3">
          {[
            { n: '1', t: 'Connect your scheduler', b: 'Paste your Acuity iCal URL (or Radius / Guardian Portal export). Ratio pulls every appointment automatically.' },
            { n: '2', t: 'Import your tracker', b: 'Drop your Student Assessment Tracker CSV in. We auto-categorize by section header, detect assessments, link siblings.' },
            { n: '3', t: 'Open the dashboard', b: 'Click Scheduler Creation in the sidebar. Print Today. Walk over to the front desk. You\'re live.' },
          ].map(s => (
            <div key={s.n} className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="text-5xl font-bold text-red-600 leading-none">{s.n}</div>
              <h3 className="mt-3 text-lg font-bold text-gray-900">{s.t}</h3>
              <p className="mt-2 text-sm text-gray-600 leading-relaxed">{s.b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───── Integrations / approved vendor catalog ───── */}
      <section id="integrations" className="bg-gray-50 border-y border-gray-100">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
          <div className="text-center">
            <span className="inline-block rounded-full bg-red-50 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-red-700">
              Plug into Mathnasium's preferred vendors
            </span>
            <h2 className="mt-4 text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
              Ratio sits at the centre of your existing stack.
            </h2>
            <p className="mt-4 text-lg text-gray-600 max-w-2xl mx-auto">
              Every vendor on Mathnasium's official approved list — scheduling, hiring,
              background checks, payroll, reviews, supplies. Ratio is the one operational
              dashboard that ties them all together.
            </p>
            <IntegrationCounts />
          </div>

          <div className="mt-10 space-y-10">
            {VENDOR_CATEGORIES.map(cat => (
              <div key={cat.id}>
                <div className="mb-3">
                  <h3 className="text-lg font-bold text-gray-900">{cat.title}</h3>
                  <p className="text-sm text-gray-600">{cat.blurb}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {cat.vendors.map(v => (
                    <VendorCard key={v.name} vendor={v} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <p className="mt-10 text-center text-xs text-gray-500 max-w-2xl mx-auto">
            Pro plan customers can request a custom integration with any tool not on this list.
            Founder-plan owners get a direct line to suggest what to build next.
          </p>
        </div>
      </section>

      {/* ───── Pricing ───── */}
      <section id="pricing" className="bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
          <div className="text-center">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
              Simple pricing. Big leverage.
            </h2>
            <p className="mt-4 text-lg text-gray-600">
              Every plan includes a 30-day free trial. No credit card to start.
            </p>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {PLANS.map(p => (
              <div key={p.name}
                className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm ${
                  p.highlight ? 'border-red-600 ring-2 ring-red-200' : 'border-gray-200'
                }`}>
                {p.tag && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-red-600 px-3 py-1 text-[10px] font-bold text-white tracking-wider">
                    {p.tag}
                  </span>
                )}
                <h3 className="text-lg font-bold text-gray-900">{p.name}</h3>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-4xl font-bold tracking-tight">{p.price}</span>
                  <span className="text-sm text-gray-500">{p.period}</span>
                </div>
                {p.extra && (
                  <p className={`text-xs mt-1 ${p.highlight ? 'text-red-700 font-semibold' : 'text-gray-600 font-medium'}`}>
                    {p.extra}
                  </p>
                )}
                <ul className="mt-6 space-y-2 text-sm flex-1">
                  {p.features.map(f => (
                    <li key={f} className="flex items-start gap-2">
                      <Check size={16} className="mt-0.5 text-emerald-600 shrink-0" />
                      <span className="text-gray-700">{f}</span>
                    </li>
                  ))}
                </ul>
                <Link to="/signup"
                  className={`mt-6 inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold ${
                    p.highlight
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}>
                  {p.cta} <ArrowRight size={14} />
                </Link>
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-xs text-gray-500">
            "Staff users" means anyone signed into your centre — instructors, admin assistants, admins, owners. Students don't count.
            Founder plan is limited to the first 15 centres. Multi-centre operators contact for volume pricing.
          </p>
        </div>
      </section>

      {/* ───── Closing CTA ───── */}
      <section className="mx-auto max-w-4xl px-4 py-16 md:py-24 text-center">
        <Building2 size={36} className="mx-auto text-red-600" />
        <h2 className="mt-4 text-3xl md:text-4xl font-bold tracking-tight text-gray-900">
          Built by a Mathnasium owner who got tired of paper schedules.
        </h2>
        <p className="mt-4 text-lg text-gray-600">
          Ratio runs live at Mathnasium Langley every day. We use it for our own shift the same way you will.
          Try it on your centre for 30 days — if it doesn't save you at least an hour a week, don't pay us.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/signup"
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-5 py-3 text-base font-semibold text-white shadow-md hover:bg-red-700">
            Start 30-day free trial <ArrowRight size={18} />
          </Link>
          <Link to="/login"
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-5 py-3 text-base font-semibold text-gray-700 hover:bg-gray-50">
            Sign in to existing centre
          </Link>
        </div>
      </section>

      {/* ───── Footer ───── */}
      <footer className="border-t border-gray-100 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-500">
          <div className="flex items-center gap-2">
            <RatioLogo size={18} alt="Ratio" />
            <span className="font-semibold text-gray-700">Ratio</span>
            <span>· for Mathnasium centres</span>
          </div>
          <div className="flex gap-4">
            <Link to="/login">Sign in</Link>
            <a href="#pricing">Pricing</a>
            <a href="#features">Features</a>
            <a href="#integrations">Integrations</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ─── Small support components for the integrations section ──────────────

function IntegrationCounts() {
  const c = vendorCounts();
  return (
    <div className="mt-6 flex flex-wrap justify-center gap-3 text-sm">
      <CountPill n={c.live}    label="Live now"     color="text-emerald-700 bg-emerald-50 border-emerald-200" />
      <CountPill n={c.soon}    label="Coming soon"  color="text-amber-700 bg-amber-50 border-amber-200" />
      <CountPill n={c.planned} label="On roadmap"   color="text-gray-700 bg-gray-100 border-gray-200" />
      <CountPill n={c.total}   label="Total"        color="text-red-700 bg-red-50 border-red-200" bold />
    </div>
  );
}

function CountPill({ n, label, color, bold }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 ${color}`}>
      <b className={bold ? 'font-bold' : 'font-semibold'}>{n}</b>
      <span className="opacity-80">{label}</span>
    </span>
  );
}

function VendorCard({ vendor }) {
  const s = VENDOR_STATUS[vendor.status] || VENDOR_STATUS.planned;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 text-sm truncate">{vendor.name}</div>
        {vendor.note && (
          <div className="text-xs text-gray-500 mt-0.5 leading-snug">{vendor.note}</div>
        )}
      </div>
      <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${s.color}`}>
        {s.label}
      </span>
    </div>
  );
}
