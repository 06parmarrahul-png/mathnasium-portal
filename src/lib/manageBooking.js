/**
 * manageBooking.js — what a family may do to their own assessment.
 *
 * WHY THIS EXISTS
 *   The reminder text asks people to reply 1 to confirm, 2 to cancel, 3 to
 *   reschedule — and the third one has nowhere to land. Rescheduling by
 *   SMS reply means a conversation with somebody at the centre. This is
 *   the page that conversation becomes: the family open their own booking
 *   from a link, and confirm, cancel or move it themselves.
 *
 * ASSESSMENTS ONLY, AND THAT IS NOT AN OVERSIGHT. Sessions come from
 * Acuity over a ONE-WAY iCal feed; Ratio reads them and has no way to
 * write one back. A "swap" of a session here would move it on this screen,
 * Acuity would keep the original, and the next feed read would put it
 * back — two systems disagreeing about where a child is meant to be,
 * which is worse than no button. Assessments live in `centerIntakes`,
 * which Ratio owns end to end, so they are the ones that can move.
 *
 * THE LINK IS THE CREDENTIAL. There is no login — a parent has an SMS and
 * an email, not an account. Each booking carries a 24-character token that
 * `api/intakes.js` has minted since the booking page shipped (and nothing
 * read until now). The token names one booking and grants nothing else.
 *
 * PURE MODULE — no React, no Firebase.
 */

/**
 * How close to the appointment somebody may still move it themselves.
 *
 * Two hours. Long enough that the 24-hour reminder is always actionable,
 * short enough that a cancellation still reaches the centre in time to
 * use the slot. Inside it the page says to ring the centre instead,
 * because at that point a person needs to know, not a database row.
 */
export const MIN_NOTICE_HOURS = 2;

/** Statuses a booking can be in, as the create path writes them. */
export const CANCELLED = 'cancelled';
export const CONFIRMED = 'confirmed';
export const SCHEDULED = 'scheduled';

/**
 * The token check.
 *
 * Length-first so a comparison never runs over a short string, and a
 * full-length walk otherwise so the time it takes says nothing about how
 * much of the token was right. Not constant-time in the strict sense —
 * JavaScript strings make that a fiction — but it does not leak a prefix.
 */
export function tokenOk(given, expected) {
  const a = String(given ?? '');
  const b = String(expected ?? '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * May this booking still be changed by the family, and if not, why not?
 *
 * The reason is written to be read by a parent on a phone, because it is.
 */
export function changeWindow(booking, nowISO = new Date().toISOString()) {
  if (!booking || !booking.slot) {
    return { canChange: false, reason: 'We couldn’t find that booking.' };
  }
  if (booking.status === CANCELLED) {
    return { canChange: false, cancelled: true, reason: 'This assessment has been cancelled.' };
  }
  const start = Date.parse(booking.slot);
  const now = Date.parse(nowISO);
  if (!Number.isFinite(start) || !Number.isFinite(now)) {
    return { canChange: false, reason: 'We couldn’t read the time on that booking.' };
  }
  if (start <= now) {
    return { canChange: false, past: true, reason: 'This assessment has already happened.' };
  }
  if (start - now < MIN_NOTICE_HOURS * 3600 * 1000) {
    return {
      canChange: false,
      tooLate: true,
      reason: `It’s less than ${MIN_NOTICE_HOURS} hours away, so please call the centre instead — they can still help.`,
    };
  }
  return { canChange: true, reason: '' };
}

/**
 * The booking as a stranger holding the link may see it.
 *
 * An allow-list, not a delete-list. The document also carries the token,
 * the lead it created, staff notes and a phone number, and the rule that
 * keeps those off a public page is that a field has to be named here to
 * leave the server. A delete-list would ship the next field somebody adds.
 */
export function publicBooking(doc) {
  if (!doc) return null;
  return {
    id: doc.id || null,
    slot: doc.slot || null,
    durationMin: doc.durationMin || null,
    status: doc.status || SCHEDULED,
    childName: doc.childName || '',
    guardianName: doc.guardianName || '',
    centerId: doc.centerId || null,
  };
}

/**
 * Is this a booking the family should be offered at all?
 *
 * Cancelled ones still open — somebody following a stale link deserves
 * "this was cancelled" rather than "not found" — but past ones are not
 * listed when we are sending somebody their links.
 */
export function isUpcoming(booking, nowISO = new Date().toISOString()) {
  const start = Date.parse(booking?.slot || '');
  return Number.isFinite(start) && start > Date.parse(nowISO);
}
