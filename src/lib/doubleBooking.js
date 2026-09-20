/**
 * doubleBooking.js — one shift a day, per person.
 *
 * Nothing used to check this. An instructor already rostered on the Monday
 * could still claim Monday's open shift off the board, or take somebody's
 * Monday swap, and end up holding two shifts on the same date. The schedule
 * accepted it silently, the ratio maths counted the person twice, and the
 * first anyone knew of it was the day itself.
 *
 * Three self-serve pickup paths could do it — Claim on the Shift Board,
 * Take on a swap request, and Claim inside the Schedule day modal — so the
 * rule lives here rather than three times over.
 *
 * WHAT COUNTS AS "ALREADY WORKING"
 *   Any shift of theirs on that date that somebody actually works. Drafts
 *   don't count: instructors can't see them, so blocking on one would be a
 *   locked button with no visible reason. Cancellations don't count either —
 *   that is the point of cancelling. isLiveShift() draws the same line the
 *   rest of the app draws.
 *
 * SAME DATE, NOT OVERLAPPING HOURS
 *   Deliberate. A 3–5 and a 5–7 on the same day don't collide on the clock,
 *   but they're still two shifts in one day for one person, which is the
 *   thing being prevented.
 *
 * WHAT THIS IS NOT
 *   Not a security control. Firestore rules can't run this query, so a
 *   determined client could still write the row. Ops staff assigning shifts
 *   from the Admin panel are untouched on purpose — that path is somebody
 *   deciding deliberately, and it stays the way to roster a genuine double.
 */

import { isLiveShift } from './snapshotGrid';

/** 24h "15:00" → "3:00 PM". Local to the message builders below. */
function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = String(t).split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return '';
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * The shift itself, if it's one that blocks a pickup — otherwise null.
 *
 * For callers that have already narrowed to a single day and hold one
 * candidate shift, so "does a draft count?" is answered here rather than
 * re-decided at the call site.
 */
export function blockingShift(shift) {
  return isLiveShift(shift) ? shift : null;
}

/**
 * The shift this person already works on `date`, or null.
 *
 * Returns the document rather than a boolean because every caller wants to
 * say WHICH shift is in the way — a bare "you can't" is the kind of message
 * people bring to an admin to have explained.
 */
export function shiftOnDate(shifts, uid, date) {
  if (!uid || !date) return null;
  return (shifts || []).find(
    s => s && s.userId === uid && s.date === date && isLiveShift(s),
  ) || null;
}

/** Would picking this date up leave them with two shifts in one day? */
export function isDoubleBooked(shifts, uid, date) {
  return shiftOnDate(shifts, uid, date) !== null;
}

/**
 * "3:00 PM – 7:00 PM", or '' when the shift has no usable times — legacy
 * rows do exist, and half a range reads worse than none.
 */
function hoursOf(shift) {
  const from = fmtTime(shift?.startTime);
  const to   = fmtTime(shift?.endTime);
  return from && to ? `${from} – ${to}` : '';
}

/** Short label for a disabled button — no room for a sentence. */
export function conflictLabel(shift) {
  const hours = hoursOf(shift);
  return hours ? `Already on ${hours}` : 'Already working this day';
}

/** The full sentence, for a tooltip or a toast. */
export function conflictReason(shift) {
  const hours = hoursOf(shift);
  return hours
    ? `You already work this day (${hours}). Speak to a centre admin if you need a second shift.`
    : 'You already work this day. Speak to a centre admin if you need a second shift.';
}
