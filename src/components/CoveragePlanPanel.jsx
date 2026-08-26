import { useMemo } from 'react';
import { planDay, toMinutes, requiredFromDemand } from '../lib/coverage-planner';
import { Layers, Clock, Users, AlertTriangle } from 'lucide-react';

/**
 * Coverage Plan — the roster this day's demand actually implies.
 *
 * Read-only. It changes nothing and schedules nobody: it takes the
 * demand curve Supply & Demand already computes, runs it through the
 * coverage planner, and shows the shifts that come out — next to what is
 * currently rostered, so the two can be compared on a real day before
 * any of this goes near live scheduling.
 *
 * The interesting column is "Planned" vs "Need". Where Planned is higher,
 * the planner is holding someone on through a dip too short to legally
 * send them home for — a 2h minimum shift means a one-hour trough can't
 * be honoured. That gap is the price of not fragmenting the day, and it
 * is shown rather than hidden.
 */
export default function CoveragePlanPanel({ slotKeys = [], sides = [], minShiftMinutes = 120 }) {
  const plan = useMemo(() => {
    const requirements = sides.map(s => ({
      capability: s.label,
      required: requiredFromDemand(s.demand || [], s.ratio),
    }));
    return {
      ...planDay({ requirements, slotStarts: slotKeys, minShiftMinutes }),
      requirements,
    };
  }, [sides, slotKeys, minShiftMinutes]);

  // Per-slot: what was asked for, what the plan actually staffs, and what
  // is on the schedule right now.
  const rows = useMemo(() => slotKeys.map((slot, i) => {
    const mins = toMinutes(slot);
    const need = plan.requirements.reduce((n, r) => n + (r.required[i] || 0), 0);
    const planned = plan.shifts.filter(
      s => toMinutes(s.startTime) <= mins && toMinutes(s.endTime) > mins,
    ).length;
    const scheduled = sides.reduce((n, s) => n + (Number(s.supply?.[i]) || 0), 0);
    return { slot, need, planned, scheduled };
  }), [slotKeys, plan, sides]);

  const totalPeople = plan.shifts.length;
  const totalHours  = Math.round((plan.totalMinutes / 60) * 10) / 10;
  const heldOn      = rows.filter(r => r.planned > r.need).length;
  const scheduledPeak = rows.reduce((m, r) => Math.max(m, r.scheduled), 0);

  if (slotKeys.length === 0) return null;

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-indigo-200 bg-white/60">
        <h4 className="text-sm font-bold text-indigo-900 flex items-center gap-1.5">
          <Layers size={14} /> Coverage plan
        </h4>
        <p className="text-xs text-indigo-700/80">
          The shifts this demand implies, at a {minShiftMinutes / 60}-hour legal minimum.
          Nothing here is scheduled — it&rsquo;s for comparison.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-indigo-200/60">
        {[
          { icon: Users, label: 'People needed', value: totalPeople,
            sub: scheduledPeak ? `${scheduledPeak} on the schedule at peak` : null },
          { icon: Clock, label: 'Total hours', value: `${totalHours}h`, sub: 'across all shifts' },
          { icon: Layers, label: 'Shifts', value: plan.shifts.length, sub: 'one block each' },
          { icon: AlertTriangle, label: 'Held through a dip', value: heldOn,
            sub: heldOn ? 'slots kept staffed' : 'no dips to fill' },
        ].map(t => (
          <div key={t.label} className="bg-white/70 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-700/70">
              <t.icon size={12} /> {t.label}
            </div>
            <p className="text-lg font-bold text-indigo-900 leading-tight">{t.value}</p>
            {t.sub && <p className="text-[10px] text-indigo-700/60">{t.sub}</p>}
          </div>
        ))}
      </div>

      {/* The shifts themselves, grouped so identical blocks collapse into
          "3 × 15:00–19:00" rather than three separate lines. */}
      <div className="px-4 py-3 border-t border-indigo-200 bg-white/40">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700/70 mb-1.5">
          Shifts to roster
        </p>
        {plan.shifts.length === 0 ? (
          <p className="text-xs text-gray-500 italic">Nothing booked — no shifts needed.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(
              plan.shifts.reduce((acc, s) => {
                const key = `${s.capability}|${s.startTime}|${s.endTime}`;
                acc[key] = (acc[key] || 0) + 1;
                return acc;
              }, {}),
            ).map(([key, count]) => {
              const [capability, start, end] = key.split('|');
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-white px-2.5 py-1 text-xs font-semibold text-indigo-900"
                >
                  <span className="rounded-full bg-indigo-600 px-1.5 text-[10px] font-bold text-white">
                    {count}×
                  </span>
                  {start}–{end}
                  <span className="text-[10px] font-medium text-indigo-500">{capability}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="overflow-x-auto border-t border-indigo-200">
        <table className="w-full text-xs">
          <thead className="bg-white/60 text-indigo-900">
            <tr>
              <th className="px-2 py-1.5 text-left font-semibold">Slot</th>
              <th className="px-2 py-1.5 text-center font-semibold">Need</th>
              <th className="px-2 py-1.5 text-center font-semibold">Planned</th>
              <th className="px-2 py-1.5 text-center font-semibold">Scheduled</th>
              <th className="px-2 py-1.5 text-left font-semibold">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const held  = r.planned > r.need;
              const short = r.scheduled < r.need;
              return (
                <tr key={r.slot} className="border-t border-indigo-100">
                  <td className="px-2 py-1 font-medium text-gray-700">{r.slot}</td>
                  <td className="px-2 py-1 text-center font-bold text-gray-900">{r.need}</td>
                  <td className={`px-2 py-1 text-center font-bold ${held ? 'text-amber-700' : 'text-indigo-800'}`}>
                    {r.planned}
                  </td>
                  <td className={`px-2 py-1 text-center font-bold ${short ? 'text-red-600' : 'text-gray-500'}`}>
                    {r.scheduled}
                  </td>
                  <td className="px-2 py-1 text-[10px] text-gray-500">
                    {held  && <span className="text-amber-700">held on — dip too short to send anyone home</span>}
                    {!held && short && <span className="text-red-600">currently under-staffed</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {plan.warnings.length > 0 && (
        <div className="px-4 py-2 border-t border-amber-200 bg-amber-50">
          {plan.warnings.map((w, i) => (
            <p key={i} className="text-[11px] text-amber-800 flex items-start gap-1.5">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
