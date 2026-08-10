// Statutory-holiday pay — BC Employment Standards Act, ss. 44–46.
//
// Extracted into its own module so the qualification rules can be unit
// tested. They used to live inline in the payroll summary, where the only
// way to check them was to run a pay period and eyeball the result.
//
// ─── The rules being implemented ────────────────────────────────────────
//
// ELIGIBILITY (s.45). An employee qualifies when they have been employed
// 30 calendar days before the holiday AND "worked or earned wages on at
// least 15 of the 30 days immediately preceding" it.
//
// The unit is DAYS, not shifts. Someone who works a split shift — a Lead
// 11:00–15:00 followed by a Host 15:00–19:00 — has worked ONE day, not
// two. Counting shift records instead made split-shift staff qualify on
// roughly half the days they should have.
//
// AVERAGE DAY'S PAY (s.46). Total wages earned in the 30-day window
// divided by the number of days that earned them.
//
// ─── Judgement calls, flagged deliberately ──────────────────────────────
//
// • Paid sick days COUNT as qualifying days. The Act says "worked or
//   earned wages", and paid sick leave is earned wages. Their hours are
//   also included in the average, so numerator and denominator agree.
// • No-shows do NOT count. No work, no wages.
// • Draft shifts do NOT count. They were never published, so they are a
//   plan rather than a record of anything that happened.
// • Volunteer shifts do NOT count. Unpaid.
//
// If your bookkeeper reads the sick-day point differently, flip
// COUNT_PAID_SICK_AS_QUALIFYING below — everything else follows from it.

export const STAT_WINDOW_DAYS = 30;
export const STAT_MIN_QUALIFYING_DAYS = 15;
const COUNT_PAID_SICK_AS_QUALIFYING = true;

// ─── Which dates are genuinely statutory ────────────────────────────────
// Anonymous Gregorian (Meeus/Jones/Butcher) Easter algorithm. Good Friday
// is two days before; everything else is a fixed date or an Nth weekday.
function easterDate(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
  const first = new Date(year, monthIdx, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, monthIdx, 1 + offset + (n - 1) * 7);
}
function mondayOnOrBefore(year, monthIdx, day) {
  const d = new Date(year, monthIdx, day);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function toDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** BC statutory holidays for a year, chronological. */
export function bcStatHolidays(year) {
  const easter = easterDate(year);
  const goodFriday = new Date(easter);
  goodFriday.setDate(easter.getDate() - 2);
  return [
    { date: `${year}-01-01`, name: "New Year's Day" },
    { date: toDateKey(nthWeekdayOfMonth(year, 1, 1, 3)), name: 'Family Day' },
    { date: toDateKey(goodFriday),                       name: 'Good Friday' },
    { date: toDateKey(mondayOnOrBefore(year, 4, 24)),    name: 'Victoria Day' },
    { date: `${year}-07-01`, name: 'Canada Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 7, 1, 1)), name: 'BC Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 8, 1, 1)), name: 'Labour Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 9, 1, 2)), name: 'Thanksgiving' },
    { date: `${year}-11-11`, name: 'Remembrance Day' },
    { date: `${year}-12-25`, name: 'Christmas Day' },
    { date: `${year}-12-26`, name: 'Boxing Day' },
  ];
}

const statDateCache = new Map();
function bcStatDates(year) {
  if (!statDateCache.has(year)) {
    statDateCache.set(year, new Set(bcStatHolidays(year).map(h => h.date)));
  }
  return statDateCache.get(year);
}

/**
 * Is this holiday one that attracts statutory holiday pay?
 *
 * The holidays list does double duty: real statutory holidays AND ordinary
 * centre closures (a staff training day, the Saturday either side of a long
 * weekend). Only the first kind is payable — every entry used to pay, so a
 * closure sitting next to a real holiday quietly paid stat twice.
 *
 *   stat === true   -> paid, always
 *   stat === false  -> unpaid closure, always
 *   no flag at all  -> paid only if the DATE is a real BC statutory holiday
 *
 * That last rule means existing data needs no migration: BC Day still pays,
 * while a closure on the Saturday before it stops paying, without anyone
 * editing anything. Set the flag explicitly to override.
 */
export function isPaidStatHoliday(holiday) {
  if (!holiday || !holiday.date) return false;
  if (holiday.stat === true) return true;
  if (holiday.stat === false) return false;
  const year = Number(holiday.date.slice(0, 4));
  if (!Number.isFinite(year)) return false;
  return bcStatDates(year).has(holiday.date);
}

/** `YYYY-MM-DD` for n days before the given date string. */
export function minusDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Does this shift represent work (or paid leave) that earns wages? */
export function earnsWages(shift) {
  if (!shift || !shift.date) return false;
  if (shift.status === 'draft') return false;
  if (shift.noShow === true) return false;
  if (shift.role === 'Volunteer') return false;
  if (shift.sickPay === true) return COUNT_PAID_SICK_AS_QUALIFYING;
  return true;
}

/**
 * Collapse a person's shifts into hours per CALENDAR DAY inside the
 * 30-day window before `holidayDate` (the holiday itself excluded).
 *
 * @param {Array}    shifts       every shift for one person
 * @param {string}   holidayDate  'YYYY-MM-DD'
 * @param {Function} hoursOf      shift -> paid hours
 * @returns {Map<string, number>} date -> hours earned that day
 */
export function qualifyingDayHours(shifts, holidayDate, hoursOf) {
  const byDate = new Map();
  for (const [date, d] of qualifyingDayBreakdown(shifts, holidayDate, hoursOf)) {
    byDate.set(date, d.hours);
  }
  return byDate;
}

/**
 * Same window and filtering as qualifyingDayHours, but keeps track of WHY
 * each day counted. Paid sick days are legally qualifying (see the note at
 * the top of this file), which surprises people looking at a roster — a
 * staffer can clear the 15-day bar partly on sick leave. Rather than change
 * the arithmetic, we carry the breakdown through so the UI can show
 * "18 worked + 2 sick" and nobody has to guess.
 *
 * A day is `sickOnly` when EVERY wage-earning shift on it was sick leave.
 * Work a real shift and call in sick for a second one on the same date and
 * it counts as a worked day — you were there.
 *
 * @returns {Map<string, {hours:number, sickOnly:boolean}>}
 */
export function qualifyingDayBreakdown(shifts, holidayDate, hoursOf) {
  const windowStart = minusDays(holidayDate, STAT_WINDOW_DAYS);
  const byDate = new Map();
  for (const s of shifts || []) {
    if (!s?.date) continue;
    if (s.date < windowStart || s.date >= holidayDate) continue;
    if (!earnsWages(s)) continue;
    const h = hoursOf(s);
    if (!(h > 0)) continue; // a zero-hour shift earned nothing
    const isSick = s.sickPay === true;
    const prev = byDate.get(s.date);
    if (prev) {
      prev.hours += h;
      prev.sickOnly = prev.sickOnly && isSick;
    } else {
      byDate.set(s.date, { hours: h, sickOnly: isSick });
    }
  }
  return byDate;
}

/**
 * Stat entitlement for one person against one holiday.
 *
 * @returns {{
 *   qualifies: boolean, daysWorked: number, totalHours: number,
 *   hours: number, windowStart: string, days: Array<{date,hours}>
 * }}  `hours` is the average day's pay, 0 when they don't qualify.
 */
export function statPayForHoliday(shifts, holidayDate, hoursOf) {
  const byDate = qualifyingDayBreakdown(shifts, holidayDate, hoursOf);
  const daysWorked = byDate.size;
  const totalHours = [...byDate.values()].reduce((a, d) => a + d.hours, 0);
  // Split the qualifying days so callers can show their make-up. sickDays
  // is a subset of daysWorked, not an addition to it — daysWorked is still
  // the number checked against the 15-day bar.
  const sickDays = [...byDate.values()].filter(d => d.sickOnly).length;
  const qualifies = daysWorked >= STAT_MIN_QUALIFYING_DAYS;
  return {
    qualifies,
    daysWorked,
    sickDays,
    workedDays: daysWorked - sickDays,
    totalHours: Math.round(totalHours * 100) / 100,
    hours: qualifies ? Math.round((totalHours / daysWorked) * 100) / 100 : 0,
    windowStart: minusDays(holidayDate, STAT_WINDOW_DAYS),
    days: [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, d]) => ({
        date,
        hours: Math.round(d.hours * 100) / 100,
        sick: d.sickOnly,
      })),
  };
}
