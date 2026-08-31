/**
 * Unit tests for demand-staffing — the module that converts real bookings
 * into per-date staffing numbers.
 *
 * This feeds headcount straight into the scheduler, so a bug here quietly
 * understaffs the floor (ratio breach, kids unattended) or overstaffs it
 * (payroll burn). The suite pins down the ratio maths, the valley-closing
 * that keeps someone on through a short dip, and the perDate wiring into
 * generateSchedule.
 */

import { describe, it, expect } from 'vitest';
import {
  requiredForSlot,
  inCentreDemandBySlot,
  closeValleys,
  sustainedLevel,
  staffingForDate,
  buildPerDateStaffing,
} from './demand-staffing.js';
import { generateSchedule } from './scheduler.js';

// Build a grouped-appointments payload shaped like /api/scheduler/appointments.
function makeDay(day, slotCounts) {
  return {
    day,
    slots: slotCounts.map(([slot, counts]) => ({
      slot,
      label: slot,
      counts: { HS: 0, EM: 0, Online: 0, Unknown: 0, ...counts },
    })),
  };
}

describe('requiredForSlot', () => {
  it('rounds up — a partial instructor cannot cover a student', () => {
    expect(requiredForSlot(8, 4)).toBe(2);
    expect(requiredForSlot(9, 4)).toBe(3);
    expect(requiredForSlot(1, 4)).toBe(1);
  });

  it('handles the non-integer house ratio of 3.5', () => {
    expect(requiredForSlot(7, 3.5)).toBe(2);
    expect(requiredForSlot(8, 3.5)).toBe(3);
  });

  it('returns 0 for no students and for a nonsense ratio', () => {
    expect(requiredForSlot(0, 3.5)).toBe(0);
    expect(requiredForSlot(10, 0)).toBe(0);
  });
});

describe('inCentreDemandBySlot', () => {
  it('sums EM and HS but never Online', () => {
    const day = makeDay('2026-09-17', [['15:00', { EM: 5, HS: 3, Online: 9 }]]);
    const [slot] = inCentreDemandBySlot(day);
    expect(slot.students).toBe(8);
    expect(slot.breakdown).toEqual({ EM: 5, HS: 3 });
  });

  it('counts uncategorized students by default — they are still in the room', () => {
    const day = makeDay('2026-09-17', [['15:00', { EM: 4, Unknown: 2 }]]);
    expect(inCentreDemandBySlot(day)[0].students).toBe(6);
  });

  it('can exclude uncategorized students when asked', () => {
    const day = makeDay('2026-09-17', [['15:00', { EM: 4, Unknown: 2 }]]);
    const [slot] = inCentreDemandBySlot(day, false);
    expect(slot.students).toBe(4);
    expect(slot.unknown).toBe(2);
  });
});

describe('closeValleys', () => {
  it('lifts a one-slot dip back to the surrounding level', () => {
    // Nobody goes home for a single 30-minute dip.
    expect(closeValleys([3, 3, 1, 3, 3], 4)).toEqual([3, 3, 3, 3, 3]);
  });

  it('leaves a genuine sustained drop alone', () => {
    const out = closeValleys([4, 4, 4, 4, 1, 1, 1, 1, 1, 1], 4);
    expect(out.slice(5, 9)).toEqual([1, 1, 1, 1]);
  });

  it('never lowers a value below the original', () => {
    const input = [1, 5, 1, 1, 1, 1];
    const out = closeValleys(input, 4);
    out.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(input[i]));
  });

  it('is a no-op for a window of 1 or an empty curve', () => {
    expect(closeValleys([3, 1, 3], 1)).toEqual([3, 1, 3]);
    expect(closeValleys([], 4)).toEqual([]);
  });
});

describe('sustainedLevel', () => {
  it('ignores a spike too brief to staff a real shift for', () => {
    // 7 needed for a single slot; 3 needed across the rest.
    expect(sustainedLevel([3, 3, 7, 3, 3, 3], 4)).toBe(3);
  });

  it('reports the peak when the peak is genuinely sustained', () => {
    expect(sustainedLevel([5, 5, 5, 5, 5], 4)).toBe(5);
  });

  it('returns 0 for an empty day', () => {
    expect(sustainedLevel([], 4)).toBe(0);
  });
});

describe('staffingForDate', () => {
  it('sets min to the peak so a whole-day shift never breaks the ratio', () => {
    // 8 slots at 1:4. Most of the day is 12 students (3 instructors); one slot
    // spikes to 20 (5 instructors). Because the scheduler assigns whole-day
    // shifts, the floor has to clear the spike — 3 people against 20 students
    // would be 1:6.7.
    const day = makeDay('2026-09-17', [
      ['15:00', { EM: 12 }], ['15:30', { EM: 12 }],
      ['16:00', { EM: 20 }], ['16:30', { EM: 12 }],
      ['17:00', { EM: 12 }], ['17:30', { EM: 12 }],
      ['18:00', { EM: 12 }], ['18:30', { EM: 12 }],
    ]);
    const rec = staffingForDate(day, { targetRatio: 4, minShiftHours: 2, cushion: 1 });
    expect(rec.hasBookings).toBe(true);
    expect(rec.peakStudents).toBe(20);
    expect(rec.peakRequired).toBe(5);
    expect(rec.min).toBe(5);
    expect(rec.max).toBe(6); // peak 5 + cushion 1
    // Still reported, for judging how much of the day is actually busy.
    expect(rec.sustainedRequired).toBe(3);
  });

  it('covers the peak even when the busy stretch is short', () => {
    // A real Thursday shape: heavy first hour, quiet afterwards.
    const day = makeDay('2026-09-17', [
      ['15:00', { EM: 13 }], ['15:30', { EM: 20 }], ['16:00', { EM: 11 }],
      ['16:30', { EM: 6 }],  ['17:00', { EM: 7 }],  ['17:30', { EM: 9 }],
      ['18:00', { EM: 6 }],  ['18:30', { EM: 2 }],
    ]);
    const rec = staffingForDate(day, {
      targetRatio: 3.5, acceptableRatio: 4, minShiftHours: 2, cushion: 1,
    });
    expect(rec.peakStudents).toBe(20);
    expect(rec.peakRequired).toBe(6);  // the 1:3.5 aim
    expect(rec.floorRequired).toBe(5); // the 1:4 floor
    expect(rec.min).toBe(5);           // floor, not the sustained 3
    expect(rec.max).toBe(7);           // aim + cushion
  });

  it('floors at 1:4 while aiming at 1:3.5', () => {
    // 15 students: 1:4 needs 4, 1:3.5 needs 5.
    const day = makeDay('2026-09-19', [
      ['10:00', { EM: 15 }], ['10:30', { EM: 15 }],
      ['11:00', { EM: 15 }], ['11:30', { EM: 15 }],
    ]);
    const rec = staffingForDate(day, {
      targetRatio: 3.5, acceptableRatio: 4, minShiftHours: 2, cushion: 0,
    });
    expect(rec.floorRequired).toBe(4);
    expect(rec.peakRequired).toBe(5);
    expect(rec.min).toBe(4);
    expect(rec.max).toBe(5);
  });

  it('collapses to one number when the peak divides evenly', () => {
    // 14 students is 4 instructors at both 1:3.5 and 1:4.
    const day = makeDay('2026-09-19', [
      ['10:00', { EM: 14 }], ['10:30', { EM: 14 }],
      ['11:00', { EM: 14 }], ['11:30', { EM: 14 }],
    ]);
    const rec = staffingForDate(day, {
      targetRatio: 3.5, acceptableRatio: 4, minShiftHours: 2, cushion: 0,
    });
    expect(rec.floorRequired).toBe(4);
    expect(rec.peakRequired).toBe(4);
    expect(rec.min).toBe(rec.max);
  });

  it('never lets the floor exceed the aim, even if the ratios are set backwards', () => {
    const day = makeDay('2026-09-19', [
      ['10:00', { EM: 15 }], ['10:30', { EM: 15 }],
      ['11:00', { EM: 15 }], ['11:30', { EM: 15 }],
    ]);
    // acceptableRatio tighter than targetRatio — a misconfiguration.
    const rec = staffingForDate(day, {
      targetRatio: 4, acceptableRatio: 2, minShiftHours: 2, cushion: 0,
    });
    expect(rec.min).toBeLessThanOrEqual(rec.max);
  });

  it('flags an empty day rather than inventing a staffing rule', () => {
    const rec = staffingForDate({ day: '2026-09-07', slots: [] });
    expect(rec.hasBookings).toBe(false);
    expect(rec.min).toBe(0);
    expect(rec.max).toBe(0);
  });

  it('marks slots where smoothing held someone through a dip', () => {
    const day = makeDay('2026-09-17', [
      ['15:00', { EM: 12 }], ['15:30', { EM: 12 }],
      ['16:00', { EM: 1 }],
      ['16:30', { EM: 12 }], ['17:00', { EM: 12 }], ['17:30', { EM: 12 }],
    ]);
    const rec = staffingForDate(day, { targetRatio: 4, minShiftHours: 2 });
    const dip = rec.slots.find(s => s.slot === '16:00');
    expect(dip.required).toBe(1);
    expect(dip.smoothed).toBe(3);
    expect(dip.heldThroughDip).toBe(true);
  });

  it('never counts Online students toward in-centre staffing', () => {
    const day = makeDay('2026-09-17', [
      ['15:00', { EM: 4, Online: 40 }], ['15:30', { EM: 4, Online: 40 }],
      ['16:00', { EM: 4, Online: 40 }], ['16:30', { EM: 4, Online: 40 }],
    ]);
    const rec = staffingForDate(day, { targetRatio: 4, minShiftHours: 2, cushion: 0 });
    expect(rec.peakStudents).toBe(4);
    expect(rec.max).toBe(1);
  });
});

describe('buildPerDateStaffing', () => {
  it('keys rules by date so two same-weekday dates can differ', () => {
    const busyThursday = makeDay('2026-09-17', [
      ['15:00', { EM: 20 }], ['15:30', { EM: 20 }],
      ['16:00', { EM: 20 }], ['16:30', { EM: 20 }],
    ]);
    const quietThursday = makeDay('2026-09-24', [
      ['15:00', { EM: 4 }], ['15:30', { EM: 4 }],
      ['16:00', { EM: 4 }], ['16:30', { EM: 4 }],
    ]);
    const { perDate } = buildPerDateStaffing([busyThursday, quietThursday], {
      targetRatio: 4, minShiftHours: 2, cushion: 0,
    });
    expect(perDate['2026-09-17'].min).toBe(5); // 20 students / 4
    expect(perDate['2026-09-24'].min).toBe(1); //  4 students / 4
  });

  it('writes no rule for a day with no bookings, and says why', () => {
    const { perDate, warnings } = buildPerDateStaffing([{ day: '2026-09-07', slots: [] }]);
    expect(perDate['2026-09-07']).toBeUndefined();
    expect(warnings.join(' ')).toContain('no bookings');
  });

  it('warns about uncategorized students that silently skew the ratio', () => {
    const day = makeDay('2026-09-17', [['15:00', { EM: 4, Unknown: 3 }]]);
    const { warnings } = buildPerDateStaffing([day]);
    expect(warnings.join(' ')).toMatch(/could not be categorized/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// The integration that matters: perDate must actually drive generateSchedule,
// and must beat the weekday rule.
// ──────────────────────────────────────────────────────────────────────────

describe('generateSchedule with perDate', () => {
  function makeInstructor(overrides = {}) {
    return {
      uid: 'u_' + Math.random().toString(36).slice(2, 8),
      displayName: 'Test Instructor',
      instructorType: 'Instructor',
      subRoles: ['Elementary'],
      approved: true,
      ...overrides,
    };
  }

  it('a date rule overrides the weekday rule for that date only', () => {
    // 2026-05-04 and 2026-05-11 are both Mondays.
    const result = generateSchedule({
      instructors: [],
      availability: [],
      startDate: '2026-05-04',
      endDate: '2026-05-11',
      config: {
        minPerDay: 8,
        perDay:  { Monday: { min: 4, max: 6 } },
        perDate: { '2026-05-04': { min: 9, max: 12 } },
      },
    });
    const overridden = result.days.find(d => d.date === '2026-05-04');
    const plainMonday = result.days.find(d => d.date === '2026-05-11');

    expect(overridden.effectiveRule.min).toBe(9);
    expect(overridden.effectiveRule.source).toBe('bookings');
    expect(plainMonday.effectiveRule.min).toBe(4);
    expect(plainMonday.effectiveRule.source).toBe('weekday');
  });

  it('a perDate entry inherits online caps from its weekday rule', () => {
    const result = generateSchedule({
      instructors: [], availability: [],
      startDate: '2026-05-04', endDate: '2026-05-04',
      config: {
        perDay:  { Monday: { min: 4, max: 6, onlineMax: 2 } },
        perDate: { '2026-05-04': { min: 9, max: 12 } },
      },
    });
    const day = result.days[0];
    expect(day.effectiveRule.min).toBe(9);
    expect(day.effectiveRule.onlineMax).toBe(2);
  });

  it('falls back to the global default when neither rule matches', () => {
    const result = generateSchedule({
      instructors: [], availability: [],
      startDate: '2026-05-04', endDate: '2026-05-04',
      config: { minPerDay: 7, maxPerDay: 10 },
    });
    expect(result.days[0].effectiveRule.min).toBe(7);
    expect(result.days[0].effectiveRule.source).toBe('default');
  });

  it('drives open-shift postings off the demand-derived minimum', () => {
    const inst = makeInstructor({ uid: 'u1', displayName: 'Solo Instructor' });
    const result = generateSchedule({
      instructors: [inst],
      availability: [{ userId: 'u1', date: '2026-05-04', startTime: '10:00', endTime: '20:00' }],
      startDate: '2026-05-04', endDate: '2026-05-04',
      config: { perDate: { '2026-05-04': { min: 4, max: 6 } } },
    });
    const day = result.days[0];
    // Two count toward the ratio: our one instructor, plus Sabrina, who is
    // default fixed staff on Mondays with countsTowardRatio: true. Against a
    // demand-derived floor of 4 that leaves 2 shifts to post.
    expect(day.countingStaffCount).toBe(2);
    expect(day.openSlotsNeeded).toBe(2);
    expect(result.openShiftNeeded.length).toBe(2);
  });
});
