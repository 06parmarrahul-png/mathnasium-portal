/**
 * coverage-schedule.js — the curve-driven scheduler, end to end.
 *
 *   demand curve → shift skeletons → people → draft days
 *      (planner)      (planner)     (matcher)   (here)
 *
 * This is a SECOND engine. generateSchedule() in scheduler.js is
 * untouched and still runs everything live; this one is opt-in from the
 * Auto-Scheduler panel so the two can be compared on real months before
 * anything depends on it. Both emit the same draft-day shape, so the
 * existing review / edit / publish flow works with either.
 *
 * Fairness accrues ACROSS the whole run, not per day — that's what makes
 * a month generated in one go rotate evenly instead of handing Monday's
 * regulars every Monday. Measured in minutes, for the reason spelled out
 * in coverage-matcher.js.
 */

import { planDay } from './coverage-planner';
import { matchDay, toDraftDay } from './coverage-matcher';

/**
 * @param {Object} params
 * @param {Array}  params.days              - [{ dateStr, dayName, dayNumber, slotKeys }]
 * @param {Object} params.curvesByWeekday   - { Monday: [{ capability, required:number[] }] }
 * @param {Array}  params.instructors       - [{ uid, displayName, subRoles, priority }]
 * @param {Object} params.availabilityByDate- { 'YYYY-MM-DD': [{ userId, startTime, endTime }] }
 * @param {number} [params.minShiftMinutes=120]
 * @param {number} [params.maxDaysPerWeek]  - falls back to each instructor's own setting
 */
export function generateCoverageSchedule({
  days = [],
  curvesByWeekday = {},
  instructors = [],
  availabilityByDate = {},
  minShiftMinutes = 120,
} = {}) {
  const warnings = [];
  const minutesSoFar = {};
  const daysWorked = {};          // uid → count of days assigned this run
  const shiftsByName = {};        // displayName → shift count (draft UI reads this)
  const byUid = new Map(instructors.map(i => [i.uid, i]));
  const draftDays = [];

  for (const day of days) {
    const requirements = curvesByWeekday[day.dayName];
    if (!requirements || requirements.length === 0) {
      // No shape for this weekday is a deliberate "we're shut / nothing
      // planned", not an error — but say so once rather than silently
      // producing an empty day the owner has to puzzle over.
      draftDays.push(toDraftDay({ ...day, assignments: [], unfilled: [] }));
      continue;
    }

    const { shifts, warnings: planWarnings } = planDay({
      requirements,
      slotStarts: day.slotKeys,
      minShiftMinutes,
    });
    for (const w of planWarnings) warnings.push(`${day.dayName} ${day.dayNumber}: ${w}`);

    // Who offered time on this specific date, folded together with their
    // profile so the matcher sees one object per person.
    const candidates = (availabilityByDate[day.dateStr] || [])
      .map(a => {
        const inst = byUid.get(a.userId);
        if (!inst) return null;
        const cap = inst.maxDaysPerWeek;
        if (Number.isFinite(cap) && (daysWorked[inst.uid] || 0) >= cap) return null;
        return {
          uid: inst.uid,
          displayName: inst.displayName,
          subRoles: inst.subRoles,
          priority: inst.priority,
          availStart: a.startTime,
          availEnd: a.endTime,
        };
      })
      .filter(Boolean);

    const { assignments, unfilled, minutesSoFar: next } = matchDay({
      skeletons: shifts,
      candidates,
      minutesSoFar,
    });
    Object.assign(minutesSoFar, next);
    for (const a of assignments) {
      daysWorked[a.uid] = (daysWorked[a.uid] || 0) + 1;
      shiftsByName[a.displayName] = (shiftsByName[a.displayName] || 0) + 1;
    }

    if (unfilled.length > 0) {
      warnings.push(
        `⚠ ${day.dayName} ${day.dayNumber}: ${unfilled.length} shift${unfilled.length > 1 ? 's' : ''} ` +
        `nobody available could cover — post as open shift${unfilled.length > 1 ? 's' : ''}.`,
      );
    }

    draftDays.push(toDraftDay({ ...day, assignments, unfilled }));
  }

  return {
    days: draftDays,
    warnings,
    // Shape the draft review screen expects from EITHER engine:
    // displayName → number of shifts. Keyed by name, not uid, because
    // that's what the summary table renders. Omitting it is what crashed
    // the page the first time this engine ran — Object.entries(undefined).
    employeeSummary: everyoneInSummary(shiftsByName, instructors),
    minutesByPerson: minutesSoFar,
    // Spread of hours across everyone who got work — the number that
    // tells you at a glance whether the rotation came out even.
    fairness: summariseFairness(minutesSoFar, instructors),
  };
}

/**
 * Everyone who was in the running, including the people who ended up with
 * nothing. A summary that silently omits the instructor who got zero
 * shifts hides exactly the case an owner most needs to notice.
 */
function everyoneInSummary(shiftsByName, instructors) {
  const out = {};
  for (const inst of instructors) {
    if (inst?.displayName) out[inst.displayName] = 0;
  }
  return { ...out, ...shiftsByName };
}

function summariseFairness(minutesSoFar, instructors) {
  const vals = instructors
    .map(i => (minutesSoFar[i.uid] || 0) / 60)
    .filter(h => h > 0);
  if (vals.length === 0) return { min: 0, max: 0, spread: 0, staffed: 0 };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return {
    min: Math.round(min * 10) / 10,
    max: Math.round(max * 10) / 10,
    spread: Math.round((max - min) * 10) / 10,
    staffed: vals.length,
  };
}
