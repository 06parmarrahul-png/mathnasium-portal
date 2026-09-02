import { describe, it, expect } from 'vitest';
import {
  toMinutes, fmtMinutes, availabilityWindows, shiftFit,
  availabilityConflict, describeDuration, describeConflict,
} from './availabilityFit';

const avail = (startTime, endTime) => ({ startTime, endTime });
const shift = (startTime, endTime, over = {}) => ({ startTime, endTime, ...over });

describe('toMinutes', () => {
  it('parses HH:MM', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('09:30')).toBe(570);
    expect(toMinutes('15:00')).toBe(900);
    expect(toMinutes('23:59')).toBe(1439);
  });

  it('accepts a single-digit hour', () => {
    expect(toMinutes('9:30')).toBe(570);
  });

  it('rejects anything it cannot trust', () => {
    for (const bad of ['', null, undefined, 'nope', '25:00', '10:75', '1000', 12, {}]) {
      expect(toMinutes(bad)).toBe(null);
    }
  });
});

describe('fmtMinutes', () => {
  it('reads as a clock time', () => {
    expect(fmtMinutes(0)).toBe('12:00am');
    expect(fmtMinutes(570)).toBe('9:30am');
    expect(fmtMinutes(720)).toBe('12:00pm');
    expect(fmtMinutes(900)).toBe('3:00pm');
    expect(fmtMinutes(1439)).toBe('11:59pm');
  });

  it('is safe on junk', () => {
    expect(fmtMinutes(null)).toBe('');
    expect(fmtMinutes(NaN)).toBe('');
  });
});

describe('availabilityWindows', () => {
  it('converts and sorts', () => {
    expect(availabilityWindows([avail('16:00', '19:00'), avail('09:00', '12:00')]))
      .toEqual([[540, 720], [960, 1140]]);
  });

  // Someone submitting 10–2 and 2–6 is available 10–6 continuously.
  // Comparing against the rows separately would report a 10–6 shift as a
  // conflict at the seam.
  it('merges windows that touch', () => {
    expect(availabilityWindows([avail('10:00', '14:00'), avail('14:00', '18:00')]))
      .toEqual([[600, 1080]]);
  });

  it('merges windows that overlap', () => {
    expect(availabilityWindows([avail('10:00', '15:00'), avail('14:00', '18:00')]))
      .toEqual([[600, 1080]]);
  });

  it('treats all-day as covering everything', () => {
    expect(availabilityWindows([avail('00:00', '23:59')])).toEqual([[0, 1440]]);
    expect(availabilityWindows([avail('00:00', '24:00')])).toEqual([[0, 1440]]);
  });

  it('drops rows it cannot use', () => {
    expect(availabilityWindows([avail('nope', '19:00'), avail('19:00', '16:00'), avail('10:00', '10:00')]))
      .toEqual([]);
    expect(availabilityWindows(null)).toEqual([]);
    expect(availabilityWindows([])).toEqual([]);
  });
});

describe('shiftFit', () => {
  const W = availabilityWindows([avail('16:00', '19:00')]);

  it('a shift inside availability is covered', () => {
    const fit = shiftFit(shift('16:00', '19:00'), W);
    expect(fit.covered).toBe(true);
    expect(fit.minutesOutside).toBe(0);
  });

  // Sabrina's case, and the reason this exists.
  it('catches a shift that starts before they are available', () => {
    const fit = shiftFit(shift('15:00', '19:00'), W);
    expect(fit.covered).toBe(false);
    expect(fit.minutesOutside).toBe(60);
    expect(fit.earlyBy).toBe(60);
    expect(fit.lateBy).toBe(0);
  });

  it('catches a shift that runs past when they are available', () => {
    const fit = shiftFit(shift('16:00', '20:30'), W);
    expect(fit.covered).toBe(false);
    expect(fit.minutesOutside).toBe(90);
    expect(fit.lateBy).toBe(90);
  });

  it('catches a shift that overruns both ends', () => {
    const fit = shiftFit(shift('15:00', '20:00'), W);
    expect(fit.minutesOutside).toBe(120);
    expect(fit.earlyBy).toBe(60);
    expect(fit.lateBy).toBe(60);
  });

  it('catches a shift with no overlap at all', () => {
    const fit = shiftFit(shift('09:00', '13:00'), W);
    expect(fit.covered).toBe(false);
    expect(fit.minutesOutside).toBe(240);
  });

  it('counts only the gap when availability is split', () => {
    const split = availabilityWindows([avail('10:00', '12:00'), avail('14:00', '18:00')]);
    // 10–18 shift: the 12–14 gap is the only part not offered.
    const fit = shiftFit(shift('10:00', '18:00'), split);
    expect(fit.covered).toBe(false);
    expect(fit.minutesOutside).toBe(120);
    expect(fit.earlyBy).toBe(0);
    expect(fit.lateBy).toBe(0);
  });

  it('an all-day availability covers any shift', () => {
    const all = availabilityWindows([avail('00:00', '23:59')]);
    expect(shiftFit(shift('06:00', '23:00'), all).covered).toBe(true);
  });

  it('returns null when there is nothing to judge', () => {
    expect(shiftFit(shift('15:00', '19:00'), [])).toBe(null);
    expect(shiftFit(shift(null, '19:00'), W)).toBe(null);
    expect(shiftFit(shift('19:00', '15:00'), W)).toBe(null);   // backwards
    expect(shiftFit(null, W)).toBe(null);
  });
});

describe('availabilityConflict — the cell-level answer', () => {
  const AV = [avail('16:00', '19:00')];

  it('flags a day where a shift falls outside', () => {
    const out = availabilityConflict([shift('15:00', '19:00')], AV);
    expect(out).not.toBe(null);
    expect(out.conflicts.length).toBe(1);
    expect(out.worst.fit.minutesOutside).toBe(60);
  });

  it('says nothing when every shift fits', () => {
    expect(availabilityConflict([shift('16:00', '18:00')], AV)).toBe(null);
  });

  // 839 of 1848 live shifts have no availability on file. Flagging them
  // would turn half the grid amber and bury the 49 real conflicts.
  it('says nothing when no availability was submitted', () => {
    expect(availabilityConflict([shift('15:00', '19:00')], [])).toBe(null);
    expect(availabilityConflict([shift('15:00', '19:00')], null)).toBe(null);
  });

  it('says nothing on an empty day', () => {
    expect(availabilityConflict([], AV)).toBe(null);
    expect(availabilityConflict(null, AV)).toBe(null);
  });

  it('ignores a cancelled shift', () => {
    expect(availabilityConflict([shift('15:00', '19:00', { status: 'cancelled' })], AV)).toBe(null);
  });

  // A draft is exactly when you want to hear about it — before it's real.
  it('still flags a draft shift', () => {
    expect(availabilityConflict([shift('15:00', '19:00', { status: 'draft' })], AV)).not.toBe(null);
  });

  it('reports every conflicting shift and picks the worst', () => {
    const out = availabilityConflict(
      [shift('15:00', '19:00'), shift('08:00', '12:00'), shift('16:00', '17:00')],
      AV,
    );
    expect(out.conflicts.length).toBe(2);
    expect(out.worst.fit.minutesOutside).toBe(240);
  });

  it('does not flag a fitting shift just because a sibling conflicts', () => {
    const out = availabilityConflict([shift('16:00', '17:00'), shift('08:00', '12:00')], AV);
    expect(out.conflicts.length).toBe(1);
    expect(out.conflicts[0].shift.startTime).toBe('08:00');
  });
});

describe('the wording', () => {
  it('describes durations the way a person says them', () => {
    expect(describeDuration(30)).toBe('30m');
    expect(describeDuration(60)).toBe('1h');
    expect(describeDuration(90)).toBe('1h 30m');
    expect(describeDuration(0)).toBe('');
    expect(describeDuration(null)).toBe('');
  });

  it('explains an early start', () => {
    const fit = shiftFit(shift('15:00', '19:00'), availabilityWindows([avail('16:00', '19:00')]));
    const text = describeConflict(fit);
    expect(text).toContain('3:00pm–7:00pm');
    expect(text).toContain('4:00pm–7:00pm');
    expect(text).toContain('starts 1h early');
  });

  it('explains a late finish', () => {
    const fit = shiftFit(shift('16:00', '20:00'), availabilityWindows([avail('16:00', '19:00')]));
    expect(describeConflict(fit)).toContain('runs 1h late');
  });

  it('explains an overrun at both ends', () => {
    const fit = shiftFit(shift('15:00', '20:00'), availabilityWindows([avail('16:00', '19:00')]));
    expect(describeConflict(fit)).toContain('both ends');
  });

  it('says nothing about a shift that fits', () => {
    const fit = shiftFit(shift('16:00', '18:00'), availabilityWindows([avail('16:00', '19:00')]));
    expect(describeConflict(fit)).toBe('');
    expect(describeConflict(null)).toBe('');
  });
});

// Real rows pulled from the live database, so the library is measured
// against what the centre actually has rather than only tidy fixtures.
describe('real cases from the live database', () => {
  const CASES = [
    ['Goldon Gao',       '15:00', '19:00', [['16:00', '19:00']], 60],
    ['Jonathan Liu',     '15:00', '18:00', [['15:30', '19:00']], 30],
    ['Jonathan Liu',     '10:00', '15:00', [['10:00', '14:00']], 60],
    ['Jason Soo',        '10:00', '14:00', [['15:00', '20:00']], 240],
    ['Bri MacDonald',    '11:00', '19:00', [['15:00', '20:00']], 240],
    ['Dev Mistry',       '08:15', '15:15', [['10:00', '14:00']], 180],
    ['Kaitlyn MacDonald','14:00', '19:30', [['10:00', '19:00']], 30],
  ];

  it.each(CASES)('%s %s–%s is flagged, %s outside', (_n, st, en, windows, expected) => {
    const out = availabilityConflict([shift(st, en)], windows.map(w => avail(w[0], w[1])));
    expect(out).not.toBe(null);
    expect(out.worst.fit.minutesOutside).toBe(expected);
  });
});
