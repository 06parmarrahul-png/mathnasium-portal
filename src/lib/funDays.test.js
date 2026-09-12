import { describe, it, expect } from 'vitest';
import {
  isFunDay, funDaysInMonth, funDayOn, funDaysAhead,
  monthDays, monthLabel, monthOf, stepMonth, diffMonth, asDate, toISO,
} from './funDays';

/** Activities taken from the centre's real September calendar. */
const fd = (date, title) => ({ id: date, type: 'fun-day', date, title });
const SEPT = [
  fd('2026-09-01', 'Labour Day'),
  fd('2026-09-02', 'Bingo'),
  fd('2026-09-03', 'Four Corners'),
  fd('2026-09-04', 'Doodle Challenge'),
  fd('2026-09-08', 'Instructor Says'),
  fd('2026-10-01', 'Coin Flip'),
  { id: 'm1', type: 'meeting', date: '2026-09-05', title: 'Staff meeting' },
];

describe('isFunDay', () => {
  it('is a fun day only when it is typed as one and has both a date and a name', () => {
    expect(isFunDay(fd('2026-09-02', 'Bingo'))).toBe(true);
    expect(isFunDay({ type: 'meeting', date: '2026-09-02', title: 'Staff meeting' })).toBe(false);
    expect(isFunDay({ type: 'fun-day', date: '2026-09-02', title: '  ' })).toBe(false);
    expect(isFunDay({ type: 'fun-day', title: 'Bingo' })).toBe(false);
    expect(isFunDay(null)).toBe(false);
  });
});

describe('funDaysInMonth', () => {
  it('takes one month, in order, and leaves the meeting out', () => {
    expect(funDaysInMonth(SEPT, '2026-09').map(e => e.title))
      .toEqual(['Labour Day', 'Bingo', 'Four Corners', 'Doodle Challenge', 'Instructor Says']);
  });

  it('does not bleed into the next month', () => {
    expect(funDaysInMonth(SEPT, '2026-10').map(e => e.title)).toEqual(['Coin Flip']);
  });

  it('copes with nothing', () => {
    expect(funDaysInMonth([], '2026-09')).toEqual([]);
    expect(funDaysInMonth(null, '2026-09')).toEqual([]);
  });
});

describe('funDayOn', () => {
  it('finds today’s', () => {
    expect(funDayOn(SEPT, '2026-09-02').title).toBe('Bingo');
  });

  it('is null on a day with none, and never returns the staff meeting', () => {
    expect(funDayOn(SEPT, '2026-09-07')).toBeNull();
    expect(funDayOn(SEPT, '2026-09-05')).toBeNull();
  });
});

describe('funDaysAhead', () => {
  it('gives today and the next few days', () => {
    expect(funDaysAhead(SEPT, '2026-09-02', 2).map(e => e.title))
      .toEqual(['Bingo', 'Four Corners', 'Doodle Challenge']);
  });

  it('counts CALENDAR days, not entries', () => {
    // A window of two days from the 4th reaches the 6th, and there is
    // nothing on the 8th yet — promising it would be promising something
    // that is not coming up.
    expect(funDaysAhead(SEPT, '2026-09-04', 2).map(e => e.title))
      .toEqual(['Doodle Challenge']);
  });

  it('never looks backwards', () => {
    expect(funDaysAhead(SEPT, '2026-09-03', 4).map(e => e.title))
      .toEqual(['Four Corners', 'Doodle Challenge']);
  });

  it('copes with a nonsense date', () => {
    expect(funDaysAhead(SEPT, 'whenever')).toEqual([]);
  });
});

describe('monthDays', () => {
  it('gives every day of the month with its weekday', () => {
    const d = monthDays('2026-09');
    expect(d.length).toBe(30);
    expect(d[0]).toEqual({ date: '2026-09-01', day: 1, weekday: 2 });   // a Tuesday
    expect(d[29].date).toBe('2026-09-30');
  });

  it('knows February', () => {
    expect(monthDays('2026-02').length).toBe(28);
    expect(monthDays('2028-02').length).toBe(29);        // a leap year
  });

  it('gives nothing for nonsense', () => {
    expect(monthDays('2026-13')).toEqual([]);
    expect(monthDays('nope')).toEqual([]);
  });
});

describe('month helpers', () => {
  it('writes a month out', () => {
    expect(monthLabel('2026-09')).toBe('September 2026');
    expect(monthLabel('bad')).toBe('bad');
  });

  it('steps forward and back across a year boundary', () => {
    expect(stepMonth('2026-09', 1)).toBe('2026-10');
    expect(stepMonth('2026-12', 1)).toBe('2027-01');
    expect(stepMonth('2026-01', -1)).toBe('2025-12');
  });

  it('takes the month off a date', () => {
    expect(monthOf('2026-09-14')).toBe('2026-09');
  });

  it('parses at local noon so the day never slips', () => {
    // new Date('2026-09-14') is the 13th in Pacific.
    expect(toISO(asDate('2026-09-14'))).toBe('2026-09-14');
  });
});

describe('diffMonth — only what changed gets written', () => {
  const existing = [fd('2026-09-02', 'Bingo'), fd('2026-09-03', 'Four Corners')];

  it('writes nothing when nothing was touched', () => {
    const d = diffMonth(existing, { '2026-09-02': 'Bingo', '2026-09-03': 'Four Corners' }, '2026-09');
    expect(d).toEqual({ adds: [], edits: [], removes: [] });
  });

  it('adds a day that was blank', () => {
    const d = diffMonth(existing, { '2026-09-04': 'Doodle Challenge' }, '2026-09');
    expect(d.adds).toEqual([{ date: '2026-09-04', title: 'Doodle Challenge' }]);
  });

  it('edits a day that was changed', () => {
    const d = diffMonth(existing, { '2026-09-02': 'Double Bingo!' }, '2026-09');
    expect(d.edits).toEqual([{ id: '2026-09-02', date: '2026-09-02', title: 'Double Bingo!' }]);
  });

  it('removes a day that was cleared', () => {
    const d = diffMonth(existing, { '2026-09-02': '' }, '2026-09');
    expect(d.removes.map(r => r.id)).toEqual(['2026-09-02']);
  });

  it('ignores whitespace-only as a change', () => {
    const d = diffMonth(existing, { '2026-09-02': '  Bingo  ' }, '2026-09');
    expect(d.edits).toEqual([]);
  });

  it('never touches another month', () => {
    const withOct = [...existing, fd('2026-10-01', 'Coin Flip')];
    const d = diffMonth(withOct, { '2026-09-02': '' }, '2026-09');
    expect(d.removes.map(r => r.id)).toEqual(['2026-09-02']);
  });
});
