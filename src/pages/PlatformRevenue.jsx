import { useState, useEffect } from 'react';
import { collection, doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Briefcase, Building2, DollarSign, TrendingUp, ShieldAlert, Edit3,
  CheckCircle2, AlertTriangle, Save, X, AlertOctagon, Clock, PauseCircle,
  Mail, Send, ExternalLink, Copy, Loader2, Link2, MinusCircle,
} from 'lucide-react';

/**
 * Platform Revenue — what *we* charge each centre for using the product.
 *
 * Super-admin only. Tracks each centre's subscription tier, monthly amount,
 * and lifecycle state (active / trial / past_due / cancelled), plus the
 * dates that matter for invoicing (next bill, last paid). Phase 2.1 will
 * wire this up to Stripe so the same fields update automatically from
 * webhook events; for now everything is manual and the data model is the
 * same so no migration's needed once Stripe is live.
 *
 * Billing data is stored on `centers/{centerId}.billing`:
 *   { tier:             'free' | 'starter' | 'pro' | 'enterprise',
 *     monthlyAmount:    number,
 *     currency:         'CAD',
 *     notes:            string,
 *     status:           'active' | 'trial' | 'past_due' | 'cancelled',
 *     currentPeriodEnd: 'YYYY-MM-DD' | null,   // when the next bill is due
 *     lastPaidAt:       'YYYY-MM-DD' | null,
 *     lastPaidAmount:   number | null,
 *     customerEmail:    string,                // for invoicing
 *     updatedAt:        serverTimestamp }
 */

// Tiers match the public Ratio marketing site exactly so the in-app billing
// view and the customer-facing pricing page never tell different stories.
// Suggested amounts are the monthly list price; annual billing is handled
// at the Stripe Price level (20% off) so we don't need a separate row here.
const TIERS = [
  { key: 'free',    label: 'Free',    suggestedAmount: 0,  color: 'bg-gray-100 text-gray-700' },
  { key: 'starter', label: 'Starter', suggestedAmount: 29, color: 'bg-emerald-100 text-emerald-800' },
  { key: 'growth',  label: 'Growth',  suggestedAmount: 49, color: 'bg-blue-100 text-blue-800' },
  { key: 'pro',     label: 'Pro',     suggestedAmount: 79, color: 'bg-purple-100 text-purple-800' },
];

const STATUSES = [
  { key: 'active',    label: 'Active',    color: 'bg-emerald-100 text-emerald-800',  badge: 'bg-emerald-500', icon: CheckCircle2 },
  { key: 'trial',     label: 'Trial',     color: 'bg-amber-100 text-amber-800',      badge: 'bg-amber-500',   icon: Clock },
  { key: 'past_due',  label: 'Past Due',  color: 'bg-rose-100 text-rose-800',        badge: 'bg-rose-500',    icon: AlertOctagon },
  { key: 'cancelled', label: 'Cancelled', color: 'bg-gray-100 text-gray-600',        badge: 'bg-gray-400',    icon: PauseCircle },
];

function tierStyle(key) {
  return TIERS.find(t => t.key === key) || TIERS[0];
}
function statusStyle(key) {
  return STATUSES.find(s => s.key === key) || STATUSES[0];
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
}

// 'YYYY-MM-DD' → 'Jan 5, 2026'. Null-safe.
function fmtDate(ds) {
  if (!ds) return '';
  const [y, m, d] = ds.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Today in YYYY-MM-DD (local). Pure helper so we can test without freezing time.
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Days between two YYYY-MM-DD dates. Positive = b is after a.
function daysBetween(a, b) {
  if (!a || !b) return 0;
  const da = new Date(a + 'T00:00:00');
  const dbb = new Date(b + 'T00:00:00');
  return Math.round((dbb - da) / 86400000);
}

export default function PlatformRevenue() {
  const { isSuperAdmin, user } = useAuth();
  const [centers, setCenters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // centerId being edited
  const [stripeModalCenter, setStripeModalCenter] = useState(null);
  const [portalLoadingFor, setPortalLoadingFor] = useState(null);
  const [portalError, setPortalError] = useState('');

  // Open the Stripe Customer Portal for a centre that already has a
  // stripeCustomerId on file. Hits our /api/stripe/create-portal-session
  // route, then redirects to the hosted portal in a new tab.
  const openCustomerPortal = async (center) => {
    setPortalError('');
    setPortalLoadingFor(center.id);
    try {
      const idToken = user ? await user.getIdToken() : null;
      if (!idToken) throw new Error('Not signed in.');
      const r = await fetch('/api/stripe/create-portal-session', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ centerId: center.id }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || `Portal request failed (${r.status}).`);
      window.open(data.url, '_blank', 'noopener');
    } catch (err) {
      setPortalError(`${center.name || center.id}: ${err.message}`);
      setTimeout(() => setPortalError(''), 5000);
    } finally {
      setPortalLoadingFor(null);
    }
  };

  useEffect(() => (
    onSnapshot(
      collection(db, 'centers'),
      snap => {
        setCenters(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false),
    )
  ), []);

  if (!isSuperAdmin) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Platform billing is for the platform operator only.</p>
      </div>
    );
  }

  // Status defaults: any centre with a positive amount and no explicit status
  // is treated as 'active'; centres with no plan default to 'free'.
  const effectiveStatus = (c) => {
    const b = c?.billing || {};
    if (b.status) return b.status;
    return (Number(b.monthlyAmount) || 0) > 0 ? 'active' : 'free';
  };

  const totalMonthly = centers.reduce((sum, c) => sum + (Number(c?.billing?.monthlyAmount) || 0), 0);
  const totalAnnual = totalMonthly * 12;
  const today = todayStr();

  const counts = { active: 0, trial: 0, past_due: 0, cancelled: 0, free: 0 };
  let paidThisMonth = 0;
  for (const c of centers) {
    const s = effectiveStatus(c);
    if (counts[s] != null) counts[s]++;
    const lastPaid = c?.billing?.lastPaidAt;
    if (lastPaid && lastPaid >= today.slice(0, 7) + '-01') {
      paidThisMonth += Number(c.billing.lastPaidAmount) || 0;
    }
  }
  const paying = counts.active + counts.trial + counts.past_due;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-700">
          <Briefcase size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Platform Revenue</h1>
          <p className="text-sm text-gray-500">
            What we charge each centre for using the product. Updates here only — owners don't see this page.
          </p>
        </div>
      </div>

      {/* Summary cards — money on the top row, fleet status on the second. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard icon={<DollarSign size={16} />} color="emerald" label="MRR" value={fmtMoney(totalMonthly)} sub="monthly recurring" />
        <SummaryCard icon={<TrendingUp size={16} />} color="blue"    label="ARR" value={fmtMoney(totalAnnual)} sub="annual run-rate" />
        <SummaryCard icon={<CheckCircle2 size={16} />} color="emerald" label="Paid this month" value={fmtMoney(paidThisMonth)} sub={`from ${centers.filter(c => (c?.billing?.lastPaidAt || '') >= today.slice(0, 7) + '-01').length} centres`} />
        <SummaryCard icon={<Building2 size={16} />}  color="purple"  label="Paying centres" value={paying} sub={`${centers.length} total`} />
      </div>

      {/* Fleet status strip — at-a-glance health of the customer base. */}
      <div className="rounded-2xl border bg-white px-5 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <FleetChip count={counts.active}    style={statusStyle('active')} />
          <FleetChip count={counts.trial}     style={statusStyle('trial')} />
          <FleetChip count={counts.past_due}  style={statusStyle('past_due')} highlight />
          <FleetChip count={counts.cancelled} style={statusStyle('cancelled')} />
          <span className="rounded-full bg-gray-50 px-3 py-1.5 text-xs font-semibold text-gray-600">
            Free · {counts.free}
          </span>
          {counts.past_due > 0 && (
            <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-rose-700">
              <AlertOctagon size={13} /> {counts.past_due} {counts.past_due === 1 ? 'centre needs' : 'centres need'} chasing
            </span>
          )}
        </div>
      </div>

      {/* Centres list */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Building2 size={18} className="text-emerald-600" />
          <h3 className="font-semibold text-gray-900">Centres ({centers.length})</h3>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-emerald-600 border-t-transparent" />
          </div>
        ) : centers.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">No centres on the platform yet.</p>
        ) : (
          <div className="space-y-2">
            {centers
              .slice()
              .sort((a, b) => {
                // Past-due always floats to the top so it's impossible to miss,
                // then trials (so you can chase conversions), then paid centres
                // by amount, then free.
                const STATUS_ORDER = { past_due: 0, trial: 1, active: 2, cancelled: 3, free: 4 };
                const sa = STATUS_ORDER[effectiveStatus(a)] ?? 5;
                const sb = STATUS_ORDER[effectiveStatus(b)] ?? 5;
                if (sa !== sb) return sa - sb;
                return (Number(b?.billing?.monthlyAmount) || 0) - (Number(a?.billing?.monthlyAmount) || 0);
              })
              .map(c => (
                <CentreRow
                  key={c.id}
                  center={c}
                  isEditing={editing === c.id}
                  onStartEdit={() => setEditing(c.id)}
                  onCancel={() => setEditing(null)}
                  onSaved={() => setEditing(null)}
                  onSendCheckoutLink={() => setStripeModalCenter(c)}
                  onOpenPortal={() => openCustomerPortal(c)}
                  portalLoading={portalLoadingFor === c.id}
                />
              ))}
          </div>
        )}
      </div>

      {/* Stripe is live — small note about the autopilot. */}
      <div className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/50 p-5">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
          <CheckCircle2 size={13} /> Stripe automation is live
        </p>
        <p className="text-xs text-emerald-900/80">
          Send a Checkout Link to a centre, they pay through Stripe, and the status / next bill / last paid columns update themselves via webhook. Use "Open Portal" for centres that need to change card or cancel.
        </p>
      </div>

      {portalError && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg">
          <AlertTriangle size={14} /> {portalError}
        </div>
      )}

      {/* Checkout Link generator modal. */}
      {stripeModalCenter && (
        <StripeCheckoutModal
          center={stripeModalCenter}
          user={user}
          onClose={() => setStripeModalCenter(null)}
        />
      )}
    </div>
  );
}

// Modal for generating a Stripe Checkout URL. Super-admin picks the tier and
// billing interval, this hits our /api/stripe/create-checkout-session route,
// and the resulting hosted Checkout URL is displayed with a one-click Copy
// button. The super-admin then emails that URL to the centre's owner; once
// the owner pays, the webhook flips the centre's status to 'active'.
function StripeCheckoutModal({ center, user, onClose }) {
  const [tier, setTier] = useState(center?.billing?.tier && center.billing.tier !== 'free' ? center.billing.tier : 'starter');
  const [billing, setBilling] = useState('monthly');
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const PAID_TIERS = TIERS.filter(t => t.key !== 'free');

  const generate = async () => {
    setError('');
    setLoading(true);
    try {
      const idToken = user ? await user.getIdToken() : null;
      if (!idToken) throw new Error('Not signed in.');
      const r = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ centerId: center.id, tier, billing }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || `Request failed (${r.status}).`);
      setUrl(data.url);
    } catch (err) {
      setError(err.message || 'Failed to generate Checkout link.');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard rejected — user can copy manually */
    }
  };

  const selectedAmount = (() => {
    const t = TIERS.find(x => x.key === tier);
    if (!t) return 0;
    if (billing === 'annual') {
      // Mirror the setup-stripe-products.js annual amounts (20% off).
      const annualMap = { starter: 276, growth: 468, pro: 756 };
      return annualMap[tier] ?? t.suggestedAmount * 12;
    }
    return t.suggestedAmount;
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !loading && onClose()}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 bg-gradient-to-r from-purple-50 to-white px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-purple-100 p-2 text-purple-700"><Link2 size={18} /></div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Send a Checkout link</h3>
              <p className="mt-0.5 text-xs text-gray-500">
                Generate a Stripe-hosted Checkout URL for <strong>{center.name || center.id}</strong>. Email it to the owner — when they pay, the status here flips to Active automatically.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-5 py-5">
          {!url && (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-gray-500">Tier</label>
                <div className="flex flex-wrap gap-2">
                  {PAID_TIERS.map(t => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setTier(t.key)}
                      className={`inline-flex items-center gap-1 rounded-full border-2 px-3 py-1.5 text-xs font-semibold transition-all ${
                        tier === t.key
                          ? 'bg-purple-600 text-white border-transparent'
                          : `${t.color} border-transparent hover:opacity-80`
                      }`}
                    >
                      {t.label} <span className="opacity-70">({fmtMoney(t.suggestedAmount)}/mo)</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-gray-500">Billing interval</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setBilling('monthly')}
                    className={`flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition-all ${
                      billing === 'monthly'
                        ? 'border-purple-600 bg-purple-600 text-white'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    Monthly
                  </button>
                  <button
                    type="button"
                    onClick={() => setBilling('annual')}
                    className={`flex-1 rounded-lg border-2 px-3 py-2 text-sm font-semibold transition-all ${
                      billing === 'annual'
                        ? 'border-purple-600 bg-purple-600 text-white'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    Annual <span className={`ml-1 text-[10px] ${billing === 'annual' ? 'text-purple-100' : 'text-emerald-600'}`}>−20%</span>
                  </button>
                </div>
              </div>

              <div className="rounded-lg bg-gray-50 px-4 py-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">{TIERS.find(t => t.key === tier)?.label} · {billing === 'annual' ? 'annual' : 'monthly'}</span>
                  <span className="font-bold text-gray-900">
                    {fmtMoney(selectedAmount)}
                    <span className="ml-1 text-xs font-normal text-gray-500">{billing === 'annual' ? '/ year' : '/ month'}</span>
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  14-day free trial · card on file but no charge until day 15 · cancel anytime via Customer Portal
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
            </>
          )}

          {url && (
            <>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <CheckCircle2 size={14} className="-mt-0.5 mr-1 inline" /> Checkout URL ready. Copy and send it to the centre.
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-gray-500">Checkout URL</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={url}
                    onFocus={(e) => e.target.select()}
                    className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-xs font-mono text-gray-800 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={copy}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-700"
                  >
                    {copied ? <><CheckCircle2 size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Tip — email this to <strong>{center.billing?.customerEmail || 'the centre owner'}</strong> with a short note. The URL is single-use, lives for 24 hours, and only works for {center.name || center.id}.
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
          >
            {url ? 'Done' : 'Cancel'}
          </button>
          {!url && (
            <button
              type="button"
              onClick={generate}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:opacity-50"
            >
              {loading
                ? <><Loader2 size={14} className="animate-spin" /> Generating…</>
                : <><Send size={14} /> Generate Checkout URL</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Inline chip showing one fleet-status count.
function FleetChip({ count, style, highlight }) {
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${style.color} ${highlight ? 'ring-2 ring-rose-300' : ''}`}>
      <Icon size={12} /> {style.label} · {count}
    </span>
  );
}

function SummaryCard({ icon, color, label, value, sub }) {
  const colorBg = {
    emerald: 'bg-emerald-100 text-emerald-700',
    blue:    'bg-blue-100 text-blue-700',
    purple:  'bg-purple-100 text-purple-700',
    gray:    'bg-gray-100 text-gray-600',
  }[color] || 'bg-gray-100 text-gray-600';
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className={`w-fit rounded-lg p-1.5 ${colorBg}`}>{icon}</div>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-0.5 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

function CentreRow({
  center, isEditing, onStartEdit, onCancel, onSaved,
  onSendCheckoutLink, onOpenPortal, portalLoading,
}) {
  const billing = center.billing || {};
  const [tier, setTier] = useState(billing.tier || 'free');
  const [amount, setAmount] = useState(String(billing.monthlyAmount ?? 0));
  const [notes, setNotes] = useState(billing.notes || '');
  // Use ?? (not ||) so an explicit empty-string "None" choice survives
  // a re-open of the editor — otherwise || would treat '' the same as
  // "never set" and reset the chip to the Active/Free fallback.
  const [status, setStatus] = useState(billing.status ?? ((Number(billing.monthlyAmount) || 0) > 0 ? 'active' : 'free'));
  const [periodEnd, setPeriodEnd] = useState(billing.currentPeriodEnd || '');
  const [lastPaidAt, setLastPaidAt] = useState(billing.lastPaidAt || '');
  const [lastPaidAmount, setLastPaidAmount] = useState(String(billing.lastPaidAmount ?? ''));
  const [customerEmail, setCustomerEmail] = useState(billing.customerEmail || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [marking, setMarking] = useState(false);

  // Re-sync when entering edit mode or when the row data changes.
  useEffect(() => {
    if (isEditing) {
      setTier(billing.tier || 'free');
      setAmount(String(billing.monthlyAmount ?? 0));
      setNotes(billing.notes || '');
      setStatus(billing.status ?? ((Number(billing.monthlyAmount) || 0) > 0 ? 'active' : 'free'));
      setPeriodEnd(billing.currentPeriodEnd || '');
      setLastPaidAt(billing.lastPaidAt || '');
      setLastPaidAmount(String(billing.lastPaidAmount ?? ''));
      setCustomerEmail(billing.customerEmail || '');
      setError('');
    }
  }, [
    isEditing,
    billing.tier, billing.monthlyAmount, billing.notes,
    billing.status, billing.currentPeriodEnd, billing.lastPaidAt,
    billing.lastPaidAmount, billing.customerEmail,
  ]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const next = {
        tier,
        monthlyAmount: Number(amount) || 0,
        currency: 'CAD',
        notes: notes.trim(),
        status,
        currentPeriodEnd: periodEnd || null,
        lastPaidAt: lastPaidAt || null,
        lastPaidAmount: lastPaidAmount === '' ? null : (Number(lastPaidAmount) || 0),
        customerEmail: customerEmail.trim(),
        updatedAt: serverTimestamp(),
      };
      await setDoc(
        doc(db, 'centers', center.id),
        { billing: next },
        { merge: true },
      );
      onSaved?.();
    } catch (err) {
      setError(err?.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  // One-click "Mark Paid" — bumps lastPaidAt to today, sets lastPaidAmount to
  // whatever this centre actually pays per period, and flips status to
  // active. Useful when you chase a past-due centre and they pay outside of
  // Stripe (wire transfer, e-transfer, etc.).
  //
  // Detects monthly vs annual cadence from the current period span so
  // annual subscribers don't have their next-bill date bumped by one month
  // when they're really on a yearly cycle.
  const handleMarkPaid = async () => {
    setMarking(true);
    setError('');
    try {
      // Cadence detection: how long does the current period span? If the
      // gap between lastPaidAt and currentPeriodEnd is > 6 months, this is
      // an annual subscription — bump 12 months forward; otherwise 1.
      let monthsToAdvance = 1;
      if (billing.lastPaidAt && billing.currentPeriodEnd) {
        const lp = new Date(billing.lastPaidAt + 'T00:00:00');
        const pe = new Date(billing.currentPeriodEnd + 'T00:00:00');
        const days = (pe - lp) / 86_400_000;
        if (days > 180) monthsToAdvance = 12;
      }
      const monthly = Number(billing.monthlyAmount) || 0;
      // Annual price mirrors what scripts/setup-stripe-products.js created
      // in Stripe (20% off monthly × 12, rounded to whole dollars).
      const annualPrice = Math.round(monthly * 12 * 0.8);
      const paidAmount = monthsToAdvance === 12 ? annualPrice : monthly;

      let nextPeriodEnd = billing.currentPeriodEnd || '';
      if (nextPeriodEnd) {
        const [y, m, d] = nextPeriodEnd.split('-').map(Number);
        const dt = new Date(y, (m - 1) + monthsToAdvance, d);
        nextPeriodEnd = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      }
      await setDoc(
        doc(db, 'centers', center.id),
        {
          billing: {
            ...billing,
            status: 'active',
            lastPaidAt: todayStr(),
            lastPaidAmount: paidAmount,
            currentPeriodEnd: nextPeriodEnd || billing.currentPeriodEnd || null,
            updatedAt: serverTimestamp(),
          },
        },
        { merge: true },
      );
    } catch (err) {
      setError(err?.message || 'Failed to mark paid.');
    } finally {
      setMarking(false);
    }
  };

  const handleTierClick = (t) => {
    setTier(t.key);
    // Auto-fill the suggested amount when the user clicks a preset chip — only
    // if they haven't already typed a custom value.
    if (!amount || Number(amount) === 0 || TIERS.some(x => String(x.suggestedAmount) === amount)) {
      setAmount(String(t.suggestedAmount));
    }
  };

  const style = tierStyle(billing.tier);
  const monthly = Number(billing.monthlyAmount) || 0;
  // Compute the "effective" status the read view shows — falls back to
  // 'active' or 'free' if the centre has never been edited.
  const effStatus = billing.status || (monthly > 0 ? 'active' : 'free');
  const sStyle = effStatus === 'free' ? null : statusStyle(effStatus);
  const today = todayStr();
  const overdueDays = (billing.currentPeriodEnd && billing.currentPeriodEnd < today)
    ? -daysBetween(today, billing.currentPeriodEnd)
    : 0;
  const daysUntilBill = (billing.currentPeriodEnd && billing.currentPeriodEnd >= today)
    ? daysBetween(today, billing.currentPeriodEnd)
    : 0;
  const isPastDue = effStatus === 'past_due' || overdueDays > 0;
  const updatedAt = billing.updatedAt?.seconds
    ? new Date(billing.updatedAt.seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className={`rounded-xl border bg-white ${isPastDue ? 'border-rose-300 shadow-[0_0_0_1px_rgba(244,63,94,0.15)]' : 'border-gray-200'}`}>
      {/* Read view */}
      {!isEditing && (
        <div className="flex items-center gap-3 px-4 py-3">
          <div className={`shrink-0 rounded-lg p-1.5 ${isPastDue ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'}`}>
            <Building2 size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-gray-900">{center.name || center.id}</p>
              {sStyle && (
                <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${sStyle.color}`}>
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${sStyle.badge}`} />
                  {sStyle.label}
                </span>
              )}
            </div>
            <p className="truncate text-xs text-gray-500">
              {[center.city, center.province].filter(Boolean).join(', ') || '—'}
              {billing.customerEmail && (
                <span className="ml-2 text-gray-400">· <Mail size={9} className="inline -mt-0.5" /> {billing.customerEmail}</span>
              )}
              {billing.notes && <span className="ml-2 text-gray-400 italic">· {billing.notes}</span>}
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500">
              {isPastDue ? (
                <span className="font-semibold text-rose-700">
                  <AlertOctagon size={11} className="-mt-0.5 inline" />{' '}
                  {overdueDays > 0 ? `${overdueDays} ${overdueDays === 1 ? 'day' : 'days'} overdue` : 'Past due'}
                </span>
              ) : billing.currentPeriodEnd ? (
                <span>Next bill {fmtDate(billing.currentPeriodEnd)}{daysUntilBill > 0 && ` · in ${daysUntilBill}d`}</span>
              ) : monthly > 0 ? (
                <span className="text-gray-400">No next-bill date set</span>
              ) : null}
              {billing.lastPaidAt && (
                <span className="ml-2 text-gray-400">
                  · Paid {fmtDate(billing.lastPaidAt)}
                  {billing.lastPaidAmount != null && ` (${fmtMoney(billing.lastPaidAmount)})`}
                </span>
              )}
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${style.color}`}>
            {style.label}
          </span>
          <div className="w-28 text-right">
            <p className="text-sm font-bold text-gray-900">{fmtMoney(monthly)}</p>
            <p className="text-[10px] text-gray-400">{monthly > 0 ? 'per month' : 'no charge'}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isPastDue && (
              <button
                type="button"
                onClick={handleMarkPaid}
                disabled={marking}
                className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                title="Mark this period as paid"
              >
                {marking ? '…' : <><CheckCircle2 size={11} className="-mt-0.5 inline" /> Mark Paid</>}
              </button>
            )}
            {/* Stripe actions — generate a Checkout link to send to the
                centre, or open the Customer Portal if they're already on
                Stripe. The Portal button only appears once we have a
                stripeCustomerId from the first paid Checkout. */}
            <button
              type="button"
              onClick={onSendCheckoutLink}
              className="rounded-lg border border-purple-200 bg-purple-50 px-2.5 py-1 text-xs font-semibold text-purple-700 hover:bg-purple-100"
              title="Generate a Stripe Checkout link to send to this centre"
            >
              <Link2 size={11} className="-mt-0.5 inline" /> Checkout Link
            </button>
            {billing.stripeCustomerId && (
              <button
                type="button"
                onClick={onOpenPortal}
                disabled={portalLoading}
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                title="Open Stripe Customer Portal in a new tab"
              >
                {portalLoading
                  ? <><Loader2 size={11} className="-mt-0.5 inline animate-spin" /> …</>
                  : <><ExternalLink size={11} className="-mt-0.5 inline" /> Portal</>}
              </button>
            )}
            <button
              type="button"
              onClick={onStartEdit}
              className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
            >
              <Edit3 size={12} className="-mt-0.5 inline" /> Edit
            </button>
          </div>
        </div>
      )}

      {/* Edit view */}
      {isEditing && (
        <div className="space-y-3 bg-emerald-50/40 px-4 py-4">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-emerald-700" />
            <p className="text-sm font-semibold text-gray-900">{center.name || center.id}</p>
            <span className="text-xs text-gray-400">{[center.city, center.province].filter(Boolean).join(', ')}</span>
            <button
              type="button"
              onClick={onCancel}
              className="ml-auto rounded-full p-1 text-gray-400 hover:bg-gray-200"
            >
              <X size={14} />
            </button>
          </div>

          {/* Tier chips — clicking auto-fills a suggested amount */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Subscription tier</label>
            <div className="flex flex-wrap gap-2">
              {TIERS.map(t => {
                const active = tier === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => handleTierClick(t)}
                    className={`rounded-full border-2 px-3 py-1 text-xs font-semibold transition-all ${
                      active
                        ? 'bg-emerald-600 text-white border-transparent'
                        : `${t.color} border-transparent hover:opacity-80`
                    }`}
                  >
                    {t.label}{' '}
                    <span className={`ml-1 ${active ? 'text-emerald-100' : 'opacity-60'}`}>
                      ({fmtMoney(t.suggestedAmount)})
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Monthly amount (CAD)</label>
              <input
                type="number"
                min={0}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Customer email (for invoices)</label>
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="ops@centre.com"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Subscription status chips. The "None" chip clears the explicit
              status — the row will then auto-display as Active (if there's a
              monthly amount) or Free (if not) via the effectiveStatus
              fallback. Useful for your own centre, internal pilots, etc.
              where no sales-funnel status applies. */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Subscription status</label>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map(s => {
                const active = status === s.key;
                const Icon = s.icon;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setStatus(s.key)}
                    className={`inline-flex items-center gap-1 rounded-full border-2 px-3 py-1 text-xs font-semibold transition-all ${
                      active
                        ? `${s.badge} text-white border-transparent`
                        : `${s.color} border-transparent hover:opacity-80`
                    }`}
                  >
                    <Icon size={11} /> {s.label}
                  </button>
                );
              })}
              {(() => {
                const active = !status;
                return (
                  <button
                    type="button"
                    onClick={() => setStatus('')}
                    title="Clear the explicit status — row will auto-show as Active or Free based on the monthly amount."
                    className={`inline-flex items-center gap-1 rounded-full border-2 px-3 py-1 text-xs font-semibold transition-all ${
                      active
                        ? 'bg-gray-500 text-white border-transparent'
                        : 'bg-gray-100 text-gray-600 border-transparent hover:opacity-80'
                    }`}
                  >
                    <MinusCircle size={11} /> None
                  </button>
                );
              })()}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Next bill date</label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Last paid date</label>
              <input
                type="date"
                value={lastPaidAt}
                onChange={(e) => setLastPaidAt(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Last paid amount</label>
              <input
                type="number"
                min={0}
                step={1}
                value={lastPaidAmount}
                onChange={(e) => setLastPaidAmount(e.target.value)}
                placeholder="0"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Notes (optional)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. discount, locked-in rate, trial through Aug"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          <div className="flex items-center justify-between">
            {updatedAt ? (
              <p className="text-xs text-gray-400">Last saved {updatedAt}</p>
            ) : <span />}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={saving}
                className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Saving…
                  </>
                ) : (
                  <><CheckCircle2 size={14} /> Save</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
