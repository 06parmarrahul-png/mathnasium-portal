import { useMemo } from 'react';
import { styleFor as subRoleStyleFor } from '../lib/subRoles';

/**
 * Half-hour staffing density grid for a single day.
 *
 * Rows: every assigned person, with a sub-role-colored bar where their
 *       shift covers each half-hour slot.
 * Columns: half-hour slots from opening to closing (varies by day-of-week).
 * Totals row: count of TEACHING staff (Instructor / Lead / promoted Host)
 *             at each slot — tells you student capacity at a glance.
 *
 * Hosts (regular, non-promoted) and Online instructors render as bars but
 * are NOT counted in the teaching total. Their presence still bumps the
 * "Total staff" sub-row.
 */

// Operating hours per day-of-week — the half-hour grid spans these.
// Matches Schedule.jsx's "Full Day" range so the grid covers anything
// from earliest admin prep to latest cleanup.
const SLOTS_BY_DAY = {
  Monday:    { startHour: 10, endHour: 20 }, // 10 AM – 8 PM
  Tuesday:   { startHour: 10, endHour: 20 },
  Wednesday: { startHour: 10, endHour: 20 },
  Thursday:  { startHour: 10, endHour: 20 },
  Friday:    { startHour: 10, endHour: 19 }, // 10 AM – 7 PM
  Saturday:  { startHour: 9,  endHour: 15 }, // 9 AM – 3 PM
  Sunday:    { startHour: 10, endHour: 18 }, // closed but show something if a shift slips through
};

const TEACHING_ROLES = new Set(['Instructor', 'Lead']);

function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = String(timeStr).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function generateSlots(dayOfWeek) {
  const range = SLOTS_BY_DAY[dayOfWeek] || SLOTS_BY_DAY.Monday;
  const slots = [];
  for (let h = range.startHour; h < range.endHour; h++) {
    const hh = String(h).padStart(2, '0');
    const next = String(h + 1).padStart(2, '0');
    slots.push({ start: `${hh}:00`, end: `${hh}:30` });
    slots.push({ start: `${hh}:30`, end: `${next}:00` });
  }
  return slots;
}

function fmtSlotLabel(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'p' : 'a';
  let h12 = h > 12 ? h - 12 : h;
  if (h12 === 0) h12 = 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

/**
 * Parse a shift-time string ("15:00 - 19:00" or "11:00 AM - 7:00 PM")
 * into { startMins, endMins } since midnight.
 */
function parseShift(str) {
  if (!str) return null;
  const parts = String(str).split(' - ');
  if (parts.length !== 2) return null;
  const norm = (p) => {
    const t = p.trim();
    if (/^\d{1,2}:\d{2}$/.test(t)) return toMinutes(t.padStart(5, '0'));
    const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const ampm = m[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      return h * 60 + min;
    }
    return 0;
  };
  return { startMins: norm(parts[0]), endMins: norm(parts[1]) };
}

const rolePriority = (r) => {
  if (r === 'Instructor' || r === 'Lead') return 0;
  if (r === 'Host')                       return 1;
  if (r === 'Online Instructor')          return 2;
  return 3;
};

export default function CoverageGrid({ day }) {
  const slots = useMemo(() => generateSlots(day.dayOfWeek), [day.dayOfWeek]);

  const sortedNames = useMemo(() => {
    return [...(day.assignedEmployees || [])].sort((a, b) => {
      const ra = day.roles?.[a] || 'Instructor';
      const rb = day.roles?.[b] || 'Instructor';
      const dp = rolePriority(ra) - rolePriority(rb);
      if (dp !== 0) return dp;
      return a.localeCompare(b);
    });
  }, [day.assignedEmployees, day.roles]);

  // Pre-parse each person's shift once
  const shiftByName = useMemo(() => {
    const m = {};
    for (const name of sortedNames) {
      m[name] = parseShift(day.shiftTimes?.[name]);
    }
    return m;
  }, [sortedNames, day.shiftTimes]);

  // Per-slot counts (teaching + total)
  const slotData = useMemo(() => {
    return slots.map(slot => {
      const sStart = toMinutes(slot.start);
      const sEnd   = toMinutes(slot.end);
      let teachingCount = 0;
      let totalCount = 0;
      for (const name of sortedNames) {
        const shift = shiftByName[name];
        if (!shift) continue;
        // Person covers this slot if their shift overlaps [sStart, sEnd)
        if (shift.startMins < sEnd && shift.endMins > sStart) {
          totalCount++;
          if (TEACHING_ROLES.has(day.roles?.[name])) teachingCount++;
        }
      }
      return { ...slot, teachingCount, totalCount };
    });
  }, [slots, sortedNames, shiftByName, day.roles]);

  const peakTeaching = slotData.reduce((mx, s) => Math.max(mx, s.teachingCount), 0);
  const peakSlot = slotData.find(s => s.teachingCount === peakTeaching && peakTeaching > 0);

  if (sortedNames.length === 0) {
    return (
      <div className="rounded-lg border-2 border-dashed border-gray-200 bg-gray-50/50 px-4 py-6 text-center">
        <p className="text-sm text-gray-400 italic">No staff assigned — nothing to cover.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Summary bar */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="text-gray-500">Peak instructors:</span>
          <span className="font-bold text-blue-700">{peakTeaching}</span>
          {peakSlot && (
            <span className="text-gray-400">@ {fmtSlotLabel(peakSlot.start)}</span>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-gray-500">
          <span>·</span>
          <span>{slots.length} half-hour slots</span>
        </span>
        <span className="flex items-center gap-1.5 text-gray-500">
          <span>·</span>
          <span>{sortedNames.length} staff total</span>
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="text-xs border-collapse w-full">
          <thead>
            <tr className="bg-gray-50">
              <th className="sticky left-0 z-10 bg-gray-50 border-r border-gray-200 px-2 py-1.5 text-left font-semibold text-gray-600 min-w-[140px]">
                Staff
              </th>
              {slots.map(slot => {
                const isHourMark = slot.start.endsWith(':00');
                return (
                  <th
                    key={slot.start}
                    className={`px-1 py-1.5 text-center font-medium min-w-[28px] border-r border-gray-100 ${isHourMark ? 'text-gray-700' : 'text-gray-300'}`}
                  >
                    {isHourMark ? fmtSlotLabel(slot.start) : ''}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedNames.map(name => {
              const sub = subRoleStyleFor(day.subRoles?.[name]);
              const role = day.roles?.[name];
              const shift = shiftByName[name];
              const isHostRow   = role === 'Host';
              const isOnlineRow = role === 'Online Instructor';
              return (
                <tr key={name} className="border-t border-gray-100 hover:bg-gray-50/40">
                  <td className="sticky left-0 z-10 bg-white border-r border-gray-200 px-2 py-1 font-medium text-gray-800 truncate">
                    <div className="flex items-center gap-1.5">
                      <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${sub?.dot || 'bg-gray-300'}`} />
                      <span className="truncate">{name}</span>
                      {isHostRow && (
                        <span className="shrink-0 ml-1 rounded bg-amber-100 text-amber-700 px-1 text-[10px] font-bold uppercase">Host</span>
                      )}
                      {isOnlineRow && (
                        <span className="shrink-0 ml-1 rounded bg-indigo-100 text-indigo-700 px-1 text-[10px] font-bold uppercase">Online</span>
                      )}
                    </div>
                  </td>
                  {slots.map(slot => {
                    const sStart = toMinutes(slot.start);
                    const sEnd   = toMinutes(slot.end);
                    const inSlot = shift && shift.startMins < sEnd && shift.endMins > sStart;
                    const isHourMark = slot.start.endsWith(':00');
                    return (
                      <td key={slot.start} className={`p-0 ${isHourMark ? 'border-r border-gray-200' : 'border-r border-gray-50'}`}>
                        <div
                          className={`h-5 ${inSlot ? (sub?.blockBg || 'bg-blue-500') : 'bg-transparent'}`}
                          title={inSlot ? `${name} · ${day.shiftTimes?.[name] || ''}` : ''}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            {/* Teaching-instructor total row (the headline number) */}
            <tr className="border-t-2 border-gray-300 bg-blue-50/40">
              <td className="sticky left-0 z-10 bg-blue-50 border-r border-gray-300 px-2 py-1 font-bold text-blue-800">
                Instructors
              </td>
              {slotData.map(slot => {
                const isHourMark = slot.start.endsWith(':00');
                const isPeak = slot.teachingCount === peakTeaching && peakTeaching > 0;
                return (
                  <td key={slot.start} className={`px-1 py-1 text-center ${isHourMark ? 'border-r border-gray-200' : 'border-r border-gray-50'}`}>
                    <span className={`font-bold ${isPeak ? 'text-blue-700' : slot.teachingCount === 0 ? 'text-gray-300' : 'text-gray-600'}`}>
                      {slot.teachingCount}
                    </span>
                  </td>
                );
              })}
            </tr>

            {/* Total staff (incl. Host / Online) */}
            <tr className="border-t border-gray-200 bg-gray-50/60">
              <td className="sticky left-0 z-10 bg-gray-50 border-r border-gray-200 px-2 py-1 text-gray-500">
                All staff
              </td>
              {slotData.map(slot => {
                const isHourMark = slot.start.endsWith(':00');
                return (
                  <td key={slot.start} className={`px-1 py-1 text-center text-gray-500 ${isHourMark ? 'border-r border-gray-200' : 'border-r border-gray-50'}`}>
                    {slot.totalCount}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-gray-400 italic">
        "Instructors" only counts roles that fill the teaching ratio (Instructor / Lead / promoted Host). Hosts on admin time and Online instructors show as bars but are not counted.
      </p>
    </div>
  );
}
