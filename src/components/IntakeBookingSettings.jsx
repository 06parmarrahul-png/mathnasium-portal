// Owner settings for the native intake booking page. Saved into
// centerConfig.intakeSettings; the public booking page reads these
// (plus the centre name) via the availability endpoint.

import { useEffect, useMemo, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import {
  Save, ExternalLink, Plus, Trash2, Loader2, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { resolveInstructionalHours, isSummerOverrideActive } from '../lib/centerConfig';

const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const DEFAULTS = {
  enabled: false,
  slotDurationMin: 60,
  slotIntervalMin: 30,
  advanceNoticeHrs: 24,
  maxAdvanceDays: 60,
  timezone: 'America/Vancouver',
  // Off by default → booking hours follow centerConfig.instructionalHours.
  useCustomAvailability: false,
  availability: {
    Sunday: [], Monday: [], Tuesday: [], Wednesday: [],
    Thursday: [], Friday: [], Saturday: [],
  },
  headline:    'Book Your Free Math Skills Assessment Today!',
  subheadline: 'Book a 60-minute consultation to see how we can support your child. We\'ll assess their math skills, spot any gaps, and create a personalized learning plan!',
};

export default function IntakeBookingSettings({ activeCenterId, centerConfig }) {
  const initial = useMemo(
    () => ({ ...DEFAULTS, ...(centerConfig?.intakeSettings || {}), availability: {
      ...DEFAULTS.availability, ...((centerConfig?.intakeSettings || {}).availability || {}),
    } }),
    [centerConfig],
  );
  const [s, setS] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => { setS(initial); }, [initial]);

  const bookingUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/book/${activeCenterId}`
    : `/book/${activeCenterId}`;

  const save = async () => {
    setError(''); setSaving(true);
    try {
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { intakeSettings: { ...s, updatedAt: serverTimestamp() } },
        { merge: true },
      );
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const setField = (k, v) => setS(prev => ({ ...prev, [k]: v }));
  const setDayWindows = (day, windows) =>
    setS(prev => ({ ...prev, availability: { ...prev.availability, [day]: windows } }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Online Booking</h2>
          <p className="text-sm text-gray-500">
            Let parents book free assessments directly through Ratio — no third-party tool needed.
          </p>
        </div>
        <button onClick={save} disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
          {saving && <Loader2 size={14} className="animate-spin" />}
          <Save size={14} /> Save
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}
      {savedAt && !error && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 flex items-start gap-1.5">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          Saved at {savedAt.toLocaleTimeString()}.
        </div>
      )}

      {/* Enable toggle */}
      <Card>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" checked={!!s.enabled} onChange={e => setField('enabled', e.target.checked)}
            className="mt-1" />
          <div>
            <p className="text-sm font-semibold text-gray-900">Enable public booking page</p>
            <p className="text-xs text-gray-500 mt-0.5">
              When on, anyone with the link can book an assessment without logging in.
            </p>
          </div>
        </label>
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
          <p className="font-semibold text-gray-700">Public link</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="rounded bg-white border border-gray-200 px-2 py-1 text-[11px] text-gray-700 truncate">
              {bookingUrl}
            </code>
            <a href={bookingUrl} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50">
              Open <ExternalLink size={10} />
            </a>
          </div>
        </div>
      </Card>

      {/* Page copy */}
      <Card title="Booking page copy">
        <Field label="Headline">
          <input value={s.headline} onChange={e => setField('headline', e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </Field>
        <Field label="Sub-headline / description">
          <textarea rows={3} value={s.subheadline} onChange={e => setField('subheadline', e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </Field>
      </Card>

      {/* Slot math */}
      <Card title="Slot rules">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Appointment length (minutes)">
            <input type="number" min={15} max={240} value={s.slotDurationMin}
              onChange={e => setField('slotDurationMin', Math.max(15, parseInt(e.target.value, 10) || 60))}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Slot starts every (minutes)">
            <input type="number" min={5} max={120} value={s.slotIntervalMin}
              onChange={e => setField('slotIntervalMin', Math.max(5, parseInt(e.target.value, 10) || 30))}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Minimum advance notice (hours)">
            <input type="number" min={0} max={168} value={s.advanceNoticeHrs}
              onChange={e => setField('advanceNoticeHrs', Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Maximum days in advance">
            <input type="number" min={1} max={365} value={s.maxAdvanceDays}
              onChange={e => setField('maxAdvanceDays', Math.max(1, parseInt(e.target.value, 10) || 60))}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          </Field>
        </div>
      </Card>

      {/* Per-day availability — defaults to mirroring instructional hours
          so booking hours stay in sync with the centre's teaching window.
          Owner can flip the toggle to set custom intake-only hours. */}
      <Card title="Weekly availability">
        <label className="flex items-start gap-3 cursor-pointer mb-3">
          <input type="checkbox" checked={!s.useCustomAvailability}
            onChange={e => setField('useCustomAvailability', !e.target.checked)}
            className="mt-1" />
          <div>
            <p className="text-sm font-semibold text-gray-900">Sync booking hours with my centre&apos;s instructional hours</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Recommended. Edit instructional hours under Centre Settings → General and the booking page follows automatically.
            </p>
          </div>
        </label>

        {s.useCustomAvailability && (
          <>
            <p className="text-xs text-gray-500 mb-2">
              Custom override — one or more time windows per day. Leave a day empty to close it.
            </p>
            <div className="space-y-2">
              {WEEKDAYS.map(day => (
                <DayRow key={day} day={day}
                  windows={s.availability[day] || []}
                  onChange={w => setDayWindows(day, w)} />
              ))}
            </div>
          </>
        )}

        {!s.useCustomAvailability && centerConfig?.instructionalHours && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs">
            <p className="font-semibold text-gray-700 mb-1">
              Currently in effect (from instructional hours)
              {isSummerOverrideActive(centerConfig, new Date()) && (
                <span className="ml-1.5 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-semibold text-amber-800">
                  summer override active
                </span>
              )}:
            </p>
            <ul className="space-y-0.5">
              {WEEKDAYS.map(day => {
                // Resolve against today's date so an active summer
                // override is reflected in the "currently in effect" list.
                const h = resolveInstructionalHours(centerConfig, new Date())[day];
                return (
                  <li key={day} className="flex justify-between">
                    <span className="text-gray-700">{day}</span>
                    <span className="text-gray-500 tabular-nums">
                      {h?.start && h?.end ? `${h.start} – ${h.end}` : 'Closed'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      {title && <h3 className="text-sm font-semibold text-gray-900">{title}</h3>}
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-700 mb-1">{label}</span>
      {children}
    </label>
  );
}

function DayRow({ day, windows, onChange }) {
  const add = () => onChange([...(windows || []), { start: '09:00', end: '17:00' }]);
  const update = (i, field, value) => {
    const next = [...windows];
    next[i] = { ...next[i], [field]: value };
    onChange(next);
  };
  const remove = (i) => onChange(windows.filter((_, idx) => idx !== i));
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-semibold text-gray-700">{day}</p>
        <button type="button" onClick={add}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 hover:underline">
          <Plus size={11} /> Add window
        </button>
      </div>
      {windows.length === 0 && <p className="text-[11px] text-gray-400 italic">Closed.</p>}
      {windows.map((w, i) => (
        <div key={i} className="flex items-center gap-2 mt-1">
          <input type="time" value={w.start} onChange={e => update(i, 'start', e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-xs" />
          <span className="text-xs text-gray-400">–</span>
          <input type="time" value={w.end} onChange={e => update(i, 'end', e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-xs" />
          <button type="button" onClick={() => remove(i)}
            className="ml-auto rounded p-1 text-gray-400 hover:bg-rose-100 hover:text-rose-700">
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
