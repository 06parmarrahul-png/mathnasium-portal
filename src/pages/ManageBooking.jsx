// The page a family lands on from their reminder or confirmation email.
//
// Route: /booking/:intakeId?k=<token>   — one booking, theirs
//        /booking                       — "email me my link"
//
// NO LOGIN. A parent has a text message and an email, not an account, so
// the token in the link is the credential: it names one booking and
// grants nothing else. See src/lib/manageBooking.js for the rules and
// api/intakes.js for the endpoint.
//
// Three things they can do, which is the whole page: confirm they are
// coming, move it, or cancel. Rescheduling shows the same free slots the
// booking page offers, because it is the same availability engine.
//
// ASSESSMENTS ONLY. Sessions come from Acuity one way and Ratio cannot
// write one back, so there is nothing here that pretends to move one.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, AlertTriangle, CalendarClock, X } from 'lucide-react';

const PAGE_BG = 'bg-gradient-to-b from-[#C8102E] via-[#9B0C22] to-[#5E0714]';

function fmtWhen(iso, tz) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: tz || undefined,
    });
  } catch { return iso; }
}

const sundayOf = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function Shell({ children }) {
  return (
    <div className={`min-h-screen ${PAGE_BG} px-4 py-10`}>
      <div className="mx-auto w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        {children}
      </div>
    </div>
  );
}

/** With no booking id: the way in for somebody holding only the SMS. */
function FindBooking() {
  const [email, setEmail] = useState('');
  const [centerId, setCenterId] = useState('langley');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      await fetch('/api/intakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send-link', centerId, email }),
      });
    } catch { /* the message below is the same either way */ }
    setBusy(false);
    setSent(true);
  };

  if (sent) {
    return (
      <Shell>
        <CheckCircle2 size={28} className="mb-3 text-emerald-600" />
        <h1 className="text-xl font-bold text-gray-900">Check your email</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          If we have a booking under that address, the link to it is on its way.
          It opens your assessment so you can confirm, move or cancel it.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <CalendarClock size={28} className="mb-3 text-[#C8102E]" />
      <h1 className="text-xl font-bold text-gray-900">Find your assessment</h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">
        Pop in the email you booked with and we&rsquo;ll send you the link to it.
      </p>
      <input
        type="email" value={email} onChange={e => setEmail(e.target.value)}
        placeholder="you@example.com" aria-label="Your email"
        className="mt-4 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-[#C8102E] focus:outline-none"
      />
      <input type="hidden" value={centerId} onChange={e => setCenterId(e.target.value)} />
      <button
        onClick={send} disabled={busy || !email.includes('@')}
        className="mt-3 w-full rounded-lg bg-[#C8102E] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
      >
        {busy ? 'Sending…' : 'Email me the link'}
      </button>
    </Shell>
  );
}

export default function ManageBooking() {
  const { intakeId } = useParams();
  const [params] = useSearchParams();
  const token = params.get('k') || '';

  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState('');
  const [picking, setPicking] = useState(false);
  const [week, setWeek] = useState(() => sundayOf(new Date()));
  const [days, setDays] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/intakes?action=booking&id=${encodeURIComponent(intakeId)}&k=${encodeURIComponent(token)}`);
      const body = await r.json();
      if (!r.ok || !body.ok) throw new Error(body.error || 'We couldn’t open that booking.');
      setState({ loading: false, ...body });
    } catch (e) {
      setState({ loading: false, error: e.message });
    }
  }, [intakeId, token]);

  useEffect(() => { load(); }, [load]);

  // Free slots, from the same endpoint the booking page uses.
  useEffect(() => {
    if (!picking || !state.booking?.centerId) return undefined;
    let gone = false;
    (async () => {
      const r = await fetch(`/api/intakes?centerId=${state.booking.centerId}&weekStart=${ymd(week)}`);
      const body = await r.json().catch(() => ({}));
      if (!gone) setDays(body.days || []);
    })();
    return () => { gone = true; };
  }, [picking, week, state.booking?.centerId]);

  const act = async (action, slot) => {
    setBusy(action);
    try {
      const r = await fetch('/api/intakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: intakeId, token, slot }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) throw new Error(body.error || 'That didn’t work.');
      setDone(action);
      setPicking(false);
      await load();
    } catch (e) {
      setState(s => ({ ...s, error: e.message }));
    } finally {
      setBusy('');
    }
  };

  if (!intakeId) return <FindBooking />;

  if (state.loading) {
    return <Shell><Loader2 className="animate-spin text-gray-400" /></Shell>;
  }

  if (state.error && !state.booking) {
    return (
      <Shell>
        <AlertTriangle size={26} className="mb-3 text-amber-500" />
        <h1 className="text-xl font-bold text-gray-900">We couldn&rsquo;t open that</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">{state.error}</p>
      </Shell>
    );
  }

  const { booking, centre, canChange, reason } = state;
  const cancelled = booking.status === 'cancelled';

  return (
    <Shell>
      <p className="text-xs font-bold uppercase tracking-widest text-[#C8102E]">{centre?.name}</p>
      <h1 className="mt-1 text-xl font-bold text-gray-900">
        {cancelled ? 'This assessment is cancelled' : `${booking.childName}’s assessment`}
      </h1>

      <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
        <p className={`text-base font-semibold ${cancelled ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
          {fmtWhen(booking.slot, centre?.timezone)}
        </p>
        {booking.durationMin && !cancelled && (
          <p className="mt-0.5 text-sm text-gray-500">{booking.durationMin} minutes</p>
        )}
        {booking.status === 'confirmed' && (
          <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
            <CheckCircle2 size={15} /> You&rsquo;ve confirmed this
          </p>
        )}
      </div>

      {done && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
          {done === 'cancel' ? 'Cancelled — thanks for letting us know.'
            : done === 'reschedule' ? 'Moved. We’ve sent the centre a note.'
            : 'Thanks — see you then!'}
        </p>
      )}
      {state.error && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">{state.error}</p>
      )}

      {!canChange && !cancelled && (
        <p className="mt-3 text-sm leading-relaxed text-gray-600">{reason}</p>
      )}

      {/* Confirming stays open right up to the appointment — "yes, we're
          coming" is useful at any hour and changes nothing anybody has to
          act on. Moving and cancelling close two hours before. */}
      {!cancelled && booking.status !== 'confirmed' && (
        <button
          onClick={() => act('confirm')} disabled={!!busy}
          className="mt-4 w-full rounded-lg bg-[#C8102E] px-4 py-3 text-sm font-bold text-white disabled:opacity-50"
        >
          {busy === 'confirm' ? 'Confirming…' : 'Yes, we’ll be there'}
        </button>
      )}

      {canChange && !picking && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <button
            onClick={() => setPicking(true)} disabled={!!busy}
            className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Pick another time
          </button>
          <button
            onClick={() => act('cancel')} disabled={!!busy}
            className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel it'}
          </button>
        </div>
      )}

      {picking && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Pick a new time</p>
            <button onClick={() => setPicking(false)} aria-label="Stop picking a new time"
              className="rounded p-1 text-gray-400 hover:bg-gray-100"><X size={16} /></button>
          </div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <button onClick={() => setWeek(w => new Date(w.getTime() - 7 * 864e5))}
              className="rounded px-2 py-1 font-semibold text-gray-600 hover:bg-gray-100">← Earlier</button>
            <button onClick={() => setWeek(w => new Date(w.getTime() + 7 * 864e5))}
              className="rounded px-2 py-1 font-semibold text-gray-600 hover:bg-gray-100">Later →</button>
          </div>
          {days === null ? (
            <Loader2 className="animate-spin text-gray-400" />
          ) : (
            <div className="max-h-72 space-y-3 overflow-y-auto">
              {days.filter(d => d.slots?.some(s => s.available)).map(day => (
                <div key={day.date}>
                  <p className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-500">{day.label || day.date}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {day.slots.filter(s => s.available).map(s => (
                      <button key={s.startISO} onClick={() => act('reschedule', s.startISO)} disabled={!!busy}
                        className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50">
                        {fmtWhen(s.startISO, centre?.timezone).split(', ').pop()}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {days.every(d => !d.slots?.some(s => s.available)) && (
                <p className="text-sm text-gray-500">Nothing free that week — try Later.</p>
              )}
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}
