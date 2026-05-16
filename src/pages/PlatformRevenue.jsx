import { useState, useEffect } from 'react';
import { collection, doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Briefcase, Building2, DollarSign, TrendingUp, ShieldAlert, Edit3,
  CheckCircle2, AlertTriangle, Save, X,
} from 'lucide-react';

/**
 * Platform Revenue — what *we* charge each centre for using the product.
 *
 * Super-admin only. Lists every centre on the platform with an editable
 * subscription tier + monthly amount, plus a summary of platform MRR / ARR.
 *
 * Billing data is stored on `centers/{centerId}.billing`:
 *   { tier: 'free' | 'starter' | 'pro' | 'enterprise',
 *     monthlyAmount: number,
 *     currency: 'CAD',
 *     notes: string,
 *     updatedAt: serverTimestamp }
 */

const TIERS = [
  { key: 'free',       label: 'Free',       suggestedAmount: 0,    color: 'bg-gray-100 text-gray-700' },
  { key: 'starter',    label: 'Starter',    suggestedAmount: 49,   color: 'bg-emerald-100 text-emerald-800' },
  { key: 'pro',        label: 'Pro',        suggestedAmount: 149,  color: 'bg-blue-100 text-blue-800' },
  { key: 'enterprise', label: 'Enterprise', suggestedAmount: 399,  color: 'bg-purple-100 text-purple-800' },
];

function tierStyle(key) {
  return TIERS.find(t => t.key === key) || TIERS[0];
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 });
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

  const totalMonthly = centers.reduce((sum, c) => sum + (Number(c?.billing?.monthlyAmount) || 0), 0);
  const totalAnnual = totalMonthly * 12;
  const paying = centers.filter(c => (Number(c?.billing?.monthlyAmount) || 0) > 0).length;
  const free = centers.length - paying;

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

      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard icon={<DollarSign size={16} />} color="emerald" label="MRR" value={fmtMoney(totalMonthly)} sub="monthly recurring" />
        <SummaryCard icon={<TrendingUp size={16} />} color="blue"    label="ARR" value={fmtMoney(totalAnnual)} sub="annual run-rate" />
        <SummaryCard icon={<Building2 size={16} />}  color="purple"  label="Paying centres" value={paying} sub={`${centers.length} total`} />
        <SummaryCard icon={<Building2 size={16} />}  color="gray"    label="Free tier" value={free} sub="non-paying" />
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
              .sort((a, b) => (Number(b?.billing?.monthlyAmount) || 0) - (Number(a?.billing?.monthlyAmount) || 0))
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

      {/* Future-pricing teaser */}
      <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-5">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <TrendingUp size={13} className="text-emerald-500" /> Coming next — Billing automation
        </p>
        <p className="text-xs text-gray-500">
          Phase 2 will hook this up to Stripe so invoices, dunning, and tier upgrades run automatically.
          For now this is the source of truth for what we're charging each centre.
        </p>
      </div>
    </div>
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Re-sync when entering edit mode or when the row data changes.
  useEffect(() => {
    if (isEditing) {
      setTier(billing.tier || 'free');
      setAmount(String(billing.monthlyAmount ?? 0));
      setNotes(billing.notes || '');
      setError('');
    }
  }, [isEditing, billing.tier, billing.monthlyAmount, billing.notes]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const next = {
        tier,
        monthlyAmount: Number(amount) || 0,
        currency: 'CAD',
        notes: notes.trim(),
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
  const updatedAt = billing.updatedAt?.seconds
    ? new Date(billing.updatedAt.seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      {/* Read view */}
      {!isEditing && (
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="shrink-0 rounded-lg bg-emerald-50 p-1.5 text-emerald-700">
            <Building2 size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-gray-900">{center.name || center.id}</p>
            <p className="text-xs text-gray-500">
              {[center.city, center.province].filter(Boolean).join(', ') || '—'}
              {billing.notes && <span className="ml-2 text-gray-400 italic">· {billing.notes}</span>}
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold ${style.color}`}>
            {style.label}
          </span>
          <div className="w-28 text-right">
            <p className="text-sm font-bold text-gray-900">{fmtMoney(monthly)}</p>
            <p className="text-[10px] text-gray-400">{monthly > 0 ? 'per month' : 'no charge'}</p>
          </div>
          <button
            type="button"
            onClick={onStartEdit}
            className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
          >
            <Edit3 size={12} className="-mt-0.5 inline" /> Edit
          </button>
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
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. discount, locked-in rate, trial through Aug"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              />
            </div>
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
