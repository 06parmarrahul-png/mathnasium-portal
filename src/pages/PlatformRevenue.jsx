import { useState, useEffect } from 'react';
import { collection, doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Briefcase, Building2, DollarSign, TrendingUp, ShieldAlert, Edit3,
  CheckCircle2, AlertTriangle, Save, X, AlertOctagon, Clock, PauseCircle,
  Mail,
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

const TIERS = [
  { key: 'free',       label: 'Free',       suggestedAmount: 0,    color: 'bg-gray-100 text-gray-700' },
  { key: 'starter',    label: 'Starter',    suggestedAmount: 49,   color: 'bg-emerald-100 text-emerald-800' },
  { key: 'pro',        label: 'Pro',        suggestedAmount: 149,  color: 'bg-blue-100 text-blue-800' },
  { key: 'enterprise', label: 'Enterprise', suggestedAmount: 399,  color: 'bg-purple-100 text-purple-800' },
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
  const { isSuperAdmin } = useAuth();
  const [centers, setCenters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // centerId being edited

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
                />
              ))}
          </div>
        )}
      </div>

      {/* Coming-next teaser — Stripe automation. */}
      <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-5">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <TrendingUp size={13} className="text-emerald-500" /> Coming next — Stripe automation
        </p>
        <p className="text-xs text-gray-500">
          Phase 2.1 will wire status / next bill / last paid up to Stripe via webhooks so this updates without you touching anything.
          Until then this is the source of truth — and the fields are already the ones Stripe will write into, so no migration is needed when it goes live.
        </p>
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

function CentreRow({ center, isEditing, onStartEdit, onCancel, onSaved }) {
  const billing = center.billing || {};
  const [tier, setTier] = useState(billing.tier || 'free');
  const [amount, setAmount] = useState(String(billing.monthlyAmount ?? 0));
  const [notes, setNotes] = useState(billing.notes || '');
  const [status, setStatus] = useState(billing.status || ((Number(billing.monthlyAmount) || 0) > 0 ? 'active' : 'free'));
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
      setStatus(billing.status || ((Number(billing.monthlyAmount) || 0) > 0 ? 'active' : 'free'));
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
  // the current monthly amount, and flips status to active. Useful when you
  // chase a past-due centre and they pay outside of Stripe.
  const handleMarkPaid = async () => {
    setMarking(true);
    setError('');
    try {
      // If currentPeriodEnd is set or in the past, bump it forward a month.
      let nextPeriodEnd = billing.currentPeriodEnd || '';
      if (nextPeriodEnd) {
        const [y, m, d] = nextPeriodEnd.split('-').map(Number);
        const dt = new Date(y, (m - 1) + 1, d);
        nextPeriodEnd = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      }
      await setDoc(
        doc(db, 'centers', center.id),
        {
          billing: {
            ...billing,
            status: 'active',
            lastPaidAt: todayStr(),
            lastPaidAmount: Number(billing.monthlyAmount) || 0,
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
        <div className="px-4 py-4 space-y-3 bg-emerald-50/40">
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

          {/* Subscription status chips */}
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
