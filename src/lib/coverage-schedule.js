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

export function generateCoverageSchedule({
  days = [],
  curvesByWeekday = {},
  curvesByDate = {},
  instructors = [],
  availabilityByDate = {},
  minShiftMinutes = 120,
  requireHost = true,
  hostNames = [],
} = {}) {
  const warnings = [];
  const minutesSoFar = {};
  const daysWorked = {};          // uid → count of days assigned this run
  const shiftsByName = {};        // displayName → shift count (draft UI reads this)
  const daysAvailable = {};       // uid → dates they submitted availability for
  const byUid = new Map(instructors.map(i => [i.uid, i]));
  const draftDays = [];

  for (const day of days) {
    // Centre closed — a stat holiday or a day the centre doesn't run.
    // Emit the day anyway, flagged, rather than dropping it: a date that
    // silently disappears from a draft looks like a bug, and the owner
    // needs to see that the 7th is Labour Day, not wonder where it went.
    if (day.closed) {
      draftDays.push({
        ...toDraftDay({ ...day, assignments: [], unfilled: [] }),
        closed: true,
        closureReason: day.closed,
      });
      continue;
    }

    // Real bookings for THIS date beat a weekday pattern. The pattern is
    // the fallback for dates far enough out that nothing is booked yet.
    const requirements = curvesByDate[day.dateStr]?.length
      ? curvesByDate[day.dateStr]
      : curvesByWeekday[day.dayName];
    if (!requirements || requirements.length === 0) {
      // Nothing to schedule from. This is the state that reads as "0/0"
      // and looks broken, so the day carries the reason the caller worked
      // out (no bookings / bookings outside this day's hours) rather than
      // leaving the owner to guess.
      const reason = day.demandNote || 'No students are booked on this date.';
      draftDays.push({
        ...toDraftDay({ ...day, assignments: [], unfilled: [] }),
        emptyReason: reason,
        notes: [],
      });
      warnings.push(`${day.dayName} ${day.dayNumber}: ${reason}`);
      continue;
    }

    // A host covers the front of house for the whole open day, every day
    // the centre runs — it isn't driven by how many students are booked,
    // so it's added as its own flat requirement rather than coming out of
    // the demand curve. preferredNames carries the centre's designated
    // host: they take it whenever they're available, and it falls to
    // anyone else host-capable when they aren't.
    const withHost = requireHost && day.slotKeys.length > 0
      ? [...requirements, {
          capability: 'Host',
          required: day.slotKeys.map(() => 1),
          preferredNames: hostNames,
        }]
      : requirements;

    const { shifts, warnings: planWarnings } = planDay({
      requirements: withHost,
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
        // Counted before any filtering, so "did they offer time?" stays
        // answerable even for people the engine won't roster.
        daysAvailable[inst.uid] = (daysAvailable[inst.uid] || 0) + 1;
        // Trainees shadow a real instructor rather than covering a slot,
        // so they must not be used to satisfy demand — counting them
        // would make the floor look staffed when one of the two is
        // watching. They stay in the summary, labelled.
        if (inst.excludeFromMatching) return null;
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

    const { assignments, unfilled, minutesSoFar: next, notes } = matchDay({
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

    draftDays.push({
      ...toDraftDay({ ...day, assignments, unfilled }),
      // Per-day explanation of anything surprising — most often why the
      // designated host didn't get the host block. Surfaced on the day
      // itself rather than pooled into the run-wide warning list, because
      // the question is always asked while looking at one day.
      notes,
      emptyReason: assignments.length === 0
        ? (day.demandNote || 'No coverage was required for this day.')
        : null,
    });
    for (const n of notes) warnings.push(`${day.dayName} ${day.dayNumber}: ${n}`);
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
    // Per-person detail so a zero can be explained rather than just
    // displayed. "0 shifts" is the same pixel whether someone never
    // submitted availability, offered time and wasn't needed, or is a
    // trainee the engine deliberately skips.
    summaryDetail: Object.fromEntries(instructors.map(i => [i.displayName, {
      shifts: shiftsByName[i.displayName] || 0,
      hours: Math.round(((minutesSoFar[i.uid] || 0) / 60) * 10) / 10,
      daysAvailable: daysAvailable[i.uid] || 0,
      reason: i.excludeReason || null,
    }])),
    // Hours keyed by NAME, because that's what the review screen lists
    // people by — the number the engine actually balanced on.
    hoursByName: Object.fromEntries(
      instructors
        .filter(i => (minutesSoFar[i.uid] || 0) > 0)
        .map(i => [i.displayName, Math.round((minutesSoFar[i.uid] / 60) * 10) / 10]),
    ),
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
