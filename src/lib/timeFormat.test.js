import { describe, it, expect } from 'vitest';
import {
  formatTime, formatRange, formatClock, formatStamp,
  resolveTimeFormat, timeFormatLabel, minutesOf, makeTimeFormatter,
  DEFAULT_TIME_FORMAT, TIME_FORMATS,
} from './timeFormat';

describe('the preference', () => {
  it('is 12-hour unless someone says otherwise', () => {
    expect(DEFAULT_TIME_FORMAT).toBe('12h');
    expect(resolveTimeFormat(undefined)).toBe('12h');
    expect(resolveTimeFormat(null)).toBe('12h');
    expect(resolveTimeFormat('')).toBe('12h');
  });

  it('honours a stored 24-hour choice', () => {
    expect(resolveTimeFormat('24h')).toBe('24h');
  });

  it('falls back rather than throwing on something it does not know', () => {
    expect(resolveTimeFormat('military')).toBe('12h');
    expect(resolveTimeFormat(24)).toBe('12h');
    expect(resolveTimeFormat({})).toBe('12h');
  });

  it('offers exactly two choices, and names them', () => {
    expect(TIME_FORMATS).toEqual(['12h', '24h']);
    expect(timeFormatLabel('12h')).toBe('12-hour');
    expect(timeFormatLabel('24h')).toBe('24-hour');
  });
});

describe('twelve-hour', () => {
  it('reads the way the centre says it out loud', () => {
    expect(formatTime('15:30', '12h')).toBe('3:30 PM');
    expect(formatTime('09:05', '12h')).toBe('9:05 AM');
    expect(formatTime('19:00', '12h')).toBe('7:00 PM');
  });

  it('gets the two hours everybody gets wrong right', () => {
    expect(formatTime('00:30', '12h')).toBe('12:30 AM');
    expect(formatTime('12:00', '12h')).toBe('12:00 PM');
    expect(formatTime('12:45', '12h')).toBe('12:45 PM');
    expect(formatTime('00:00', '12h')).toBe('12:00 AM');
  });

  it('has a compact width for chart axes and a short one for dense boards', () => {
    expect(formatTime('15:30', '12h', 'compact')).toBe('3:30PM');
    expect(formatTime('15:00', '12h', 'short')).toBe('3pm');
    expect(formatTime('15:30', '12h', 'short')).toBe('3:30pm');
    expect(formatTime('09:00', '12h', 'short')).toBe('9am');
  });
});

describe('twenty-four hour', () => {
  it('shows the stored time, zero-padded', () => {
    expect(formatTime('15:30', '24h')).toBe('15:30');
    expect(formatTime('9:05', '24h')).toBe('09:05');
    expect(formatTime('00:00', '24h')).toBe('00:00');
  });

  it('ignores the width, because there is nothing to shorten', () => {
    expect(formatTime('15:30', '24h', 'compact')).toBe('15:30');
    expect(formatTime('15:00', '24h', 'short')).toBe('15:00');
  });
});

describe('what it accepts', () => {
  it('takes minutes past midnight, the way the staffing maths carries them', () => {
    expect(minutesOf(930)).toBe(930);
    expect(formatTime(930, '12h')).toBe('3:30 PM');
    expect(formatTime(930, '24h')).toBe('15:30');
  });

  it('parses an unpadded hour', () => {
    expect(minutesOf('9:05')).toBe(545);
    expect(minutesOf('15:30')).toBe(930);
  });

  it('shows nothing when there is nothing', () => {
    expect(formatTime('', '12h')).toBe('');
    expect(formatTime(null, '12h')).toBe('');
    expect(formatTime(undefined, '12h')).toBe('');
  });

  it('hands back rubbish unchanged rather than hiding it', () => {
    // A stray value on an old document should look wrong on the page,
    // not vanish from it.
    expect(formatTime('sometime', '12h')).toBe('sometime');
    expect(minutesOf('sometime')).toBe(null);
  });
});

describe('ranges', () => {
  it('uses one separator everywhere', () => {
    expect(formatRange('15:00', '19:00', '12h')).toBe('3:00 PM – 7:00 PM');
    expect(formatRange('15:00', '19:00', '24h')).toBe('15:00 – 19:00');
  });

  it('tightens up in the narrow widths', () => {
    expect(formatRange('15:00', '19:00', '12h', 'short')).toBe('3pm–7pm');
  });

  it('refuses half a range', () => {
    // Half of one reads as a start time somebody forgot to finish.
    expect(formatRange('15:00', '', '12h')).toBe('');
    expect(formatRange(null, '19:00', '12h')).toBe('');
  });
});

describe('timestamps', () => {
  const when = new Date('2026-09-20T15:04:00');

  it('shows a clock face in the chosen format', () => {
    expect(formatClock(when, '12h')).toBe('3:04 PM');
    expect(formatClock(when, '24h')).toBe('15:04');
  });

  it('puts the day on a stamp', () => {
    expect(formatStamp(when, '12h')).toBe('Sep 20, 3:04 PM');
    expect(formatStamp(when, '24h')).toBe('Sep 20, 15:04');
  });

  it('takes a Firestore timestamp, either shape', () => {
    expect(formatClock({ seconds: Math.floor(when.getTime() / 1000) }, '12h')).toBe('3:04 PM');
    expect(formatClock({ toDate: () => when }, '12h')).toBe('3:04 PM');
  });

  it('shows nothing for a stamp that isn\'t there yet', () => {
    // serverTimestamp() reads back null until the write lands.
    expect(formatClock(null, '12h')).toBe('');
    expect(formatStamp(undefined, '12h')).toBe('');
    expect(formatClock('not a date', '12h')).toBe('');
  });
});

describe('the bound formatter', () => {
  const twelve = makeTimeFormatter('12h');
  const twentyFour = makeTimeFormatter('24h');

  it('is callable, and carries the format with it', () => {
    expect(twelve('15:30')).toBe('3:30 PM');
    expect(twentyFour('15:30')).toBe('15:30');
    expect(twelve.format).toBe('12h');
    expect(twelve.is24h).toBe(false);
    expect(twentyFour.is24h).toBe(true);
  });

  it('exposes every width and both timestamp shapes', () => {
    expect(twelve.compact('15:30')).toBe('3:30PM');
    expect(twelve.short('15:00')).toBe('3pm');
    expect(twelve.range('15:00', '19:00')).toBe('3:00 PM – 7:00 PM');
    expect(twelve.clock(new Date('2026-09-20T15:04:00'))).toBe('3:04 PM');
    expect(twelve.stamp(new Date('2026-09-20T15:04:00'))).toBe('Sep 20, 3:04 PM');
  });

  it('defaults to 12-hour when handed a preference it cannot read', () => {
    expect(makeTimeFormatter(undefined)('15:30')).toBe('3:30 PM');
  });
});

describe('the chart-axis tick', () => {
  it('is one hour and one letter', () => {
    expect(formatTime('10:00', '12h', 'tick')).toBe('10a');
    expect(formatTime('15:00', '12h', 'tick')).toBe('3p');
    expect(formatTime('12:00', '12h', 'tick')).toBe('12p');
    expect(formatTime('00:00', '12h', 'tick')).toBe('12a');
  });

  it('keeps the minutes when a tick is not on the hour', () => {
    expect(formatTime('15:30', '12h', 'tick')).toBe('3:30p');
  });

  it('is just the hour on a 24-hour clock', () => {
    expect(formatTime('15:00', '24h', 'tick')).toBe('15');
    expect(formatTime('09:00', '24h', 'tick')).toBe('09');
    expect(formatTime('15:30', '24h', 'tick')).toBe('15:30');
  });

  it('is on the bound formatter too', () => {
    expect(makeTimeFormatter('12h').tick('15:00')).toBe('3p');
  });
});
