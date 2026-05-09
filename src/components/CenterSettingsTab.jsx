import { useState, useEffect } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { DAY_NAMES } from '../lib/centerConfig';
import { Settings, Save, X, Plus, AlertTriangle, CheckCircle2, Building2, Clock, BookOpen, Users } from 'lucide-react';

/**
 * Edit per-center settings: identity, instructional + operating hours,
 * guaranteed names list, salary staff list.
 *
 * Fixed-staff editor intentionally not included this pass — those entries
 * have complex per-day shift strings and editing them safely is its own
 * project. They remain editable in code via lib/scheduler.js FIXED_SCHEDULES
 * (or via direct Firestore writes to centers/{id}/config/main.fixedStaff).
 *
 * Saves write to centers/{centerId}/config/main and the change flows back
 * out to every consumer via the AuthContext subscription.
 */

export default function CenterSettingsTab({ activeCenterId, centerConfig }) {
  // Local form state — initialized from the live config but allows uncommitted edits.
  const [form, setForm] = useState(centerConfig);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');

  // Re-sync when the underlying config changes (e.g., after save).
  useEffect(() => {
    setForm(centerConfig);
  }, [centerConfig]);

  const dirty = JSON.stringify(form) !== JSON.stringify(centerConfig);

  const setField = (key, value) => setForm(p => ({ ...p, [key]: value }));
  const setHours = (kind, day, side, value) => setForm(p => ({
    ...p,
    [kind]: {
      ...p[kind],
      [day]: { ...(p[kind]?.[day] || {}), [side]: value },
    },
  }));

  const addToList = (key, value) => {
    const v = (value || '').trim();
    if (!v) return;
    const current = Array.isArray(form[key]) ? form[key] : [];
    if (current.includes(v)) return;
    setForm(p => ({ ...p, [key]: [...current, v] }));
  };
  const removeFromList = (key, value) => {
    const current = Array.isArray(form[key]) ? form[key] : [];
    setForm(p => ({ ...p, [key]: current.filter(x => x !== value) }));
  };

  const handleSave = async () => {
    if (!activeCenterId) return;
    setSaving(true);
    setError('');
    try {
      // Strip stale createdAt so we don't overwrite it with undefined
      const { createdAt: _ignored, ...payload } = form || {};
      void _ignored;
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { ...payload, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (err) {
      setError(err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => setForm(centerConfig);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <Settings size={18} className="text-purple-600" />
          <h3 className="font-semibold text-gray-900">Center Settings</h3>
        </div>
        <p className="text-sm text-gray-500">
          Tunables for <strong>{centerConfig?.name || activeCenterId}</strong>. Changes apply immediately to the auto-scheduler, the Full Day picker, payroll exclusions, and the coverage grid for everyone at this center.
        </p>
      </div>

      {/* Identity */}
      <Section title="Identity" icon={Building2}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Center name">
            <input
              type="text"
              value={form?.name || ''}
              onChange={e => setField('name', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            />
          </Field>
          <Field label="City">
            <input
              type="text"
              value={form?.city || ''}
              onChange={e => setField('city', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            />
          </Field>
          <Field label="Province / state">
            <input
              type="text"
              value={form?.province || ''}
              onChange={e => setField('province', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            />
          </Field>
          <Field label="Country">
            <input
              type="text"
              value={form?.country || ''}
              onChange={e => setField('country', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            />
          </Field>
          <Field label="Timezone (IANA)">
            <input
              type="text"
              value={form?.timezone || ''}
              onChange={e => setField('timezone', e.target.value)}
              placeholder="America/Vancouver"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            />
          </Field>
        </div>
      </Section>

      {/* Instructional hours */}
      <Section
        title="Instructional Hours"
        icon={BookOpen}
        hint="Teaching window. Auto-scheduler clamps Instructor/Lead/promoted-Host shifts to this range."
      >
        <DayHoursTable
          hours={form?.instructionalHours}
          onChange={(day, side, value) => setHours('instructionalHours', day, side, value)}
        />
      </Section>

      {/* Operating hours */}
      <Section
        title="Operating Hours"
        icon={Clock}
        hint="Open-to-close including admin prep + cleanup. Used by the Full Day availability toggle and the coverage grid x-axis."
      >
        <DayHoursTable
          hours={form?.operatingHours}
          onChange={(day, side, value) => setHours('operatingHours', day, side, value)}
        />
      </Section>

      {/* Guaranteed names */}
      <Section
        title="Guaranteed Shift — First Names"
        icon={Users}
        hint="Anyone whose first name appears here is guaranteed a shift when they submit availability. Per-user toggle in Manage Users overrides this list."
      >
        <ListEditor
          items={form?.guaranteedNames || []}
          onAdd={v => addToList('guaranteedNames', v)}
          onRemove={v => removeFromList('guaranteedNames', v)}
          placeholder="First name (e.g., Luke)"
          chipColor="emerald"
        />
      </Section>

      {/* Salary staff */}
      <Section
        title="Salaried Staff — Excluded from Hourly Payroll"
        icon={Users}
        hint="Full names. People listed here are paid a salary, so their shifts won't appear in the Payroll tab's hourly summary."
      >
        <ListEditor
          items={form?.salaryStaff || []}
          onAdd={v => addToList('salaryStaff', v)}
          onRemove={v => removeFromList('salaryStaff', v)}
          placeholder="Full name (e.g., Jasper Wu)"
          chipColor="amber"
        />
      </Section>

      {/* Fixed staff editor placeholder */}
      <Section
        title="Fixed Staff Schedules"
        icon={Users}
        hint="Staff with hardcoded weekly schedules (e.g., Center Director, Manager). Editor coming in a later pass — for now, edit lib/scheduler.js FIXED_SCHEDULES or write directly to Firestore at centers/{id}/config/main.fixedStaff."
      >
        <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-500">
          {Object.keys(form?.fixedStaff || {}).length === 0
            ? 'No fixed staff configured. The auto-scheduler is using the default (legacy) fixed staff list from code.'
            : (
              <div className="flex flex-wrap gap-2">
                {Object.entries(form.fixedStaff).map(([name, sched]) => (
                  <span key={name} className="rounded-full bg-white border border-gray-300 px-3 py-1 text-xs">
                    <strong className="text-gray-800">{name}</strong>
                    <span className="text-gray-400"> · {sched.role || '—'}</span>
                  </span>
                ))}
              </div>
            )}
        </div>
      </Section>

      {/* Save bar */}
      <div className="sticky bottom-0 -mx-4 px-4 py-3 bg-white/80 backdrop-blur border-t border-gray-200 flex items-center justify-between gap-3 flex-wrap rounded-b-xl">
        <div className="flex items-center gap-2 text-xs">
          {dirty && !savedAt && (
            <span className="flex items-center gap-1 text-amber-700">
              <AlertTriangle size={13} />
              Unsaved changes
            </span>
          )}
          {savedAt && !dirty && (
            <span className="flex items-center gap-1 text-emerald-700">
              <CheckCircle2 size={13} />
              Saved
            </span>
          )}
          {error && (
            <span className="text-red-600">{error}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleReset}
            disabled={!dirty || saving}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            Discard changes
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Section({ title, icon: Icon, hint, children }) {
  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm">
      <div className="flex items-start gap-2 mb-3">
        {Icon && <Icon size={16} className="text-purple-600 mt-0.5" />}
        <div>
          <h4 className="font-semibold text-gray-900 text-sm">{title}</h4>
          {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      {children}
    </label>
  );
}

function DayHoursTable({ hours, onChange }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500">
            <th className="text-left pb-1 font-medium pr-3">Day</th>
            <th className="text-left pb-1 font-medium px-2">Start</th>
            <th className="text-left pb-1 font-medium px-2">End</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {DAY_NAMES.map(day => (
            <tr key={day}>
              <td className="py-2 pr-3 font-medium text-gray-700 w-32">{day}</td>
              <td className="py-2 px-2">
                <input
                  type="time"
                  value={hours?.[day]?.start || ''}
                  onChange={e => onChange(day, 'start', e.target.value)}
                  className="w-32 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
                />
              </td>
              <td className="py-2 px-2">
                <input
                  type="time"
                  value={hours?.[day]?.end || ''}
                  onChange={e => onChange(day, 'end', e.target.value)}
                  className="w-32 rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListEditor({ items, onAdd, onRemove, placeholder, chipColor = 'gray' }) {
  const [input, setInput] = useState('');
  const palette = {
    emerald: { bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-200' },
    amber:   { bg: 'bg-amber-100',   text: 'text-amber-800',   border: 'border-amber-200'   },
    gray:    { bg: 'bg-gray-100',    text: 'text-gray-800',    border: 'border-gray-200'    },
  }[chipColor] || { bg: 'bg-gray-100', text: 'text-gray-800', border: 'border-gray-200' };

  const submit = (e) => {
    e?.preventDefault();
    if (!input.trim()) return;
    onAdd(input);
    setInput('');
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {items.length === 0 ? (
          <span className="text-sm text-gray-400 italic">No entries yet.</span>
        ) : items.map(item => (
          <span
            key={item}
            className={`flex items-center gap-1.5 rounded-full ${palette.bg} ${palette.text} px-3 py-1 text-xs font-semibold border ${palette.border}`}
          >
            {item}
            <button
              onClick={() => onRemove(item)}
              className="rounded-full hover:bg-black/10 w-4 h-4 flex items-center justify-center transition-colors"
              aria-label={`Remove ${item}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={placeholder}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
        />
        <button
          type="submit"
          disabled={!input.trim()}
          className="flex items-center gap-1 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-30 transition-colors"
        >
          <Plus size={14} />
          Add
        </button>
      </form>
    </div>
  );
}
