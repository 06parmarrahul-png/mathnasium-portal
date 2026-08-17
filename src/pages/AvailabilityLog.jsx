import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import {
  ACTION_STYLE, AVAIL_ACTIONS, CONFLICT_TEXT,
  subscribeAvailabilityLog, indexShifts, conflictFor,
  describeChange, fmtWindow, fmtDay, fmtWhen, fmtTime, logToCsv,
} from '../lib/availabilityLog';
import {
  History, Search, Download, AlertTriangle, CalendarDays, Loader2,
  ChevronRight, ChevronDown, ShieldCheck, CalendarRange, UserCog,
} from 'lucide-react';

/**
 * Availability Log — admin-and-above.
 *
 * Answers one question fast: "did this person actually have availability
 * in when we scheduled them?" Every add / change / removal is a row with
 * the exact before → after, and any change that collides with a shift
 * they're already assigned is flagged in red at the top of the page.
 *
 * The conflict flag is computed here, live, against current shifts —
 * not stamped on the row when it was written. That matters: if someone
 * pulls their Thursday and we schedule them for Thursday a week later,
 * the row turns red retroactively, which is exactly the case that
 * started the argument.
 */

const RANGES = [
  { key: '7',   label: 'Last 7 days',  days: 7   },
  { key: '30',  label: 'Last 30 days', days: 30  },
  { key: '90',  label: 'Last 90 days', days: 90  },
  { key: 'all', label: 'Everything',   days: null },
];

// How far back to pull shifts for conflict-checking. Log entries point at
// availability dates that are usually in the FUTURE, so the window has to
// reach forward — an unbounded date filter would do that, but we still
// trim the past so the listener stays small.
const SHIFT_LOOKBACK_DAYS = 120;

function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function NotAuthorized() {
  return (
    <div className="mx-auto max-w-md rounded-xl bg-white p-8 text-center shadow-sm">
      <h2 className="mb-2 text-xl font-bold text-gray-900">Not authorized</h2>
      <p className="text-sm text-gray-500">
        The availability log is available to admins, admin assistants, directors and owners.
      </p>
    </div>
  );
}

function StatTile({ icon, label, value, sub, tone = 'gray' }) {
  // Local const rather than a destructured `icon: Icon` — core
  // no-unused-vars doesn't count a JSX element name as a use, and this
  // repo's varsIgnorePattern covers vars but not args.
  const Icon = icon;
  const tones = {
    gray: 'bg-white border-gray-200 text-gray-900',
    red:  'bg-red-50 border-red-200 text-red-900',
    amber:'bg-amber-50 border-amber-200 text-amber-900',
  };
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide opacity-70">
        <Icon size={14} /> {label}
      </div>
      <p className="mt-1 text-2xl font-bold leading-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs opacity-70">{sub}</p>}
    </div>
  );
}

function ActionChip({ action }) {
  const s = ACTION_STYLE[action] || ACTION_STYLE.changed;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${s.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function ConflictBanner({ conflict }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-600" />
      <div className="text-xs text-red-900">
        <p className="font-semibold">{CONFLICT_TEXT[conflict.kind]}</p>
        <p className="mt-0.5">
          Scheduled:{' '}
          {conflict.shifts.map((s, i) => (
            <span key={s.id || i}>
              {i > 0 && ', '}
              {fmtTime(s.startTime)}–{fmtTime(s.endTime)}
              {s.role ? ` (${s.role})` : ''}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

/** One change. `entry._conflict` is attached by the page. */
function EntryRow({ entry, compact = false }) {
  return (
    <div className={compact ? 'py-2' : 'px-4 py-3'}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <ActionChip action={entry.action} />
        <span className="font-semibold text-gray-900">{entry.targetName}</span>
        <span className="inline-flex items-center gap-1 text-sm text-gray-600">
          <CalendarDays size={13} className="text-gray-400" />
          {fmtDay(entry.date)}
        </span>
        <span className="ml-auto text-xs text-gray-400">
          {entry.actorIsSelf ? entry.actorName : `${entry.actorName} (on their behalf)`}
          {' · '}
          {fmtWhen(entry.at)}
        </span>
      </div>

      <p className="mt-1 text-sm text-gray-700">{describeChange(entry)}</p>

      {entry.action === AVAIL_ACTIONS.REMOVED && (
        <p className="mt-0.5 text-xs text-gray-500">Previously {fmtWindow(entry.before)}</p>
      )}

      {entry._conflict && <ConflictBanner conflict={entry._conflict} />}
    </div>
  );
}

/** A weekly bulk save — collapsed to one line so it can't flood the feed. */
function BatchGroup({ entries }) {
  const [open, setOpen] = useState(false);
  const conflicts = entries.filter(e => e._conflict).length;
  const newest = entries[0];

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-start gap-2 text-left"
      >
        {open ? <ChevronDown size={16} className="mt-0.5 shrink-0 text-gray-400" />
              : <ChevronRight size={16} className="mt-0.5 shrink-0 text-gray-400" />}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-semibold text-gray-600">
              Weekly set
            </span>
            <span className="font-semibold text-gray-900">{newest.targetName}</span>
            <span className="text-sm text-gray-600">
              {entries.length} day{entries.length === 1 ? '' : 's'} updated
            </span>
            {conflicts > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-800">
                <AlertTriangle size={11} /> {conflicts} conflict{conflicts === 1 ? '' : 's'}
              </span>
            )}
            <span className="ml-auto text-xs text-gray-400">{fmtWhen(newest.at)}</span>
          </span>
          {!open && (
            <span className="mt-1 block truncate text-xs text-gray-500">
              {entries.slice(0, 4).map(e => fmtDay(e.date)).join(' · ')}
              {entries.length > 4 ? ` +${entries.length - 4} more` : ''}
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="mt-2 divide-y divide-gray-100 border-l-2 border-gray-200 pl-4">
          {entries.map(e => <EntryRow key={e.id} entry={e} compact />)}
        </div>
      )}
    </div>
  );
}

export default function AvailabilityLog() {
  const { activeCenterId, canSeeAdminPanel, isSuperAdmin } = useAuth();

  const [entries, setEntries] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [loadedCenter, setLoadedCenter] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [range, setRange] = useState('30');
  const [conflictsOnly, setConflictsOnly] = useState(false);

  // Deriving `loading` from which centre's data is in state avoids
  // calling setState in the effect body (react-hooks/set-state-in-effect).
  const loading = loadedCenter !== activeCenterId;

  useEffect(() => {
    if (!canSeeAdminPanel || !activeCenterId) return;
    return subscribeAvailabilityLog(
      activeCenterId,
      { max: 400 },
      list => { setEntries(list); setLoadedCenter(activeCenterId); setLoadError(null); },
      err => {
        console.error('[availability-log] subscribe failed:', err);
        setLoadedCenter(activeCenterId);
        // A missing composite index is by far the most likely failure on
        // first run, and Firestore puts a one-click fix URL in the message.
        setLoadError(err?.message || 'Could not load the log.');
      },
    );
  }, [activeCenterId, canSeeAdminPanel]);

  // Shifts, for conflict detection. Same (centerId, date) index the rest
  // of the app already uses.
  useEffect(() => {
    if (!canSeeAdminPanel || !activeCenterId) return;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', daysAgoIso(SHIFT_LOOKBACK_DAYS)),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => console.error('[availability-log] shifts subscribe failed:', err),
    );
  }, [activeCenterId, canSeeAdminPanel]);

  const shiftIndex = useMemo(() => indexShifts(shifts), [shifts]);

  // Attach the live conflict verdict to every row once, up front.
  const decorated = useMemo(
    () => entries.map(e => ({ ...e, _conflict: conflictFor(e, shiftIndex) })),
    [entries, shiftIndex],
  );

  const filtered = useMemo(() => {
    const r = RANGES.find(x => x.key === range);
    const cutoff = r?.days ? daysAgoIso(r.days) : null;
    const q = search.trim().toLowerCase();

    return decorated.filter(e => {
      if (cutoff && String(e.at || '').slice(0, 10) < cutoff) return false;
      if (actionFilter !== 'all' && e.action !== actionFilter) return false;
      if (conflictsOnly && !e._conflict) return false;
      if (!q) return true;
      return [e.targetName, e.actorName, e.date]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [decorated, range, actionFilter, conflictsOnly, search]);

  const conflictCount = filtered.filter(e => e._conflict).length;
  const removedCount  = filtered.filter(e => e.action === AVAIL_ACTIONS.REMOVED).length;

  // Collapse weekly bulk saves into one expandable line, keeping overall
  // newest-first order (entries arrive sorted, so the first sighting of a
  // batchId marks where the group belongs).
  const groups = useMemo(() => {
    const out = [];
    const byBatch = new Map();
    for (const e of filtered) {
      if (!e.batchId) { out.push({ type: 'single', key: e.id, entry: e }); continue; }
      if (!byBatch.has(e.batchId)) {
        const group = { type: 'batch', key: e.batchId, entries: [] };
        byBatch.set(e.batchId, group);
        out.push(group);
      }
      byBatch.get(e.batchId).entries.push(e);
    }
    // A "batch" that ended up with a single row reads better as a normal row.
    return out.map(g =>
      g.type === 'batch' && g.entries.length === 1
        ? { type: 'single', key: g.entries[0].id, entry: g.entries[0] }
        : g,
    );
  }, [filtered]);

  const handleExport = () => {
    if (filtered.length === 0) { toast.info('Nothing to export with these filters.'); return; }
    const blob = new Blob([logToCsv(filtered)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `availability-log-${activeCenterId}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!canSeeAdminPanel) return <NotAuthorized />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <History size={24} className="text-red-600" /> Availability Log
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Every time someone adds, changes or removes their availability — with the
            exact before and after. Admins, admin assistants, directors and owners only.
          </p>
        </div>
        <button
          onClick={handleExport}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Download size={16} /> Export
        </button>
      </div>

      {loadError && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="min-w-0 text-sm text-amber-900">
            <p className="font-semibold">Couldn&rsquo;t load the history</p>
            <p className="mt-0.5">
              This centre&rsquo;s availability history isn&rsquo;t available right now. Try again in a
              few minutes — if it keeps happening, let your Enterprise contact know.
            </p>
            {/* The underlying message names the infrastructure it came
                from, which is meaningless to a centre admin and not
                theirs to act on. Enterprise sees it; nobody else does. */}
            {isSuperAdmin && (
              <p className="mt-2 break-words rounded bg-amber-100 px-2 py-1 font-mono text-xs">
                {loadError}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile icon={CalendarRange} label="Changes" value={filtered.length} sub="In the selected range" />
        <StatTile
          icon={AlertTriangle}
          label="Conflicts"
          value={conflictCount}
          sub="Clash with a scheduled shift"
          tone={conflictCount > 0 ? 'red' : 'gray'}
        />
        <StatTile
          icon={UserCog}
          label="Removals"
          value={removedCount}
          sub="Availability taken away"
          tone={removedCount > 0 ? 'amber' : 'gray'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="relative min-w-[14rem] flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by instructor or date…"
            className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
          />
        </div>
        <select
          value={range}
          onChange={e => setRange(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
        >
          {RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <select
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
        >
          <option value="all">All changes</option>
          <option value={AVAIL_ACTIONS.ADDED}>Added</option>
          <option value={AVAIL_ACTIONS.CHANGED}>Changed</option>
          <option value={AVAIL_ACTIONS.REMOVED}>Removed</option>
        </select>
        <button
          onClick={() => setConflictsOnly(v => !v)}
          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            conflictsOnly
              ? 'border-red-300 bg-red-50 text-red-700'
              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          <AlertTriangle size={14} /> Conflicts only
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
            <Loader2 size={16} className="animate-spin" /> Loading changes…
          </div>
        ) : groups.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <ShieldCheck size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-base font-semibold text-gray-900">
              {loadError
                ? 'History unavailable'
                : entries.length === 0 ? 'No changes recorded yet' : 'Nothing matches those filters'}
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
              {loadError
                ? 'Changes will show up here once this clears — see the note above.'
                : entries.length === 0
                  ? 'Changes appear here as soon as staff start editing their availability. Anything changed before this log was added is not recorded.'
                  : 'Try widening the date range or clearing the conflicts filter.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {groups.map(g => (
              g.type === 'batch'
                ? <BatchGroup key={g.key} entries={g.entries} />
                : <div key={g.key} className={g.entry._conflict ? 'bg-red-50/40' : ''}>
                    <EntryRow entry={g.entry} />
                  </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
