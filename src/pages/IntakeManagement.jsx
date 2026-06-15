// /intakes — owner-side management of native intake bookings.
//
// Lists every booking from the new /api/intakes/create flow, grouped by
// day. Lets the owner mark them complete, no-show, or cancel. Reads
// straight from Firestore (collection: centerIntakes) — rules restrict
// access to owner-like + super_admin so parent PII stays inside the
// circle of trust.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  collection, query, where, orderBy, onSnapshot, doc, updateDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  CalendarCheck, Phone, Mail, User, ShieldAlert, CheckCircle2,
  XCircle, AlertTriangle, ExternalLink, Loader2,
} from 'lucide-react';

const STATUS_OPTIONS = [
  { key: 'scheduled', label: 'Scheduled', cls: 'bg-blue-100 text-blue-800'  },
  { key: 'completed', label: 'Completed', cls: 'bg-emerald-100 text-emerald-800' },
  { key: 'no_show',   label: 'No-show',   cls: 'bg-amber-100 text-amber-800' },
  { key: 'cancelled', label: 'Cancelled', cls: 'bg-gray-200 text-gray-700' },
];

function statusBadge(s) {
  return STATUS_OPTIONS.find(o => o.key === s) || STATUS_OPTIONS[0];
}
function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export default function IntakeManagement() {
  const { activeCenterId, canSeeCenterSettings } = useAuth();
  const [intakes, setIntakes] = useState(null);
  const [filter, setFilter] = useState('upcoming'); // upcoming | all | past
  const [statusFilter, setStatusFilter] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!activeCenterId || !canSeeCenterSettings) return undefined;
    return onSnapshot(
      query(
        collection(db, 'centerIntakes'),
        where('centerId', '==', activeCenterId),
        orderBy('slot', 'desc'),
      ),
      snap => setIntakes(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err  => setError(err.message),
    );
  }, [activeCenterId, canSeeCenterSettings]);

  const filteredGrouped = useMemo(() => {
    if (!Array.isArray(intakes)) return null;
    const nowISO = new Date().toISOString();
    let list = intakes;
    if (filter === 'upcoming')  list = list.filter(i => i.slot >= nowISO);
    if (filter === 'past')      list = list.filter(i => i.slot <  nowISO);
    if (statusFilter !== 'all') list = list.filter(i => (i.status || 'scheduled') === statusFilter);
    // Group by day.
    const map = new Map();
    for (const i of list) {
      const k = dayKey(i.slot);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(i);
    }
    return [...map.entries()]
      .sort((a, b) => filter === 'past' ? b[0].localeCompare(a[0]) : a[0].localeCompare(b[0]))
      .map(([k, items]) => ({ k, items: items.sort((a, b) => a.slot.localeCompare(b.slot)) }));
  }, [intakes, filter, statusFilter]);

  if (!canSeeCenterSettings) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Intakes is owner / Enterprise only.</p>
      </div>
    );
  }

  const setStatus = async (intake, next) => {
    try {
      await updateDoc(doc(db, 'centerIntakes', intake.id), {
        status: next, statusUpdatedAt: new Date().toISOString(),
      });
    } catch (e) {
      setError(e.message);
    }
  };

  const total = Array.isArray(intakes) ? intakes.length : 0;
  const upcomingN = Array.isArray(intakes) ? intakes.filter(i => i.slot >= new Date().toISOString()).length : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="rounded-xl bg-red-100 p-2.5 text-red-700"><CalendarCheck size={22} /></div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">Intakes</h1>
          <p className="text-sm text-gray-500">
            Native bookings from the public assessment page. <strong>{total}</strong> total · <strong>{upcomingN}</strong> upcoming.
          </p>
        </div>
        <Link
          to={`/book/${activeCenterId}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
        >
          View public page <ExternalLink size={12} />
        </Link>
      </header>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
          {[
            { k: 'upcoming', label: 'Upcoming' },
            { k: 'past',     label: 'Past' },
            { k: 'all',      label: 'All' },
          ].map(p => (
            <button key={p.k} onClick={() => setFilter(p.k)}
              className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
                filter === p.k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {p.label}
            </button>
          ))}
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white text-xs px-2 py-1.5">
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      {intakes === null && (
        <div className="py-12 text-center text-sm text-gray-400 flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading intakes…
        </div>
      )}

      {intakes && filteredGrouped.length === 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white py-16 text-center text-sm text-gray-500">
          {total === 0
            ? 'No intakes booked yet. Share the public booking link to get started.'
            : 'No intakes match these filters.'}
        </div>
      )}

      {filteredGrouped && filteredGrouped.length > 0 && (
        <div className="space-y-3">
          {filteredGrouped.map(g => (
            <DayBlock key={g.k} dayKey={g.k} items={g.items} onSetStatus={setStatus} />
          ))}
        </div>
      )}
    </div>
  );
}

function DayBlock({ dayKey, items, onSetStatus }) {
  const d = new Date(dayKey + 'T12:00:00');
  const header = d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  return (
    <section className="rounded-2xl border bg-white shadow-sm overflow-hidden">
      <header className="bg-gray-50 px-4 py-2 border-b">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-600">
          {header}
          <span className="ml-2 text-gray-400 normal-case font-medium tracking-normal">
            · {items.length} intake{items.length === 1 ? '' : 's'}
          </span>
        </h3>
      </header>
      <ul className="divide-y divide-gray-100">
        {items.map(item => <Row key={item.id} item={item} onSetStatus={onSetStatus} />)}
      </ul>
    </section>
  );
}

function Row({ item, onSetStatus }) {
  const s = statusBadge(item.status || 'scheduled');
  return (
    <li className="px-4 py-3 flex flex-wrap items-start gap-3 hover:bg-gray-50/50">
      <div className="w-24 shrink-0">
        <p className="text-sm font-bold text-gray-900 tabular-nums">{fmtTime(item.slot)}</p>
        <p className="text-[11px] text-gray-400">{item.durationMin || 60} min</p>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-semibold text-gray-900 text-sm">{item.childName}</p>
          <span className="text-xs text-gray-500">· {item.childGrade}</span>
          {item.childSchool && (
            <span className="text-xs text-gray-500">· {item.childSchool}</span>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${s.cls}`}>
            {s.label}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
          <span className="inline-flex items-center gap-1"><User size={11} /> {item.guardianName}</span>
          <a href={`mailto:${item.email}`} className="inline-flex items-center gap-1 hover:text-red-700 hover:underline">
            <Mail size={11} /> {item.email}
          </a>
          <a href={`tel:${item.phone}`} className="inline-flex items-center gap-1 hover:text-red-700 hover:underline">
            <Phone size={11} /> {item.phone}
          </a>
          {item.smsOptIn && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">SMS OK</span>
          )}
        </div>
        {item.notes && (
          <p className="mt-1.5 text-xs text-gray-600 italic">"{item.notes}"</p>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1">
        <button onClick={() => onSetStatus(item, 'completed')} title="Mark completed"
          className="rounded p-1.5 text-gray-400 hover:bg-emerald-100 hover:text-emerald-700">
          <CheckCircle2 size={15} />
        </button>
        <button onClick={() => onSetStatus(item, 'no_show')} title="No-show"
          className="rounded p-1.5 text-gray-400 hover:bg-amber-100 hover:text-amber-700">
          <AlertTriangle size={15} />
        </button>
        <button onClick={() => onSetStatus(item, 'cancelled')} title="Cancel"
          className="rounded p-1.5 text-gray-400 hover:bg-rose-100 hover:text-rose-700">
          <XCircle size={15} />
        </button>
      </div>
    </li>
  );
}
