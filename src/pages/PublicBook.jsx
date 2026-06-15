// Parent-facing public booking page. NO LOGIN required — parents land
// here from a marketing link, pick a slot, fill the form, submit.
//
// Route: /book/:centerId
//
// Mirrors the Apptoto flow the centre used previously:
//   - Mathnasium-red branded header
//   - Headline + sub copy (centre-configurable)
//   - Week-view slot grid (yellow highlight = available, dim = closed/taken)
//   - Selected slot detail card
//   - Form: email, phone, guardian name, child name, child grade,
//           SMS opt-in checkbox with the exact Mathnasium compliance text
//   - Confirmation screen on success

import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';

const GRADE_OPTIONS = [
  'Pre-K', 'Kindergarten',
  'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5',
  'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 10',
  'Grade 11', 'Grade 12',
  'Adult / Other',
];

// Mathnasium's standard SMS opt-in disclaimer — pulled verbatim from
// their Apptoto flow so we keep the same compliance posture.
const SMS_DISCLAIMER = `By checking this box, you agree to receive recurring advertising text messages from Mathnasium about promotions and our learning center offerings to the phone number provided above, including texts placed using an automatic telephone dialing system. Consent to receive advertising text messages is not required to purchase goods or services. Message frequency varies. Message and data rates may apply. Reply "STOP" to no longer receive messages. Email SMS@mathnasium.com, or text "HELP", for assistance. Information you provide will be held in accordance with our Privacy Policy.`;

function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function sundayOf(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtDayHeader(d) {
  return {
    wd: d.toLocaleDateString('en-US', { weekday: 'short' }),
    md: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  };
}
function fmtConfirmTime(iso, tz) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: tz || undefined,
  });
}

export default function PublicBook() {
  const { centerId } = useParams();
  const [weekStart, setWeekStart] = useState(() => sundayOf(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Set true once we've auto-skipped past empty current week(s) — drives
  // a tiny banner so the parent isn't confused why the visible week
  // doesn't match "this week".
  const [autoAdvanced, setAutoAdvanced] = useState(false);

  const [selectedSlot, setSelectedSlot] = useState(null); // ISO string
  const [confirmed, setConfirmed] = useState(null);       // { slot, durationMin, name }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError('');
      try {
        const r = await fetch(`/api/intakes?centerId=${encodeURIComponent(centerId)}&weekStart=${ymdLocal(weekStart)}`);
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`);
        if (!cancelled) setData(body);

        // Auto-advance past empty weeks so the parent lands on the first
        // bookable week instead of staring at a dimmed grid. Hard cap of
        // 8 weeks so we don't loop forever if the centre has no slots
        // configured at all.
        if (!cancelled && body?.settings?.enabled) {
          const anyAvailable = (body.days || []).some(d => d.slots.some(s => s.available));
          const weeksAhead = Math.round((weekStart - sundayOf(new Date())) / (7 * 24 * 3600 * 1000));
          if (!anyAvailable && weeksAhead < 8) {
            setAutoAdvanced(true);
            setWeekStart(prev => addDays(prev, 7));
          }
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [centerId, weekStart]);

  // Unique time-row labels for the grid: union of every label that
  // appears across the 7 days, sorted chronologically.
  const timeRows = useMemo(() => {
    if (!data?.days) return [];
    const seen = new Map(); // label -> minutes-since-midnight (for sort)
    for (const day of data.days) {
      for (const s of day.slots) {
        if (!seen.has(s.label)) {
          const m = new Date(s.startISO).getHours() * 60 + new Date(s.startISO).getMinutes();
          seen.set(s.label, m);
        }
      }
    }
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);
  }, [data]);

  if (confirmed) {
    return <ConfirmationScreen confirmed={confirmed} centre={data?.centre} timezone={data?.centre?.timezone} />;
  }

  return (
    <div className="min-h-screen bg-red-600">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:py-12">
        <div className="rounded-2xl bg-black p-6 sm:p-10 text-white text-center mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold">
            {data?.settings?.headline || 'Book Your Free Math Skills Assessment Today!'}
          </h1>
          <p className="mt-2 text-sm sm:text-base font-semibold underline underline-offset-4">
            {data?.centre?.name || 'Mathnasium'}
          </p>
          {data?.settings?.subheadline && (
            <p className="mt-4 text-sm sm:text-base text-white/85 leading-relaxed">
              {data.settings.subheadline}
            </p>
          )}
        </div>

        {loading && (
          <div className="rounded-2xl bg-white p-10 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin" /> Loading availability…
          </div>
        )}

        {error && (
          <div className="rounded-2xl bg-white p-6 border border-rose-200">
            <div className="flex items-start gap-2 text-sm text-rose-800">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">Couldn&apos;t load the booking page.</p>
                <p className="mt-1 text-rose-700/90">{error}</p>
              </div>
            </div>
          </div>
        )}

        {data && !data.settings.enabled && (
          <div className="rounded-2xl bg-white p-10 text-center">
            <p className="text-sm text-gray-700">
              Online booking isn&apos;t enabled for this centre yet. Please call or email us to schedule.
            </p>
          </div>
        )}

        {data && data.settings.enabled && (
          <>
            {autoAdvanced && (
              <p className="mb-2 text-center text-xs text-white/85">
                Showing the earliest week with available times.
              </p>
            )}
            <SlotGrid
              data={data}
              timeRows={timeRows}
              weekStart={weekStart}
              onWeekStart={(d) => { setAutoAdvanced(false); setWeekStart(d); }}
              selectedSlot={selectedSlot}
              onSelectSlot={setSelectedSlot}
            />

            {selectedSlot && (
              <BookingForm
                centerId={centerId}
                slot={selectedSlot}
                durationMin={data.settings.slotDurationMin}
                timezone={data.centre.timezone}
                onCancel={() => setSelectedSlot(null)}
                onConfirmed={(payload) => setConfirmed(payload)}
              />
            )}
          </>
        )}
      </div>

      <footer className="text-center text-xs text-white/70 pb-6">
        Powered by <Link to="/" className="underline hover:text-white">Ratio</Link>
      </footer>
    </div>
  );
}

function SlotGrid({ data, timeRows, weekStart, onWeekStart, selectedSlot, onSelectSlot }) {
  const days = data.days;
  return (
    <div className="rounded-2xl bg-white shadow-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <button
          onClick={() => onWeekStart(addDays(weekStart, -7))}
          className="rounded-full p-2 text-gray-500 hover:bg-gray-100"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="text-sm font-semibold text-gray-700">
          Week of {weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
        </div>
        <button
          onClick={() => onWeekStart(addDays(weekStart, 7))}
          className="rounded-full p-2 text-gray-500 hover:bg-gray-100"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {/* Time-label column header — kept empty since the row
                  labels speak for themselves. CRITICAL: count must match
                  the body row's cells (1 + 7) so columns align. */}
              <th className="px-2 py-3 w-16" />
              {days.map(d => {
                const date = new Date(d.date + 'T12:00:00');
                const h = fmtDayHeader(date);
                return (
                  <th key={d.date} className="px-2 py-3 text-center font-semibold text-gray-700">
                    <div className="text-xs">{h.wd}</div>
                    <div className="text-xs text-gray-500">{h.md}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {timeRows.map(label => (
              <tr key={label} className="border-t border-gray-100">
                {/* Leading time-label cell — matches the empty thead
                    column so the 7 day cells below align with their
                    matching column headers. */}
                <td className="px-2 py-1 text-xs font-medium text-gray-500 whitespace-nowrap tabular-nums">
                  {label}
                </td>
                {days.map(d => {
                  const slot = d.slots.find(s => s.label === label);
                  if (!slot) {
                    return <td key={d.date} className="px-2 py-2 text-center text-xs text-gray-300">—</td>;
                  }
                  const isSel = selectedSlot === slot.startISO;
                  const canPick = slot.available;
                  return (
                    <td key={d.date} className="px-1 py-1 text-center">
                      <button
                        type="button"
                        disabled={!canPick}
                        onClick={() => onSelectSlot(slot.startISO)}
                        className={[
                          'w-full rounded px-2 py-1.5 text-xs font-medium transition-colors',
                          isSel
                            ? 'bg-red-600 text-white'
                            : canPick
                              ? 'bg-yellow-300 text-gray-900 hover:bg-yellow-400'
                              : 'text-gray-300 cursor-not-allowed',
                        ].join(' ')}
                      >
                        {slot.label}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[11px] text-gray-400 text-center">
        Times shown in {data.centre.timezone || 'your local time'}.
      </p>
    </div>
  );
}

function BookingForm({ centerId, slot, durationMin, timezone, onCancel, onConfirmed }) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [childName, setChildName] = useState('');
  const [childGrade, setChildGrade] = useState('');
  const [childSchool, setChildSchool] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const ready = email && phone && guardianName && childName && childGrade;

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setSubmitting(true);
    try {
      const r = await fetch('/api/intakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          centerId, slot, email, phone, guardianName, childName, childGrade,
          childSchool, smsOptIn, notes,
        }),
      });
      const body = await r.json();
      if (!body.ok) throw new Error(body.error || `Failed (${r.status})`);
      onConfirmed({
        slot: body.slot,
        durationMin: body.durationMin,
        guardianName, childName,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-6 rounded-2xl bg-white shadow-lg p-5 sm:p-8 space-y-4">
      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-sm">
        <p className="text-gray-500">Selected slot</p>
        <p className="font-semibold text-gray-900">{fmtConfirmTime(slot, timezone)}</p>
        <p className="text-xs text-gray-500 mt-0.5">{durationMin} minutes · {timezone}</p>
      </div>

      <Field label="Email" required>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
          required autoComplete="email"
          className="w-full rounded border border-red-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Phone Number" required>
        <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
          required autoComplete="tel"
          className="w-full rounded border border-red-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Guardian's Name" required>
        <input type="text" value={guardianName} onChange={e => setGuardianName(e.target.value)}
          required autoComplete="name"
          className="w-full rounded border border-red-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Child's Name" required>
        <input type="text" value={childName} onChange={e => setChildName(e.target.value)}
          required
          className="w-full rounded border border-red-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Child's Grade" required>
        <select value={childGrade} onChange={e => setChildGrade(e.target.value)}
          required
          className="w-full rounded border border-red-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200">
          <option value="">Select grade…</option>
          {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
      </Field>
      <Field label="Child's School (optional)">
        <input type="text" value={childSchool} onChange={e => setChildSchool(e.target.value)}
          placeholder="e.g. Langley Fundamental Elementary"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Anything we should know? (optional)">
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>

      <label className="flex items-start gap-2 text-xs text-gray-600 leading-relaxed cursor-pointer">
        <input type="checkbox" checked={smsOptIn} onChange={e => setSmsOptIn(e.target.checked)}
          className="mt-0.5" />
        <span>{SMS_DISCLAIMER}</span>
      </label>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} disabled={submitting}
          className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">
          Cancel
        </button>
        <button type="submit" disabled={!ready || submitting}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
          {submitting && <Loader2 size={14} className="animate-spin" />}
          Book Now
        </button>
      </div>
    </form>
  );
}

function Field({ label, required, children }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">
        {label}{required && <span className="text-red-600"> *</span>}
      </span>
      {children}
    </label>
  );
}

function ConfirmationScreen({ confirmed, centre, timezone }) {
  return (
    <div className="min-h-screen bg-red-600 flex items-center justify-center px-4 py-12">
      <div className="max-w-md w-full rounded-2xl bg-white shadow-xl p-8 text-center">
        <div className="mx-auto rounded-full bg-emerald-100 p-3 w-fit mb-4">
          <CheckCircle2 size={36} className="text-emerald-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">You&apos;re booked!</h1>
        <p className="mt-2 text-sm text-gray-600">
          We&apos;ve sent a confirmation email with the details. Looking forward to seeing {confirmed.childName} at {centre?.name || 'Mathnasium'}.
        </p>
        <div className="mt-5 rounded-lg bg-gray-50 border border-gray-200 p-4 text-left">
          <p className="text-xs text-gray-500">Appointment</p>
          <p className="font-semibold text-gray-900 mt-0.5">{fmtConfirmTime(confirmed.slot, timezone)}</p>
          <p className="text-xs text-gray-500 mt-0.5">{confirmed.durationMin} minutes</p>
        </div>
        <p className="mt-5 text-xs text-gray-400">
          Need to reschedule? Just reply to the confirmation email.
        </p>
      </div>
    </div>
  );
}
