// Parent-facing public booking page. NO LOGIN required — parents land
// here from a marketing link, pick a slot, fill the form, submit.
//
// Route: /book/:centerId
//
// Mirrors the Apptoto flow the centre used previously:
//   - Mathnasium-red branded header
//   - Headline + sub copy (centre-configurable)
//   - Week-view slot grid (green = free, solid green = picked, dim = taken)
//   - Selected slot detail card
//   - Form: email, phone, guardian name, child name, child grade,
//           SMS opt-in checkbox with the exact Mathnasium compliance text
//   - Confirmation screen on success

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronUp, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { scrollToElement } from '../lib/smoothScroll';

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

/**
 * Mathnasium red, deepening toward the foot of the page.
 *
 * This replaced a flat `bg-red-600`, which is Tailwind's red — brighter
 * and more orange than the brand red the rest of the app uses for
 * identity (`--nl-brand` in index.css). Held at full saturation across a
 * whole viewport it made every white card edge buzz against it.
 *
 * The darkening is doing a second job: this page is a stack of white
 * cards on a coloured field, and a field that shifts underneath them
 * gives the stack somewhere to sit instead of floating on one flat wall.
 */
const PAGE_BG = 'bg-gradient-to-b from-[#C8102E] via-[#9B0C22] to-[#5E0714]';

/** The same red for the things you press, so the page holds one red. */
const BRAND_BTN = 'bg-[#C8102E] hover:bg-[#A80D26]';

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

  // Picking a slot reveals the form below the fold, and going back
  // hides it again. Both moves are the page changing under someone who
  // is looking somewhere else, so both get walked rather than jumped.
  // Skipped on first paint: nobody has picked anything yet.
  const gridRef = useRef(null);
  const formRef = useRef(null);
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) { settled.current = true; return undefined; }
    const el = selectedSlot ? formRef.current : gridRef.current;
    // Returned so a second pick mid-flight cancels the first trip
    // instead of two animations fighting over the scroll position.
    return scrollToElement(el);
  }, [selectedSlot]);

  if (confirmed) {
    return <ConfirmationScreen confirmed={confirmed} centre={data?.centre} timezone={data?.centre?.timezone} />;
  }

  return (
    <div className={`min-h-screen ${PAGE_BG}`}>
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
            <div ref={gridRef}>
              <SlotGrid
                data={data}
                timeRows={timeRows}
                weekStart={weekStart}
                onWeekStart={(d) => { setAutoAdvanced(false); setWeekStart(d); }}
                selectedSlot={selectedSlot}
                onSelectSlot={setSelectedSlot}
              />
            </div>

            {selectedSlot && (
              <div ref={formRef}>
                <BookingForm
                  centerId={centerId}
                  slot={selectedSlot}
                  durationMin={data.settings.slotDurationMin}
                  timezone={data.centre.timezone}
                  onChangeSlot={() => setSelectedSlot(null)}
                  onConfirmed={(payload) => setConfirmed(payload)}
                />
              </div>
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
                    {/* A day at the centre's daily limit has open hours and
                        no open slots, which otherwise looks exactly like a
                        day the centre is shut. Say which it is. */}
                    {d.dayFull && (
                      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                        Full
                      </div>
                    )}
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
                            ? 'bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-600/25'
                            : canPick
                              ? 'border border-emerald-300 bg-emerald-50 text-emerald-800 hover:border-emerald-500 hover:bg-emerald-100'
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
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-gray-100 px-4 py-2.5 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-4 rounded border border-emerald-300 bg-emerald-50" />
          Available
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-4 rounded bg-emerald-600" />
          Your pick
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="text-gray-300">—</span> Not available
        </span>
        <span className="text-gray-400">
          Times shown in {data.centre.timezone || 'your local time'}.
        </span>
      </div>
    </div>
  );
}

function BookingForm({ centerId, slot, durationMin, timezone, onChangeSlot, onConfirmed }) {
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
      {/* The way back rides WITH the time it changes, at the top of the
          form where a reader checking "is this the right slot?" is
          already looking. There is a second one down by Book Now, for
          anyone who only notices the wrong time on their way out. */}
      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-sm flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-gray-500">Selected slot</p>
          <p className="font-semibold text-gray-900">{fmtConfirmTime(slot, timezone)}</p>
          <p className="text-xs text-gray-500 mt-0.5">{durationMin} minutes · {timezone}</p>
        </div>
        <button type="button" onClick={onChangeSlot}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:border-gray-400 hover:bg-gray-50">
          <ChevronUp size={13} /> Change time slot
        </button>
      </div>

      <Field label="Email" required>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)}
          required autoComplete="email"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Phone Number" required>
        <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
          required autoComplete="tel"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Guardian's Name" required>
        <input type="text" value={guardianName} onChange={e => setGuardianName(e.target.value)}
          required autoComplete="name"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Child's Name" required>
        <input type="text" value={childName} onChange={e => setChildName(e.target.value)}
          required
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200" />
      </Field>
      <Field label="Child's Grade" required>
        <select value={childGrade} onChange={e => setChildGrade(e.target.value)}
          required
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-200">
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
        <button type="button" onClick={onChangeSlot} disabled={submitting}
          className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700">
          Change time slot
        </button>
        <button type="submit" disabled={!ready || submitting}
          className={`inline-flex items-center gap-1.5 rounded-lg ${BRAND_BTN} px-5 py-2 text-sm font-semibold text-white disabled:opacity-50`}>
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
    <div className={`min-h-screen ${PAGE_BG} flex items-center justify-center px-4 py-12`}>
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
