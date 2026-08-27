import { useEffect, useMemo, useState } from 'react';
import { planDay, requiredFromDemand, slotKeysForDay } from '../lib/coverage-planner';
import { Activity, Wand2, Eraser, Info } from 'lucide-react';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Author the "how many people do I need, when" curve for each weekday.
 *
 * The bars are the point. A staffing curve is a shape, and a column of
 * number inputs hides the shape — you can't see a peak or a dip in a
 * list of digits. Click-and-drag on the bars, with the numbers alongside
 * for exactness.
 *
 * Underneath, the same curve is run through the planner live, so the
 * owner sees the SHIFTS their curve implies while they're editing it,
 * not after generating. That feedback is what makes the trough rule
 * legible: nudge a dip down and watch the shift count stay put, because
 * the 2-hour minimum won't let anyone go home for it.
 */
export default function CoverageCurveEditor({
  centerConfig, curvesByWeekday = {}, onChange, typicalDemand = {}, targetRatio = 3.5,
  minShiftMinutes = 120, loading = false,
}) {
  const [activeDay, setActiveDay] = useState('Monday');
  const slotKeys = useMemo(
    () => slotKeysForDay(centerConfig, activeDay),
    [centerConfig, activeDay],
  );

  /** Students typically booked in each of this day's slots. */
  const demandFor = useMemo(() => (dayName) => {
    const byTime = typicalDemand[dayName];
    if (!byTime) return null;
    const keys = slotKeysForDay(centerConfig, dayName);
    const vals = keys.map(k => Number(byTime[k]) || 0);
    return vals.some(v => v > 0) ? vals : null;
  }, [typicalDemand, centerConfig]);

  // Seed every weekday from real demand the first time history arrives.
  // Starting from a blank grid means an owner has to author ~50 numbers
  // before the mode does anything — the useful default is "here's what
  // your bookings actually looked like", which they then adjust.
  const nothingAuthored = Object.keys(curvesByWeekday).length === 0;
  const hasHistory = Object.keys(typicalDemand).length > 0;
  useEffect(() => {
    if (!nothingAuthored || !hasHistory) return;
    const seeded = {};
    for (const d of WEEKDAYS) {
      const demand = demandFor(d);
      if (!demand) continue;
      seeded[d] = [{ capability: 'Instructor', required: requiredFromDemand(demand, targetRatio) }];
    }
    if (Object.keys(seeded).length > 0) onChange(seeded);
    // onChange is a setState from the parent; re-running on its identity
    // would loop. Seeding is a one-shot on first history load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nothingAuthored, hasHistory, targetRatio]);

  const curve = useMemo(() => {
    const rows = curvesByWeekday[activeDay];
    const row = rows?.find(r => r.capability === 'Instructor') || rows?.[0];
    const vals = row?.required || [];
    // Pad or trim to the day's slot count so an hours change doesn't
    // strand a curve of the wrong length.
    return slotKeys.map((_, i) => Number(vals[i]) || 0);
  }, [curvesByWeekday, activeDay, slotKeys]);

  const peak = Math.max(4, ...curve);

  const setCurve = (next) => {
    onChange({
      ...curvesByWeekday,
      [activeDay]: [{ capability: 'Instructor', required: next }],
    });
  };

  const setSlot = (i, v) => {
    const next = [...curve];
    next[i] = Math.max(0, Math.min(30, Math.round(Number(v) || 0)));
    setCurve(next);
  };

  const fillFromDemand = () => {
    const demand = demandFor(activeDay);
    if (!demand) return;
    setCurve(requiredFromDemand(demand, targetRatio));
  };

  const plan = useMemo(() => planDay({
    requirements: [{ capability: 'Instructor', required: curve }],
    slotStarts: slotKeys,
    minShiftMinutes,
  }), [curve, slotKeys, minShiftMinutes]);

  const grouped = useMemo(() => Object.entries(
    plan.shifts.reduce((acc, s) => {
      const k = `${s.startTime}|${s.endTime}`;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
  ), [plan]);

  const hasDemand = !!demandFor(activeDay);
  const activeDemand = demandFor(activeDay);
  const peakStudents = activeDemand ? Math.max(0, ...activeDemand) : 0;

  /** Peak headcount a weekday's curve asks for — shown on its tab. */
  const peakFor = (d) => {
    const req = curvesByWeekday[d]?.[0]?.required || [];
    return req.length ? Math.max(0, ...req.map(Number)) : 0;
  };

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/30 overflow-hidden mb-5">
      <div className="px-4 py-2.5 border-b border-indigo-200 bg-white/60 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h4 className="text-sm font-bold text-indigo-900 flex items-center gap-1.5">
            <Activity size={14} /> Coverage curve
          </h4>
          {/* Say where the numbers came from. Pre-filled figures with no
              provenance are the fastest way to lose an owner's trust. */}
          <p className="text-xs text-indigo-700/80">
            {loading
              ? 'Reading your booking history…'
              : hasDemand
                ? <>Pre-filled from your typical <b>{activeDay}</b> — {peakStudents} students at peak,
                    at 1:{targetRatio}. Adjust anything that looks off.</>
                : <>No saved booking history for {activeDay} yet — set the numbers by hand,
                    or open Supply &amp; Demand for a few {activeDay}s to build history.</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fillFromDemand}
            disabled={!hasDemand}
            title={hasDemand
              ? `Fill from your typical ${activeDay} bookings at a 1:${targetRatio} ratio`
              : `No saved demand history for ${activeDay} yet`}
            className="inline-flex items-center gap-1 rounded-md border border-indigo-300 bg-white px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
          >
            <Wand2 size={12} /> Fill from demand
          </button>
          <button
            onClick={() => setCurve(slotKeys.map(() => 0))}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
          >
            <Eraser size={12} /> Clear
          </button>
        </div>
      </div>

      {/* Weekday tabs — a dot marks the days that actually have a curve,
          so an owner can see at a glance what's still blank. */}
      <div className="flex gap-1 px-3 pt-2 flex-wrap">
        {WEEKDAYS.map(d => {
          const active = d === activeDay;
          const peak = peakFor(d);
          return (
            <button
              key={d}
              onClick={() => setActiveDay(d)}
              title={peak ? `${d}: peaks at ${peak} instructors` : `${d}: no coverage set`}
              className={`inline-flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? 'bg-white text-indigo-900 border border-b-white border-indigo-200'
                  : 'text-indigo-600 hover:bg-white/60'
              }`}
            >
              {d.slice(0, 3)}
              {/* The headcount, right on the tab — the number an owner
                  actually wants, without opening each day to find it. */}
              <span className={`rounded-full px-1.5 text-[10px] font-bold ${
                peak ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {peak || '–'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="bg-white/70 border-t border-indigo-200 px-4 py-3">
        {/* The curve. Bars scale to the day's peak; the number under each
            is directly editable for when you want an exact figure. */}
        <div className="overflow-x-auto">
          <div className="flex items-end gap-1 min-w-max" style={{ height: 120 }}>
            {slotKeys.map((slot, i) => {
              const v = curve[i] || 0;
              const isHour = slot.endsWith(':00');
              return (
                <div key={slot} className="flex flex-col items-center gap-1" style={{ width: 34 }}>
                  <div className="relative flex-1 w-full flex items-end">
                    <button
                      onClick={() => setSlot(i, v + 1)}
                      onContextMenu={(e) => { e.preventDefault(); setSlot(i, v - 1); }}
                      title={`${slot} — ${v} needed. Click to add, right-click to remove.`}
                      className="w-full rounded-t transition-all hover:opacity-80"
                      style={{
                        height: `${Math.max(3, (v / peak) * 100)}%`,
                        backgroundColor: v === 0 ? '#e5e7eb' : '#6366f1',
                      }}
                    />
                  </div>
                  <input
                    type="number"
                    min={0}
                    value={v}
                    onChange={(e) => setSlot(i, e.target.value)}
                    className="w-full rounded border border-indigo-200 px-0.5 py-0.5 text-center text-[10px] font-bold text-indigo-900 focus:border-indigo-500 focus:outline-none"
                  />
                  <span className={`text-[9px] ${isHour ? 'font-bold text-gray-600' : 'text-gray-300'}`}>
                    {isHour ? slot.slice(0, 5) : '·'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Live consequence of the curve above. */}
      <div className="px-4 py-2.5 border-t border-indigo-200 bg-white/40">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700/70 mb-1.5">
          {activeDay} works out to
        </p>
        {plan.shifts.length === 0 ? (
          <p className="text-xs text-gray-500 italic">
            No coverage set for {activeDay} — the scheduler will leave it empty.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {grouped.map(([k, count]) => {
                const [start, end] = k.split('|');
                return (
                  <span key={k} className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-white px-2.5 py-1 text-xs font-semibold text-indigo-900">
                    <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] font-bold text-white">{count}×</span>
                    {start}–{end}
                  </span>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-500 flex items-start gap-1">
              <Info size={11} className="mt-0.5 shrink-0" />
              {plan.shifts.length} shift{plan.shifts.length === 1 ? '' : 's'} ·{' '}
              {Math.round((plan.totalMinutes / 60) * 10) / 10}h total ·
              minimum {minShiftMinutes / 60}h each. A dip shorter than that can&rsquo;t send
              anyone home, so it stays staffed.
            </p>
          </>
        )}
        {plan.warnings.map((w, i) => (
          <p key={i} className="mt-1 text-[10px] text-amber-700">{w}</p>
        ))}
      </div>
    </div>
  );
}
