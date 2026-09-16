import { useState, useEffect } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { DAY_NAMES, isSummerOverrideActive } from '../lib/centerConfig';
import { Settings, Save, X, AlertTriangle, CheckCircle2, Building2, Clock, BookOpen, Sun } from 'lucide-react';

/**
 * Edit per-center settings: identity, instructional + operating hours,
 * salaried-staff list.
 *
 * Guaranteed shift is now a per-user toggle in Manage Staff (under each
 * staff member's Edit modal), not a centre-wide names list. Fixed-staff
 * editing isn't surfaced here yet — message support to add / change a
 * fixed-staff entry; the auto-scheduler reads them straight from
 * centers/{id}/config/main.fixedStaff in the meantime.
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
          <h3 className="font-semibold text-gray-900">Centre Settings</h3>
        </div>
        <p className="text-sm text-gray-500">
          Tunables for <strong>{centerConfig?.name || activeCenterId}</strong>. Changes apply immediately to the auto-scheduler, the Full Day picker, payroll exclusions, and the coverage grid for everyone at this center.
        </p>
      </div>

      {/* Identity */}
      <Section title="Identity" icon={Building2}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Centre name">
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

      {/* Summer (date-bounded) override — narrow feature for Langley's
          2026 July/August change. Auto-expires after the `to` date, so
          there's no September cleanup task. */}
      <Section
        title="Seasonal Hours Override"
        icon={Sun}
        hint="Optional. Date-bounded overlay on instructional hours — auto-expires after the end date, no manual revert."
      >
        <SummerOverrideEditor
          override={form?.summerHours2026}
          baseHours={form?.instructionalHours}
          onChange={(next) => setField('summerHours2026', next)}
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

      {/* The Designated Host and Salaried Staff editors used to sit here.
          Removed because they're configured once and never revisited, while
          cluttering the settings owners open every week. The VALUES are
          untouched: `form` is the whole config object and the save is
          {merge:true}, so `autoHostNames` and `salaryStaff` round-trip
          unedited and every feature reading them still works. Change them in
          the Firebase console. */}

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

/**
 * Editor for the date-bounded summer override on instructional hours.
 *
 * Deliberately narrow: one date range, one map of day → {start, end}.
 * Designed for Langley's 2026 July/August schedule change. If we need
 * recurring overrides or multiple windows later, this gets replaced
 * with a generic editor — for now YAGNI.
 *
 * Saving null disables the override entirely. Owner can clear the
 * "Enabled" checkbox to revert to year-round hours without touching
 * the dates or per-day values (handy if they want to re-enable later).
 */
function SummerOverrideEditor({ override, baseHours, onChange }) {
  const enabled = !!override;
  const o = override || { from: '', to: '', byDay: {} };
  const active = isSummerOverrideActive({ summerHours2026: override }, new Date());

  const setOverride = (patch) => onChange({ ...o, ...patch });
  const setDayHours = (day, side, value) => onChange({
    ...o,
    byDay: { ...(o.byDay || {}), [day]: { ...((o.byDay || {})[day] || {}), [side]: value } },
  });
  const removeDay = (day) => {
    const next = { ...(o.byDay || {}) };
    delete next[day];
    onChange({ ...o, byDay: next });
  };
  // Both ends in ONE update. This used to be two setDayHours() calls
  // joined by `&&`: setDayHours returns undefined, so the second never
  // ran and the day was added with a start and no end — and both calls
  // derived from the same stale `o`, so the second would have clobbered
  // the first anyway.
  const addDay = (day) => onChange({
    ...o,
    byDay: {
      ...(o.byDay || {}),
      [day]: {
        start: baseHours?.[day]?.start || '10:00',
        end:   baseHours?.[day]?.end   || '14:00',
      },
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled}
            onChange={(e) => onChange(e.target.checked
              ? { from: o.from || '', to: o.to || '', byDay: o.byDay || {} }
              : null)} />
          Enable a summer / seasonal override
        </label>
        {active && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
            <CheckCircle2 size={11} /> Active right now
          </span>
        )}
      </div>

      {enabled && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Starts on">
              <input type="date" value={o.from || ''}
                onChange={(e) => setOverride({ from: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20" />
            </Field>
            <Field label="Ends on (auto-expires after this date)">
              <input type="date" value={o.to || ''}
                onChange={(e) => setOverride({ to: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20" />
            </Field>
          </div>

          <div className="rounded border border-gray-200 bg-gray-50 p-3">
            <p className="mb-2 text-xs font-medium text-gray-700">
              Per-day instructional hours during this window — days not listed below fall through to the year-round defaults above.
            </p>
            {Object.keys(o.byDay || {}).length === 0 && (
              <p className="text-xs text-gray-500 mb-2">No days overridden yet.</p>
            )}
            {Object.entries(o.byDay || {}).map(([day, h]) => (
              <div key={day} className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="w-20 shrink-0 font-medium text-gray-700">{day}</span>
                <input type="time" value={h?.start || ''}
                  onChange={(e) => setDayHours(day, 'start', e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-xs" />
                <span className="text-gray-400">to</span>
                <input type="time" value={h?.end || ''}
                  onChange={(e) => setDayHours(day, 'end', e.target.value)}
                  className="rounded border border-gray-300 px-2 py-1 text-xs" />
                <button type="button" onClick={() => removeDay(day)}
                  className="ml-auto inline-flex items-center rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600">
                  <X size={12} />
                </button>
              </div>
            ))}
            <div className="mt-2 flex flex-wrap gap-1">
              {DAY_NAMES.filter(d => !(d in (o.byDay || {}))).map(d => (
                <button key={d} type="button" onClick={() => addDay(d)}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-[11px] text-gray-600 hover:border-purple-400 hover:text-purple-700">
                  <Plus size={10} /> {d}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
