/**
 * centreClosures.js — the days a centre is shut.
 *
 * ONE LIST, TWO QUESTIONS. Everything lives in `config/main.holidays` as
 * `{ date, name, stat? }`, and the same array answers both:
 *
 *   Holidays  the statutory ones. What payroll pays, what Employment
 *             Standards names. Twelve a year in BC.
 *   Closures  every day the door is locked — the stats AND the centre's
 *             own: renovations, a burst pipe, the week between Christmas
 *             and New Year.
 *
 * Holidays are a SUBSET of closures, not a sibling of them, which is why
 * this is a filter over one array rather than two stored lists. Two lists
 * would need the stats writing into both, and the day somebody edited one
 * and not the other is the day payroll and the schedule disagreed.
 *
 * WHAT MAKES A DAY STATUTORY is not stored on the entry by default — see
 * isPaidStatHoliday() in statPay.js. A date that IS a BC stat counts as one
 * unless the entry says otherwise, so the list self-corrects: when the
 * National Day for Truth and Reconciliation was added to the stat list,
 * every centre that had already closed for the 30th by hand started paying
 * it properly with nobody editing anything.
 */

import { addDays } from './ratioCalendar';
import { isPaidStatHoliday } from './statPay';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The longest stretch that can be closed in one go.
 *
 * Not a policy about holidays — a guard against a typo. A mis-keyed year
 * in the "to" box would otherwise write three thousand entries into the
 * centre config and there is no undo on the other side of that.
 */
export const MAX_RANGE_DAYS = 60;

/**
 * Every date from `from` to `to` inclusive, or null when the range makes
 * no sense. A missing `to` is a single day, which is the common case and
 * the one the box is empty for.
 */
export function datesInRange(from, to) {
  if (!ISO.test(String(from || ''))) return null;
  if (!to) return [from];
  if (!ISO.test(String(to))) return null;
  if (to < from) return null;
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > MAX_RANGE_DAYS) return null;
  }
  return out;
}

/** Why a range was refused, in words the person can act on. */
export function rangeProblem(from, to) {
  if (!ISO.test(String(from || ''))) return 'Pick a date.';
  if (!to) return null;
  if (!ISO.test(String(to))) return 'That end date isn’t a real date.';
  if (to < from) return 'The last day is before the first one.';
  if (datesInRange(from, to) === null) {
    return `That’s more than ${MAX_RANGE_DAYS} days — close it in shorter stretches.`;
  }
  return null;
}

/**
 * Add a stretch of days to the list.
 *
 * Dates already on the list are LEFT ALONE rather than overwritten: the
 * one already there may be a stat with a name that matters, and closing
 * the week around it should not quietly rename Christmas Day to "Winter
 * break". Returns what to save plus what it skipped, so the page can say.
 */
export function addClosures(existing, dates, name) {
  const list = Array.isArray(existing) ? existing : [];
  const have = new Set(list.map(h => h?.date));
  const label = String(name || '').trim() || 'Closed';
  const added = (dates || []).filter(d => !have.has(d)).map(d => ({ date: d, name: label }));
  const skipped = (dates || []).filter(d => have.has(d));
  return {
    list: [...list, ...added].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    added: added.length,
    skipped: skipped.length,
  };
}

/** Remove a stretch. Takes dates rather than one date so undoing a range is one action. */
export function removeClosures(existing, dates) {
  const gone = new Set(dates || []);
  return (Array.isArray(existing) ? existing : []).filter(h => !gone.has(h?.date));
}

/** Is this entry one of the twelve? */
export function isStat(holiday) {
  return isPaidStatHoliday(holiday);
}

/**
 * The two views over one list. `holidays` is the statutory subset;
 * `closures` is everything, because that is what "closed" means.
 */
export function partitionClosures(list) {
  const all = (Array.isArray(list) ? list : []).filter(h => h && ISO.test(String(h.date || '')));
  return { closures: all, holidays: all.filter(isStat) };
}

/** "3 days" / "1 day" / '' — what the Add button is about to do. */
export function rangeSummary(from, to) {
  const dates = datesInRange(from, to);
  if (!dates) return '';
  return dates.length === 1 ? '1 day' : `${dates.length} days`;
}
