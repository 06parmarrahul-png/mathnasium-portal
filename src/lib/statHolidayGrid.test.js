import { describe, it, expect } from 'vitest';
import {
  holidayCards, defaultHolidayDate, holidayYears, windowIsLoaded, windowIsClosed, buildStatRows,
} from './statHolidayGrid';

// Langley's real holiday list on 2026-09-14, including the two Saturday
// closures next to long weekends, which are not paid stat holidays.
const LANGLEY = [
  { name: "New Year's Day", date: '2026-01-01' }, { date: '2026-02-16', name: 'Family Day' },
  { name: 'Good Friday', date: '2026-04-03' }, { date: '2026-05-18', name: 'Victoria Day' },
  { name: 'Canada Day', date: '2026-07-01' }, { date: '2026-08-03', name: 'BC Day' },
  { name: 'Labour Day', date: '2026-09-07' }, { date: '2026-10-12', name: 'Thanksgiving' },
  { date: '2026-11-11', name: 'Remembrance Day' }, { name: 'Christmas Day', date: '2026-12-25' },
  { name: 'Boxing Day', date: '2026-12-26' }, { date: '2027-01-01', name: "New Year's Day" },
  { date: '2026-08-01', name: 'BC Day' }, { date: '2026-09-05', name: 'Labour Day' },
];

describe('holidayCards', () => {
  const cards = holidayCards(LANGLEY, '2026-09-14');
  const byDate = Object.fromEntries(cards.map(c => [c.date, c]));

  it('lists the paid statutory holidays in order, leaving out plain closures', () => {
    expect(cards.map(c => c.date)).toEqual([
      '2026-01-01', '2026-02-16', '2026-04-03', '2026-05-18', '2026-07-01', '2026-08-03',
      '2026-09-07', '2026-10-12', '2026-11-11', '2026-12-25', '2026-12-26', '2027-01-01',
    ]);
    expect(byDate['2026-08-01']).toBeUndefined();
    expect(byDate['2026-09-05']).toBeUndefined();
  });

  it('marks Thanksgiving as the next one on the 14th of September', () => {
    expect(cards.filter(c => c.status === 'next').map(c => c.holiday.name)).toEqual(['Thanksgiving']);
    expect(byDate['2026-11-11'].status).toBe('upcoming');
  });

  it('gives each holiday the pay period it lands in and the day that period is paid', () => {
    expect(byDate['2026-10-12'].period).toEqual({ start: '2026-10-11', end: '2026-10-25' });
    expect(byDate['2026-10-12'].payDate).toBe('2026-10-30');
    expect(byDate['2026-09-07'].period).toEqual({ start: '2026-08-26', end: '2026-09-10' });
    expect(byDate['2026-09-07'].payDate).toBe('2026-09-15');
  });

  it('knows Labour Day is still being paid on the 14th, and BC Day already was', () => {
    expect(byDate['2026-09-07'].status).toBe('being-paid');
    expect(byDate['2026-08-03'].status).toBe('paid');
  });

  it('spells out the 30-day qualifying window', () => {
    expect(byDate['2026-10-12'].windowStart).toBe('2026-09-12');
    expect(byDate['2026-10-12'].windowEnd).toBe('2026-10-11');
  });

  it('shows a holiday entered twice once', () => {
    expect(holidayCards([...LANGLEY, { name: 'Thanksgiving', date: '2026-10-12' }], '2026-09-14')
      .filter(c => c.date === '2026-10-12')).toHaveLength(1);
  });

  it('treats the holiday itself, on the day, as next', () => {
    expect(holidayCards(LANGLEY, '2026-10-12').find(c => c.status === 'next').date).toBe('2026-10-12');
  });

  it('copes with no list', () => {
    expect(holidayCards(undefined, '2026-09-14')).toEqual([]);
  });
});

describe('which holiday opens expanded', () => {
  const cards = holidayCards(LANGLEY, '2026-09-14');

  it('the one in the selected pay period', () => {
    expect(defaultHolidayDate(cards, { start: '2026-08-26', end: '2026-09-10' })).toBe('2026-09-07');
  });

  it('otherwise the next one', () => {
    expect(defaultHolidayDate(cards, { start: '2026-09-11', end: '2026-09-25' })).toBe('2026-10-12');
  });

  it('otherwise the last, once every holiday has passed', () => {
    const past = holidayCards(LANGLEY, '2027-06-01');
    expect(defaultHolidayDate(past, null)).toBe('2027-01-01');
    expect(defaultHolidayDate([], null)).toBeNull();
  });
});

describe('what can honestly be worked out', () => {
  const cards = holidayCards(LANGLEY, '2026-09-14');
  const at = (d) => cards.find(c => c.date === d);

  it('only holidays whose whole window is inside the loaded shifts', () => {
    expect(windowIsLoaded(at('2026-09-07'), '2026-03-18')).toBe(true);
    expect(windowIsLoaded(at('2026-04-03'), '2026-03-18')).toBe(false);   // window starts 4 Mar
  });

  it('knows when a window is still open', () => {
    expect(windowIsClosed(at('2026-09-07'), '2026-09-14')).toBe(true);
    expect(windowIsClosed(at('2026-10-12'), '2026-09-14')).toBe(false);
  });

  it('lists the years for the switcher', () => {
    expect(holidayYears(cards)).toEqual(['2026', '2027']);
  });
});

describe('buildStatRows', () => {
  const thanksgiving = { name: 'Thanksgiving', date: '2026-10-12' };
  const person = (name, count, statHours = 0) => ({
    name, count, qualifies: count >= 15, statHours, sickDays: 0, workedDays: count, days: [], totalHours: 0,
  });

  it('puts the eligible first, highest stat pay first, then who is closest to 15', () => {
    const rows = buildStatRows([{ holiday: thanksgiving, perPerson: [
      person('Ann', 9), person('Bo', 16, 5.5), person('Cy', 20, 7.25), person('Di', 14),
    ] }], new Map([['Bo', 'Lead']]));
    expect(rows.map(r => r.name)).toEqual(['Cy', 'Bo', 'Di', 'Ann']);
    expect(rows.find(r => r.name === 'Bo').role).toBe('Lead');
    expect(rows.find(r => r.name === 'Ann').role).toBe('Instructor');
  });

  it('adds stat hours across two holidays in one period', () => {
    const boxing = { name: 'Boxing Day', date: '2026-12-26' };
    const rows = buildStatRows([
      { holiday: { name: 'Christmas Day', date: '2026-12-25' }, perPerson: [person('Ann', 18, 6)] },
      { holiday: boxing, perPerson: [person('Ann', 18, 6.004)] },
    ]);
    expect(rows[0].totalStat).toBe(12);
    expect(rows[0].perHoliday).toHaveLength(2);
  });
});
