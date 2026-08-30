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
 * Head start a Lead gets over a plain instructor for the same block.
 *
 * Deliberately a head start rather than a hard rule. Sorting Leads
 * strictly above instructors would hand them every shift and starve
 * everyone else, which is the failure the blended-priority design exists
 * to avoid. At roughly one shift's worth of minutes, a Lead goes first
 * while the two are close, and an instructor who's been passed over
 * enough still overtakes them.
 */
export const LEAD_HEAD_START_MINUTES = 180;

/**
 * How far a named preferred person outranks everyone else for a block.
 *
 * Large enough that the centre's designated host takes the host shift
 * whenever they're available, small enough that it's still a preference:
 * if they're not available, or already booked that day, the block falls
 * to anyone else who can host rather than going unfilled.
 */
export const PREFERRED_HEAD_START_MINUTES = 100000;

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
  //
  // Being NAMED for a block implies the capability for it. The centre's
  // designated host is the host by definition; requiring the Host box to
  // also be ticked in Manage Staff makes the same fact true in two
  // places, and the day it isn't, the host block quietly goes to someone
  // else with no way to see why.
  if (skeleton.capability && skeleton.capability !== 'Instructor') {
    const named = (skeleton.preferredNames || []).some(
      n => String(n).trim().toLowerCase() === String(candidate.displayName || '').trim().toLowerCase());
    if (!named && !hasCapability(candidate.subRoles, skeleton.capability)) return false;
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
  // Why a named person (the designated host, usually) didn't get the
  // block meant for them. "Rahul should be host and isn't" has four very
  // different causes and they're indistinguishable from the roster alone,
  // so the engine says which one it hit.
  const notes = [];

  const nameKey = (n) => String(n || '').trim().toLowerCase();

  const explainPreferredMiss = (skeleton, chosenName) => {
    const wanted = skeleton.preferredNames || [];
    if (wanted.length === 0) return;
    if (wanted.some(n => nameKey(n) === nameKey(chosenName))) return;
    for (const name of wanted) {
      const who = candidates.find(c => nameKey(c.displayName) === nameKey(name));
      const block = `${skeleton.capability || 'shift'} ${skeleton.startTime}–${skeleton.endTime}`;
      if (!who) {
        // Careful with this one: by the time the matcher sees a day, the
        // caller has already dropped anyone over their max-days-per-week.
        // "Didn't submit availability" would be a confident wrong answer.
        notes.push(
          `${name} wasn't in the pool for this day — no availability submitted, or already at `
          + `their maximum days for the week. ${block} went to ${chosenName || 'nobody'}.`);
      } else if (skeleton.capability && skeleton.capability !== 'Instructor'
                 && !hasCapability(who.subRoles, skeleton.capability)) {
        notes.push(
          `${name} isn't ticked as able to ${skeleton.capability} in Manage Staff, `
          + `so ${block} went to ${chosenName || 'nobody'}.`);
      } else if (takenToday.has(who.uid) && oneShiftPerPerson) {
        notes.push(`${name} was already on another shift, so ${block} went to ${chosenName || 'nobody'}.`);
      } else if (!isEligible(who, skeleton)) {
        notes.push(
          `${name} is only free ${who.availStart}–${who.availEnd}, which doesn't cover `
          + `${block} — it went to ${chosenName || 'nobody'}.`);
      }
    }
  };

  // Blocks with a NAMED person go first, then the scarcest.
  //
  // Scarcity alone was wrong, and wrong in a way that looked random. A
  // person can only hold one shift a day, so whichever block is filled
  // first keeps them. When several staff can host, the host block has a
  // HIGH eligible count and sorts late — by which time an ordinary
  // instructor block has already taken the designated host, and the host
  // shift falls to whoever else is left. Across a week that produced the
  // designated host covering host on one day and instructing on the rest,
  // with no obvious pattern.
  //
  // Naming someone is a stronger statement than scarcity: it says this
  // block is theirs. So those blocks get first refusal.
  const ordered = skeletons
    .map((s, i) => ({
      skeleton: s,
      i,
      hasPreferred: (s.preferredNames || []).length > 0 ? 0 : 1,
      eligibleCount: candidates.filter(c => isEligible(c, s)).length,
    }))
    .sort((a, b) =>
      a.hasPreferred - b.hasPreferred
      || a.eligibleCount - b.eligibleCount
      || b.skeleton.minutes - a.skeleton.minutes
      || a.i - b.i);

  for (const { skeleton } of ordered) {
    const pool = candidates.filter(c =>
      isEligible(c, skeleton)
      && !(oneShiftPerPerson && takenToday.has(c.uid)));

    if (pool.length === 0) {
      explainPreferredMiss(skeleton, null);
      unfilled.push(skeleton);
      continue;
    }

    // Who this block is meant for, if anyone — e.g. the centre's
    // designated host. Compared on name because that's how the existing
    // centerConfig.autoHostNames setting identifies people.
    const preferred = new Set(
      (skeleton.preferredNames || []).map(n => String(n).trim().toLowerCase()));
    const isPreferred = (c) =>
      preferred.size > 0 && preferred.has(String(c.displayName || '').trim().toLowerCase());

    // Lower score wins: priority head start, then whoever has the least
    // time on the books so far. This is the rule in plain terms — if one
    // person is on 12 hours and another on 3, the person on 3 gets it.
    //
    // Two head starts sit on top of that, both subtractive so they lead
    // without ever becoming absolute: the block's preferred person, and
    // Leads over plain instructors.
    const score = (c) =>
      (c.priority ?? 2) * PRIORITY_WEIGHT_MINUTES
      + (running[c.uid] || 0)
      - (isPreferred(c) ? PREFERRED_HEAD_START_MINUTES : 0)
      - (c.isLead ? LEAD_HEAD_START_MINUTES : 0);

    pool.sort((a, b) =>
      score(a) - score(b)
      // Prefer the LESS flexible person for a specialised block, so
      // people who can cover several capabilities stay free for the
      // blocks that still need filling.
      || (a.subRoles?.length ?? 0) - (b.subRoles?.length ?? 0)
      || String(a.displayName || '').localeCompare(String(b.displayName || '')));

    const chosen = pool[0];
    explainPreferredMiss(skeleton, chosen.displayName);
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

  return { assignments, unfilled, minutesSoFar: running, notes };
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
    // What this day actually asked for = filled + couldn't-fill. The
    // review screen compares against this instead of the classic
    // engine's min-per-day, which is a headcount setting that means
    // nothing once the curve decides the number. A classic draft omits
    // it and the screen falls back, so both engines read correctly.
    targetStaffCount: assignments.filter(a => a.capability !== 'Host').length + unfilled.length,
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
