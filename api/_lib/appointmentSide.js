/**
 * Which side of the floor an appointment belongs to, read off its TYPE.
 *
 * This is the LAST resort, and that matters. An appointment is placed by
 * matching the booking name against the student tracker, and the student's
 * own category is the right answer every time it is available. Only when
 * the person behind the booking is unknown — a first session, a booking in
 * a parent's name, a spelling nothing recognises — does the appointment
 * type get a say.
 *
 * Extracted from api/scheduler/appointments.js so it can be tested. The
 * route is a Vercel function and the project sits exactly on the Hobby
 * 12-function cap, which is why this lives under _lib: underscore-prefixed
 * paths are not deployed as functions, and their tests can sit beside them.
 */

const ONLINE_RE = /\b(online|@?home|virtual)\b/i;
const HS_RE = /\b(hs|high\s*school|grade\s*(8|9|10|11|12))\b/i;
const EM_RE = /\b(em|elementary|grade\s*[1-7])\b/i;

/**
 * The half-hour in-centre block, new from 1 October 2026.
 *
 * "Langley In-Centre 30 minute math tutoring" — the same naming as the 60
 * and 90 minute types, so the only thing separating it is the length.
 *
 * THE LENGTH IS THE SIGNAL, and only for this one type. The 60 and 90
 * minute blocks are booked by Elementary and Highschool students alike, so
 * their names say nothing about the side and nothing can be inferred. The
 * 30 minute block is young students only — Great Foundations through about
 * grade 2 — so for once the type is enough.
 *
 * `tutor` is required as well as the length. A 30 minute ASSESSMENT or
 * consultation is not this block, and reading a bare "30 minute" as
 * "Elementary" would file those on the wrong side.
 */
const MIN_30_RE = /\b30\s*(?:min|mins|minute|minutes)\b/i;
const TUTORING_RE = /\btutor(?:ing|s)?\b/i;

export function isYoungHalfHourBlock(type) {
  const s = String(type ?? '');
  return MIN_30_RE.test(s) && TUTORING_RE.test(s);
}

/**
 * 'Online' | 'HS' | 'EM' | null — null meaning the type says nothing and
 * the caller should fall back to Unknown.
 *
 * ORDER IS THE WHOLE DESIGN. Anything the name states OUTRIGHT wins, and
 * the half-hour rule is tried last, so it can only ever turn an Unknown
 * into Elementary. A type that says "30 minute … High School" is read as
 * Highschool, because it said so; the length is an inference and the words
 * are evidence.
 */
export function sideFromTypeName(type) {
  const s = String(type ?? '');
  if (ONLINE_RE.test(s)) return 'Online';
  if (HS_RE.test(s)) return 'HS';
  if (EM_RE.test(s)) return 'EM';
  if (isYoungHalfHourBlock(s)) return 'EM';
  return null;
}
