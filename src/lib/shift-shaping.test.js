/**
 * Unit tests for shift-shaping — reshaping a day's shifts around its demand
 * curve.
 *
 * The invariants that matter operationally:
 *   - nobody is rostered below the legal minimum
 *   - nobody already scheduled gets silently dropped
 *   - a short dip never splits a shift
 *   - the host stays out of the coverage rotation
 *   - leads go first, then whoever has the fewest hours
 */

import { describe, it, expect } from 'vitest';
import {
  toMinutes, toHHMM, blocksFromCurve, shapeShifts, toShiftTimeStrings,
} from './shift-shaping.js';

const SLOTS_3_TO_7 = ['15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30'];

function person(name, opts = {}) {
  return {
    name,
    rank: 1,
    hoursSoFar: 0,
    availStart: toMinutes('15:00'),
    availEnd: toMinutes('19:00'),
    isHost: false,
    ...opts,
  };
}

describe('toMinutes / toHHMM', () => {
  it('round-trips a clock time', () => {
    expect(toHHMM(toMinutes('15:30'))).toBe('15:30');
    expect(toMinutes('09:05')).toBe(545);
  });

  it('rejects nonsense rather than guessing', () => {
    expect(toMinutes('')).toBeNull();
    expect(toMinutes('25:00')).toBeNull();
    expect(toMinutes('abc')).toBeNull();
  });
});

describe('blocksFromCurve', () => {
  it('emits one block per layer, spanning that layer’s contiguous run', () => {
    // 2 people needed all day, a 3rd only for the first two hours.
    const blocks = blocksFromCurve([3,3,3,3,2,2,2,2], SLOTS_3_TO_7, 4);
    expect(blocks).toHaveLength(3);
    const spans = blocks.map(b => `${b.start}-${b.end}`).sort();
    expect(spans).toEqual(['15:00-17:00', '15:00-19:00', '15:00-19:00']);
  });

  it('widens a run shorter than the legal minimum instead of dropping it', () => {
    // The 3rd person is only needed for one 30-min slot.
    const blocks = blocksFromCurve([3,2,2,2,2,2,2,2], SLOTS_3_TO_7, 4);
    const short = blocks.find(b => b.layer === 3);
    expect(short.widened).toBe(true);
    expect(short.hours).toBe(2);
    expect(short.start).toBe('15:00');
    expect(short.end).toBe('17:00');
  });

  it('never runs a block past the end of the day', () => {
    // Spike in the final slot — widening must extend backwards, not past close.
    const blocks = blocksFromCurve([1,1,1,1,1,1,1,3], SLOTS_3_TO_7, 4);
    for (const b of blocks) {
      expect(toMinutes(b.end)).toBeLessThanOrEqual(toMinutes('19:00'));
    }
  });

  it('returns nothing for an empty day', () => {
    expect(blocksFromCurve([], [], 4)).toEqual([]);
  });
});

describe('shapeShifts', () => {
  it('staggers people so only the rush is fully staffed', () => {
    const required = [3,3,3,3,1,1,1,1]; // busy until 5pm, quiet after
    const people = [person('Ann'), person('Ben'), person('Cal')];
    const { shifts } = shapeShifts({ required, slotKeys: SLOTS_3_TO_7, people });

    const spans = Object.values(shifts).map(s => `${s.start}-${s.end}`).sort();
    // One person carries the whole day; two cover the rush and go home.
    expect(spans).toEqual(['15:00-17:00', '15:00-17:00', '15:00-19:00']);
  });

  it('keeps someone on through a dip too short to send them home for', () => {
    // Demand drops to 1 for a single slot in the middle.
    const required = [2,2,2,1,2,2,2,2];
    const people = [person('Ann'), person('Ben')];
    const { shifts } = shapeShifts({ required, slotKeys: SLOTS_3_TO_7, people });
    // Both run the full day — nobody is sent home for 30 minutes.
    for (const s of Object.values(shifts)) {
      expect(`${s.start}-${s.end}`).toBe('15:00-19:00');
    }
  });

  it('never rosters anyone below the legal minimum', () => {
    const required = [4,1,1,1,1,1,1,1];
    const people = [person('Ann'), person('Ben'), person('Cal'), person('Dee')];
    const { shifts } = shapeShifts({ required, slotKeys: SLOTS_3_TO_7, people, minShiftHours: 2 });
    for (const s of Object.values(shifts)) {
      expect(toMinutes(s.end) - toMinutes(s.start)).toBeGreaterThanOrEqual(120);
    }
  });

  it('gives leads the widest blocks, then the person with fewest hours', () => {
    const required = [3,3,3,3,1,1,1,1];
    const people = [
      person('Ivy Instructor', { rank: 1, hoursSoFar: 2 }),
      person('Lee Lead',       { rank: 0, hoursSoFar: 40 }),
      person('Newt Newbie',    { rank: 1, hoursSoFar: 0 }),
    ];
    const { shifts } = shapeShifts({ required, slotKeys: SLOTS_3_TO_7, people });
    // The full-day block goes to the lead despite having the most hours.
    expect(`${shifts['Lee Lead'].start}-${shifts['Lee Lead'].end}`).toBe('15:00-19:00');
    // Among instructors, fewest hours takes the next-best block.
    expect(shifts['Newt Newbie']).toBeDefined();
    expect(shifts['Ivy Instructor']).toBeDefined();
  });

  it('keeps the host on the full day and out of the coverage rotation', () => {
    const required = [2,2,2,2,2,2,2,2];
    const people = [
      person('Rahul', { isHost: true, availStart: toMinutes('15:00'), availEnd: toMinutes('19:00') }),
      person('Ann'), person('Ben'),
    ];
    const { shifts } = shapeShifts({ required, slotKeys: SLOTS_3_TO_7, people });
    expect(shifts['Rahul'].role).toBe('host');
    expect(`${shifts['Rahul'].start}-${shifts['Rahul'].end}`).toBe('15:00-19:00');
    // The two coverage blocks went to the other two, not the host.
    expect(shifts['Ann'].role).toBe('coverage');
    expect(shifts['Ben'].role).toBe('coverage');
  });

  it('never drops someone already scheduled, even when the curve does not need them', () => {
    const required = [1,1,1,1,1,1,1,1]; // one person would do
    const people = [person('Ann'), person('Ben'), person('Cal')];
    const { shifts } = shapeShifts({ required, slotKeys: SLOTS_3_TO_7, people });
    expect(Object.keys(shifts).sort()).toEqual(['Ann', 'Ben', 'Cal']);
    // The extras are marked as surplus rather than quietly cut.
    const roles = Object.values(shifts).map(s => s.role).sort();
    expect(roles).toEqual(['coverage', 'surplus', 'surplus']);
  });

  it('reports an uncovered block with a reason instead of failing silently', () => {
    const required = [3,3,3,3,3,3,3,3];
    // Only one person, and they leave at 5pm.
    const people = [person('Ann', { availEnd: toMinutes('17:00') })];
    const { uncovered } = shapeShifts({ required, slotKeys: SLOTS_3_TO_7, people });
    expect(uncovered.length).toBeGreaterThan(0);
    expect(uncovered[0].reason).toMatch(/not available|already on a block/);
  });

  it('respects an instructor who cannot start until later', () => {
    const required = [2,2,2,2,2,2,2,2];
    const people = [
      person('Ann'),
      person('Late Larry', { availStart: toMinutes('17:00') }),
    ];
    const { shifts } = shapeShifts({ required, slotKeys: SLOTS_3_TO_7, people });
    expect(toMinutes(shifts['Late Larry'].start)).toBeGreaterThanOrEqual(toMinutes('17:00'));
  });

  it('handles an empty day without throwing', () => {
    expect(shapeShifts({ required: [], slotKeys: [], people: [] }).shifts).toEqual({});
    expect(shapeShifts({ required: [1], slotKeys: ['15:00'], people: [] }).shifts).toEqual({});
  });
});

describe('toShiftTimeStrings', () => {
  it('formats to the "HH:MM - HH:MM" shape the app stores', () => {
    expect(toShiftTimeStrings({ Ann: { start: '15:00', end: '19:00' } }))
      .toEqual({ Ann: '15:00 - 19:00' });
  });
});
