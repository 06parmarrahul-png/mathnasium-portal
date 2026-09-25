import { useState, useEffect } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { toast } from '../lib/notify';
// The stat list and the "is this a stat" test both live in statPay.js.
// This file used to carry its own copy of the list — the same eleven
// holidays and the same Easter algorithm, written out a second time — and
// the two quietly fell out of step: neither had the National Day for Truth
// and Reconciliation. One list now, and payroll reads the same one the
// auto-fill button writes.
import { bcStatHolidays } from '../lib/statPay';
import {
  datesInRange, rangeProblem, rangeSummary, addClosures, partitionClosures, isStat,
} from '../lib/centreClosures';
import {
  Plus, AlertTriangle, CalendarDays, CalendarX, Trash2,
} from 'lucide-react';

/**
 * HolidaysEditor — one-off centre closures (stat holidays, renovations, etc.).
 *
 * Lives in both the Admin Panel (Holidays tab) and the Super Admin page so
 * admins, owners, and super-admins can all manage it. The data sits on
 * centers/{centerId}/config/main.holidays and flows back out via the
 * AuthContext subscription, so every other surface (admin grid, schedule
 * calendar, auto-scheduler) updates the moment a holiday is added or removed.
 *
 * Holiday shape: { date: 'YYYY-MM-DD', name: 'Christmas Day' }.
 */

// ─── Component ───────────────────────────────────────────────────────────

export default function HolidaysEditor({ activeCenterId, centerConfig, activeCenterName }) {
  const [date, setDate] = useState('');
  // Optional. Empty means one day, which is what it is most of the time.
  const [until, setUntil] = useState('');
  const [name, setName] = useState('');
  // 'closures' first: it is the whole list, and adding a closed day is the
  // reason people open this. "Holidays" answers a narrower question — are
  // the twelve stats in? — and is one click away.
  const [view, setView] = useState('closures');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPast, setShowPast] = useState(false);
  // Optimistic local copy — render this immediately on edit so the UI
  // doesn't appear frozen while we wait for the Firestore listener to fire.
  // We resync from props whenever centerConfig.holidays changes.
  const [localHolidays, setLocalHolidays] = useState(
    Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : []
  );
  useEffect(() => {
    setLocalHolidays(Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : []);
  }, [centerConfig?.holidays]);

  const holidays = localHolidays;
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  // Holidays are a SUBSET of closures, not a sibling — same array, one
  // filter. See centreClosures.js for why that matters.
  const parts = partitionClosures(holidays);
  // The counts on the switch are UPCOMING ones, because that is what the
  // list below shows. A chip reading 10 above a list of 9 sends people
  // hunting for the tenth; the past ones have their own toggle.
  const counts = {
    closures: parts.closures.filter(h => h.date >= todayStr).length,
    holidays: parts.holidays.filter(h => h.date >= todayStr).length,
  };
  const shown = view === 'holidays' ? parts.holidays : parts.closures;
  const sorted = [...shown].sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));
  const upcoming = sorted.filter(h => (h?.date || '') >= todayStr);
  const past     = sorted.filter(h => (h?.date || '') <  todayStr);

  // Save the next list, optimistically updating local state first so the
  // UI feels instant. If Firestore rejects (permission, network, etc.)
  // we roll back to the previous server-truth state and surface the
  // error visibly so silent failures stop being a thing.
  const saveList = async (next) => {
    const prev = localHolidays;
    setLocalHolidays(next);
    setSaving(true);
    setError('');
    try {
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { holidays: next, updatedAt: serverTimestamp() },
        { merge: true },
      );
    } catch (err) {
      // Roll the optimistic update back so the user sees the data revert.
      setLocalHolidays(prev);
      console.error('[holidays] save failed:', err);
      const msg = `Could not save: ${err?.message || err?.code || 'unknown error'}`;
      setError(`${msg}. Try again or contact your platform operator.`);
      toast.error(msg, 7000);
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    setError('');
    const problem = rangeProblem(date, until);
    if (problem) { setError(problem); return; }

    const dates = datesInRange(date, until);
    const { list, added, skipped } = addClosures(holidays, dates, name);
    if (added === 0) {
      setError(dates.length === 1
        ? 'That date is already on the list.'
        : 'Every day in that stretch is already on the list.');
      return;
    }
    await saveList(list);
    // Say when some of the stretch was already closed, rather than
    // silently adding four of five days and looking like it worked.
    if (skipped > 0) {
      toast.success(`${added} ${added === 1 ? 'day' : 'days'} closed · `
        + `${skipped} already ${skipped === 1 ? 'was' : 'were'}`);
    }
    setDate('');
    setUntil('');
    setName('');
  };

  const handleDelete = async (d) => {
    const next = holidays.filter(h => h.date !== d);
    await saveList(next);
  };

  // One-click BC stat-holiday fill for the current and next calendar year.
  // Dedupes against whatever's already on the list, so clicking twice is a no-op.
  const autoFillYears = [new Date().getFullYear(), new Date().getFullYear() + 1];
  const handleAutoFill = async () => {
    const all = autoFillYears.flatMap(y => bcStatHolidays(y));
    const existing = new Set(holidays.map(h => h?.date));
    const toAdd = all.filter(h => !existing.has(h.date));
    if (toAdd.length === 0) {
      setError('All Canadian holidays for these years are already on the list.');
      setTimeout(() => setError(''), 3000);
      return;
    }
    await saveList([...holidays, ...toAdd]);
  };

  const fmt = (ds) => {
    if (!ds) return '';
    const [y, m, day] = ds.split('-');
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(day, 10));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-center gap-2">
        <CalendarX size={18} className="text-purple-600" />
        <h3 className="font-semibold text-gray-900">Holidays &amp; closures</h3>
      </div>
      <p className="mb-3 text-sm text-gray-500">
        Days <strong>{activeCenterName || 'this centre'}</strong> is shut. They show as{' '}
        <em>Closed</em> on the admin grid, grey out on the Schedule calendar, and are skipped
        by the auto-scheduler.
      </p>

      {/* Two views over ONE list, because a statutory holiday is a closure
          — the centre is shut either way. Keeping them as separate stored
          lists would mean writing the stats into both, and the day
          somebody edited one and not the other is the day payroll and the
          schedule disagreed. */}
      <div className="mb-4 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
        {[
          { key: 'closures', label: 'Closures', n: counts.closures,
            hint: 'Every day the centre is shut — stat holidays and your own' },
          { key: 'holidays', label: 'Holidays', n: counts.holidays,
            hint: 'Statutory holidays only — the ones payroll pays' },
        ].map(v => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            title={v.hint}
            aria-pressed={view === v.key}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              view === v.key ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            {v.label} <span className="ml-0.5 tabular-nums opacity-60">{v.n}</span>
          </button>
        ))}
      </div>
      <p className="mb-4 text-xs text-gray-400">
        {view === 'holidays'
          ? 'The twelve BC statutory holidays. Payroll pays these; the rest of the list it doesn’t.'
          : 'Everything, statutory or not. Add renovations, a burst pipe, the week between Christmas and New Year.'}
      </p>

      {/* Add form. The "to" box is what turns ten adds into one — closing
          for winter break used to mean typing each day in on its own. */}
      <div className="mb-4 grid gap-2 sm:grid-cols-[auto_auto_1fr_auto] sm:items-end">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            {until ? 'First day' : 'Date'}
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            To <span className="font-normal normal-case text-gray-400">(optional)</span>
          </label>
          <input
            type="date"
            value={until}
            min={date || undefined}
            onChange={(e) => setUntil(e.target.value)}
            aria-label="Last day of the closure, if it runs more than one day"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Name (optional)</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Christmas Day"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={saving || !date}
          className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
        >
          <Plus size={14} /> Add{rangeSummary(date, until) && until ? ` ${rangeSummary(date, until)}` : ''}
        </button>
      </div>
      {error && (
        <p className="mb-3 flex items-center gap-1 text-xs text-red-600">
          <AlertTriangle size={12} /> {error}
        </p>
      )}

      {/* One-click BC stat holiday auto-fill */}
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-purple-100 bg-purple-50/60 px-3 py-2">
        <p className="min-w-0 text-xs text-purple-900">
          Don't want to type them all in? Auto-fill BC statutory holidays for{' '}
          <strong>{autoFillYears[0]}</strong> and <strong>{autoFillYears[1]}</strong>.
        </p>
        <button
          type="button"
          onClick={handleAutoFill}
          disabled={saving}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
        >
          <CalendarDays size={13} /> Auto-fill
        </button>
      </div>

      {/* Upcoming */}
      {upcoming.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-400">
          {view === 'holidays'
            ? 'No statutory holidays on the list yet — Auto-fill puts all twelve in.'
            : 'No upcoming closures.'}
        </p>
      ) : (
        <div className="space-y-1.5">
          {upcoming.map(h => (
            <div key={h.date} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <CalendarX size={14} className="shrink-0 text-purple-500" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-gray-800">
                  <span className="truncate">{h.name || 'Closed'}</span>
                  {/* Only in the mixed view. In Holidays every row is one,
                      so a chip on all of them says nothing. */}
                  {view === 'closures' && isStat(h) && (
                    <span className="shrink-0 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-purple-700"
                      title="A BC statutory holiday — payroll pays this one">
                      Stat
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500">{fmt(h.date)}</p>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(h.date)}
                disabled={saving}
                className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Past holidays — collapsible */}
      {past.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowPast(s => !s)}
            className="text-xs font-semibold text-gray-500 hover:text-gray-800"
          >
            {showPast ? '− Hide' : '+ Show'} past holidays ({past.length})
          </button>
          {showPast && (
            <div className="mt-2 space-y-1.5">
              {past.slice().reverse().map(h => (
                <div key={h.date} className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-3 py-2 opacity-70">
                  <CalendarX size={14} className="shrink-0 text-gray-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-700">{h.name || 'Closed'}</p>
                    <p className="text-xs text-gray-400">{fmt(h.date)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(h.date)}
                    disabled={saving}
                    className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
