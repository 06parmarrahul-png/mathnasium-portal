import { describe, it, expect } from 'vitest';
import {
  periodFor, stepPeriod, periodLabel, isInPeriod, payDateFor, upcomingPayroll,
  scheduledHours, payHours, isAdjusted, summarisePeriod,
  sickDaysThisYear, grossPay, isPlausibleRate, money, isHourlyPaid,
} from './payProjection';

/**
 * This page tells somebody what they are going to be paid, so the bar for
 * these is higher than usual: a number that is wrong in a way that looks
 * right is worse than no page at all — they would budget against it.
 *
 * The rules mirror Manage Payroll deliberately. Where a test looks
 * over-cautious, that is why.
 */

const round = (n) => Math.round(n * 100) / 100;

const shift = (over = {}) => ({
  id: 's1', date: '2026-09-15', startTime: '15:00', endTime: '19:00',
  status: 'published', ...over,
});

describe('pay periods — 11th-25th and 26th-10th', () => {
  it('places a mid-month date', () => {
    expect(periodFor('2026-09-15')).toEqual({ start: '2026-09-11', end: '2026-09-25' });
  });

  it('places the boundaries themselves', () => {
    expect(periodFor('2026-09-11').start).toBe('2026-09-11');
    expect(periodFor('2026-09-25').end).toBe('2026-09-25');
    expect(periodFor('2026-09-26')).toEqual({ start: '2026-09-26', end: '2026-10-10' });
    expect(periodFor('2026-09-10')).toEqual({ start: '2026-08-26', end: '2026-09-10' });
  });

  it('crosses a year boundary in both directions', () => {
    expect(periodFor('2026-12-28')).toEqual({ start: '2026-12-26', end: '2027-01-10' });
    expect(periodFor('2027-01-05')).toEqual({ start: '2026-12-26', end: '2027-01-10' });
  });

  it('handles February without inventing a 30th', () => {
    expect(periodFor('2026-02-27')).toEqual({ start: '2026-02-26', end: '2026-03-10' });
    expect(periodFor('2026-03-05')).toEqual({ start: '2026-02-26', end: '2026-03-10' });
  });

  it('is not fooled by UTC — a bare ISO date parses as the day before in Pacific', () => {
    // The classic trap. If periodFor used `new Date('2026-09-11')` this
    // would land in the previous period.
    expect(periodFor('2026-09-11').start).toBe('2026-09-11');
    expect(periodFor('2026-09-26').start).toBe('2026-09-26');
  });

  it('steps backwards and forwards without gaps or overlaps', () => {
    let p = periodFor('2026-09-15');
    for (let i = 0; i < 30; i++) {
      const prev = stepPeriod(p, -1);
      expect(prev.end < p.start).toBe(true);          // no overlap
      const back = stepPeriod(prev, 1);
      expect(back).toEqual(p);                        // and it round-trips
      p = prev;
    }
  });

  it('labels readably', () => {
    expect(periodLabel({ start: '2026-09-11', end: '2026-09-25' })).toBe('11–25 September');
    expect(periodLabel({ start: '2026-09-26', end: '2026-10-10' })).toBe('26 September – 10 October');
  });

  it('knows what is inside it', () => {
    const p = { start: '2026-09-11', end: '2026-09-25' };
    expect(isInPeriod('2026-09-11', p)).toBe(true);
    expect(isInPeriod('2026-09-25', p)).toBe(true);
    expect(isInPeriod('2026-09-10', p)).toBe(false);
    expect(isInPeriod('2026-09-26', p)).toBe(false);
    expect(isInPeriod(null, p)).toBe(false);
  });
});

describe('pay dates and the payroll to run next', () => {
  it('pays five days after a period closes: the 10th on the 15th, the 25th on the 30th', () => {
    expect(payDateFor({ start: '2026-08-26', end: '2026-09-10' })).toBe('2026-09-15');
    expect(payDateFor({ start: '2026-09-11', end: '2026-09-25' })).toBe('2026-09-30');
    expect(payDateFor({ start: '2026-12-26', end: '2027-01-10' })).toBe('2027-01-15');
  });

  it('on the 14th opens the payroll being paid on the 15th, not the period running now', () => {
    expect(upcomingPayroll('2026-09-14')).toEqual({ start: '2026-08-26', end: '2026-09-10' });
  });

  it('keeps it through payday, and moves on the day after', () => {
    expect(upcomingPayroll('2026-09-15')).toEqual({ start: '2026-08-26', end: '2026-09-10' });
    expect(upcomingPayroll('2026-09-16')).toEqual({ start: '2026-09-11', end: '2026-09-25' });
  });

  it('does the same for the 25th-ending period, paid on the 30th', () => {
    expect(upcomingPayroll('2026-09-26')).toEqual({ start: '2026-09-11', end: '2026-09-25' });
    expect(upcomingPayroll('2026-09-30')).toEqual({ start: '2026-09-11', end: '2026-09-25' });
    expect(upcomingPayroll('2026-10-01')).toEqual({ start: '2026-09-26', end: '2026-10-10' });
  });

  it('before a period has even closed, that period is the next payroll', () => {
    expect(upcomingPayroll('2026-09-05')).toEqual({ start: '2026-08-26', end: '2026-09-10' });
    expect(upcomingPayroll('2026-09-20')).toEqual({ start: '2026-09-11', end: '2026-09-25' });
  });

  it('crosses the year', () => {
    expect(upcomingPayroll('2026-12-31')).toEqual({ start: '2026-12-26', end: '2027-01-10' });
    expect(upcomingPayroll('2027-01-14')).toEqual({ start: '2026-12-26', end: '2027-01-10' });
    expect(upcomingPayroll('2027-01-16')).toEqual({ start: '2027-01-11', end: '2027-01-25' });
  });
});

describe('hours — the same rule as Manage Payroll', () => {
  it('measures a shift', () => {
    expect(scheduledHours(shift())).toBe(4);
    expect(scheduledHours(shift({ startTime: '09:00', endTime: '14:30' }))).toBe(5.5);
  });

  it('is zero for unreadable times rather than NaN', () => {
    expect(scheduledHours(shift({ startTime: null }))).toBe(0);
    expect(scheduledHours({})).toBe(0);
  });

  it('pays the override when one is set', () => {
    expect(payHours(shift({ payHoursOverride: 3.5 }))).toBe(3.5);
  });

  it('pays NOTHING for a no-show, whatever the override says', () => {
    // Copied from Admin.jsx deliberately: the no-show wins.
    expect(payHours(shift({ noShow: true }))).toBe(0);
    expect(payHours(shift({ noShow: true, payHoursOverride: 4 }))).toBe(0);
  });

  it('ignores a nonsense override and falls back to the clock', () => {
    expect(payHours(shift({ payHoursOverride: 'four' }))).toBe(4);
    expect(payHours(shift({ payHoursOverride: NaN }))).toBe(4);
    expect(payHours(shift({ payHoursOverride: null }))).toBe(4);
  });

  it('flags a row an admin actually changed', () => {
    expect(isAdjusted(shift({ payHoursOverride: 3 }))).toBe(true);
    expect(isAdjusted(shift({ payHoursOverride: 4 }))).toBe(false);   // same as scheduled
    expect(isAdjusted(shift())).toBe(false);
  });

  it('applies NO overtime — because payroll does not either', () => {
    // A twelve-hour day pays twelve hours here, exactly as the real sheet
    // exports it. Inventing time-and-a-half would disagree with the money
    // that actually arrives.
    expect(payHours(shift({ startTime: '08:00', endTime: '20:00' }))).toBe(12);
  });
});

describe('summarisePeriod', () => {
  const period = { start: '2026-09-11', end: '2026-09-25' };
  const rows = [
    shift({ id: 'a', date: '2026-09-12' }),
    shift({ id: 'b', date: '2026-09-15', payHoursOverride: 3 }),
    shift({ id: 'c', date: '2026-09-20', noShow: true }),
    shift({ id: 'd', date: '2026-09-30' }),                       // next period
    shift({ id: 'e', date: '2026-09-13', status: 'draft' }),      // never published
    shift({ id: 'f', date: '2026-09-14', status: 'cancelled' }),
  ];

  it('counts only published shifts inside the period', () => {
    const s = summarisePeriod(rows, period);
    expect(s.rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(s.shiftCount).toBe(3);
  });

  it('separates what was scheduled from what will be paid', () => {
    const s = summarisePeriod(rows, period);
    expect(s.scheduled).toBe(12);   // 4 + 4 + 4
    expect(s.pay).toBe(7);          // 4 + 3 + 0 (no-show)
  });

  it('surfaces how settled the period is', () => {
    const s = summarisePeriod(rows, period);
    expect(s.adjusted).toBe(1);
    expect(s.noShows).toBe(1);
    expect(s.reviewed).toBe(0);
  });

  it('orders rows by date then start time', () => {
    const s = summarisePeriod([
      shift({ id: 'late', date: '2026-09-15', startTime: '17:00', endTime: '19:00' }),
      shift({ id: 'early', date: '2026-09-15', startTime: '09:00', endTime: '12:00' }),
      shift({ id: 'first', date: '2026-09-12' }),
    ], period);
    expect(s.rows.map(r => r.id)).toEqual(['first', 'early', 'late']);
  });

  it('counts a sick day once even across two rows', () => {
    const s = summarisePeriod([
      shift({ id: 'x', date: '2026-09-16', sickPay: true }),
      shift({ id: 'y', date: '2026-09-16', sickPay: true, startTime: '09:00', endTime: '12:00' }),
    ], period);
    expect(s.sickDays).toBe(1);
  });

  it('splits what is already worked from what is still to come', () => {
    // Mid-period, "am I on track" needs both halves. Today's own shift
    // counts as still to come — the day is not over.
    const s = summarisePeriod(rows, period, '2026-09-15');
    expect(s.done).toBe(4);        // the 12th
    expect(s.upcoming).toBe(3);    // the 15th (today, 3h override) + the 20th no-show (0)
    expect(round(s.done + s.upcoming)).toBe(s.pay);
  });

  it('counts everything as done once the period has passed', () => {
    const s = summarisePeriod(rows, period, '2026-10-01');
    expect(s.done).toBe(s.pay);
    expect(s.upcoming).toBe(0);
  });

  it('counts everything as upcoming before the period starts', () => {
    const s = summarisePeriod(rows, period, '2026-09-01');
    expect(s.upcoming).toBe(s.pay);
    expect(s.done).toBe(0);
  });

  it('is empty, not broken, with nothing to show', () => {
    const s = summarisePeriod([], period);
    expect(s).toMatchObject({ shiftCount: 0, scheduled: 0, pay: 0 });
    expect(summarisePeriod(null, period).rows).toEqual([]);
  });
});

describe('sick days this year — a count, not an entitlement', () => {
  // The paid-leave standing and the stat-pay forecast came off this page:
  // quoting employment-standards minimums at staff is the centre's
  // conversation, not a self-serve number. What is left is the plain fact.
  const sickShift = (date) => ({ date, sickPay: true, startTime: '15:00', endTime: '19:00' });

  it('counts the days they called in sick', () => {
    const s = sickDaysThisYear({
      shifts: [sickShift('2026-01-06'), sickShift('2026-03-02'), { date: '2026-04-01' }],
      asOf: '2026-09-15',
    });
    expect(s.count).toBe(2);
    expect(s.dates).toEqual(['2026-01-06', '2026-03-02']);
    expect(s.year).toBe('2026');
  });

  it('resets on 1 January — last year’s days are last year’s', () => {
    const s = sickDaysThisYear({
      shifts: [sickShift('2025-12-31'), sickShift('2026-01-01')],
      asOf: '2026-01-01',
    });
    expect(s.count).toBe(1);
    expect(s.dates).toEqual(['2026-01-01']);
  });

  it('counts a day once, however many rows it has', () => {
    // A split shift is two rows on one date. Somebody was off sick once.
    const s = sickDaysThisYear({
      shifts: [sickShift('2026-02-10'), sickShift('2026-02-10')],
      externalSickDates: ['2026-02-10'],
      asOf: '2026-09-15',
    });
    expect(s.count).toBe(1);
  });

  it('includes a sick day with nothing scheduled', () => {
    // No shift to carry it, so it sits on the person instead.
    const s = sickDaysThisYear({
      shifts: [],
      externalSickDates: ['2026-05-04', '2025-05-04'],
      asOf: '2026-09-15',
    });
    expect(s.count).toBe(1);
    expect(s.dates).toEqual(['2026-05-04']);
  });

  it('is zero, not broken, for somebody who has never been off', () => {
    expect(sickDaysThisYear({ asOf: '2026-09-15' })).toEqual({ year: '2026', count: 0, dates: [] });
    expect(sickDaysThisYear({ shifts: null, externalSickDates: null, asOf: '2026-09-15' }).count).toBe(0);
  });

  it('ignores rows with no date and junk in the list', () => {
    const s = sickDaysThisYear({
      shifts: [{ sickPay: true }, null, sickShift('2026-06-01')],
      externalSickDates: [null, '', '2026-06-02'],
      asOf: '2026-09-15',
    });
    expect(s.dates).toEqual(['2026-06-01', '2026-06-02']);
  });
});

describe('money', () => {
  it('multiplies hours by rate', () => {
    expect(grossPay(20, 21.5)).toBe(430);
    expect(grossPay(7.25, 20)).toBe(145);
  });

  it('rounds to the cent', () => {
    expect(grossPay(3.33, 19.99)).toBe(66.57);
  });

  it('returns null — not zero — without a usable rate', () => {
    // "$0.00" reads as an answer. Null lets the page ask for the rate.
    expect(grossPay(20, null)).toBeNull();
    expect(grossPay(20, 0)).toBeNull();
    expect(grossPay(20, -5)).toBeNull();
    expect(grossPay(20, 'twenty')).toBeNull();
    expect(grossPay(null, 20)).toBeNull();
    expect(grossPay(undefined, 20)).toBeNull();
  });

  it('but zero hours really is zero pay, not a gap', () => {
    // The distinction that matters: nobody scheduled this period earns
    // nothing, and the page should say so plainly.
    expect(grossPay(0, 20)).toBe(0);
  });

  it('rejects an implausible rate rather than showing a fantasy', () => {
    expect(isPlausibleRate(21.5)).toBe(true);
    expect(isPlausibleRate(0)).toBe(false);
    expect(isPlausibleRate(-1)).toBe(false);
    expect(isPlausibleRate(2150)).toBe(false);      // cents typed as dollars
    expect(isPlausibleRate('abc')).toBe(false);
  });

  it('formats Canadian dollars', () => {
    expect(money(430)).toMatch(/430\.00/);
    expect(money(null)).toBe('—');
    expect(money('abc')).toBe('—');
  });
});

describe('isHourlyPaid — who this page is for', () => {
  const CFG = { salaryStaff: ['Neeru Sharma', 'Vinod Kumar'] };

  it('includes everyone paid for the hours they work', () => {
    expect(isHourlyPaid({ displayName: 'Kaitlyn MacDonald' }, CFG)).toBe(true);
    expect(isHourlyPaid({ displayName: 'A Trainee' }, CFG)).toBe(true);
  });

  it('excludes volunteers — a pay page for unpaid work is wrong, not empty', () => {
    expect(isHourlyPaid({ displayName: 'Helper', isVolunteer: true }, CFG)).toBe(false);
  });

  it('excludes salaried staff, who are not paid from the hourly sheet', () => {
    expect(isHourlyPaid({ displayName: 'Neeru Sharma' }, CFG)).toBe(false);
    expect(isHourlyPaid({ displayName: '  neeru sharma  ' }, CFG)).toBe(false);
  });

  it('copes with no centre config', () => {
    expect(isHourlyPaid({ displayName: 'Anyone' }, null)).toBe(true);
    expect(isHourlyPaid({}, {})).toBe(true);
  });
});
