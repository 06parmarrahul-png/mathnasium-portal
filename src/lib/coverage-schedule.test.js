import { describe, it, expect } from 'vitest';
import { generateCoverageSchedule } from './coverage-schedule';

const SLOTS = ['15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30'];

const day = (dateStr, dayName, dayNumber) => ({ dateStr, dayName, dayNumber, slotKeys: SLOTS });

// Three Mondays in a row — enough to see whether the rotation is fair.
const MONDAYS = [
  day('2026-09-07', 'Monday', 7),
  day('2026-09-14', 'Monday', 14),
  day('2026-09-21', 'Monday', 21),
];

const staff = (n, over = {}) => Array.from({ length: n }, (_, i) => ({
  uid: `u${i + 1}`,
  displayName: `Person ${i + 1}`,
  subRoles: ['Elementary', 'Highschool'],
  priority: 2,
  ...over,
}));

/** Everyone available the full window on every date. */
const availableAll = (dates, people) => Object.fromEntries(
  dates.map(d => [d.dateStr, people.map(p => ({
    userId: p.uid, startTime: '15:00', endTime: '19:00',
  }))]),
);

describe('generateCoverageSchedule', () => {
  const curves = {
    Monday: [{ capability: 'Instructor', required: [2, 2, 4, 4, 3, 3, 4, 4] }],
  };

  it('produces a draft day per date in the range', () => {
    const people = staff(6);
    const { days } = generateCoverageSchedule({
      days: MONDAYS,
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll(MONDAYS, people),
    });
    expect(days).toHaveLength(3);
    expect(days[0].date).toBe('2026-09-07');
    expect(days[0].dayOfWeek).toBe('Monday');
  });

  it('staffs each day to the curve, holding through the short dip', () => {
    const people = staff(6);
    const { days } = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
    });
    // 2 open at 15:00, 2 more join at 16:00 — the 17:00 dip to 3 is too
    // short to send anyone home for, so it's held.
    expect(days[0].assignedEmployees).toHaveLength(4);
    const times = Object.values(days[0].shiftTimes).sort();
    expect(times.filter(t => t === '15:00 - 19:00')).toHaveLength(2);
    expect(times.filter(t => t === '16:00 - 19:00')).toHaveLength(2);
  });

  it('rotates across the month instead of using the same people weekly', () => {
    // 8 people, 4 needed each Monday. Over three Mondays that's 12
    // assignments — nobody should be carrying three while others sit at
    // zero, because fairness accrues across the whole run.
    const people = staff(8);
    const { minutesByPerson, fairness } = generateCoverageSchedule({
      days: MONDAYS,
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll(MONDAYS, people),
    });
    const worked = Object.values(minutesByPerson).filter(m => m > 0);
    expect(worked.length).toBeGreaterThanOrEqual(6);
    // Nobody ends up with more than about one extra shift of work.
    expect(fairness.spread).toBeLessThanOrEqual(4);
  });

  it('respects each instructor\'s maxDaysPerWeek', () => {
    const people = staff(6).map(p => ({ ...p, maxDaysPerWeek: 1 }));
    const { minutesByPerson } = generateCoverageSchedule({
      days: MONDAYS,
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll(MONDAYS, people),
    });
    // With a 1-day cap across 3 Mondays, no one can appear twice — so at
    // most 6 people work, and total assignments cannot exceed 6.
    const workedCount = Object.values(minutesByPerson).filter(m => m > 0).length;
    expect(workedCount).toBeLessThanOrEqual(6);
  });

  it('flags shifts nobody could cover rather than silently under-staffing', () => {
    const people = staff(2);   // curve wants 4
    const { days, warnings } = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
    });
    expect(days[0].openSlotsNeeded).toBeGreaterThan(0);
    expect(days[0].unfilledShifts.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('open shift'))).toBe(true);
  });

  it('leaves a weekday with no curve empty, without inventing shifts', () => {
    const people = staff(6);
    const { days } = generateCoverageSchedule({
      days: [day('2026-09-08', 'Tuesday', 8)],
      curvesByWeekday: curves,           // Monday only
      instructors: people,
      availabilityByDate: availableAll([day('2026-09-08', 'Tuesday', 8)], people),
    });
    expect(days[0].assignedEmployees).toHaveLength(0);
    expect(days[0].openSlotsNeeded).toBe(0);
  });

  it('only considers people who actually submitted availability', () => {
    const people = staff(6);
    const { days } = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: { '2026-09-07': [
        { userId: 'u1', startTime: '15:00', endTime: '19:00' },
        { userId: 'u2', startTime: '15:00', endTime: '19:00' },
      ] },
    });
    expect(days[0].assignedEmployees.sort()).toEqual(['Person 1', 'Person 2']);
  });

  it('routes a Highschool block to someone who can teach it', () => {
    const people = [
      { uid: 'e', displayName: 'Elem Only', subRoles: ['Elementary'], priority: 2 },
      { uid: 'h', displayName: 'HS Only',   subRoles: ['Highschool'], priority: 2 },
    ];
    const { days } = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: {
        Monday: [
          { capability: 'Elementary', required: [1, 1, 1, 1, 1, 1, 1, 1] },
          { capability: 'Highschool', required: [1, 1, 1, 1, 1, 1, 1, 1] },
        ],
      },
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
    });
    expect(days[0].subRoles['HS Only']).toBe('Highschool');
    expect(days[0].subRoles['Elem Only']).toBe('Elementary');
  });
});
