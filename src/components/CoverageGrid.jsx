import { Fragment, useMemo } from 'react';
import { assignmentFor, assignmentShort, assignmentColorHex, contrastText } from '../lib/centerConfig';

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

// 3-tier ordering for Today's Snapshot:
//   0 = Important staff (Hosts + Management — Manager, Director, Admin, etc.)
//       These run the centre; they should sit at the top of the grid.
//   1 = Online instructors — bars only, don't count toward teaching ratio.
//   2 = In-centre instructors (Instructor + Lead) — the teaching workforce.
// Bold dividers separate the three groups in the rendered table.
//
// Checks BOTH role and subRole because most centres tag online staff as
// role:'Instructor' + subRole:'Online' rather than role:'Online Instructor'.
const rolePriority = (role, subRole) => {
  if (role === 'Online Instructor' || subRole === 'Online') return 1;
  if (role === 'Instructor' || role === 'Lead')             return 2;
  // Everything else (Host, Manager, Director, Admin, Director of Education,
  // Centre Director, …) is "important staff".
  return 0;
};

export default function CoverageGrid({ day, centerConfig }) {
  const slots = useMemo(() => generateSlots(day.dayOfWeek), [day.dayOfWeek]);

  // Normalise input to a list of per-SHIFT entries. Each entry is one
  // shift on the day, so one person with two shifts (e.g. LEAD 11–3
  // AND HOST 3–7) gets two entries with distinct roles + times instead
  // of name-keyed maps that silently overwrote each other.
  //
  // - New format (`day.shiftEntries`): preferred — caller already has
  //   per-shift data with stable keys.
  // - Legacy format (`day.assignedEmployees` + name-keyed maps): kept
  //   for callers like the auto-scheduler draft editor that don't ship
  //   duplicates. Each name becomes a single entry.
  const entries = useMemo(() => {
    if (Array.isArray(day.shiftEntries) && day.shiftEntries.length > 0) {
      return day.shiftEntries.map((e, i) => ({
        key:       e.key || `${e.name}|${i}`,
        name:      e.name,
        role:      e.role || 'Instructor',
        subRole:   e.subRole,
        shiftTime: e.shiftTime,
        sickPay:   !!e.sickPay,
      }));
    }
    return (day.assignedEmployees || []).map((name, i) => ({
      key:       `${name}|${i}`,
      name,
      role:      day.roles?.[name] || 'Instructor',
      subRole:   day.subRoles?.[name],
      shiftTime: day.shiftTimes?.[name],
      sickPay:   !!day.sickPay?.[name],
    }));
  }, [day.shiftEntries, day.assignedEmployees, day.roles, day.subRoles, day.shiftTimes, day.sickPay]);

  // Sort by tier, then by name within tier. Two entries for the same
  // person stay adjacent (same name, same tier) but each shows its own
  // role badge + bar.
  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      const dp = rolePriority(a.role, a.subRole) - rolePriority(b.role, b.subRole);
      if (dp !== 0) return dp;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  // Pre-parse each entry's shift once (keyed by entry key, not name —
  // a person with two shifts needs two parses).
  const shiftByKey = useMemo(() => {
    const m = {};
    for (const e of sortedEntries) m[e.key] = parseShift(e.shiftTime);
    return m;
  }, [sortedEntries]);

  // Per-slot counts (teaching + total). Teaching counts every teaching
  // SHIFT in the slot (so Bri's LEAD 11–3 counts in 11–3 and her HOST
  // 3–7 doesn't, even though they're the same person). Total counts
  // distinct PEOPLE so two overlapping shifts for one body still read
  // as one body in the room.
  const slotData = useMemo(() => {
    return slots.map(slot => {
      const sStart = toMinutes(slot.start);
      const sEnd   = toMinutes(slot.end);
      let teachingCount = 0;
      const namesPresent = new Set();
      for (const e of sortedEntries) {
        const shift = shiftByKey[e.key];
        if (!shift) continue;
        if (shift.startMins < sEnd && shift.endMins > sStart) {
          namesPresent.add(e.name);
          if (TEACHING_ROLES.has(e.role)) teachingCount++;
        }
      }
      return { ...slot, teachingCount, totalCount: namesPresent.size };
    });
  }, [slots, sortedEntries, shiftByKey]);

  const peakTeaching = slotData.reduce((mx, s) => Math.max(mx, s.teachingCount), 0);
  const peakSlot = slotData.find(s => s.teachingCount === peakTeaching && peakTeaching > 0);

  // Distinct head-count for the summary bar — one person scheduled twice
  // is still one body in the room.
  const distinctStaff = useMemo(() => new Set(sortedEntries.map(e => e.name)).size, [sortedEntries]);

  if (sortedEntries.length === 0) {
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
          <span>{distinctStaff} staff total{sortedEntries.length > distinctStaff && (
            <> · {sortedEntries.length} shifts</>
          )}</span>
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
            {sortedEntries.map((entry, idx) => {
              const { name, role, subRole, shiftTime, sickPay: isSick } = entry;
              const shift = shiftByKey[entry.key];
              // Bold dividers between the three tiers so the staff list
              // reads "important staff → online → in-centre instructors"
              // at a glance. Insert a section header before the FIRST
              // row of each tier whose priority is new.
              const myPriority = rolePriority(role, subRole);
              const prevPriority = idx === 0
                ? -1
                : rolePriority(sortedEntries[idx - 1].role, sortedEntries[idx - 1].subRole);
              const isFirstOfTier = myPriority !== prevPriority;
              const tierLabel = myPriority === 0 ? 'Hosts & Management'
                              : myPriority === 1 ? 'Online Instructors'
                              : 'In-Centre Instructors';
              const colspan = 1 + slots.length;
              // Derive a single clean assignment label per shift ("Manager",
              // "Highschool Instructor", "Host", "Online Instructor", etc.)
              // and use the centre's assignment-colour palette so BOTH the
              // bar AND the badge use the role's colour — matches the chip
              // on the right of each row.
              const assignment = assignmentFor({ role, subRole });
              const roleBg = isSick ? '#7f1d1d' : assignmentColorHex(assignment, centerConfig);
              const roleText = contrastText(roleBg);
              const badgeLabel = isSick ? 'SICK' : assignmentShort(assignment);
              const badgeTooltip = isSick ? `${assignment} · Sick Pay` : assignment;
              // Flag rows where the same person has another entry on the
              // day — gives an at-a-glance "this is one of two shifts for
              // this person today" cue so it doesn't look like a duplicate.
              const sameNameCount = sortedEntries.reduce((n, e) => e.name === name ? n + 1 : n, 0);
              const isDoubleBooked = sameNameCount > 1;
              return (
                <Fragment key={entry.key}>
                  {isFirstOfTier && (
                    <tr className="bg-gray-50 border-y-2 border-gray-300">
                      <td colSpan={colspan}
                        className="sticky left-0 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-600 bg-gray-50">
                        {tierLabel}
                      </td>
                    </tr>
                  )}
                <tr className="border-t border-gray-100 hover:bg-gray-50/40">
                  <td className="sticky left-0 z-10 bg-white border-r border-gray-200 px-2 py-1 font-medium text-gray-800 truncate min-w-[180px]">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="shrink-0 w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: roleBg }}
                      />
                      <span className="truncate">{name}</span>
                      {isDoubleBooked && (
                        <span
                          className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-bold uppercase tracking-wide text-amber-700"
                          title={`${name} has ${sameNameCount} shifts today`}
                        >
                          ×{sameNameCount}
                        </span>
                      )}
                      <span
                        className="shrink-0 ml-auto rounded px-1.5 text-[10px] font-bold uppercase tracking-wide"
                        style={{ backgroundColor: roleBg, color: roleText }}
                        title={badgeTooltip}
                      >
                        {badgeLabel}
                      </span>
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
                          className="h-5"
                          style={inSlot ? { backgroundColor: roleBg } : undefined}
                          title={inSlot ? `${name}${isSick ? ' (sick)' : ''} · ${shiftTime || ''}` : ''}
                        />
                      </td>
                    );
                  })}
                </tr>
                </Fragment>
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
