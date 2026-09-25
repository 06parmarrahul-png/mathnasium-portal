/**
 * probation.js — when somebody's paid sick leave starts.
 *
 * BC ESA: five paid sick days a calendar year, earned after 90 consecutive
 * days of employment. Before that, a sick day is recorded and unpaid.
 *
 * THE BUG THIS EXISTS TO KILL. The rule was written twice — once in the
 * payroll calculation and once in the Sick Days tab — reading the start
 * date like this:
 *
 *     u.hireDate
 *       || (u.approvedAt?.toDate ? … : null)
 *       || (u.createdAt?.toDate  ? … : null)
 *
 * Both fallbacks were dead:
 *   - `approvedAt` is READ IN TWO PLACES AND WRITTEN IN NONE. It has never
 *     existed on a user document.
 *   - `createdAt` is written as an ISO STRING — by the staff-creation API
 *     and by the signup path — and `.toDate` is a Firestore Timestamp
 *     method. A string does not have one, so the branch never ran.
 *
 * So the start date was null for everybody who had never had one typed in
 * by hand, and the two copies then disagreed about what null meant:
 * the Sick Days tab said "On probation", and PAYROLL PAID THE DAY, because
 * its check was `if (hireDate) { …only then test probation… }`. The same
 * person was shown as probationary on one screen and paid on the next.
 *
 * One rule now, and it reads a date whatever shape it is in.
 */

export const PROBATION_DAYS = 90;
export const SICK_DAYS_PER_YEAR = 5;

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

/**
 * 'YYYY-MM-DD' out of any of the shapes a date is stored in here: a plain
 * day string, a full ISO timestamp string, a Firestore Timestamp, a Date.
 * Null when there is nothing usable — never a guess.
 */
export function asDay(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = ISO_DAY.exec(value.trim());
    return m ? m[1] : null;
  }
  if (typeof value?.toDate === 'function') {
    try { return value.toDate().toISOString().slice(0, 10); } catch { return null; }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  // Firestore sometimes hands back {seconds, nanoseconds} rather than a
  // Timestamp instance — over the REST API, and in some cached reads.
  if (typeof value?.seconds === 'number') {
    return new Date(value.seconds * 1000).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * The day a person's clock starts, and whether we actually know it.
 *
 * `hireDate` is the real answer and the only one anybody typed on purpose.
 * `createdAt` is a STAND-IN: for staff added to Ratio when they started it
 * is right, and for anyone whose account was made long after they were
 * hired it is late — which is why `assumed` comes back true, and why the
 * Sick Days tab highlights those rows. A stand-in that nobody is told
 * about is how this went wrong the first time.
 */
export function startDateOf(user) {
  const hire = asDay(user?.hireDate);
  if (hire) return { date: hire, assumed: false, known: true };
  const created = asDay(user?.approvedAt) || asDay(user?.createdAt);
  if (created) return { date: created, assumed: true, known: false };
  return { date: null, assumed: false, known: false };
}

/** Whole days between two 'YYYY-MM-DD' days. Null if either is missing. */
export function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * Is this person still on probation on `asOf`?
 *
 * NO START DATE MEANS ON PROBATION. That is the safer of the two wrong
 * answers and it is what the Sick Days tab has always said; payroll used
 * to say the opposite and pay the day. Paying somebody who has not earned
 * it is money that has already left, and asking for it back is a worse
 * conversation than paying a day late once a date is filled in.
 *
 * The way out is not a better default — it is the highlight on the Sick
 * Days tab that says whose date is missing.
 */
export function probationState(user, asOf) {
  const { date, assumed, known } = startDateOf(user);
  const daysIn = daysBetween(date, asOf);
  if (daysIn === null) {
    return { onProbation: true, daysIn: 0, startDate: null, assumed: false, known: false };
  }
  return { onProbation: daysIn < PROBATION_DAYS, daysIn, startDate: date, assumed, known };
}

/**
 * Which of a person's sick DATES are payable.
 *
 * Entitlement is spent chronologically across the whole calendar year, so
 * whether today's sick day is paid depends on how many came before it. A
 * date is unpaid when they were on probation that day, or when the five
 * are already gone.
 */
export function paidSickDates(sickDates, user) {
  const paid = new Set();
  let used = 0;
  for (const ds of [...(sickDates || [])].filter(Boolean).sort()) {
    if (used >= SICK_DAYS_PER_YEAR) break;
    if (probationState(user, ds).onProbation) continue;
    paid.add(ds);
    used += 1;
  }
  return paid;
}
