/**
 * board-budget.js — what a day's placements cost against its staffing budget.
 *
 * Pure, so it can be tested. This decides whether the owner is told they have
 * room for another body or that they're over budget, which is a payroll
 * decision — it shouldn't live untestable inside a component.
 *
 * BUCKETS COME FROM THE SAME PLACE AS THE BUDGET PAGE
 *   `bucketHoursForShift` splits a floor shift at the instructional window
 *   (inside → Instructional, outside → Admin Hours) and treats a host shift as
 *   Host end to end. Reusing it means the board and the Staffing Budget page
 *   can't drift into disagreeing about the same shift.
 *
 * WHY IT'S MEASURED AGAINST A SLICE, NOT THE WHOLE DAY
 *   A Wednesday is budgeted 52h, but that covers Online and STEAM work too,
 *   which is scheduled somewhere else. The board creates floor, host and
 *   admin-assistant shifts, so it's measured against instructional + host +
 *   adminAssistant + adminHours (44h on a Wednesday). Counting board
 *   placements against the full 52h would invite spending the online and
 *   STEAM allocation a second time.
 */

import { WEEKDAY_DEFAULTS, bucketHoursForShift, BUDGET_BUCKETS } from './budgetBuckets';

/**
 * The buckets shifts created on this board can land in.
 *
 * `adminAssistant` is here because the board schedules the admin assistant's
 * pre-open shift alongside the floor — it's the same fixed, non-instructional
 * pattern as the host desk. Online and STEAM are still absent: they're
 * budgeted on the same day but scheduled elsewhere.
 */
export const BOARD_BUCKETS = ['instructional', 'host', 'adminAssistant', 'adminHours'];

/**
 * The shift role each slot kind writes. These strings are what
 * `wholeShiftBucket` keys off, so they must match the values the rest of the
 * app stores: 'Host' → host, 'Admin' → adminAssistant, anything else splits
 * at the instructional window.
 */
export const SLOT_ROLE = {
  host: 'Host',
  admin: 'Admin',
  coverage: 'Instructor',
};

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Hours between two 'HH:MM' times; 0 when either is unreadable or inverted. */
export function slotHours(slot) {
  const s = toMin(slot?.start);
  const e = toMin(slot?.end);
  if (s == null || e == null || e <= s) return 0;
  return (e - s) / 60;
}

/**
 * @param {Object} day  { dayName, instrWindow, slots: [{ start, end, kind, assigned }] }
 * @returns {Object} budget summary — see the fields below.
 */
export function boardBudget(day) {
  const allotted = WEEKDAY_DEFAULTS[day?.dayName] || {};
  const used = {};

  for (const slot of day?.slots || []) {
    if (!slot?.assigned) continue;
    const hrs = slotHours(slot);
    if (hrs <= 0) continue;
    const buckets = bucketHoursForShift(
      {
        startTime: slot.start,
        endTime: slot.end,
        role: SLOT_ROLE[slot.kind] || 'Instructor',
      },
      hrs,
      day?.instrWindow || null,
    );
    for (const [k, v] of Object.entries(buckets)) used[k] = (used[k] || 0) + v;
  }

  const boardAllotted = BOARD_BUCKETS.reduce((n, k) => n + (Number(allotted[k]) || 0), 0);
  const boardUsed = BOARD_BUCKETS.reduce((n, k) => n + (used[k] || 0), 0);
  const fullDay = Object.values(allotted).reduce((n, v) => n + (Number(v) || 0), 0);

  return {
    used,
    allotted,
    boardUsed,
    boardAllotted,
    fullDay,
    // Budgeted for this day but spent by work the board doesn't schedule.
    elsewhere: fullDay - boardAllotted,
    remaining: boardAllotted - boardUsed,
    over: boardUsed > boardAllotted,
    buckets: BOARD_BUCKETS
      .filter(k => (Number(allotted[k]) || 0) > 0 || (used[k] || 0) > 0)
      .map(k => {
        const meta = BUDGET_BUCKETS.find(b => b.key === k);
        return {
          key: k,
          label: meta?.label || k,
          color: meta?.color || '#666',
          used: used[k] || 0,
          allotted: Number(allotted[k]) || 0,
        };
      }),
  };
}
