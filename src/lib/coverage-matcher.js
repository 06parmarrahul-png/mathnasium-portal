/**
 * coverage-matcher.js — put people into the shifts the planner asked for.
 *
 * The planner emits anonymous skeletons ("someone, 16:00–19:00,
 * Elementary"). This decides WHO. It is deliberately a separate module
 * from both the planner and the existing generateSchedule engine:
 *   • the planner can be reasoned about without people in the picture
 *   • the live scheduler keeps working exactly as it does today
 *
 * FAIRNESS IS MEASURED IN MINUTES, NOT SHIFTS
 *   The existing engine counts shifts, which is a fine proxy while every
 *   shift is roughly a person's whole availability window. Under the
 *   coverage model shifts have deliberately different lengths, and the
 *   proxy inverts: someone with 4 × 2h shifts (8h) looks "busier" than
 *   someone with 3 × 4h (12h), so counting shifts would keep handing
 *   work to the person who already has the most of it. So we accrue
 *   minutes. Same blended-priority idea as the live engine, different
 *   unit — see PRIORITY_WEIGHT_MINUTES.
 *
 * MOST-CONSTRAINED FIRST
 *   Skeletons are filled in order of how few people can work them. Fill
 *   the easy ones first and you spend your flexible staff on shifts
 *   anyone could have covered, then strand the hard ones. Counting
 *   eligibility up front and starting with the scarcest is what stops
 *   that.
 */

import { toMinutes } from './coverage-planner';
import { hasCapability } from './subRoles';

// A priority level is worth this much "head start" in fairness terms.
// The live engine uses 3 SHIFTS; at a typical ~3h shift that's ~180
// minutes, so this keeps the two engines behaving comparably rather
// than making priority suddenly dominant or irrelevant.
export const PRIORITY_WEIGHT_MINUTES = 180;

/**
 * Can this person work this skeleton?
 *
 * Availability must COVER the whole block — a partial overlap would
 * leave the rest of the shift uncovered, which is worse than an honest
 * gap the owner can fill with an open shift.
 */
export function isEligible(candidate, skeleton) {
  if (!candidate || !skeleton) return false;
  if (candidate.unavailable) return false;

  // Capability. A skeleton with no capability is open to anyone.
  if (skeleton.capability && skeleton.capability !== 'Instructor') {
    if (!hasCapability(candidate.subRoles, skeleton.capability)) return false;
  }

  const availStart = toMinutes(candidate.availStart);
  const availEnd   = toMinutes(candidate.availEnd);
  const shiftStart = toMinutes(skeleton.startTime);
  const shiftEnd   = toMinutes(skeleton.endTime);
  if (availStart == null || availEnd == null) return false;
  if (shiftStart == null || shiftEnd == null) return false;

  return availStart <= shiftStart && availEnd >= shiftEnd;
}

/**
 * Assign people to one day's skeletons.
 *
 * @param {Object}   params
 * @param {Array}    params.skeletons  - from planDay(); {capability,startTime,endTime,minutes}
 * @param {Array}    params.candidates - {uid,displayName,subRoles,priority,availStart,availEnd}
 * @param {Object}   [params.minutesSoFar] - uid → minutes already assigned this run
 * @param {boolean}  [params.oneShiftPerPerson=true]
 * @returns {{ assignments, unfilled, minutesSoFar }}
 */
export function matchDay({
  skeletons = [],
  candidates = [],
  minutesSoFar = {},
  oneShiftPerPerson = true,
} = {}) {
  const running = { ...minutesSoFar };
  const takenToday = new Set();
  const assignments = [];
  const unfilled = [];

  // Order by scarcity: how many people could work each block at all.
  // Ties broken by length, so the long awkward blocks get first refusal
  // on whoever can actually do them.
  const ordered = skeletons
    .map((s, i) => ({
      skeleton: s,
      i,
      eligibleCount: candidates.filter(c => isEligible(c, s)).length,
    }))
    .sort((a, b) =>
      a.eligibleCount - b.eligibleCount
      || b.skeleton.minutes - a.skeleton.minutes
      || a.i - b.i);

  for (const { skeleton } of ordered) {
    const pool = candidates.filter(c =>
      isEligible(c, skeleton)
      && !(oneShiftPerPerson && takenToday.has(c.uid)));

    if (pool.length === 0) { unfilled.push(skeleton); continue; }

    // Lower score wins: priority head start, then whoever has the least
    // time on the books so far. This is the rule in plain terms — if one
    // person is on 12 hours and another on 3, the person on 3 gets it.
    const score = (c) =>
      (c.priority ?? 2) * PRIORITY_WEIGHT_MINUTES + (running[c.uid] || 0);

    pool.sort((a, b) =>
      score(a) - score(b)
      // Prefer the LESS flexible person for a specialised block, so
      // people who can cover several capabilities stay free for the
      // blocks that still need filling.
      || (a.subRoles?.length ?? 0) - (b.subRoles?.length ?? 0)
      || String(a.displayName || '').localeCompare(String(b.displayName || '')));

    const chosen = pool[0];
    takenToday.add(chosen.uid);
    running[chosen.uid] = (running[chosen.uid] || 0) + (skeleton.minutes || 0);
    assignments.push({
      uid: chosen.uid,
      displayName: chosen.displayName,
      capability: skeleton.capability,
      startTime: skeleton.startTime,
      endTime: skeleton.endTime,
      minutes: skeleton.minutes,
    });
  }

  return { assignments, unfilled, minutesSoFar: running };
}

/**
 * Shape one day's match into the object the existing draft UI already
 * renders, so the review / edit / publish flow is reused rather than
 * rebuilt. Mirrors the day shape generateSchedule() emits.
 */
export function toDraftDay({ dateStr, dayName, dayNumber, assignments, unfilled }) {
  const shiftTimes = {};
  const roles = {};
  const subRoles = {};
  for (const a of assignments) {
    shiftTimes[a.displayName] = `${a.startTime} - ${a.endTime}`;
    roles[a.displayName] = a.capability === 'Host' ? 'Host' : 'Instructor';
    if (a.capability && a.capability !== 'Instructor' && a.capability !== 'Host') {
      subRoles[a.displayName] = a.capability;
    }
  }
  return {
    date: dateStr,
    dayOfWeek: dayName,
    dayNumber,
    assignedEmployees: assignments.map(a => a.displayName),
    availableEmployees: assignments.map(a => a.displayName),
    shiftTimes,
    roles,
    subRoles,
    countingStaffCount: assignments.filter(a => a.capability !== 'Host').length,
    onlineCount: assignments.filter(a => a.capability === 'Online').length,
    openSlotsNeeded: unfilled.length,
    // Carried through so the review screen can show exactly which blocks
    // nobody could work, rather than just a count.
    unfilledShifts: unfilled.map(s => ({
      capability: s.capability, startTime: s.startTime, endTime: s.endTime,
    })),
  };
}

/** Total assigned minutes per person, for a fairness read-out. */
export function hoursByPerson(minutesSoFar = {}) {
  return Object.fromEntries(
    Object.entries(minutesSoFar).map(([uid, mins]) => [uid, Math.round((mins / 60) * 10) / 10]),
  );
}
