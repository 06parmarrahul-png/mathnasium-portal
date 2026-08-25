import { useState, useEffect } from 'react';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { toast } from '../lib/notify';
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

// ─── Canadian stat-holiday math (used by the auto-fill button) ──────────

// Anonymous Gregorian (Meeus/Jones/Butcher) Easter algorithm — returns the
// Date of Western Easter Sunday for the given year. Good Friday is 2 days
// before; everything else is a fixed date or an Nth weekday.
function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// Nth occurrence of weekday (0=Sun..6=Sat) in monthIdx (0=Jan..11=Dec).
function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
  const first = new Date(year, monthIdx, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, monthIdx, 1 + offset + (n - 1) * 7);
}

// The Monday falling on or before a given date — Victoria Day's definition.
function mondayOnOrBefore(year, monthIdx, day) {
  const d = new Date(year, monthIdx, day);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * BC statutory holidays for the given year, chronological order. Covers
 * New Year's, Family Day, Good Friday, Victoria Day, Canada Day, BC Day,
 * Labour Day, Thanksgiving, Remembrance Day, Christmas, Boxing Day.
 */
function canadianStatHolidays(year) {
  const easter = easterDate(year);
  const goodFriday = new Date(easter);
  goodFriday.setDate(easter.getDate() - 2);
  return [
    { date: `${year}-01-01`, name: "New Year's Day" },
    { date: toDateKey(nthWeekdayOfMonth(year, 1, 1, 3)), name: 'Family Day' },
    { date: toDateKey(goodFriday),                       name: 'Good Friday' },
    { date: toDateKey(mondayOnOrBefore(year, 4, 24)),    name: 'Victoria Day' },
    { date: `${year}-07-01`, name: 'Canada Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 7, 1, 1)), name: 'BC Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 8, 1, 1)), name: 'Labour Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 9, 1, 2)), name: 'Thanksgiving' },
    { date: `${year}-11-11`, name: 'Remembrance Day' },
    { date: `${year}-12-25`, name: 'Christmas Day' },
    { date: `${year}-12-26`, name: 'Boxing Day' },
  ];
}

// ─── Component ───────────────────────────────────────────────────────────

export default function HolidaysEditor({ activeCenterId, centerConfig, activeCenterName }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
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
  const sorted = [...holidays].sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));
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
    if (!date) { setError('Pick a date.'); return; }
    if (holidays.some(h => h.date === date)) {
      setError('That date is already on the list.');
      return;
    }
    const next = [...holidays, { date, name: name.trim() || 'Closed' }];
    await saveList(next);
    setDate('');
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
    const all = autoFillYears.flatMap(y => canadianStatHolidays(y));
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
        <h3 className="font-semibold text-gray-900">Holidays</h3>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        One-off days <strong>{activeCenterName || 'this centre'}</strong> is closed (stat holidays,
        renovations, etc.). Holiday dates show as <em>Closed</em> on the admin grid, grey out on
        the Schedule calendar, and are skipped by the auto-scheduler.
      </p>

      {/* Add form */}
      <div className="mb-4 grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-end">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
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
          <Plus size={14} /> Add
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
          No upcoming holidays.
        </p>
      ) : (
        <div className="space-y-1.5">
          {upcoming.map(h => (
            <div key={h.date} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <CalendarX size={14} className="shrink-0 text-purple-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-gray-800">{h.name || 'Closed'}</p>
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
