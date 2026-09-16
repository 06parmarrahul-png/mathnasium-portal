/**
 * CoverageModelCard — the coverage view, in the Supply & Demand shape.
 *
 * WHAT IT REPLACED
 *   "Average Coverage by Day": one bar per weekday, an 8-week average of
 *   distinct instructors, measured against ONE number for the whole day
 *   (minPerDay, default 8). Two problems with that. A day is the wrong
 *   unit — 3:00 is quiet and 4:30 is the wall, and a daily average hides
 *   both. And it counted every name on a posted shift, so the host, the
 *   admin desk and the trainees all read as teaching cover; it never went
 *   through countsInRatio() the way every other screen does.
 *
 * WHAT IT SHOWS
 *   One weekday at a time, half-hour columns like Supply & Demand, and
 *   three rows that answer three different questions:
 *
 *     Staff wanted — the centre's own target, set on the Staffing Board.
 *     Available    — people who said they could work it.
 *     Scheduled    — people actually rostered on it.
 *
 *   The gap between the last two is a rota to fix. A gap on the middle one
 *   is a people problem, and no amount of rota-shuffling touches it, so it
 *   is called out in its own colour rather than lumped in with "short".
 *
 * FORWARD-LOOKING, ON PURPOSE. The card this replaced looked 8 weeks back,
 * which is the wrong direction for a question you can still do something
 * about. Availability is submitted for dates that haven't happened yet, so
 * this reads the next few weeks and averages the occurrences of each
 * weekday. Drafts count as scheduled — planned coverage is still coverage,
 * the same rule Manage Schedule's "Total assigned" uses.
 */

import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { PAGES } from '../lib/pageNames';
import { buildTimeOffIndex } from '../lib/timeOff';
import { resolveInstructionalHours, ALL_WEEKDAYS, DEFAULT_CENTER_CONFIG, holidayFor } from '../lib/centerConfig';
import {
  resolveCoverageModel, slotKeysFor, targetFor, hasTargets,
  coverageForDate, summariseSlots, classifySlot, upcomingDatesFor,
} from '../lib/coverageModel';
import { Target, Loader2, AlertTriangle } from 'lucide-react';

const WEEKS_AHEAD = 4;

function slotLabel(slot) {
  const [h, m] = slot.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}` : `${h12}:${String(m).padStart(2, '0')}`;
}
const meridiem = (slot) => (Number(slot.split(':')[0]) >= 12 ? 'p' : 'a');
const round1 = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');

const STATUS_STYLE = {
  met:         'bg-emerald-50 text-emerald-700',
  fillable:    'bg-amber-50 text-amber-800',
  unstaffable: 'bg-rose-50 text-rose-700',
  none:        'text-gray-300',
};

export default function CoverageModelCard({ users = [], shifts = [] }) {
  const { activeCenterId, centerConfig, centreRoles } = useAuth();
  const [availability, setAvailability] = useState([]);
  const [timeOff, setTimeOff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [day, setDay] = useState(() => ALL_WEEKDAYS[new Date().getDay()]);

  const operatingDays = (Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0)
    ? centerConfig.operatingDays
    : DEFAULT_CENTER_CONFIG.operatingDays;

  // Availability is per DATE, so the forward window has to be read live —
  // the shifts the page already holds reach into the future, but nothing
  // upstream subscribes to availability.
  useEffect(() => {
    if (!activeCenterId) return;
    const today = new Date();
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const start = ymd(today);
    const u1 = onSnapshot(
      query(
        collection(db, 'availability'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', start),
        orderBy('date'),
      ),
      snap => { setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setLoading(false); },
      () => { setAvailability([]); setLoading(false); },
    );
    // No single `date` field to range-filter on (it lives in startDate /
    // endDate), so this one is unbounded — same as the Staffing Board.
    const u2 = onSnapshot(
      query(collection(db, 'timeOffRequests'), where('centerId', '==', activeCenterId)),
      snap => setTimeOff(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setTimeOff([]),
    );
    return () => { u1(); u2(); };
  }, [activeCenterId]);

  const model = useMemo(() => resolveCoverageModel(centerConfig), [centerConfig]);
  const timeOffIndex = useMemo(() => buildTimeOffIndex(timeOff), [timeOff]);

  const { slots, rows, dates, skipped, availDates } = useMemo(() => {
    const all = upcomingDatesFor(day, WEEKS_AHEAD, new Date(), ALL_WEEKDAYS);
    // A closed day would otherwise average in as a week with nobody on.
    const open = all.filter(d => !holidayFor(new Date(`${d}T12:00:00`), centerConfig));
    const hours = resolveInstructionalHours(
      centerConfig, open[0] ? new Date(`${open[0]}T12:00:00`) : new Date(),
    );
    const slotKeys = slotKeysFor(hours?.[day]);
    const empty = { slots: [], rows: [], dates: open, skipped: all.length - open.length, availDates: [] };
    if (slotKeys.length === 0) return empty;
    // Drafts count; a cancelled shift is not coverage.
    const live = shifts.filter(s => s?.status !== 'cancelled');
    const perDate = open.map(date => ({
      date,
      rows: coverageForDate({
        date, slotKeys, users, availability, shifts: live, timeOffIndex, roles: centreRoles,
      }),
    }));

    // TWO DENOMINATORS, DELIBERATELY. The rota is known for every date, so
    // it averages over all of them. Availability is only known for the dates
    // someone has actually filled in — usually the next week or two — and
    // averaging the empty ones in would report a fortnight of "nobody free"
    // that is really "nobody asked yet".
    const withAvail = new Set(availability.map(a => a?.date));
    const availOnly = perDate.filter(d => withAvail.has(d.date));
    const scheduledRows = summariseSlots(perDate.map(d => d.rows));
    const availableRows = availOnly.length > 0
      ? new Map(summariseSlots(availOnly.map(d => d.rows)).map(r => [r.slot, r]))
      : null;

    return {
      slots: slotKeys,
      rows: scheduledRows.map(r => {
        const a = availableRows?.get(r.slot);
        return {
          ...r,
          available:      a ? a.available : null,
          worstAvailable: a ? a.worstAvailable : null,
          availSamples:   availOnly.length,
        };
      }),
      dates: open,
      skipped: all.length - open.length,
      availDates: availOnly.map(d => d.date),
    };
  }, [day, centerConfig, users, availability, shifts, timeOffIndex, centreRoles]);

  const classified = rows.map(r => ({
    ...r,
    target: targetFor(model, day, r.slot),
    ...classifySlot({ target: targetFor(model, day, r.slot), available: r.available, scheduled: r.scheduled }),
  }));

  const worstGap = classified
    .filter(r => r.status === 'unstaffable')
    .sort((a, b) => b.shortAvailable - a.shortAvailable)[0];
  const fillableCount = classified.filter(r => r.status === 'fillable').length;
  const dayHasTargets = hasTargets(model, day);

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            <Target size={15} className="text-purple-600" />
            Coverage vs target
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Rota averaged across the next {dates.length} {day}{dates.length === 1 ? '' : 's'}
            {skipped > 0 && <> ({skipped} closed {skipped === 1 ? 'day' : 'days'} skipped)</>}
            {availDates.length > 0
              ? <> · availability from the {availDates.length} with any on file</>
              : <> · nobody has submitted availability for {day} yet</>}
            {' '}· only staff who count toward the ratio.
            {' '}Targets are set on the {PAGES.staffingBoard.name}.
          </p>
        </div>
        <div className="inline-flex flex-wrap gap-0.5 rounded-lg bg-gray-100 p-0.5">
          {operatingDays.map(d => (
            <button
              key={d}
              onClick={() => setDay(d)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-all ${
                day === d ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {d.slice(0, 3)}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400">
          <Loader2 size={15} className="animate-spin" /> Reading availability…
        </p>
      ) : slots.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-400">
          No instructional hours set for {day} — add them in Centre Settings → Hours.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="sticky left-0 z-10 bg-white pb-1.5 pr-3 text-left font-bold uppercase tracking-wide text-gray-500">
                    Slot
                  </th>
                  {classified.map(r => (
                    <th key={r.slot} className="px-1 pb-1.5 text-center font-semibold tabular-nums text-gray-600">
                      {slotLabel(r.slot)}<span className="text-[9px] text-gray-400">{meridiem(r.slot)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr>
                  <td className="sticky left-0 z-10 bg-white py-2 pr-3 font-semibold text-gray-700">Staff wanted</td>
                  {classified.map(r => (
                    <td key={r.slot} className="px-1 py-2 text-center tabular-nums">
                      {Number.isFinite(r.target)
                        ? <span className="font-bold text-gray-900">{r.target}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="sticky left-0 z-10 bg-white py-2 pr-3 text-gray-600">
                    Available
                    <span className="block text-[10px] text-gray-400">
                      {availDates.length > 0 ? 'told us they can work' : 'none submitted yet'}
                    </span>
                  </td>
                  {classified.map(r => (
                    <td
                      key={r.slot}
                      className="px-1 py-2 text-center tabular-nums text-gray-700"
                      title={r.available == null
                        ? 'Nobody has submitted availability for these dates yet'
                        : (r.worstAvailable !== Math.round(r.available)
                            ? `Worst of the ${r.availSamples}: ${r.worstAvailable}`
                            : undefined)}
                    >
                      {r.available == null
                        ? <span className="text-gray-300">—</span>
                        : round1(r.available)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="sticky left-0 z-10 bg-white py-2 pr-3 text-gray-600">
                    Scheduled
                    <span className="block text-[10px] text-gray-400">on the rota, drafts included</span>
                  </td>
                  {classified.map(r => (
                    <td
                      key={r.slot}
                      className="px-1 py-2 text-center tabular-nums text-gray-700"
                      title={r.worstScheduled !== Math.round(r.scheduled)
                        ? `Worst of the ${r.samples}: ${r.worstScheduled}`
                        : undefined}
                    >
                      {round1(r.scheduled)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="sticky left-0 z-10 bg-white py-2 pr-3 font-bold uppercase tracking-wide text-gray-500">
                    Status
                  </td>
                  {classified.map(r => (
                    <td key={r.slot} className="px-0.5 py-1.5 text-center">
                      <span
                        className={`block rounded px-1 py-1.5 text-[11px] font-semibold ${STATUS_STYLE[r.status]}`}
                        title={r.status === 'none'
                          ? 'No target set for this half hour'
                          : r.status === 'unstaffable'
                            ? `Want ${r.target}, ${round1(r.available)} free, ${round1(r.scheduled)} rostered — ${r.shortAvailable} more would have to be free`
                            : `Want ${r.target}, ${round1(r.scheduled)} rostered${r.available == null ? '' : `, ${round1(r.available)} free`}`}
                      >
                        {r.status === 'none' && '—'}
                        {r.status === 'met' && 'OK'}
                        {r.status === 'fillable' && `-${r.short}`}
                        {r.status === 'unstaffable' && `-${r.shortAvailable}`}
                      </span>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {!dayHasTargets ? (
            <p className="mt-4 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-center text-xs text-gray-500">
              No targets set for {day} yet. Add them under <b>Coverage targets</b> on the{' '}
              {PAGES.staffingBoard.name} and this fills in.
            </p>
          ) : (
            <div className="mt-4 space-y-1.5">
              {worstGap && (
                <p className="flex items-start gap-1.5 text-xs text-rose-700">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>
                    <b>{slotLabel(worstGap.slot)}{meridiem(worstGap.slot) === 'p' ? 'pm' : 'am'}</b> can&rsquo;t be
                    staffed: you want {worstGap.target}, and {round1(worstGap.available)} {worstGap.available === 1 ? 'person has' : 'people have'}
                    {' '}said they can work it. Hiring or availability, not the rota.
                  </span>
                </p>
              )}
              {fillableCount > 0 && (
                <p className="text-xs text-amber-800">
                  {fillableCount} {fillableCount === 1 ? 'slot is' : 'slots are'} short on the rota
                  {availDates.length > 0
                    ? <> but have enough people free — those are fixable on the {PAGES.staffingBoard.name}.</>
                    : <>. Whether anyone is free to fill them is unknown until availability comes in.</>}
                </p>
              )}
            </div>
          )}

          <p className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> target met
            <span className="mx-1 text-gray-300">·</span>
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> short on the rota, people are free
            <span className="mx-1 text-gray-300">·</span>
            <span className="inline-block h-2 w-2 rounded-full bg-rose-500" /> not enough people available
          </p>
        </>
      )}
    </div>
  );
}
