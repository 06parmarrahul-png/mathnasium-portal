/**
 * Saying when a student actually leaves.
 *
 * THE PROBLEM, from 1 October 2026: the on-the-hour column holds everybody
 * who starts at 3:00, and until now they all left at 4:00. The half-hour
 * in-centre block puts Great Foundations students in that same column
 * leaving at 3:30, and on the sheet they looked identical to the rest — so
 * an instructor would keep a six-year-old at the desk half an hour past
 * their session, or miss that a desk frees up mid-slot.
 *
 * ONLY SHORTER-THAN-STANDARD SESSIONS ARE MARKED, and that asymmetry is
 * deliberate. A LONGER session is already visible: the Highschool side
 * pulls anything that isn't an hour into its own 1.5 hr column, so the
 * column itself says it. A SHORTER one has nowhere else to go — it sits in
 * the on-hour column beside the full-hour students — so it is the only
 * case the sheet cannot express on its own. Badging the long ones as well
 * would add a chip that repeats its own column heading, on a sheet that
 * gets printed and read at a glance mid-shift.
 */

/** What a session is assumed to be when nothing says otherwise. */
export const STANDARD_MINUTES = 60;

/**
 * '30 min' for a session shorter than the standard hour, null for anything
 * else — including a missing or malformed duration, where inventing a
 * badge would be worse than staying quiet.
 *
 * Spelled out rather than '30m' because this sheet gets PRINTED and read
 * at arm's length in the middle of a shift.
 */
export function shortSessionLabel(duration) {
  const mins = Math.round(Number(duration));
  if (!Number.isFinite(mins) || mins <= 0) return null;
  if (mins >= STANDARD_MINUTES) return null;
  return `${mins} min`;
}

/**
 * Minutes past midnight at which a student on `slot` actually gets up, or
 * null when either part is missing.
 *
 * RETURNS MINUTES, NOT A CLOCK FACE. Whether the reader sees "3:30 PM" or
 * "15:30" is their own setting, and the one place that knows it is
 * useTimeFormat() in the component — see src/lib/timeFormat.js, and the
 * scan test that stops a thirteenth hand-rolled formatter appearing.
 *
 * Works off the slot KEY rather than the booking's timestamp on purpose:
 * the key is already centre-local ("15:00"), so there is no zone to get
 * wrong.
 */
export function sessionEndMinutes(slot, duration) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slot ?? '').trim());
  const mins = Math.round(Number(duration));
  if (!m || !Number.isFinite(mins) || mins <= 0) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + mins;
}
