import { describe, it, expect } from 'vitest';
import {
  minutesOf, hhmm, asDate, addDays, weekStartOf, isUsableEntry, entrySpan,
  validateEntry, entriesBetween, holdBlocks, blockedStarts, closureMap,
  rowsForDate, kindLabel, kindTone,
} from './ratioCalendar';

/**
 * Langley, Friday 25 September 2026. The centre teaches 3–7pm that day,
 * an assessment runs 60 minutes and the grid offers one every 30.
 *
 * This is the same fixture api/_lib/intakeAvailability.test.js uses for
 * holds. The two implementations are deliberately separate — a Vercel
 * function may not import from src/ — so the shared fixture is what stops
 * them drifting apart without anyone noticing.
 */
const FRI = '2026-09-25';
const WINDOWS = [{ start: '15:00', end: '19:00' }];

const TRAINING = {
  id: 'e1', title: 'Radius training', kind: 'training', date: FRI,
  startTime: '15:00', endTime: '17:00', allDay: false,
  assignedTo: ['u1', 'u2'], assignedNames: ['Neeru Gill', 'Rahul Parmar'],
  holdsBooking: true,
};

describe('reading a time off an entry', () => {
  it('parses the wall clock entries actually store', () => {
    expect(minutesOf('15:30')).toBe(930);
    expect(minutesOf('9:05')).toBe(545);
  });

  it('gives null for junk rather than a plausible midnight', () => {
    // 0 would be midnight, and midnight sorts first — a bad row would
    // silently lead the day.
    expect(minutesOf('')).toBe(null);
    expect(minutesOf(undefined)).toBe(null);
    expect(minutesOf('25:00')).toBe(null);
    expect(minutesOf('12:99')).toBe(null);
    expect(minutesOf('soon')).toBe(null);
  });

  it('round-trips through hhmm', () => {
    expect(hhmm(930)).toBe('15:30');
    expect(hhmm(0)).toBe('00:00');
    expect(minutesOf(hhmm(1140))).toBe(1140);
  });
});

describe('dates stay on the local calendar', () => {
  it('parses a bare date at local noon, not UTC midnight', () => {
    // UTC midnight is the previous day here, which is how a calendar
    // silently draws everything one column to the left.
    expect(asDate('2026-09-25').getDate()).toBe(25);
    expect(asDate('2026-01-01').getMonth()).toBe(0);
  });

  it('steps across a month boundary', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('finds the Sunday the week grid opens on', () => {
    expect(weekStartOf('2026-09-25')).toBe('2026-09-20');   // Friday → Sunday
    expect(weekStartOf('2026-09-20')).toBe('2026-09-20');   // already Sunday
    expect(weekStartOf('2026-09-26')).toBe('2026-09-20');   // Saturday
  });
});

describe('what counts as an entry', () => {
  it('needs a title and a real date', () => {
    expect(isUsableEntry(TRAINING)).toBe(true);
    expect(isUsableEntry({ ...TRAINING, title: '   ' })).toBe(false);
    expect(isUsableEntry({ ...TRAINING, date: 'soon' })).toBe(false);
    expect(isUsableEntry(null)).toBe(false);
  });

  it('treats a half-known time as all day rather than guessing', () => {
    expect(entrySpan(TRAINING)).toEqual({ start: 900, end: 1020 });
    expect(entrySpan({ ...TRAINING, endTime: null })).toBe(null);
    expect(entrySpan({ ...TRAINING, allDay: true })).toBe(null);
    expect(entrySpan({ ...TRAINING, endTime: '15:00' })).toBe(null);  // ends when it starts
  });

  it('sorts all-day first, then by start time', () => {
    const rows = entriesBetween([
      { title: 'Late', date: FRI, startTime: '18:00', endTime: '19:00' },
      { title: 'All day', date: FRI, allDay: true },
      { title: 'Early', date: FRI, startTime: '10:00', endTime: '11:00' },
      { title: 'Tomorrow', date: '2026-09-26', startTime: '09:00', endTime: '10:00' },
    ], FRI, '2026-09-26');
    expect(rows.map(r => r.title)).toEqual(['All day', 'Early', 'Late', 'Tomorrow']);
  });

  it('keeps entries outside the window out', () => {
    expect(entriesBetween([TRAINING], '2026-09-26', '2026-09-30')).toEqual([]);
  });
});

describe('validating what someone typed', () => {
  it('accepts the real one', () => {
    expect(validateEntry(TRAINING)).toBe(null);
  });

  it('wants a name and a date', () => {
    expect(validateEntry({ ...TRAINING, title: '' })).toMatch(/name/i);
    expect(validateEntry({ ...TRAINING, date: '' })).toMatch(/date/i);
  });

  it('wants both ends of a timed entry, or all day', () => {
    expect(validateEntry({ ...TRAINING, startTime: '' })).toMatch(/start/i);
    expect(validateEntry({ ...TRAINING, endTime: '' })).toMatch(/end/i);
    expect(validateEntry({ ...TRAINING, allDay: true, startTime: '', endTime: '' })).toBe(null);
  });

  it('refuses an entry that ends before it starts', () => {
    expect(validateEntry({ ...TRAINING, endTime: '14:00' })).toMatch(/after it starts/i);
  });

  it('refuses a hold that holds nothing', () => {
    // A zero-width hold is a silent no-op — the kind someone only finds
    // out about when a family books straight over it.
    expect(validateEntry({ ...TRAINING, startTime: '15:00', endTime: '15:02' }))
      .toMatch(/five minutes/i);
    // Same shape without the hold is fine — a two-minute note is allowed.
    expect(validateEntry({ ...TRAINING, startTime: '15:00', endTime: '15:02', holdsBooking: false }))
      .toBe(null);
  });
});

describe('holds become busy blocks the booking engine understands', () => {
  it('emits the same shape a real booking takes', () => {
    expect(holdBlocks([TRAINING])).toEqual([{
      startISO: '2026-09-25T15:00:00', durationMin: 120,
      source: 'calendar', title: 'Radius training',
    }]);
  });

  it('ignores an entry that does not hold', () => {
    expect(holdBlocks([{ ...TRAINING, holdsBooking: false }])).toEqual([]);
    expect(holdBlocks([{ ...TRAINING, holdsBooking: undefined }])).toEqual([]);
  });

  it('covers the whole day for an all-day hold', () => {
    const [b] = holdBlocks([{ ...TRAINING, allDay: true }]);
    expect(b.startISO).toBe('2026-09-25T00:00:00');
    expect(b.durationMin).toBe(1440);
  });

  it('respects the window it was asked for', () => {
    expect(holdBlocks([TRAINING], { from: '2026-09-26', to: '2026-09-30' })).toEqual([]);
    expect(holdBlocks([TRAINING], { from: FRI, to: FRI })).toHaveLength(1);
  });

  it('drops an entry with no usable date or title', () => {
    expect(holdBlocks([{ ...TRAINING, title: '' }])).toEqual([]);
    expect(holdBlocks([{ ...TRAINING, date: 'whenever' }])).toEqual([]);
    expect(holdBlocks(null)).toEqual([]);
  });
});

describe('telling someone what a hold will do before they save it', () => {
  it('names every slot the training takes off Friday', () => {
    // The centre offers 3:00, 3:30, 4:00, 4:30, 5:00, 5:30 and 6:00.
    // A 3–5 training blocks the first four: an assessment starting at
    // 4:30 runs to 5:30 and overlaps the tail of it.
    expect(blockedStarts({
      windows: WINDOWS, startTime: '15:00', endTime: '17:00',
    })).toEqual(['15:00', '15:30', '16:00', '16:30']);
  });

  it('does not block a slot that starts exactly when the hold ends', () => {
    // 5:00–6:00 sits flush against a hold ending at 5:00. Blocking it
    // would cost the centre a bookable hour for no reason.
    expect(blockedStarts({
      windows: WINDOWS, startTime: '15:00', endTime: '17:00',
    })).not.toContain('17:00');
  });

  it('does not block a slot that ends exactly when the hold starts', () => {
    expect(blockedStarts({
      windows: WINDOWS, startTime: '16:00', endTime: '17:00',
    })).toEqual(['15:30', '16:00', '16:30']);
  });

  it('takes the whole day for an all-day hold', () => {
    expect(blockedStarts({ windows: WINDOWS, allDay: true }))
      .toEqual(['15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00']);
  });

  it('blocks nothing on a day the centre does not teach', () => {
    expect(blockedStarts({ windows: [], startTime: '15:00', endTime: '17:00' })).toEqual([]);
  });

  it('blocks nothing for a hold with no usable times', () => {
    expect(blockedStarts({ windows: WINDOWS, startTime: '15:00', endTime: null })).toEqual([]);
    expect(blockedStarts({ windows: WINDOWS, startTime: '17:00', endTime: '15:00' })).toEqual([]);
  });

  it('follows the centre-s own slot length and interval', () => {
    // A 30-minute assessment every 15 minutes is a different grid, and
    // the same hold takes a different set of times off it.
    expect(blockedStarts({
      windows: [{ start: '15:00', end: '16:30' }],
      startTime: '15:30', endTime: '16:00',
      slotDurationMin: 30, slotIntervalMin: 15,
    })).toEqual(['15:15', '15:30', '15:45']);
  });
});

describe('closures come from Centre Settings, not from a second list', () => {
  it('keys the centre-s own holidays by date', () => {
    expect(closureMap([
      { date: '2026-09-07', name: 'Labour Day' },
      { date: '2026-09-18', name: 'Staff training day', stat: false },
    ])).toEqual({
      '2026-09-07': { name: 'Labour Day', stat: true },
      '2026-09-18': { name: 'Staff training day', stat: false },
    });
  });

  it('treats a holiday with no flag as statutory, which is how they are stored', () => {
    expect(closureMap([{ date: '2026-09-07', name: 'Labour Day' }])['2026-09-07'].stat).toBe(true);
  });

  it('respects the window and survives junk', () => {
    const list = [{ date: '2026-09-07', name: 'Labour Day' }, { name: 'No date' }, null];
    expect(closureMap(list, '2026-09-08', '2026-09-30')).toEqual({});
    expect(Object.keys(closureMap(list))).toEqual(['2026-09-07']);
  });
});

describe('one day, everything on it, from where it already lives', () => {
  const DAY = {
    dateISO: FRI,
    entries: [TRAINING],
    events: [{ id: 'ev1', date: FRI, title: 'Bingo', type: 'fun-day' }],
    intakes: [{
      id: 'i1', slot: `${FRI}T18:00:00`, durationMin: 60,
      childName: 'Sofia K.', guardianName: 'A. Kovac', status: 'scheduled',
    }],
    timeOff: [{ id: 't1', userName: 'Luke Huang', status: 'approved', startDate: FRI, endDate: FRI }],
    holidays: [{ date: '2026-09-07', name: 'Labour Day' }],
  };

  it('merges the five sources into one ordered day', () => {
    const rows = rowsForDate(DAY);
    expect(rows.map(r => r.source)).toEqual(['event', 'timeoff', 'entry', 'intake']);
    expect(rows.map(r => r.title)).toEqual([
      'Bingo', 'Luke Huang — time off', 'Radius training', 'Assessment — Sofia K.',
    ]);
  });

  it('gives an assessment its real end time from the booking length', () => {
    const intake = rowsForDate(DAY).find(r => r.source === 'intake');
    expect(intake.startTime).toBe('18:00');
    expect(intake.endTime).toBe('19:00');
    expect(intake.kind).toBe('assessment');
  });

  it('leaves a cancelled booking off the day', () => {
    const rows = rowsForDate({ ...DAY, intakes: [{ ...DAY.intakes[0], status: 'cancelled' }] });
    expect(rows.some(r => r.source === 'intake')).toBe(false);
  });

  it('shows only APPROVED time off', () => {
    for (const status of ['pending', 'denied', undefined]) {
      const rows = rowsForDate({ ...DAY, timeOff: [{ ...DAY.timeOff[0], status }] });
      expect(rows.some(r => r.source === 'timeoff')).toBe(false);
    }
  });

  it('spreads a multi-day leave across each of its days', () => {
    const off = [{ id: 't2', userName: 'Luke Huang', status: 'approved', startDate: '2026-09-23', endDate: '2026-09-27' }];
    for (const d of ['2026-09-23', FRI, '2026-09-27']) {
      expect(rowsForDate({ dateISO: d, timeOff: off }).some(r => r.source === 'timeoff')).toBe(true);
    }
    expect(rowsForDate({ dateISO: '2026-09-28', timeOff: off })).toEqual([]);
  });

  it('puts the closure at the top of a closed day and marks it holding', () => {
    const rows = rowsForDate({ ...DAY, dateISO: '2026-09-07' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'closure', title: 'Labour Day',
      note: 'Statutory — centre closed', holdsBooking: true, allDay: true,
    });
  });

  it('reads a fun day as all-day when the event carries no time', () => {
    const fun = rowsForDate(DAY).find(r => r.source === 'event');
    expect(fun.allDay).toBe(true);
    expect(fun.kind).toBe('fun-day');
  });

  it('has nothing to show for an empty day rather than throwing', () => {
    expect(rowsForDate({ dateISO: FRI })).toEqual([]);
  });
});

describe('kinds', () => {
  it('names every kind, and falls back rather than rendering blank', () => {
    expect(kindLabel('training')).toBe('Training');
    expect(kindLabel('hold')).toBe('Just a hold');
    expect(kindLabel('nonsense')).toBe('Task');
  });

  it('colours a kind from the .nl tokens so themes follow', () => {
    expect(kindTone('assessment')).toEqual({ color: 'var(--nl-ok)', wash: 'var(--nl-okw)' });
    expect(kindTone('nonsense').color).toBe('var(--nl-muted)');
  });
});
