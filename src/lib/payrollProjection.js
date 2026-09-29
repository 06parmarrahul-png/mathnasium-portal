/**
 * payrollProjection.js — what the next two pay runs are going to cost.
 *
 * This lived inside Centre Analytics, four hundred lines down a five
 * thousand line component, rebuilding payroll's own exclusion sets from
 * scratch because the tab it sat in was never given them. It is the
 * number an owner opens the page for, and its own footnote said "matches
 * the Manage Payroll export" — a promise that two separate copies of the
 * same rules had to keep by hand. It belongs on Manage Payroll, where
 * the sets it needs are already in the room.
 *
 * THE CYCLE. Mathnasium pays semi-monthly, lagged:
 *
 *   the 15th run covers the 26th of the PRIOR month → the 10th of this one
 *   the 30th run covers the 11th → the 25th of this one
 *
 * which leaves the 26th onward accruing toward NEXT month's 15th. That
 * gap is not a bug in the arithmetic, it is the lag, and it is why a
 * month viewed on the 27th shows neither of its runs as upcoming.
 *
 * Dates are ISO strings end to end. The version this replaces built Date
 * objects at local midnight and formatted them back, which works until it
 * doesn't; a string comparison against `s.date` — itself a string — has
 * no timezone to get wrong.
 *
 * PURE MODULE. Who is payable is the caller's business, passed in, so the
 * page holding the real payroll sets can hand over the same ones it uses
 * for the table underneath.
 */

import { payHours } from './payProjection';

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM' → [year, month]. Anything unparseable returns null. */
function splitMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? [y, mo] : null;
}

/** The month a pay period pays out in: the one its END falls in. */
export function monthOfPeriodEnd(dateISO) {
  const s = String(dateISO || '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
}

/** "September 2026" — the heading. */
export function monthLabel(month) {
  const parts = splitMonth(month);
  return parts ? `${MONTHS_LONG[parts[1] - 1]} ${parts[0]}` : '';
}

/** "Aug 26 – Sep 10". En dash, because it is a range and not a minus sign. */
export function windowLabel(start, end) {
  const one = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : '';
  };
  return `${one(start)} – ${one(end)}`;
}

/**
 * The two runs that pay out in a month, earliest window first.
 *
 * January's 15th run reaches back into the previous DECEMBER, which is
 * the one case the month arithmetic has to actually think about.
 */
export function runsForMonth(month) {
  const parts = splitMonth(month);
  if (!parts) return [];
  const [y, m] = parts;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return [
    { key: '15th', label: '15th payroll', start: iso(py, pm, 26), end: iso(y, m, 10) },
    { key: '30th', label: '30th payroll', start: iso(y, m, 11), end: iso(y, m, 25) },
  ];
}

/**
 * Hours, shifts and heads for each run of a month.
 *
 * `isPayable` decides who counts — pass the page's own payroll filter.
 * `today` marks the run currently accruing, or neither of them from the
 * 26th onward, when the money is already going to next month.
 */
export function projectPayroll({ shifts = [], month, isPayable = () => true, today = null } = {}) {
  const runs = runsForMonth(month).map(run => {
    const rows = shifts.filter(s => s && s.date >= run.start && s.date <= run.end && isPayable(s));
    return {
      ...run,
      window: windowLabel(run.start, run.end),
      hours: rows.reduce((sum, s) => sum + payHours(s), 0),
      shifts: rows.length,
      instructors: new Set(rows.map(s => s.userName).filter(Boolean)).size,
      upcoming: Boolean(today) && today >= run.start && today <= run.end,
    };
  });
  return {
    month,
    monthLabel: monthLabel(month),
    runs,
    totalHours: runs.reduce((sum, r) => sum + r.hours, 0),
  };
}
