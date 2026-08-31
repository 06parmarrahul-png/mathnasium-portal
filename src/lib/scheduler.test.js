/**
 * Unit tests for the scheduler — the single highest-risk piece of code in
 * the portal. A regression here silently corrupts every centre's payroll,
 * so the goal of this suite is to nail down the behaviour we already rely
 * on and catch unintended changes in future refactors.
 *
 * Tests focus on pure helpers (clamping, time parsing, role classifiers)
 * plus a handful of end-to-end smoke tests that drive generateSchedule
 * with realistic inputs. Run with `npm run test` (watch) or
 * `npm run test:run` (single pass / CI).
 */

import { describe, it, expect } from 'vitest';
import {
  clampToInstructionalHours,
  parseAMPMtoHHMM,
  getWeekOfMonth,
  isOnlineOnly,
  isHostRole,
  shiftSubRoleFor,
  isGuaranteed,
  getSubRoleScore,
  generateSchedule,
} from './scheduler.js';

// ──────────────────────────────────────────────────────────────────────────
// clampToInstructionalHours — intersects availability with the day's
// teaching window. Returns null when there's no overlap.
// ──────────────────────────────────────────────────────────────────────────

describe('clampToInstructionalHours', () => {
  it('clamps a wider availability window down to instructional hours', () => {
    // Mon teaching window default is 15:00–19:00; instructor said 10:00–20:00
    expect(clampToInstructionalHours('10:00', '20:00', 'Monday'))
      .toEqual({ start: '15:00', end: '19:00' });
  });

  it('returns the availability window unchanged when it already fits', () => {
    expect(clampToInstructionalHours('16:00', '18:00', 'Tuesday'))
      .toEqual({ start: '16:00', end: '18:00' });
  });

  it('returns null when availability ends before the teaching window starts', () => {
    expect(clampToInstructionalHours('09:00', '14:00', 'Monday')).toBeNull();
  });

  it('returns null when availability starts after the teaching window ends', () => {
    expect(clampToInstructionalHours('20:00', '22:00', 'Monday')).toBeNull();
  });

  it('applies the Saturday window (10:00–14:00) instead of weekday', () => {
    expect(clampToInstructionalHours('09:00', '15:00', 'Saturday'))
      .toEqual({ start: '10:00', end: '14:00' });
  });

  it('returns null on unknown day names instead of throwing', () => {
    expect(clampToInstructionalHours('15:00', '19:00', 'Sunday')).toBeNull();
  });

  it('returns null when start/end are missing', () => {
    expect(clampToInstructionalHours(null, '19:00', 'Monday')).toBeNull();
    expect(clampToInstructionalHours('15:00', null, 'Monday')).toBeNull();
  });

  it('respects a custom per-centre instructionalHours map', () => {
    // Burnaby-test centre: Mon teaches 4-7pm instead of 3-7pm
    const burnaby = { Monday: { start: '16:00', end: '19:00' } };
    expect(clampToInstructionalHours('10:00', '20:00', 'Monday', burnaby))
      .toEqual({ start: '16:00', end: '19:00' });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// parseAMPMtoHHMM — used by the fixed-staff parser.
// ──────────────────────────────────────────────────────────────────────────

describe('parseAMPMtoHHMM', () => {
  it('parses afternoon PM times', () => {
    expect(parseAMPMtoHHMM('3:00 PM')).toBe('15:00');
    expect(parseAMPMtoHHMM('11:30 PM')).toBe('23:30');
  });

  it('parses morning AM times', () => {
    expect(parseAMPMtoHHMM('9:00 AM')).toBe('09:00');
    expect(parseAMPMtoHHMM('11:45 AM')).toBe('11:45');
  });

  it('handles 12 AM (midnight) and 12 PM (noon) correctly', () => {
    expect(parseAMPMtoHHMM('12:00 AM')).toBe('00:00');
    expect(parseAMPMtoHHMM('12:00 PM')).toBe('12:00');
    expect(parseAMPMtoHHMM('12:30 PM')).toBe('12:30');
  });

  it('returns null for "Off" sentinel value used by fixed-staff config', () => {
    expect(parseAMPMtoHHMM('Off')).toBeNull();
    expect(parseAMPMtoHHMM('off')).toBeNull();
  });

  it('returns null for empty or malformed strings', () => {
    expect(parseAMPMtoHHMM('')).toBeNull();
    expect(parseAMPMtoHHMM(null)).toBeNull();
    expect(parseAMPMtoHHMM('garbage')).toBeNull();
    expect(parseAMPMtoHHMM('15:00')).toBeNull(); // 24h string not AM/PM
  });

  it('tolerates lowercase am/pm', () => {
    expect(parseAMPMtoHHMM('3:00 pm')).toBe('15:00');
    expect(parseAMPMtoHHMM('9:00 am')).toBe('09:00');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// getWeekOfMonth — drives the alternating-week recurrence ("every other
// Saturday"). 1-indexed; days 1–7 are week 1, 8–14 are week 2, etc.
// ──────────────────────────────────────────────────────────────────────────

describe('getWeekOfMonth', () => {
  it('returns 1 for days 1 through 7', () => {
    expect(getWeekOfMonth(new Date(2026, 4, 1))).toBe(1);
    expect(getWeekOfMonth(new Date(2026, 4, 7))).toBe(1);
  });
  it('returns 2 for days 8 through 14', () => {
    expect(getWeekOfMonth(new Date(2026, 4, 8))).toBe(2);
    expect(getWeekOfMonth(new Date(2026, 4, 14))).toBe(2);
  });
  it('returns 5 for late-month days', () => {
    expect(getWeekOfMonth(new Date(2026, 4, 31))).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Role classifiers — small but critical: they decide who lands in which
// scheduling pass.
// ──────────────────────────────────────────────────────────────────────────

describe('isOnlineOnly', () => {
  it('returns true for an Online instructor', () => {
    expect(isOnlineOnly({ subRoles: ['Online'] })).toBe(true);
  });

  it('returns true for a hybrid Online + Elementary instructor (Online dominates for auto-schedule)', () => {
    // Per the recent "Online instructors can hold other sub-roles" change,
    // such users still auto-schedule on the online platform — they only
    // claim in-centre shifts manually.
    expect(isOnlineOnly({ subRoles: ['Online', 'Elementary'] })).toBe(true);
  });

  it('returns false when Online is not present', () => {
    expect(isOnlineOnly({ subRoles: ['Elementary'] })).toBe(false);
    expect(isOnlineOnly({ subRoles: ['Highschool'] })).toBe(false);
    expect(isOnlineOnly({ subRoles: [] })).toBe(false);
    expect(isOnlineOnly({})).toBe(false);
  });
});

describe('isHostRole', () => {
  it('is true for instructorType "Host"', () => {
    expect(isHostRole({ instructorType: 'Host' })).toBe(true);
  });
  it('is false for other instructor types', () => {
    expect(isHostRole({ instructorType: 'Instructor' })).toBe(false);
    expect(isHostRole({ instructorType: 'Lead' })).toBe(false);
    expect(isHostRole({})).toBe(false);
  });
});

describe('shiftSubRoleFor', () => {
  it('returns Online when Online is in subRoles (even alongside in-centre roles)', () => {
    expect(shiftSubRoleFor({ subRoles: ['Online'] })).toBe('Online');
    expect(shiftSubRoleFor({ subRoles: ['Online', 'Elementary'] })).toBe('Online');
  });
  it('returns Highschool when capable', () => {
    expect(shiftSubRoleFor({ subRoles: ['Highschool'] })).toBe('Highschool');
    expect(shiftSubRoleFor({ subRoles: ['Highschool', 'Elementary'] })).toBe('Highschool');
  });
  it('defaults to Elementary otherwise', () => {
    expect(shiftSubRoleFor({ subRoles: ['Elementary'] })).toBe('Elementary');
    expect(shiftSubRoleFor({ subRoles: [] })).toBe('Elementary');
    expect(shiftSubRoleFor({})).toBe('Elementary');
  });
});

describe('getSubRoleScore', () => {
  // Lower score = more preferred. Highschool can float to either bucket so
  // it's the most flexible (0). Elementary only = 1. Online only = 2.
  it('scores Highschool-capable as most flexible', () => {
    expect(getSubRoleScore({ subRoles: ['Highschool'] })).toBe(0);
    expect(getSubRoleScore({ subRoles: ['Elementary', 'Highschool'] })).toBe(0);
  });
  it('scores Elementary-only as 1', () => {
    expect(getSubRoleScore({ subRoles: ['Elementary'] })).toBe(1);
  });
  it('scores Online-only as 2', () => {
    expect(getSubRoleScore({ subRoles: ['Online'] })).toBe(2);
  });
  it('defaults to Elementary-treatment when no sub-role is set', () => {
    expect(getSubRoleScore({})).toBe(1);
    expect(getSubRoleScore({ subRoles: [] })).toBe(1);
  });
});

describe('isGuaranteed (removed feature — stub always false)', () => {
  // Guaranteed-shift pinning was removed in favour of rank-
  // based scheduling. The exported function remains as a stub so
  // anything importing the symbol still resolves, but it always
  // returns false — confirms the old hardcoded name list, per-user
  // flag, and centre-config list are all no-ops.
  it('always returns false (per-user flag ignored)', () => {
    expect(isGuaranteed({ displayName: 'Random Person', guaranteed: true })).toBe(false);
  });
  it('always returns false (per-centre list ignored)', () => {
    expect(isGuaranteed({ displayName: 'Luke Skywalker' }, ['Luke'])).toBe(false);
    expect(isGuaranteed({ displayName: 'Kaitlyn Murphy' })).toBe(false);
  });
  it('handles missing displayName without throwing', () => {
    expect(isGuaranteed({})).toBe(false);
    expect(isGuaranteed({ displayName: '' })).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// generateSchedule — smoke tests with realistic inputs. We deliberately
// don't assert every detail (the engine has too many knobs); instead we
// pin down a few high-value invariants that, if broken, would silently
// produce wrong schedules.
// ──────────────────────────────────────────────────────────────────────────

// Helper to build a simple instructor record.
function makeInstructor(overrides = {}) {
  return {
    uid:            'u_' + Math.random().toString(36).slice(2, 8),
    displayName:    'Test Instructor',
    instructorType: 'Instructor',
    subRoles:       ['Elementary'],
    approved:       true,
    maxDaysPerWeek: 5,
    ...overrides,
  };
}

describe('generateSchedule (smoke)', () => {
  it('produces working-day entries for every Mon–Sat in the month', () => {
    const result = generateSchedule({
      instructors: [],
      availability: [],
      month: 'May',
      year: 2026,
    });
    // May 2026 has 6 days × ~4 weeks ≈ 26 Mon–Sat days
    expect(result.days.length).toBeGreaterThanOrEqual(25);
    expect(result.days.length).toBeLessThanOrEqual(27);
    for (const day of result.days) {
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(day.dayOfWeek).not.toBe('Sunday');
    }
  });

  it('assigns an available instructor to the right day with clamped hours', () => {
    const inst = makeInstructor({
      uid: 'u1',
      displayName: 'Alice Available',
      subRoles: ['Elementary'],
    });
    const result = generateSchedule({
      instructors: [inst],
      // Alice is available 10am–8pm on May 4, 2026 (a Monday).
      availability: [{ userId: 'u1', date: '2026-05-04', startTime: '10:00', endTime: '20:00' }],
      month: 'May',
      year: 2026,
      // Loosen the min so we don't trip warnings on a one-instructor schedule.
      config: { minPerDay: 1, maxPerDay: 11, maxDaysPerWeek: 5 },
    });
    const monday = result.days.find(d => d.date === '2026-05-04');
    expect(monday).toBeDefined();
    expect(monday.assignedEmployees).toContain('Alice Available');
    // Shift must be clamped to instructional hours (15:00–19:00), not the full availability.
    expect(monday.shiftTimes['Alice Available']).toBe('15:00 - 19:00');
    // Sub-role label propagates so the calendar can colour it.
    expect(monday.subRoles['Alice Available']).toBe('Elementary');
  });

  it('does not schedule Online instructors into in-centre slots', () => {
    const onlineInst = makeInstructor({
      uid: 'u2',
      displayName: 'Olivia Online',
      subRoles: ['Online'],
    });
    const result = generateSchedule({
      instructors: [onlineInst],
      availability: [{ userId: 'u2', date: '2026-05-04', startTime: '10:00', endTime: '20:00' }],
      month: 'May',
      year: 2026,
      config: { minPerDay: 1, maxPerDay: 11, maxDaysPerWeek: 5 },
    });
    const monday = result.days.find(d => d.date === '2026-05-04');
    expect(monday).toBeDefined();
    if (monday.assignedEmployees.includes('Olivia Online')) {
      // If she's scheduled at all, it's as Online, not as an in-centre Instructor.
      expect(monday.subRoles['Olivia Online']).toBe('Online');
      expect(monday.roles['Olivia Online']).toBe('Online Instructor');
    }
  });

  it('skips days listed as holidays in centerConfig', () => {
    const inst = makeInstructor({
      uid: 'u3',
      displayName: 'Holly Holiday',
    });
    const result = generateSchedule({
      instructors: [inst],
      availability: [{ userId: 'u3', date: '2026-05-04', startTime: '10:00', endTime: '20:00' }],
      month: 'May',
      year: 2026,
      config: { minPerDay: 1 },
      centerConfig: {
        holidays: [{ date: '2026-05-04', name: 'Test holiday' }],
      },
    });
    // The day should be filtered out of working days entirely.
    const monday = result.days.find(d => d.date === '2026-05-04');
    expect(monday).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scheduling order. The per-person "priority" tier was removed; order is now
// two rules only — Leads outrank Instructors, then fewest shifts so far.
// These pin that down, because getting it wrong is invisible in the UI and
// shows up weeks later as one person having worked twice as much as another.
// ──────────────────────────────────────────────────────────────────────────

describe('scheduling order: rank, then fairness', () => {
  // Full availability on the first four Mondays of May 2026.
  const MAY_MONDAYS = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25'];
  const availFor = (uid, dates = MAY_MONDAYS) =>
    dates.map(date => ({ userId: uid, date, startTime: '10:00', endTime: '20:00' }));

  it('gives a Lead the slot before an Instructor when only one fits', () => {
    const lead = makeInstructor({
      uid: 'lead1', displayName: 'Lena Lead', instructorType: 'Lead',
    });
    const inst = makeInstructor({
      uid: 'inst1', displayName: 'Ira Instructor', instructorType: 'Instructor',
    });
    const result = generateSchedule({
      instructors: [lead, inst],
      availability: [
        { userId: 'lead1', date: '2026-05-04', startTime: '10:00', endTime: '20:00' },
        { userId: 'inst1', date: '2026-05-04', startTime: '10:00', endTime: '20:00' },
      ],
      startDate: '2026-05-04', endDate: '2026-05-04',
      // Sabrina is default fixed staff on Monday and counts toward the ratio,
      // so a max of 2 leaves exactly one open in-centre slot.
      config: { minPerDay: 1, maxPerDay: 2 },
    });
    const day = result.days[0];
    expect(day.assignedEmployees).toContain('Lena Lead');
    expect(day.assignedEmployees).not.toContain('Ira Instructor');
  });

  it('spreads shifts evenly between equals rather than favouring one', () => {
    const a = makeInstructor({ uid: 'a', displayName: 'Ana Instructor' });
    const b = makeInstructor({ uid: 'b', displayName: 'Bo Instructor' });
    const result = generateSchedule({
      instructors: [a, b],
      availability: [...availFor('a'), ...availFor('b')],
      startDate: '2026-05-04', endDate: '2026-05-25',
      // One in-centre slot per Monday, on top of fixed staff.
      config: { minPerDay: 1, maxPerDay: 2, maxDaysPerWeek: 5 },
    });
    const mondays = result.days.filter(d => MAY_MONDAYS.includes(d.date));
    const counts = { 'Ana Instructor': 0, 'Bo Instructor': 0 };
    for (const d of mondays) {
      for (const n of d.assignedEmployees) if (n in counts) counts[n]++;
    }
    // Four Mondays, one slot each — fairness must alternate, not stack.
    expect(Math.abs(counts['Ana Instructor'] - counts['Bo Instructor'])).toBeLessThanOrEqual(1);
  });

  it('ignores a leftover priority field on the user record', () => {
    // Old Firestore docs still carry `priority`. It must have no effect —
    // otherwise the removal is cosmetic and the old behaviour lingers.
    const hi = makeInstructor({ uid: 'hi', displayName: 'Aaa Highpri', priority: 1 });
    const lo = makeInstructor({ uid: 'lo', displayName: 'Bbb Lowpri', priority: 3 });
    const result = generateSchedule({
      instructors: [hi, lo],
      availability: [...availFor('hi'), ...availFor('lo')],
      startDate: '2026-05-04', endDate: '2026-05-25',
      config: { minPerDay: 1, maxPerDay: 2, maxDaysPerWeek: 5 },
    });
    const counts = { 'Aaa Highpri': 0, 'Bbb Lowpri': 0 };
    for (const d of result.days) {
      for (const n of d.assignedEmployees) if (n in counts) counts[n]++;
    }
    // If priority still mattered, Highpri would take every slot.
    expect(Math.abs(counts['Aaa Highpri'] - counts['Bbb Lowpri'])).toBeLessThanOrEqual(1);
  });
});
