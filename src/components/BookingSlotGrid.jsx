import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, AlertTriangle } from 'lucide-react';
import { useTimeFormat } from '../lib/useTimeFormat';
import { todayISO } from '../lib/payProjection';
import {
  weekStartOf, weekEndOf, shiftWeek, gridFrom, toggleRule, toggleDay, dayIsClosed, closedCount,
} from '../lib/bookingSlotGrid';

/**
 * The booking week, as staff see it — the same one families get.
 *
 * IT ASKS THE PUBLIC ENDPOINT. /api/intakes?action=availability is what
 * /book/:centerId draws from, so this grid is a mirror of the parent page
 * rather than a second implementation of the same rules assembled on the
 * client. Everything already in the engine — the day cap, calendar holds,
 * statutory closures, advance notice, the summer hours override — arrives
 * here having already been applied, because it is literally the same
 * answer. The one thing drawn from local state is whether a time is shut
 * BY HAND, so an unsaved tap shows at once.
 *
 * Green is bookable, red is not, and a tap flips it. Booked and held
 * times are inert: offering to "open" an hour a family is already coming
 * to would be the worst button on this page.
 */

const TONE = {
  open:   'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100',
  closed: 'border-rose-300 bg-rose-100 text-rose-800 hover:bg-rose-200',
  booked: 'border-gray-200 bg-gray-100 text-gray-400',
  held:   'border-sky-200 bg-sky-50 text-sky-700',
  past:   'border-gray-200 bg-gray-50 text-gray-300',
  far:    'border-gray-200 bg-gray-50 text-gray-300',
};

const SHORT = { open: 'Open', closed: 'Closed', booked: 'Booked', held: 'Held', past: '—', far: '—' };

const fmtDay = (ymd) => new Date(`${ymd}T12:00:00`)
  .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export default function BookingSlotGrid({ centerId, enabled, rules, onChange, reloadKey = 0 }) {
  // The row labels are times somebody reads, so they go through the one
  // clock like every other time in the app — 12-hour by default, 24-hour
  // for anyone who asked for it on My Account.
  const fmtTime = useTimeFormat();
  const fmtLabel = (t) => fmtTime.compact(t);
  // The LOCAL calendar day. `new Date().toISOString()` is the UTC one, and
  // the centre is seven hours behind it — so from five in the afternoon
  // the grid would have opened on next week and counted today's closures
  // as past.
  const today = useMemo(() => todayISO(), []);
  const [weekStart, setWeekStart] = useState(() => weekStartOf(today) || today);
  const [days, setDays] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (signal) => {
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/intakes?action=availability&centerId=${encodeURIComponent(centerId)}&weekStart=${weekStart}`, { signal });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error || 'Could not read the week.');
      setDays(body.days || []);
    } catch (e) {
      if (e.name !== 'AbortError') { setError(e.message); setDays([]); }
    } finally {
      setLoading(false);
    }
  }, [centerId, weekStart]);

  useEffect(() => {
    if (!enabled || !centerId) { setDays([]); return undefined; }
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [enabled, centerId, load, reloadKey]);

  const { times, columns } = useMemo(() => gridFrom(days || [], rules), [days, rules]);
  const shut = closedCount(rules, today);

  if (!enabled) {
    return (
      <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Switch online booking on above and this becomes the week families see.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1">
          <button type="button" aria-label="Previous week"
            onClick={() => setWeekStart(w => shiftWeek(w, -1))}
            className="rounded-lg border border-gray-300 bg-white p-1.5 hover:bg-gray-50">
            <ChevronLeft size={14} />
          </button>
          <span className="px-1 text-sm font-semibold tabular-nums text-gray-800">
            {fmtDay(weekStart)} – {fmtDay(weekEndOf(weekStart))}
          </span>
          <button type="button" aria-label="Next week"
            onClick={() => setWeekStart(w => shiftWeek(w, 1))}
            className="rounded-lg border border-gray-300 bg-white p-1.5 hover:bg-gray-50">
            <ChevronRight size={14} />
          </button>
          {loading && <Loader2 size={13} className="ml-1 animate-spin text-gray-400" />}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <Key className="border-emerald-300 bg-emerald-50">Open</Key>
          <Key className="border-rose-300 bg-rose-100">Closed</Key>
          <Key className="border-gray-200 bg-gray-100">Booked</Key>
          <Key className="border-sky-200 bg-sky-50">Held</Key>
        </div>
      </div>

      {error && (
        <p className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {times.length === 0 && !loading ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-6 text-center text-xs text-gray-500">
          No times this week. The centre&rsquo;s hours decide which times exist — set those under
          Weekly availability below, or in Centre Settings &rarr; General.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-1 text-xs">
            <thead>
              <tr>
                <th className="w-16" />
                {columns.map(col => {
                  const allShut = dayIsClosed(col);
                  const anyLive = col.cells.some(c => c.tappable);
                  return (
                    <th key={col.date} className="align-bottom">
                      <div className="font-semibold text-gray-700">{fmtDay(col.date)}</div>
                      {col.closed ? (
                        <div className="text-[10px] font-normal text-gray-400">{col.closureName}</div>
                      ) : anyLive ? (
                        <button type="button"
                          onClick={() => onChange(toggleDay(rules, col, allShut))}
                          className="mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 underline-offset-2 hover:underline">
                          {allShut ? 'Open the day' : 'Close the day'}
                        </button>
                      ) : (
                        <div className="text-[10px] font-normal text-gray-300">—</div>
                      )}
                      {col.dayFull && (
                        <div className="text-[10px] font-normal text-amber-700">at its daily limit</div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {times.map((t, row) => (
                <tr key={t}>
                  <th className="pr-1 text-right align-middle text-[11px] font-medium tabular-nums text-gray-500">
                    {fmtLabel(t)}
                  </th>
                  {columns.map(col => {
                    const cell = col.cells[row];
                    if (cell.kind === 'none') return <td key={col.date} />;
                    const label = SHORT[cell.kind];
                    return (
                      <td key={col.date}>
                        <button type="button" disabled={!cell.tappable}
                          title={`${fmtDay(col.date)} ${fmtLabel(t)} — ${label}`}
                          aria-label={`${fmtDay(col.date)} ${fmtLabel(t)} — ${label}`}
                          onClick={() => onChange(toggleRule(rules, col.date, t, cell.kind === 'closed'))}
                          className={`w-full rounded-md border px-1 py-1.5 text-[11px] font-semibold transition-colors disabled:cursor-default ${TONE[cell.kind]}`}>
                          {label}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          {shut === 0
            ? 'Nothing closed by hand. Families see every time the hours allow.'
            : `${shut} time${shut === 1 ? '' : 's'} closed by hand, from today on.`}
        </p>
        {shut > 0 && (
          <button type="button"
            onClick={() => onChange({})}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50">
            <RotateCcw size={11} /> Open everything again
          </button>
        )}
      </div>
    </div>
  );
}

function Key({ className, children }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm border ${className}`} />
      {children}
    </span>
  );
}
