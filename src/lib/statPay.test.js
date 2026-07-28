import { describe, it, expect } from 'vitest';
import {
  isPaidStatHoliday, minusDays, earnsWages,
  qualifyingDayHours, statPayForHoliday, bcStatHolidays,
  STAT_MIN_QUALIFYING_DAYS,
} from './statPay';

// Same maths the app uses for a shift's length.
const hoursOf = (s) => {
  if (!s.startTime || !s.endTime) return 0;
  const [sh, sm] = s.startTime.split(':').map(Number);
  const [eh, em] = s.endTime.split(':').map(Number);
  const r = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
  return isNaN(r) || r < 0 ? 0 : r;
};

const shift = (date, start, end, extra = {}) => ({ date, startTime: start, endTime: end, ...extra });

// n consecutive weekdays of work ending the day before `before`.
function workDays(n, before, start = '15:00', end = '20:00', extra = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(shift(minusDays(before, i), start, end, extra));
  return out;
}

const BC_DAY = '2026-08-03'; // first Monday of August 2026

describe('isPaidStatHoliday', () => {
  it('BC Day 2026 is the first Monday of August', () => {
    expect(bcStatHolidays(2026).find(h => h.name === 'BC Day').date).toBe('2026-08-03');
    expect(new Date(BC_DAY + 'T00:00:00').getDay()).toBe(1); // Monday
  });

  // The real case: closed Sat Aug 1 AND Mon Aug 3, both in the holidays
  // list, both previously paying stat.
  it('pays the real stat holiday but NOT the closure beside it', () => {
    expect(isPaidStatHoliday({ date: '2026-08-03', name: 'BC Day' })).toBe(true);
    expect(isPaidStatHoliday({ date: '2026-08-01', name: 'Closed' })).toBe(false);
  });

  it('recognises every BC stat holiday with no flag set', () => {
    for (const h of bcStatHolidays(2026)) expect(isPaidStatHoliday(h)).toBe(true);
  });

  it('an arbitrary closure does not pay', () => {
    expect(isPaidStatHoliday({ date: '2026-08-14', name: 'Staff training' })).toBe(false);
    expect(isPaidStatHoliday({ date: '2026-12-27', name: 'Christmas break' })).toBe(false);
  });

  it('an explicit flag overrides the date test in both directions', () => {
    expect(isPaidStatHoliday({ date: '2026-08-14', name: 'Paid day off', stat: true })).toBe(true);
    expect(isPaidStatHoliday({ date: '2026-08-03', name: 'BC Day', stat: false })).toBe(false);
  });

  it('handles junk safely', () => {
    expect(isPaidStatHoliday(null)).toBe(false);
    expect(isPaidStatHoliday({ name: 'no date' })).toBe(false);
  });
});

describe('earnsWages', () => {
  it('counts an ordinary published shift', () => {
    expect(earnsWages(shift('2026-07-20', '15:00', '20:00'))).toBe(true);
  });
  it('rejects drafts — never published, so nothing happened', () => {
    expect(earnsWages(shift('2026-07-20', '15:00', '20:00', { status: 'draft' }))).toBe(false);
  });
  it('rejects no-shows — no work, no wages', () => {
    expect(earnsWages(shift('2026-07-20', '15:00', '20:00', { noShow: true }))).toBe(false);
  });
  it('rejects volunteer shifts — unpaid', () => {
    expect(earnsWages(shift('2026-07-20', '15:00', '20:00', { role: 'Volunteer' }))).toBe(false);
  });
  it('counts a paid sick day as earned wages', () => {
    expect(earnsWages(shift('2026-07-20', '15:00', '20:00', { sickPay: true }))).toBe(true);
  });
});

describe('qualifying days are DAYS, not shift records', () => {
  // The split-shift shapes that actually occur: half online / half in-centre,
  // or a Lead block followed by a Host block. Grouping is purely by DATE, so
  // role, shiftType and sub-role are all irrelevant — same day, one day.
  it('online + in-centre on the same day counts as ONE day', () => {
    const day = '2026-07-20';
    const r = statPayForHoliday([
      shift(day, '10:00', '14:00', { role: 'Online Instructor', shiftType: 'Online' }),
      shift(day, '15:00', '19:00', { role: 'Instructor', shiftType: 'In-Centre' }),
    ], BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(1);
    expect(r.totalHours).toBe(8); // both shifts' hours still count
  });

  it('Lead then Host on the same day counts as ONE day', () => {
    const day = '2026-07-21';
    const r = statPayForHoliday([
      shift(day, '11:00', '15:00', { role: 'Lead' }),
      shift(day, '15:00', '19:00', { role: 'Host' }),
    ], BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(1);
    expect(r.totalHours).toBe(8);
  });

  it('three shifts in one day still counts as ONE day', () => {
    const day = '2026-07-22';
    const r = statPayForHoliday([
      shift(day, '09:00', '11:00'), shift(day, '12:00', '14:00'), shift(day, '15:00', '18:00'),
    ], BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(1);
    expect(r.totalHours).toBe(7);
  });

  it('a split shift is one day, not two', () => {
    const day = '2026-07-20';
    const byDate = qualifyingDayHours(
      [shift(day, '11:00', '15:00'), shift(day, '15:00', '19:00')], BC_DAY, hoursOf,
    );
    expect(byDate.size).toBe(1);
    expect(byDate.get(day)).toBe(8); // hours still add up
  });

  it('8 days of split shifts (16 records) does NOT qualify', () => {
    const shifts = [];
    for (let i = 1; i <= 8; i++) {
      const d = minusDays(BC_DAY, i);
      shifts.push(shift(d, '11:00', '15:00'), shift(d, '15:00', '19:00'));
    }
    expect(shifts).toHaveLength(16); // would have passed the old record count
    const r = statPayForHoliday(shifts, BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(8);
    expect(r.qualifies).toBe(false);
    expect(r.hours).toBe(0);
  });

  it('15 distinct days qualifies; 14 does not', () => {
    expect(statPayForHoliday(workDays(14, BC_DAY), BC_DAY, hoursOf).qualifies).toBe(false);
    expect(statPayForHoliday(workDays(15, BC_DAY), BC_DAY, hoursOf).qualifies).toBe(true);
    expect(STAT_MIN_QUALIFYING_DAYS).toBe(15);
  });
});

describe('window boundaries', () => {
  it('excludes the holiday itself', () => {
    const r = statPayForHoliday([...workDays(15, BC_DAY), shift(BC_DAY, '09:00', '17:00')], BC_DAY, hoursOf);
    expect(r.days.some(d => d.date === BC_DAY)).toBe(false);
  });
  it('excludes work older than 30 days', () => {
    const old = shift(minusDays(BC_DAY, 31), '15:00', '20:00');
    const r = statPayForHoliday([old, ...workDays(15, BC_DAY)], BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(15);
  });
  it('includes day 30 exactly', () => {
    const r = statPayForHoliday([shift(minusDays(BC_DAY, 30), '15:00', '20:00')], BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(1);
  });
});

describe('non-working records do not build eligibility', () => {
  it('drafts, no-shows and volunteer shifts are all ignored', () => {
    const shifts = [
      ...workDays(12, BC_DAY),
      shift('2026-07-10', '15:00', '20:00', { status: 'draft' }),
      shift('2026-07-11', '15:00', '20:00', { status: 'draft' }),
      shift('2026-07-12', '15:00', '20:00', { noShow: true }),
      shift('2026-07-13', '15:00', '20:00', { role: 'Volunteer' }),
    ];
    const r = statPayForHoliday(shifts, BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(12); // not 16
    expect(r.qualifies).toBe(false);
  });

  it('a zero-hour shift earns nothing and adds no day', () => {
    const r = statPayForHoliday([shift('2026-07-20', '09:00', '09:00')], BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(0);
  });
});

describe("average day's pay", () => {
  it('divides total hours by days worked', () => {
    // 15 days: 10 at 5h, 5 at 8h -> 90h over 15 days = 6h
    const shifts = [
      ...Array.from({ length: 10 }, (_, i) => shift(minusDays(BC_DAY, i + 1), '15:00', '20:00')),
      ...Array.from({ length: 5 }, (_, i) => shift(minusDays(BC_DAY, i + 11), '09:00', '17:00')),
    ];
    const r = statPayForHoliday(shifts, BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(15);
    expect(r.totalHours).toBe(90);
    expect(r.hours).toBe(6);
  });

  it('averages per DAY, so split shifts do not drag the figure down', () => {
    // 15 days x two 4h shifts = 8h days. Per-day average is 8h, not 4h.
    const shifts = [];
    for (let i = 1; i <= 15; i++) {
      const d = minusDays(BC_DAY, i);
      shifts.push(shift(d, '11:00', '15:00'), shift(d, '15:00', '19:00'));
    }
    const r = statPayForHoliday(shifts, BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(15);
    expect(r.hours).toBe(8);
  });

  it('a paid sick day counts toward both the days and the average', () => {
    const shifts = [...workDays(14, BC_DAY), shift(minusDays(BC_DAY, 15), '15:00', '20:00', { sickPay: true })];
    const r = statPayForHoliday(shifts, BC_DAY, hoursOf);
    expect(r.daysWorked).toBe(15);
    expect(r.qualifies).toBe(true);
    expect(r.hours).toBe(5);
  });
});

describe('audit trail', () => {
  it('returns the qualifying days in date order for the export', () => {
    const r = statPayForHoliday(workDays(15, BC_DAY), BC_DAY, hoursOf);
    expect(r.days).toHaveLength(15);
    const dates = r.days.map(d => d.date);
    expect([...dates].sort()).toEqual(dates);
    expect(r.windowStart).toBe(minusDays(BC_DAY, 30));
  });
});
