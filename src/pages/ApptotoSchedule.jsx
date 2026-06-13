// Full Apptoto schedule view — grouped by day, with intake-only filter
// and contact details inline. Mirrors what the user sees in Apptoto's
// own inbox, rendered inside Ratio so it's reachable from the analytics
// dashboard without context-switching.
//
// Route: /apptoto (also linked from the Apptoto analytics card).
// Visibility: owner / admin assistant / super_admin only — same gate as
// the rest of Centre Settings.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { fetchApptotoEvents } from '../lib/integrations/apptoto';
import {
  CalendarCheck, ChevronLeft, ChevronRight, Loader2, AlertTriangle,
  Mail, Phone, User, ShieldAlert, RefreshCw, Plug, ExternalLink,
} from 'lucide-react';

// Same field-name fallbacks as ApptotoAppointmentsCard. Hoisted here so
// this page can read events without depending on the card.
const START_KEYS = [
  'start_time', 'start_date', 'start', 'startTime', 'starts_at', 'startsAt',
  'dt_start', 'dtstart', 'event_start', 'calendar_event_start', 'time_start',
  'datetime', 'at', 'when',
];
const END_KEYS = [
  'end_time', 'end_date', 'end', 'endTime', 'ends_at', 'endsAt',
  'dt_end', 'dtend', 'event_end', 'calendar_event_end',
];
const TITLE_KEYS = [
  'title', 'calendar_event_name', 'name', 'summary', 'subject',
  'event_title', 'appointment_type',
];
const pickFromKeys = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) if (obj[k]) return obj[k];
  return null;
};
const pickStart = (e) =>
  pickFromKeys(e, START_KEYS) || pickFromKeys(e?.calendar_event, START_KEYS) || pickFromKeys(e?.time, START_KEYS);
const pickEnd = (e) =>
  pickFromKeys(e, END_KEYS) || pickFromKeys(e?.calendar_event, END_KEYS) || pickFromKeys(e?.time, END_KEYS);
const pickTitle = (e) =>
  pickFromKeys(e, TITLE_KEYS) || pickFromKeys(e?.calendar_event, TITLE_KEYS) || '(untitled)';

function pickContact(e) {
  if (!e) return { name: '', email: '', phone: '' };
  const c = e.contact
    || e.address_book_contact
    || (Array.isArray(e.participants) && e.participants[0])
    || {};
  const name = e.contact_name || e.client_name || c.name
    || `${c.first_name || ''} ${c.last_name || ''}`.trim();
  return {
    name: name || '',
    email: c.email || e.email || '',
    phone: c.phone || c.mobile_phone || e.phone || '',
  };
}

const INTAKE_RE = /\b(assess|intake|consult|trial|new\s*student|tour|appointment\s*booked|booked)\b/i;

function fmtDayHeader(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function ApptotoSchedule() {
  const { activeCenterId, canSeeCenterSettings } = useAuth();
  const [connected, setConnected] = useState(null);
  const [events, setEvents]   = useState(null);
  const [error,  setError]    = useState('');
  const [filter, setFilter]   = useState('all'); // 'all' | 'intakes' | 'other'
  // 14-day windows; user pages forward/back through them.
  const [offsetDays, setOffsetDays] = useState(0);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      doc(db, 'centers', activeCenterId, 'connectors', 'apptoto'),
      snap => setConnected(!!snap.data()?.connected),
      () => setConnected(false),
    );
  }, [activeCenterId]);

  const [upstreamMeta, setUpstreamMeta] = useState(null);
  const load = async () => {
    if (!activeCenterId || !connected) return;
    setError(''); setEvents(null); setUpstreamMeta(null);
    try {
      const start = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() + 14 * 24 * 3600 * 1000);
      const r = await fetchApptotoEvents(activeCenterId, {
        start: start.toISOString(), end: end.toISOString(),
      });
      setEvents(r.events || []);
      setUpstreamMeta({ upstreamCount: r.upstreamCount, count: r.count });
    } catch (e) {
      setError(e.message); setEvents([]);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [activeCenterId, connected, offsetDays]);

  // Group + filter the events into a day-keyed map for the render pass.
  const groups = useMemo(() => {
    if (!Array.isArray(events)) return [];
    const filtered = events.filter(ev => {
      const t = pickTitle(ev);
      const hit = INTAKE_RE.test(t || '');
      if (filter === 'intakes') return hit;
      if (filter === 'other')   return !hit;
      return true;
    });
    const byDay = new Map();
    for (const ev of filtered) {
      const startISO = pickStart(ev);
      if (!startISO) continue;
      const d = new Date(startISO);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!byDay.has(key)) byDay.set(key, { date: d, items: [] });
      const contact = pickContact(ev);
      byDay.get(key).items.push({
        start: startISO, end: pickEnd(ev),
        title: pickTitle(ev), contact,
        isIntake: INTAKE_RE.test(pickTitle(ev) || ''),
      });
    }
    return [...byDay.values()]
      .sort((a, b) => a.date - b.date)
      .map(g => ({ ...g, items: g.items.sort((a, b) => a.start.localeCompare(b.start)) }));
  }, [events, filter]);

  const totalShown = groups.reduce((n, g) => n + g.items.length, 0);

  if (!canSeeCenterSettings) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Apptoto Schedule is owner / Enterprise only.</p>
      </div>
    );
  }

  const windowStart = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  const windowEnd   = new Date(windowStart.getTime() + 14 * 24 * 3600 * 1000);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="rounded-xl bg-purple-100 p-2.5 text-purple-700"><CalendarCheck size={22} /></div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Apptoto Schedule</h1>
          <p className="text-sm text-gray-500">
            Live appointments from Apptoto — grouped by day, with contact details.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={!connected || events === null}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </header>

      {connected === false && (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center">
          <Plug size={20} className="mx-auto text-gray-400 mb-2" />
          <p className="text-sm font-medium text-gray-700">Apptoto isn&apos;t connected for this centre.</p>
          <Link
            to="/center-settings?tab=connections"
            className="mt-3 inline-flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700"
          >
            Open Connections <ExternalLink size={11} />
          </Link>
        </div>
      )}

      {connected && (
        <>
          {/* Window pager + filter pills */}
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white">
              <button
                type="button"
                onClick={() => setOffsetDays(o => o - 14)}
                className="rounded-l-lg px-2 py-1.5 text-gray-600 hover:bg-gray-50"
              >
                <ChevronLeft size={14} />
              </button>
              <div className="px-3 py-1.5 text-xs font-semibold text-gray-700 tabular-nums">
                {windowStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                {' – '}
                {windowEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
              <button
                type="button"
                onClick={() => setOffsetDays(o => o + 14)}
                className="rounded-r-lg px-2 py-1.5 text-gray-600 hover:bg-gray-50"
              >
                <ChevronRight size={14} />
              </button>
              {offsetDays !== 0 && (
                <button
                  type="button"
                  onClick={() => setOffsetDays(0)}
                  className="ml-1 px-2 py-1.5 text-xs font-medium text-purple-700 hover:underline"
                >
                  Today
                </button>
              )}
            </div>

            <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
              {[
                { k: 'all',     label: 'All' },
                { k: 'intakes', label: 'Intakes / assessments' },
                { k: 'other',   label: 'Other' },
              ].map(p => (
                <button
                  key={p.k}
                  type="button"
                  onClick={() => setFilter(p.k)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                    filter === p.k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}

          {events === null ? (
            <div className="py-16 text-center text-sm text-gray-400 flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Loading appointments…
            </div>
          ) : groups.length === 0 ? (
            <div className="rounded-2xl border border-gray-200 bg-white py-12 text-center text-sm text-gray-500">
              <p>No appointments in this window.</p>
              {upstreamMeta && upstreamMeta.upstreamCount > 0 && (
                <p className="mt-2 text-xs text-gray-400">
                  Apptoto returned {upstreamMeta.upstreamCount} event{upstreamMeta.upstreamCount === 1 ? '' : 's'},
                  but none fell inside this 14-day window. Page back to find them.
                </p>
              )}
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500">
                Showing <strong className="text-gray-700">{totalShown}</strong> appointment{totalShown === 1 ? '' : 's'} across {groups.length} day{groups.length === 1 ? '' : 's'}.
              </p>
              <div className="space-y-3">
                {groups.map(g => (
                  <DayBlock key={g.date.toISOString()} group={g} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function DayBlock({ group }) {
  return (
    <section className="rounded-2xl border bg-white shadow-sm overflow-hidden">
      <header className="bg-gray-50 px-4 py-2 border-b">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-600">
          {fmtDayHeader(group.date)}
          <span className="ml-2 text-gray-400 normal-case font-medium tracking-normal">
            · {group.items.length} appointment{group.items.length === 1 ? '' : 's'}
          </span>
        </h3>
      </header>
      <ul className="divide-y divide-gray-100">
        {group.items.map((it, i) => (
          <AppointmentRow key={i} item={it} />
        ))}
      </ul>
    </section>
  );
}

function AppointmentRow({ item }) {
  const c = item.contact || {};
  return (
    <li className="px-4 py-3 flex flex-wrap items-start gap-3 hover:bg-gray-50/50">
      <div className="w-20 shrink-0">
        <p className="text-sm font-bold text-gray-900 tabular-nums">
          {fmtTime(item.start)}
        </p>
        {item.end && (
          <p className="text-[11px] text-gray-400 tabular-nums">→ {fmtTime(item.end)}</p>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-semibold text-gray-900 text-sm truncate">{item.title}</p>
          {item.isIntake && (
            <span className="rounded-full bg-purple-100 text-purple-800 text-[10px] font-bold px-2 py-0.5 uppercase tracking-wider">
              Intake
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
          {c.name && (
            <span className="inline-flex items-center gap-1"><User size={11} /> {c.name}</span>
          )}
          {c.email && (
            <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 hover:text-purple-700 hover:underline">
              <Mail size={11} /> {c.email}
            </a>
          )}
          {c.phone && (
            <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 hover:text-purple-700 hover:underline">
              <Phone size={11} /> {c.phone}
            </a>
          )}
          {!c.name && !c.email && !c.phone && (
            <span className="italic text-gray-400">No contact details on this event.</span>
          )}
        </div>
      </div>
    </li>
  );
}
