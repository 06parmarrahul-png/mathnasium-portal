// Apptoto Appointments card — drops into Centre Analytics. Reads the
// per-centre connector flag, fetches the next 14 days of events via the
// /api/apptoto/events server proxy, and surfaces three counters:
//
//   - Today
//   - This week (Sun–Sat)
//   - Assessments / intakes in the next 14 days (keyword match on title)
//
// Plus an upcoming list (next 5 events). If Apptoto isn't connected,
// shows a CTA pointing to Centre Settings → Connections.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { fetchApptotoEvents } from '../lib/integrations/apptoto';
import {
  CalendarCheck, Plug, Loader2, AlertTriangle, ExternalLink,
} from 'lucide-react';

// Apptoto's /events response field names aren't 100% uniform — older
// integrations have surfaced { start_time, title } while newer payloads
// use { datetime, calendar_event_name }. Read whichever's there.
const pickStart = (e) =>
  e?.start_time || e?.datetime || e?.start || e?.startTime || null;
const pickTitle = (e) =>
  e?.title || e?.calendar_event_name || e?.name || e?.summary || '(untitled)';
const pickContact = (e) =>
  e?.contact_name
  || (e?.contact && (e.contact.name || `${e.contact.first_name || ''} ${e.contact.last_name || ''}`.trim()))
  || e?.attendee_name || '';

const ASSESSMENT_RE = /\b(assess|intake|consult|trial|new\s*student|tour)\b/i;

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}
function endOfWeek(d) {
  const x = startOfWeek(d);
  x.setDate(x.getDate() + 7);
  return x;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default function ApptotoAppointmentsCard() {
  const { activeCenterId } = useAuth();
  const [connected, setConnected] = useState(null); // null = loading
  const [events, setEvents] = useState(null);       // null = loading; [] = empty
  const [error, setError] = useState('');

  // Watch the centre's connector flag so the card flips state in real time
  // if the owner connects/disconnects from another tab.
  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      doc(db, 'centers', activeCenterId, 'connectors', 'apptoto'),
      snap => setConnected(!!snap.data()?.connected),
      () => setConnected(false),
    );
  }, [activeCenterId]);

  // Fetch the next 14 days once we know it's connected.
  useEffect(() => {
    if (!activeCenterId || !connected) return;
    let cancelled = false;
    (async () => {
      setError(''); setEvents(null);
      try {
        const start = new Date();
        const end   = new Date(Date.now() + 14 * 24 * 3600 * 1000);
        const r = await fetchApptotoEvents(activeCenterId, {
          start: start.toISOString(), end: end.toISOString(),
        });
        if (!cancelled) setEvents(r.events || []);
      } catch (e) {
        if (!cancelled) { setError(e.message); setEvents([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [activeCenterId, connected]);

  const counts = useMemo(() => {
    if (!Array.isArray(events)) return { today: 0, week: 0, assessments: 0, upcoming: [] };
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const weekStart = startOfWeek(now);
    const weekEnd   = endOfWeek(now);
    let today = 0, week = 0, assessments = 0;
    const upcoming = [];
    for (const ev of events) {
      const startISO = pickStart(ev);
      if (!startISO) continue;
      const d = new Date(startISO);
      const isToday = d.toISOString().slice(0, 10) === todayStr;
      if (isToday) today++;
      if (d >= weekStart && d < weekEnd) week++;
      if (ASSESSMENT_RE.test(pickTitle(ev) || '')) assessments++;
      if (d >= now) upcoming.push({ when: startISO, title: pickTitle(ev), contact: pickContact(ev) });
    }
    upcoming.sort((a, b) => a.when.localeCompare(b.when));
    return { today, week, assessments, upcoming: upcoming.slice(0, 5) };
  }, [events]);

  // ── States ──────────────────────────────────────────────────────────
  if (connected === null) {
    return (
      <Frame>
        <div className="py-6 text-center text-sm text-gray-400 flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Checking Apptoto…
        </div>
      </Frame>
    );
  }

  if (!connected) {
    return (
      <Frame>
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center">
          <Plug size={18} className="mx-auto text-gray-400 mb-2" />
          <p className="text-sm font-medium text-gray-700">Apptoto not connected</p>
          <p className="mt-1 text-xs text-gray-500">
            Connect to pull intake meetings & assessments into this dashboard.
          </p>
          <Link
            to="/center-settings?tab=connections"
            className="mt-3 inline-flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700"
          >
            Connect Apptoto <ExternalLink size={11} />
          </Link>
        </div>
      </Frame>
    );
  }

  if (events === null) {
    return (
      <Frame>
        <div className="py-6 text-center text-sm text-gray-400 flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading appointments…
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      {error && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3 mb-4">
        <StatTile label="Today"               value={counts.today}       sub="scheduled" />
        <StatTile label="This week"           value={counts.week}        sub="Sun–Sat"   />
        <StatTile label="Assessments / intakes" value={counts.assessments} sub="next 14 days" tone="purple" />
      </div>

      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">Next up</p>
        {counts.upcoming.length === 0 ? (
          <p className="text-xs text-gray-500 italic">Nothing scheduled in the next 14 days.</p>
        ) : (
          <ul className="space-y-1.5">
            {counts.upcoming.map((u, i) => (
              <li key={i} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-800">{u.title}</p>
                  {u.contact && <p className="text-xs text-gray-500 truncate">{u.contact}</p>}
                </div>
                <span className="text-xs text-gray-500 whitespace-nowrap shrink-0">{fmtTime(u.when)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Frame>
  );
}

function Frame({ children }) {
  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="rounded-lg bg-purple-100 p-1.5 text-purple-700"><CalendarCheck size={14} /></div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Apptoto Appointments</h3>
          <p className="text-[11px] text-gray-500">Intake meetings & assessments — live from Apptoto.</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function StatTile({ label, value, sub, tone }) {
  const cls = tone === 'purple'
    ? 'border-purple-200 bg-purple-50 text-purple-900'
    : 'border-gray-200 bg-gray-50 text-gray-900';
  return (
    <div className={`rounded-xl border px-4 py-3 ${cls}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-0.5 text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-[11px] text-gray-500">{sub}</p>
    </div>
  );
}
