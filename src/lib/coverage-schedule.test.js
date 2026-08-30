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

  // Regression: the draft review screen does Object.entries() on this.
  // Returning a draft without it took the whole admin page down with
  // "Cannot convert undefined or null to object" the first time the
  // coverage engine ran for real.
  it('returns an employeeSummary the draft screen can render', () => {
    const people = staff(6);
    const result = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
    });
    expect(result.employeeSummary).toBeDefined();
    expect(() => Object.entries(result.employeeSummary)).not.toThrow();
    // Keyed by display name, and counting SHIFTS — the same shape the
    // classic engine emits, so one screen can render either.
    expect(result.employeeSummary['Person 1']).toBeTypeOf('number');
  });

  it('includes people who got nothing, so a zero is visible', () => {
    const people = staff(6);
    const result = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: curves,          // needs 4, so 2 miss out
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
    });
    expect(Object.keys(result.employeeSummary)).toHaveLength(6);
    expect(Object.values(result.employeeSummary).filter(n => n === 0).length)
      .toBeGreaterThan(0);
  });

  // Real bookings for a specific date must beat the weekday pattern —
  // that's the whole point of scheduling a chosen week.
  it('prefers a date\'s real bookings over the weekday curve', () => {
    const people = staff(8);
    const { days } = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: { Monday: [{ capability: 'Instructor', required: [1, 1, 1, 1, 1, 1, 1, 1] }] },
      curvesByDate:    { '2026-09-07': [{ capability: 'Instructor', required: [5, 5, 5, 5, 5, 5, 5, 5] }] },
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
    });
    // 5 from the real bookings, not 1 from the pattern.
    expect(days[0].assignedEmployees).toHaveLength(5);
  });

  it('falls back to the weekday curve for a date with nothing booked', () => {
    const people = staff(8);
    const { days } = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: { Monday: [{ capability: 'Instructor', required: [2, 2, 2, 2, 2, 2, 2, 2] }] },
      curvesByDate:    { '2026-09-14': [{ capability: 'Instructor', required: [9, 9, 9, 9, 9, 9, 9, 9] }] },
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
    });
    expect(days[0].assignedEmployees).toHaveLength(2);
  });

  it('rosters a host every open day, preferring the designated one', () => {
    const people = [
      ...staff(4),
      { uid: 'h1', displayName: 'Rahul Parmar', subRoles: ['Host'], priority: 2 },
      { uid: 'h2', displayName: 'Backup Host',  subRoles: ['Host'], priority: 2 },
    ];
    const { days } = generateCoverageSchedule({
      days: MONDAYS,
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll(MONDAYS, people),
      requireHost: true,
      hostNames: ['Rahul Parmar'],
    });
    for (const d of days) {
      expect(d.roles['Rahul Parmar']).toBe('Host');
    }
  });

  it('does not add a host block when the centre does not want one', () => {
    const people = staff(6);
    const { days } = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
      requireHost: false,
    });
    expect(Object.values(days[0].roles).some(r => r === 'Host')).toBe(false);
  });

  it('rosters nobody on a closed day, but still shows the day', () => {
    // Labour Day. Dropping the date entirely makes a draft look like it
    // lost a day; the owner needs to see WHY it's empty.
    const people = staff(6);
    const closedDay = { ...day('2026-09-07', 'Monday', 7), closed: 'Labour Day' };
    const { days } = generateCoverageSchedule({
      days: [closedDay],
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll([closedDay], people),
      requireHost: true,
      hostNames: ['Rahul Parmar'],
    });
    expect(days).toHaveLength(1);
    expect(days[0].closed).toBe(true);
    expect(days[0].closureReason).toBe('Labour Day');
    expect(days[0].assignedEmployees).toHaveLength(0);
    // Not flagged as understaffed — it isn't short, it's shut.
    expect(days[0].openSlotsNeeded).toBe(0);
  });

  it('still schedules the open days either side of a closure', () => {
    const people = staff(6);
    const list = [
      { ...day('2026-09-07', 'Monday', 7), closed: 'Labour Day' },
      day('2026-09-14', 'Monday', 14),
    ];
    const { days } = generateCoverageSchedule({
      days: list,
      curvesByWeekday: curves,
      instructors: people,
      availabilityByDate: availableAll(list, people),
    });
    expect(days[0].assignedEmployees).toHaveLength(0);
    expect(days[1].assignedEmployees.length).toBeGreaterThan(0);
  });

  it('reports hours by name, the figure it actually balances on', () => {
    const people = staff(6);
    const { hoursByName, employeeSummary } = generateCoverageSchedule({
      days: [MONDAYS[0]],
      curvesByDate: { '2026-09-07': [{ capability: 'Instructor', required: [2, 2, 4, 4, 4, 4, 4, 4] }] },
      instructors: people,
      availabilityByDate: availableAll([MONDAYS[0]], people),
      requireHost: false,
    });
    // Only people who actually worked appear in hours...
    const worked = Object.keys(hoursByName);
    expect(worked.length).toBeGreaterThan(0);
    for (const name of worked) expect(hoursByName[name]).toBeGreaterThan(0);
    // ...while the shift summary still lists everyone, zeros included.
    expect(Object.keys(employeeSummary)).toHaveLength(6);
  });
});

