import { describe, it, expect } from 'vitest';
import {
  supplyFromAssignments, supplyFromShifts, floorSupply, uniqueOnFloor,
  sideOfSubRole, slotIndexFor, SIDE_LABELS,
} from './floorSupply';

// 3:00–7:00pm in half hours — Langley's instructional window.
const WINDOW = { startMin: 15 * 60, slotCount: 8 };

// Shaped like the real document for 2026-09-16.
const ASSIGNMENTS = {
  'EM|15:00': ['Homer Ayuste', 'Arham Ahmed', 'Caleb Schelp'],
  'HS|15:00': ['Luke Huang'],
  'EM|15:30': ['Homer Ayuste', 'Arham Ahmed', 'Caleb Schelp', 'Dev Mistry', 'Alex Feldman'],
  'HS|15:30': ['Luke Huang', 'Jason Soo', 'Dev Prasad', 'Nathan Miller'],
  'EM|18:30': ['Homer Ayuste'],
};

describe('supply from the Student Scheduler', () => {
  const s = supplyFromAssignments(ASSIGNMENTS, WINDOW);

  it('counts each side separately, per half hour', () => {
    expect(s.EM.counts).toEqual([3, 5, 0, 0, 0, 0, 0, 1]);
    expect(s.HS.counts).toEqual([1, 4, 0, 0, 0, 0, 0, 0]);
  });

  it('keeps the names behind each number, in order', () => {
    expect(s.EM.names[0]).toEqual(['Arham Ahmed', 'Caleb Schelp', 'Homer Ayuste']);
    expect(s.HS.names[1]).toEqual(['Dev Prasad', 'Jason Soo', 'Luke Huang', 'Nathan Miller']);
  });

  it('says it has something to show', () => {
    expect(s.hasAny).toBe(true);
    expect(s.source).toBe('scheduler');
  });

  it('counts a person on both sides in that half hour once on each — it is two half-people to fix', () => {
    const both = supplyFromAssignments({ 'EM|15:00': ['Sam Lee'], 'HS|15:00': ['Sam Lee'] }, WINDOW);
    expect(both.EM.counts[0]).toBe(1);
    expect(both.HS.counts[0]).toBe(1);
    expect(uniqueOnFloor(both).size).toBe(1);
  });

  it('counts the same name twice in one slot once', () => {
    const dup = supplyFromAssignments({ 'EM|15:00': ['Sam Lee', 'sam  lee', 'Ann Park'] }, WINDOW);
    expect(dup.EM.counts[0]).toBe(2);
  });

  it('leaves out anyone the caller skips, but keeps them visible', () => {
    const skip = (n) => (n === 'Caleb Schelp' ? 'Trainee' : null);
    const out = supplyFromAssignments(ASSIGNMENTS, WINDOW, { skip });
    expect(out.EM.counts[0]).toBe(2);
    expect(out.EM.names[0]).not.toContain('Caleb Schelp');
    expect(out.skipped).toEqual([{ name: 'Caleb Schelp', why: 'Trainee' }]);
  });

  it('reports assignments outside the day window instead of dropping them silently', () => {
    const early = supplyFromAssignments({ 'EM|10:00': ['Sam Lee', 'Ann Park'], ...ASSIGNMENTS }, WINDOW);
    expect(early.outsideWindow).toBe(2);
    expect(early.EM.counts[0]).toBe(3);
  });

  it('ignores keys that are not a side, and an empty day', () => {
    expect(supplyFromAssignments({ 'ONLINE|15:00': ['Sam Lee'], updatedAt: 'x' }, WINDOW).hasAny).toBe(false);
    expect(supplyFromAssignments(null, WINDOW).EM.counts).toEqual(new Array(8).fill(0));
    expect(supplyFromAssignments({}, WINDOW).hasAny).toBe(false);
  });
});

describe('supply from shifts — the fallback before sides are set', () => {
  const shift = (over) => ({
    userName: 'Sam Lee', subRole: 'Elementary', startTime: '15:00', endTime: '17:00',
    status: 'published', includedInRatio: true, ...over,
  });

  it('puts each shift on the side of its sub-role', () => {
    const s = supplyFromShifts([
      shift(),
      shift({ userName: 'Ann Park', subRole: 'Highschool' }),
      shift({ userName: 'Bo Ng', subRole: 'High School' }),
    ], WINDOW);
    expect(s.EM.counts).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(s.HS.counts).toEqual([2, 2, 2, 2, 0, 0, 0, 0]);
    expect(s.source).toBe('shifts');
  });

  it('needs half a slot before it counts for it', () => {
    // 15:00–15:20 is 20 minutes of the first slot, 0 of the second.
    expect(supplyFromShifts([shift({ endTime: '15:20' })], WINDOW).EM.counts[0]).toBe(1);
    // 15:20–15:30 is only 10 minutes.
    expect(supplyFromShifts([shift({ startTime: '15:20', endTime: '15:30' })], WINDOW).EM.counts[0]).toBe(0);
  });

  it('is not fooled by a draft, a cancellation, a sick day, or an out-of-ratio shift', () => {
    for (const over of [{ status: 'draft' }, { status: 'cancelled' }, { sickPay: true }, { includedInRatio: false }]) {
      expect(supplyFromShifts([shift(over)], WINDOW).EM.counts[0]).toBe(0);
    }
  });

  it('ignores Online and Host shifts — they are not on a side', () => {
    expect(supplyFromShifts([shift({ subRole: 'Online' }), shift({ subRole: '' })], WINDOW).hasAny).toBe(false);
    expect(sideOfSubRole('Online')).toBeNull();
  });
});

describe('floorSupply — the sheet, else the schedule', () => {
  const shifts = [{ userName: 'Ann Park', subRole: 'Highschool', startTime: '15:00', endTime: '16:00', includedInRatio: true }];

  it('uses the Student Scheduler when the sides are set', () => {
    const s = floorSupply({ assignments: ASSIGNMENTS, shifts, dayWindow: WINDOW });
    expect(s.source).toBe('scheduler');
    expect(s.EM.counts[0]).toBe(3);
  });

  it('falls back to the shifts for a day nobody has set sides for yet', () => {
    const s = floorSupply({ assignments: {}, shifts, dayWindow: WINDOW });
    expect(s.source).toBe('shifts');
    expect(s.HS.counts[0]).toBe(1);
  });

  it('a day with neither is an empty floor, not a crash', () => {
    const s = floorSupply({ assignments: null, shifts: [], dayWindow: WINDOW });
    expect(s.hasAny).toBe(false);
    expect(s.EM.counts.every(n => n === 0)).toBe(true);
  });
});

describe('the small pieces', () => {
  it('places a half hour in the window', () => {
    expect(slotIndexFor('15:00', WINDOW)).toBe(0);
    expect(slotIndexFor('18:30', WINDOW)).toBe(7);
    expect(slotIndexFor('19:00', WINDOW)).toBe(-1);
    expect(slotIndexFor('14:30', WINDOW)).toBe(-1);
    expect(slotIndexFor('nonsense', WINDOW)).toBe(-1);
  });

  it('names the sides the way the centre says them', () => {
    expect(SIDE_LABELS.EM).toBe('Elementary / Middle');
    expect(SIDE_LABELS.HS).toBe('High School');
  });
});
