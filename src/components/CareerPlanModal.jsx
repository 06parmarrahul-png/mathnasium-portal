import { useState, useEffect } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { TrendingUp, X, AlertTriangle, CheckCircle2 } from 'lucide-react';

/**
 * CareerPlanModal — lets a staff member submit / update their 4-month plan.
 *
 * Stored on the user doc as a `careerPlan` sub-object so owners can roll it
 * up in the Analytics → Hiring Forecast view. The staff member always edits
 * their own doc (Firestore rules permit self-update for non-privilege
 * fields, which careerPlan is).
 *
 * Shape:
 *   careerPlan = {
 *     stayingIn4Months:        'yes' | 'no' | 'unsure',
 *     expectedDepartureMonth:  'YYYY-MM' | null,
 *     reason:                  'graduating' | 'moving' | 'career' | 'school' | 'other' | null,
 *     reasonNotes:             string,
 *     aspirations:             string,
 *     updatedAt:               serverTimestamp,
 *   }
 */

const REASON_OPTIONS = [
  { value: 'graduating', label: 'Graduating' },
  { value: 'moving',     label: 'Moving away' },
  { value: 'career',     label: 'Career change' },
  { value: 'school',     label: 'School / workload' },
  { value: 'other',      label: 'Other' },
];

// Build a list of the next 12 month keys ('YYYY-MM') with friendly labels
// for the departure-month dropdown.
function nextMonths(n = 12) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    out.push({ key, label });
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

export default function CareerPlanModal({ open, onClose, onSaved }) {
  const { profile, refreshProfile } = useAuth();
  const existing = profile?.careerPlan || {};

  const [staying, setStaying] = useState(existing.stayingIn4Months || 'yes');
  const [departureMonth, setDepartureMonth] = useState(existing.expectedDepartureMonth || '');
  const [reason, setReason] = useState(existing.reason || '');
  const [reasonNotes, setReasonNotes] = useState(existing.reasonNotes || '');
  const [aspirations, setAspirations] = useState(existing.aspirations || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Re-seed every time the modal opens (or the saved plan changes), so the
  // form always reflects the latest server state.
  useEffect(() => {
    if (!open) return;
    setStaying(existing.stayingIn4Months || 'yes');
    setDepartureMonth(existing.expectedDepartureMonth || '');
    setReason(existing.reason || '');
    setReasonNotes(existing.reasonNotes || '');
    setAspirations(existing.aspirations || '');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profile?.careerPlan?.updatedAt?.seconds]);

  if (!open) return null;

  const needsDeparture = staying !== 'yes';
  const months = nextMonths(12);

  const handleSave = async () => {
    if (!profile?.uid) return;
    setSaving(true);
    setError('');
    try {
      const plan = {
        stayingIn4Months: staying,
        expectedDepartureMonth: needsDeparture ? (departureMonth || null) : null,
        reason: needsDeparture ? (reason || null) : null,
        reasonNotes: needsDeparture ? reasonNotes.trim() : '',
        aspirations: aspirations.trim(),
        updatedAt: serverTimestamp(),
      };
      await updateDoc(doc(db, 'users', profile.uid), { careerPlan: plan });
      // AuthContext caches profile from sign-in; pull the fresh doc so the
      // Home banner and Analytics forecast pick up the new plan immediately.
      await refreshProfile?.();
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err?.message || 'Failed to save your plan.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-gray-100 bg-gradient-to-r from-purple-50 to-white px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-purple-100 p-2 text-purple-600">
              <TrendingUp size={18} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Your 4-Month Plan</h3>
              <p className="mt-0.5 text-xs text-gray-500 max-w-sm">
                Helps us plan staffing so you're never overworked and so we can
                support your goals. We only share aggregates with owners.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {/* Staying choice */}
          <div>
            <label className="mb-2 block text-xs font-bold uppercase tracking-wide text-gray-500">
              Do you expect to still be working here 4 months from now?
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { v: 'yes',    label: 'Yes',    bg: 'bg-emerald-100', text: 'text-emerald-800', activeBg: 'bg-emerald-600' },
                { v: 'unsure', label: 'Unsure', bg: 'bg-amber-100',   text: 'text-amber-800',   activeBg: 'bg-amber-500' },
                { v: 'no',     label: 'No',     bg: 'bg-rose-100',    text: 'text-rose-800',    activeBg: 'bg-rose-600' },
              ].map((opt) => {
                const active = staying === opt.v;
                return (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setStaying(opt.v)}
                    className={`rounded-xl border-2 px-3 py-3 text-sm font-semibold transition-all ${
                      active
                        ? `${opt.activeBg} text-white border-transparent shadow-sm`
                        : `${opt.bg} ${opt.text} border-transparent hover:opacity-80`
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Departure month + reason (only if not staying for sure) */}
          {needsDeparture && (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-gray-500">
                  Expected last month
                </label>
                <select
                  value={departureMonth}
                  onChange={(e) => setDepartureMonth(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
                >
                  <option value="">— Pick a month —</option>
                  {months.map((m) => (
                    <option key={m.key} value={m.key}>{m.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-400">
                  Best guess is fine — you can update this anytime.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-gray-500">
                  Reason
                </label>
                <div className="flex flex-wrap gap-2">
                  {REASON_OPTIONS.map((opt) => {
                    const active = reason === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setReason(opt.value)}
                        className={`rounded-full px-3 py-1.5 text-xs font-semibold border-2 transition-all ${
                          active
                            ? 'bg-purple-600 text-white border-transparent'
                            : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <textarea
                  value={reasonNotes}
                  onChange={(e) => setReasonNotes(e.target.value)}
                  placeholder="Anything we should know? (Optional)"
                  rows={2}
                  className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none resize-none"
                />
              </div>
            </>
          )}

          {/* Aspirations */}
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-gray-500">
              Aspirations
            </label>
            <textarea
              value={aspirations}
              onChange={(e) => setAspirations(e.target.value)}
              placeholder="School, programs, dream jobs… anything you're working toward. Helps us mentor and time transitions."
              rows={3}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none resize-none"
            />
            <p className="mt-1 text-xs text-gray-400">
              Owners see this so they can support your path — feel free to share.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button
            type="button"
            onClick={() => !saving && onClose()}
            disabled={saving}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || (needsDeparture && !departureMonth)}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:opacity-50"
          >
            <CheckCircle2 size={14} />
            {saving ? 'Saving…' : 'Save plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
