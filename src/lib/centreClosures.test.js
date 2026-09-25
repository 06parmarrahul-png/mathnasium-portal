import { describe, it, expect } from 'vitest';
import {
  datesInRange, rangeProblem, addClosures, removeClosures,
  partitionClosures, isStat, rangeSummary, MAX_RANGE_DAYS,
} from './centreClosures';
import { bcStatHolidays } from './statPay';

describe('closing a stretch of days', () => {
  it('one date when there is no end date — the common case', () => {
    expect(datesInRange('2026-12-25')).toEqual(['2026-12-25']);
    expect(datesInRange('2026-12-25', '')).toEqual(['2026-12-25']);
  });

  it('every day between, inclusive — the point of the whole thing', () => {
    // Winter break used to be ten separate adds.
    expect(datesInRange('2026-12-24', '2026-12-28')).toEqual([
      '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-27', '2026-12-28',
    ]);
  });

  it('crosses a month, and a year', () => {
    expect(datesInRange('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02',
    ]);
  });

  it('refuses an end before the start', () => {
    expect(datesInRange('2026-12-25', '2026-12-20')).toBeNull();
    expect(rangeProblem('2026-12-25', '2026-12-20')).toMatch(/before/i);
  });

  it('REFUSES A MIS-KEYED YEAR rather than writing three thousand entries', () => {
    // There is no undo on the other side of that.
    expect(datesInRange('2026-12-25', '2036-12-25')).toBeNull();
    expect(rangeProblem('2026-12-25', '2036-12-25')).toMatch(new RegExp(`${MAX_RANGE_DAYS} days`));
  });

  it('allows exactly the cap', () => {
    const dates = datesInRange('2026-01-01', '2026-02-29'.replace('29', '28'));
    expect(dates).toHaveLength(59);
    expect(rangeProblem('2026-01-01', '2026-02-28')).toBeNull();
  });

  it('says what it is about to do', () => {
    expect(rangeSummary('2026-12-25')).toBe('1 day');
    expect(rangeSummary('2026-12-24', '2026-12-28')).toBe('5 days');
    expect(rangeSummary('', '')).toBe('');
  });

  it('asks for a date before anything else', () => {
    expect(rangeProblem('', '2026-12-28')).toMatch(/pick a date/i);
    expect(rangeProblem('not-a-date')).toMatch(/pick a date/i);
  });
});

describe('adding them to the list', () => {
  const xmas = { date: '2026-12-25', name: 'Christmas Day' };

  it('adds the new days and keeps the list in date order', () => {
    const { list, added } = addClosures([xmas], ['2026-12-24', '2026-12-28'], 'Winter break');
    expect(added).toBe(2);
    expect(list.map(h => h.date)).toEqual(['2026-12-24', '2026-12-25', '2026-12-28']);
  });

  it('LEAVES A DAY THAT IS ALREADY THERE ALONE', () => {
    // Closing the week around Christmas must not rename Christmas Day to
    // "Winter break" — the entry already there may be the stat one.
    const { list, skipped } = addClosures([xmas], ['2026-12-24', '2026-12-25'], 'Winter break');
    expect(skipped).toBe(1);
    expect(list.find(h => h.date === '2026-12-25').name).toBe('Christmas Day');
  });

  it('falls back to "Closed" rather than an empty name', () => {
    const { list } = addClosures([], ['2026-07-14'], '   ');
    expect(list[0].name).toBe('Closed');
  });

  it('survives a list that is missing or junk', () => {
    expect(addClosures(undefined, ['2026-07-14'], 'x').added).toBe(1);
    expect(addClosures(null, [], 'x').list).toEqual([]);
  });

  it('removes a whole stretch in one go', () => {
    const list = [xmas, { date: '2026-12-26', name: 'Boxing Day' }, { date: '2026-12-27', name: 'Closed' }];
    expect(removeClosures(list, ['2026-12-26', '2026-12-27']).map(h => h.date)).toEqual(['2026-12-25']);
  });
});

describe('holidays are a subset of closures', () => {
  const list = [
    { date: '2026-12-25', name: 'Christmas Day' },       // a stat, by date
    { date: '2026-12-27', name: 'Winter break' },        // not a stat
    { date: '2026-09-30', name: 'Truth and Reconciliation' },
    { date: '2026-08-15', name: 'Renovations' },
  ];

  it('closures is EVERYTHING — that is what closed means', () => {
    expect(partitionClosures(list).closures).toHaveLength(4);
  });

  it('holidays is the statutory ones only', () => {
    const { holidays } = partitionClosures(list);
    expect(holidays.map(h => h.date).sort()).toEqual(['2026-09-30', '2026-12-25']);
  });

  it('counts Sept 30 as statutory — it has been since 2023', () => {
    expect(isStat({ date: '2026-09-30' })).toBe(true);
  });

  it('honours an explicit flag over the date', () => {
    // A centre that closes on Boxing Day but does not pay it, or pays a
    // day that is not a stat, says so on the entry.
    expect(isStat({ date: '2026-12-26', stat: false })).toBe(false);
    expect(isStat({ date: '2026-08-15', stat: true })).toBe(true);
  });

  it('drops entries with no usable date rather than rendering a blank row', () => {
    const { closures } = partitionClosures([{ name: 'oops' }, null, { date: 'soon' }, list[0]]);
    expect(closures).toHaveLength(1);
  });

  it('survives nothing at all', () => {
    expect(partitionClosures(undefined)).toEqual({ closures: [], holidays: [] });
  });
});

describe('the stat list itself', () => {
  it('has twelve, including Truth and Reconciliation', () => {
    const list = bcStatHolidays(2026);
    expect(list).toHaveLength(12);
    expect(list.find(h => h.date === '2026-09-30')?.name)
      .toBe('National Day for Truth and Reconciliation');
  });

  it('stays in date order with the new one in its place', () => {
    const dates = bcStatHolidays(2026).map(h => h.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('carries it every year, not just this one', () => {
    for (const y of [2025, 2026, 2027, 2030]) {
      expect(bcStatHolidays(y).some(h => h.date === `${y}-09-30`)).toBe(true);
    }
  });
});
