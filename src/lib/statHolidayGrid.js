import { isPaidStatHoliday, minusDays } from './statPay';
import { periodFor, payDateFor } from './payProjection';

/**
 * The Stat Pay tab's holiday grid: every paid statutory holiday, the pay
 * period it lands in, the day that period is paid, and where it stands.
 *
 * The tab used to show only the holidays inside whichever pay period was
 * selected — so most of the time it showed nothing, and nobody could see
 * that Thanksgiving was coming or which payroll it would fall into.
 */

/**
 * @returns {Array<{ holiday, date, period, payDate, windowStart, windowEnd,
 *   status: 'next'|'upcoming'|'being-paid'|'paid' }>} chronological.
 *
 *   next        the first holiday on or after today
 *   upcoming    later ones
 *   being-paid  the holiday has passed, its payroll hasn't been paid yet
 *   paid        its pay date has passed
 */
export function holidayCards(holidays, todayISO) {
  const paid = (Array.isArray(holidays) ? holidays : [])
    .filter(isPaidStatHoliday)
    .sort((a, b) => a.date.localeCompare(b.date));

  // A holiday entered twice (the list is hand-edited) shows once.
  const seen = new Set();
  const unique = paid.filter(h => (seen.has(h.date) ? false : (seen.add(h.date), true)));

  let nextTaken = false;
  return unique.map(h => {
    const period = periodFor(h.date);
    const payDate = payDateFor(period);
    let status;
    if (h.date >= todayISO) {
      status = nextTaken ? 'upcoming' : 'next';
      nextTaken = true;
    } else {
      status = todayISO <= payDate ? 'being-paid' : 'paid';
    }
    return {
      holiday: h,
      date: h.date,
      period,
      payDate,
      windowStart: minusDays(h.date, 30),
      windowEnd: minusDays(h.date, 1),
      status,
    };
  });
}

/** Which holiday opens expanded: one in the selected pay period, else the next one, else the last. */
export function defaultHolidayDate(cards, period) {
  if (!cards.length) return null;
  const inPeriod = period && cards.find(c => c.date >= period.start && c.date <= period.end);
  if (inPeriod) return inPeriod.date;
  const next = cards.find(c => c.status === 'next');
  return (next || cards[cards.length - 1]).date;
}

/** Years that have holidays, for the year switcher. */
export function holidayYears(cards) {
  return [...new Set(cards.map(c => c.date.slice(0, 4)))].sort();
}

/**
 * Can we work this holiday out? Only if its whole qualifying window is
 * inside the shifts the page has loaded — otherwise the count would be
 * short and read as "nobody qualified".
 */
export function windowIsLoaded(card, historyFrom) {
  return !historyFrom || card.windowStart >= historyFrom;
}

/** Has the qualifying window closed? Before that, counts include scheduled shifts. */
export function windowIsClosed(card, todayISO) {
  return card.windowEnd < todayISO;
}

/**
 * Per-holiday results → one row per person, for the roster table.
 * `detail` is [{ holiday, perPerson: [{ name, count, qualifies, statHours,
 * sickDays, workedDays, days, totalHours, windowStart }] }].
 * Moved out of Admin.jsx so the pay-period roster and the holiday grid
 * build their rows the same way.
 */
export function buildStatRows(detail, roleByName = new Map()) {
  const byName = new Map();
  for (const d of detail || []) {
    for (const p of d.perPerson || []) {
      if (!byName.has(p.name)) {
        byName.set(p.name, {
          name: p.name,
          role: roleByName.get(p.name) || 'Instructor',
          perHoliday: [],
          totalStat: 0,
          qualifies: false,
        });
      }
      const row = byName.get(p.name);
      row.perHoliday.push({
        holiday: d.holiday, count: p.count, qualifies: p.qualifies, statHours: p.statHours,
        sickDays: p.sickDays, workedDays: p.workedDays,
        days: p.days, totalHours: p.totalHours, windowStart: p.windowStart,
      });
      if (p.qualifies) { row.totalStat += p.statHours; row.qualifies = true; }
    }
  }
  return [...byName.values()]
    .map(r => ({
      ...r,
      totalStat: Math.round(r.totalStat * 100) / 100,
      // Highest window day count across the holidays — ranks the
      // not-yet-eligible by who's closest to the 15 mark.
      shifts: r.perHoliday.reduce((mx, h) => Math.max(mx, h.count || 0), 0),
      // Sick/worked split from whichever holiday supplied that peak count,
      // so the breakdown shown always adds up to the number beside it.
      sickDays: (r.perHoliday.reduce(
        (best, h) => (!best || (h.count || 0) > (best.count || 0)) ? h : best, null,
      ) || {}).sickDays || 0,
    }))
    .sort((a, b) => {
      if (a.qualifies !== b.qualifies) return Number(b.qualifies) - Number(a.qualifies);
      if (a.qualifies) return (b.totalStat - a.totalStat) || a.name.localeCompare(b.name);
      return (b.shifts - a.shifts) || a.name.localeCompare(b.name);
    });
}
