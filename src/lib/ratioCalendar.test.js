import { describe, it, expect } from 'vitest';
import {
  minutesOf, hhmm, asDate, addDays, weekStartOf, isUsableEntry, entrySpan,
  validateEntry, entriesBetween, holdBlocks, blockedStarts, closureMap,
  rowsForDate, kindLabel, kindTone,
  occurrenceDates, nextOccurrence, nthWeekdayOfMonth, weekdayOrdinal,
  defaultUntil, describeSeries, repeatLabel, isRepeating, MAX_OCCURRENCES,
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

/**
 * Recurrence.
 *
 * The management meeting is 12–1 every Wednesday. Wednesday 23 September
 * 2026 is the one being made recurring, so that is the anchor throughout.
 */
const WED = '2026-09-23';

describe('stepping to the next occurrence', () => {
  it('walks a fixed interval', () => {
    expect(nextOccurrence(WED, 'weekly')).toBe('2026-09-30');
    expect(nextOccurrence(WED, 'biweekly')).toBe('2026-10-07');
    expect(nextOccurrence(WED, 'fourweekly')).toBe('2026-10-21');
  });

  it('crosses a month and a year without drifting off the weekday', () => {
    expect(nextOccurrence('2026-12-30', 'weekly')).toBe('2027-01-06');
    expect(asDate(nextOccurrence('2026-12-30', 'weekly')).getDay())
      .toBe(asDate('2026-12-30').getDay());
  });

  it('is nothing at all when it does not repeat', () => {
    expect(nextOccurrence(WED, 'none')).toBe(null);
    expect(nextOccurrence(WED, 'nonsense')).toBe(null);
  });
});

describe('a monthly meeting is a weekday, not a date', () => {
  it('knows which Wednesday of the month it is', () => {
    expect(weekdayOrdinal('2026-09-02')).toBe(1);
    expect(weekdayOrdinal(WED)).toBe(4);        // the fourth Wednesday
    expect(weekdayOrdinal('2026-09-30')).toBe(5);
  });

  it('keeps the position rather than the date', () => {
    // The fourth Wednesday of September is the 23rd; of October, the 28th.
    // A same-DATE rule would have said 23 October, which is a Friday.
    expect(nextOccurrence(WED, 'monthly')).toBe('2026-10-28');
    expect(asDate('2026-10-28').getDay()).toBe(3);
  });

  it('skips a month that has no fifth Wednesday instead of sliding it', () => {
    // 30 Sep 2026 is the fifth Wednesday. October has four, November has
    // four, December has five. Sliding to the fourth would put a meeting
    // in diaries on a day nobody agreed to.
    expect(nthWeekdayOfMonth(2026, 9, 3, 5)).toBe(null);   // October
    expect(nextOccurrence('2026-09-30', 'monthly')).toBe('2026-12-30');
  });

  it('finds the nth weekday of any month, and null past the end', () => {
    expect(nthWeekdayOfMonth(2026, 8, 3, 1).getDate()).toBe(2);   // 1st Wed Sep
    expect(nthWeekdayOfMonth(2026, 8, 3, 5).getDate()).toBe(30);  // 5th Wed Sep
    expect(nthWeekdayOfMonth(2026, 1, 0, 5)).toBe(null);          // Feb 2026
  });

  it('normalises a month index that runs past December', () => {
    const jan = nthWeekdayOfMonth(2026, 12, 3, 1);
    expect(jan.getFullYear()).toBe(2027);
    expect(jan.getMonth()).toBe(0);
  });
});

describe('the dates a series lands on', () => {
  it('is just the one when it does not repeat', () => {
    expect(occurrenceDates({ startISO: WED, freq: 'none' }))
      .toEqual({ dates: [WED], skipped: [], truncated: false });
  });

  it('runs weekly to the date it was given, inclusive', () => {
    const { dates } = occurrenceDates({ startISO: WED, freq: 'weekly', untilISO: '2026-10-21' });
    expect(dates).toEqual(['2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14', '2026-10-21']);
  });

  it('defaults to a year ahead when nobody picks an end', () => {
    const { dates } = occurrenceDates({ startISO: WED, freq: 'weekly' });
    expect(defaultUntil(WED)).toBe('2027-09-23');
    expect(dates).toHaveLength(53);
    expect(dates[dates.length - 1] <= '2027-09-23').toBe(true);
  });

  it('drops a later occurrence the centre is closed on, and says which', () => {
    // A meeting does not happen on a day the centre is shut, and moving
    // it to the Thursday would put it in diaries nobody agreed to.
    const { dates, skipped } = occurrenceDates({
      startISO: WED, freq: 'weekly', untilISO: '2026-10-21',
      skip: ['2026-09-30', '2026-10-14'],
    });
    expect(skipped).toEqual(['2026-09-30', '2026-10-14']);
    expect(dates).toEqual(['2026-09-23', '2026-10-07', '2026-10-21']);
  });

  it('KEEPS the start date even when it is a closure', () => {
    // Somebody chose that exact day. Dropping it can return an empty
    // series, and "I pressed save and nothing appeared" is worse than one
    // meeting on an odd day that they can see and move.
    const { dates, skipped } = occurrenceDates({
      startISO: WED, freq: 'weekly', untilISO: '2026-10-07', skip: [WED, '2026-09-30'],
    });
    expect(dates[0]).toBe(WED);
    expect(skipped).toEqual(['2026-09-30']);
  });

  it('never returns an empty series for a usable start', () => {
    for (const freq of ['weekly', 'biweekly', 'fourweekly', 'monthly']) {
      const { dates } = occurrenceDates({ startISO: WED, freq, untilISO: '2020-01-01' });
      expect(dates).toEqual([WED]);          // end before start → just the one
    }
  });

  it('stops at the ceiling rather than writing forever', () => {
    const { dates, truncated } = occurrenceDates({
      startISO: WED, freq: 'weekly', untilISO: '2099-01-01',
    });
    expect(dates).toHaveLength(MAX_OCCURRENCES);
    expect(truncated).toBe(true);
  });

  it('gives nothing for a date that is not a date', () => {
    expect(occurrenceDates({ startISO: 'whenever', freq: 'weekly' }).dates).toEqual([]);
    expect(occurrenceDates().dates).toEqual([]);
  });

  it('every weekly date is the same weekday as the start', () => {
    const { dates } = occurrenceDates({ startISO: WED, freq: 'weekly', untilISO: '2027-03-31' });
    for (const d of dates) expect(asDate(d).getDay()).toBe(3);
  });
});

describe('saying what save will do, before it does it', () => {
  it('counts the entries and names the last date', () => {
    const run = occurrenceDates({ startISO: WED, freq: 'weekly', untilISO: '2026-10-21' });
    expect(describeSeries(run, 'weekly')).toMatch(/^5 entries, every week, through/);
  });

  it('owns up to the ones it dropped', () => {
    const run = occurrenceDates({
      startISO: WED, freq: 'weekly', untilISO: '2026-10-21', skip: ['2026-09-30'],
    });
    expect(describeSeries(run, 'weekly')).toMatch(/1 skipped — the centre is closed/);
  });

  it('owns up to hitting the ceiling', () => {
    const run = occurrenceDates({ startISO: WED, freq: 'weekly', untilISO: '2099-01-01' });
    expect(describeSeries(run, 'weekly')).toMatch(new RegExp(`Stopped at ${MAX_OCCURRENCES}`));
  });

  it('says so plainly when there is only one', () => {
    expect(describeSeries({ dates: [WED], skipped: [], truncated: false }, 'none'))
      .toBe('Just the one.');
  });
});

describe('repeat labels', () => {
  it('names each rule and falls back rather than rendering blank', () => {
    expect(repeatLabel('weekly')).toBe('Every week');
    expect(repeatLabel('monthly')).toBe('Every month');
    expect(repeatLabel('nonsense')).toBe('Does not repeat');
  });

  it('knows which ones actually repeat', () => {
    expect(isRepeating('weekly')).toBe(true);
    expect(isRepeating('none')).toBe(false);
    expect(isRepeating('nonsense')).toBe(false);
  });
});
