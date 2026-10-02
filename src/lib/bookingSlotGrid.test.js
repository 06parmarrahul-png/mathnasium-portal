import { describe, it, expect } from 'vitest';
import {
  weekStartOf, shiftWeek, timeOf, cellState, gridFrom, toggleRule, pruneRules, closedCount,
  toggleDay, dayIsClosed, weekEndOf,
} from './bookingSlotGrid';

const slot = (date, time, extra = {}) => ({
  startISO: `${date}T${time}:00`,
  label: time,
  taken: false, held: false, staffClosed: false,
  inPast: false, tooFuture: false, dayFull: false,
  available: true,
  ...extra,
});

const day = (date, weekday, times, extra = {}) => ({
  date, weekday, closed: false, closureName: null, dayFull: false,
  slots: times.map(t => slot(date, t)),
  ...extra,
});

describe('which week is on screen', () => {
  it('starts weeks on Sunday, like the booking page', () => {
    expect(weekStartOf('2026-10-07')).toBe('2026-10-04');   // a Wednesday
    expect(weekStartOf('2026-10-04')).toBe('2026-10-04');   // already Sunday
  });

  it('pages a week at a time, across a month end', () => {
    expect(shiftWeek('2026-10-04', 1)).toBe('2026-10-11');
    expect(shiftWeek('2026-10-04', -1)).toBe('2026-09-27');
  });

  it('gives back what it was handed rather than NaN', () => {
    expect(weekStartOf('')).toBeNull();
    expect(shiftWeek('nonsense', 1)).toBe('nonsense');
  });

  it('reads the time a rule is filed under straight off the string', () => {
    // Not through Date: a slot is wall-clock with no zone on it.
    expect(timeOf('2026-10-07T15:30:00')).toBe('15:30');
    expect(timeOf(null)).toBe('');
  });
});

describe('what one cell is', () => {
  it('is open, and tappable, by default', () => {
    expect(cellState(slot('2026-10-06', '15:00'), false))
      .toEqual({ kind: 'open', tappable: true });
  });

  it('is closed and still tappable once somebody shuts it', () => {
    expect(cellState(slot('2026-10-06', '15:00'), true))
      .toEqual({ kind: 'closed', tappable: true });
  });

  it('never offers to open an hour a family is already coming to', () => {
    expect(cellState(slot('2026-10-06', '15:00', { taken: true }), true))
      .toEqual({ kind: 'booked', tappable: false });
    expect(cellState(slot('2026-10-06', '15:00', { held: true }), false))
      .toEqual({ kind: 'held', tappable: false });
  });

  it('puts "shut by hand" ahead of "in the past", because only one undoes', () => {
    expect(cellState(slot('2026-10-06', '15:00', { inPast: true }), true).kind).toBe('closed');
    expect(cellState(slot('2026-10-06', '15:00', { inPast: true }), false).kind).toBe('past');
  });

  it('leaves a full day-s times reading as open', () => {
    // The cap is its own thing somebody can raise; painting these shut
    // would claim they had been closed by hand.
    expect(cellState(slot('2026-10-06', '15:00', { dayFull: true, available: false }), false).kind)
      .toBe('open');
  });

  it('is nothing at all where the day has no such time', () => {
    expect(cellState(null, false)).toEqual({ kind: 'none', tappable: false });
  });
});

describe('the grid', () => {
  const days = [
    day('2026-10-05', 'Monday', ['15:00', '15:30', '16:00']),
    day('2026-10-10', 'Saturday', ['10:00', '10:30']),
  ];

  it('rows are every time in the week, so days line up with each other', () => {
    const { times } = gridFrom(days);
    expect(times).toEqual(['10:00', '10:30', '15:00', '15:30', '16:00']);
  });

  it('leaves a day empty at a time it does not open', () => {
    const { columns } = gridFrom(days);
    const monday = columns[0];
    expect(monday.cells.find(c => c.time === '10:00').kind).toBe('none');
    expect(monday.cells.find(c => c.time === '15:00').kind).toBe('open');
  });

  it('draws a closed time from the LOCAL rules, so an unsaved tap shows', () => {
    const { columns } = gridFrom(days, { '2026-10-05': { '15:30': false } });
    const monday = columns[0];
    expect(monday.cells.find(c => c.time === '15:30').kind).toBe('closed');
    expect(monday.cells.find(c => c.time === '15:00').kind).toBe('open');
  });

  it('carries a centre closure through so the column can say why', () => {
    const { columns } = gridFrom([
      { date: '2026-10-12', weekday: 'Monday', slots: [], closed: true, closureName: 'Thanksgiving' },
    ]);
    expect(columns[0]).toMatchObject({ closed: true, closureName: 'Thanksgiving' });
  });

  it('survives being handed nothing', () => {
    expect(gridFrom(null)).toEqual({ times: [], columns: [] });
  });
});

describe('a tap', () => {
  it('shuts a time without touching its neighbours', () => {
    const got = toggleRule({ '2026-10-05': { '16:00': false } }, '2026-10-05', '15:30', false);
    expect(got['2026-10-05']).toEqual({ '16:00': false, '15:30': false });
  });

  it('writes true to reopen rather than dropping the key', () => {
    // The panel saves with a merge write: a deleted key would survive in
    // Firestore and the slot would stay shut.
    const got = toggleRule({ '2026-10-05': { '15:30': false } }, '2026-10-05', '15:30', true);
    expect(got['2026-10-05']['15:30']).toBe(true);
  });

  it('starts a day that had no rules at all', () => {
    expect(toggleRule(undefined, '2026-10-05', '15:30', false))
      .toEqual({ '2026-10-05': { '15:30': false } });
  });
});

describe('what gets saved', () => {
  const rules = {
    '2026-09-01': { '15:00': false },      // gone
    '2026-10-06': { '15:30': false, '16:00': true },
    '2026-10-07': {},                       // nothing left in it
  };

  it('drops dates that can never be booked again', () => {
    expect(pruneRules(rules, '2026-10-05')).toEqual({ '2026-10-06': { '15:30': false, '16:00': true } });
  });

  it('keeps today', () => {
    expect(Object.keys(pruneRules(rules, '2026-09-01'))).toContain('2026-09-01');
  });

  it('counts the times actually shut, not the ones reopened', () => {
    expect(closedCount(rules, '2026-10-05')).toBe(1);
    expect(closedCount({}, '2026-10-05')).toBe(0);
  });
});

describe('turning a whole date off', () => {
  const column = gridFrom([{
    date: '2026-10-06', weekday: 'Tuesday', closed: false, closureName: null, dayFull: false,
    slots: [
      slot('2026-10-06', '15:00'),
      slot('2026-10-06', '15:30', { taken: true }),
      slot('2026-10-06', '16:00', { held: true }),
      slot('2026-10-06', '16:30'),
    ],
  }]).columns[0];

  it('shuts every time a family could still take, and nothing else', () => {
    const got = toggleDay({}, column, false);
    // The booked hour keeps its booking and the held one keeps its hold:
    // neither is this grid's to overrule.
    expect(got['2026-10-06']).toEqual({ '15:00': false, '16:30': false });
  });

  it('gives the day back', () => {
    const shut = toggleDay({}, column, false);
    expect(toggleDay(shut, column, true)['2026-10-06'])
      .toEqual({ '15:00': true, '16:30': true });
  });

  it('knows when there is nothing left to take', () => {
    expect(dayIsClosed(column)).toBe(false);
    const shut = gridFrom([{
      date: '2026-10-06', weekday: 'Tuesday', slots: [slot('2026-10-06', '15:00')],
    }], { '2026-10-06': { '15:00': false } }).columns[0];
    expect(dayIsClosed(shut)).toBe(true);
  });

  it('is not "closed" when the day simply has no times', () => {
    const empty = gridFrom([{ date: '2026-10-11', weekday: 'Sunday', slots: [] }]).columns[0];
    expect(dayIsClosed(empty)).toBe(false);
  });
});

describe('the range on the nav', () => {
  it('closes the week on the Saturday, across a month end', () => {
    expect(weekEndOf('2026-10-25')).toBe('2026-10-31');
    expect(weekEndOf('2026-11-29')).toBe('2026-12-05');
  });

  it('hands back what it was given rather than an Invalid Date', () => {
    expect(weekEndOf('')).toBe('');
  });
});
