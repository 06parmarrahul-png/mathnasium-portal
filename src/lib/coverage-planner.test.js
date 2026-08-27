import { describe, it, expect } from 'vitest';
import { planCoverage, planDay, smoothTroughs, toHHMM, toMinutes, requiredFromDemand, slotKeysForDay } from './coverage-planner';

// A 3:00–7:00 afternoon in 30-minute slots.
const SLOTS = ['15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30'];

describe('time helpers', () => {
  it('round-trips HH:MM', () => {
    expect(toMinutes('15:30')).toBe(930);
    expect(toHHMM(930)).toBe('15:30');
    expect(toHHMM(toMinutes('09:05'))).toBe('09:05');
  });
  it('survives junk', () => {
    expect(toMinutes('')).toBe(null);
    expect(toMinutes(undefined)).toBe(null);
  });
});

describe('smoothTroughs', () => {
  it('fills a dip too short to send anyone home for', () => {
    // 5:00–5:30 dips to 6 between two stretches of 7. One hour — you
    // cannot legally roster the 1h shift that honouring it would need.
    const raw = [3, 3, 7, 7, 6, 6, 7, 7];
    expect(smoothTroughs(raw, { minShiftMinutes: 120 })).toEqual([3, 3, 7, 7, 7, 7, 7, 7]);
  });

  it('leaves a dip alone when it is long enough to be a real break', () => {
    // Four slots = 2h at 6 — long enough that ending a shift and starting
    // another is legal, so the trough is genuine and stays.
    const raw = [7, 7, 6, 6, 6, 6, 7, 7];
    expect(smoothTroughs(raw, { minShiftMinutes: 120 })).toEqual(raw);
  });

  it('does not invent coverage at the start or end of the day', () => {
    // Opening quietly and closing quietly are not troughs — there's no
    // shoulder on the outside to raise them to.
    const raw = [2, 2, 7, 7, 7, 7, 3, 3];
    expect(smoothTroughs(raw, { minShiftMinutes: 120 })).toEqual(raw);
  });

  it('is a no-op on a flat curve', () => {
    expect(smoothTroughs([5, 5, 5, 5], { minShiftMinutes: 120 })).toEqual([5, 5, 5, 5]);
  });
});

// ── The case from the owner's own description of a Monday ──────────────
//   "3 instructors 3:00-3:30, jumps to 7 from 4:00, dips at 5:00 to 6,
//    but I need 7 again at 6:00 so I may as well keep them."
describe("the owner's Monday", () => {
  const required = [3, 3, 7, 7, 6, 6, 7, 7];

  it('keeps 7 on rather than fragmenting the afternoon', () => {
    const { shifts } = planCoverage({ required, slotStarts: SLOTS, minShiftMinutes: 120 });
    // 7 people, not the 8 a literal reading of the curve would demand.
    expect(shifts).toHaveLength(7);
    // Nobody goes home mid-afternoon: every shift runs to close.
    expect(shifts.every(s => s.endTime === '19:00')).toBe(true);
    // 3 open the day, 4 more arrive for the 4:00 rise.
    expect(shifts.filter(s => s.startTime === '15:00')).toHaveLength(3);
    expect(shifts.filter(s => s.startTime === '16:00')).toHaveLength(4);
  });

  it('never emits a shift shorter than the legal minimum', () => {
    const { shifts } = planCoverage({ required, slotStarts: SLOTS, minShiftMinutes: 120 });
    expect(shifts.every(s => s.minutes >= 120)).toBe(true);
  });

  it('reports the slack the smoothing bought', () => {
    // 5:00 and 5:30 are covered by 7 where 6 was asked for. That's the
    // price of not fragmenting, and it should be visible, not hidden.
    const { overstaffedSlots } = planCoverage({ required, slotStarts: SLOTS, minShiftMinutes: 120 });
    expect(overstaffedSlots).toBe(2);
  });
});

describe('planCoverage — coverage correctness', () => {
  const coverageAt = (shifts, hhmm) => shifts.filter(
    s => toMinutes(s.startTime) <= toMinutes(hhmm) && toMinutes(s.endTime) > toMinutes(hhmm),
  ).length;

  it('never leaves a slot under-covered', () => {
    const required = [3, 3, 7, 7, 6, 6, 7, 7];
    const { shifts } = planCoverage({ required, slotStarts: SLOTS, minShiftMinutes: 120 });
    SLOTS.forEach((slot, i) => {
      expect(coverageAt(shifts, slot)).toBeGreaterThanOrEqual(required[i]);
    });
  });

  it('handles a flat day with the minimum number of people', () => {
    const { shifts } = planCoverage({
      required: [4, 4, 4, 4, 4, 4, 4, 4], slotStarts: SLOTS, minShiftMinutes: 120,
    });
    expect(shifts).toHaveLength(4);
    expect(shifts.every(s => s.startTime === '15:00' && s.endTime === '19:00')).toBe(true);
  });

  it('lets a genuinely long lull release staff', () => {
    // A 3h lull in a 6h day. Note the release lands at 17:00, not 16:00
    // when demand actually falls: the four leaving started at 15:00, so
    // 16:00 would be a one-hour shift. They stay the extra hour, then go.
    const LONG = ['15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
                  '18:00', '18:30', '19:00', '19:30', '20:00', '20:30'];
    const required = [6, 6, 2, 2, 2, 2, 2, 2, 6, 6, 6, 6];
    const { shifts, smoothed } = planCoverage({
      required, slotStarts: LONG, minShiftMinutes: 120,
    });
    // A 3h lull is a real break, so it survives smoothing untouched.
    expect(smoothed).toEqual(required);
    // Held through the legal minimum...
    expect(coverageAt(shifts, '16:00')).toBe(6);
    // ...then genuinely released.
    expect(coverageAt(shifts, '17:30')).toBe(2);
    expect(shifts.every(s => s.minutes >= 120)).toBe(true);
  });

  it('staffs nobody when nothing is booked', () => {
    const { shifts, totalMinutes } = planCoverage({
      required: [0, 0, 0, 0, 0, 0, 0, 0], slotStarts: SLOTS, minShiftMinutes: 120,
    });
    expect(shifts).toHaveLength(0);
    expect(totalMinutes).toBe(0);
  });

  it('stretches a short spike up to the legal minimum', () => {
    // One busy half-hour. A 30-minute shift is illegal, so it grows.
    const { shifts } = planCoverage({
      required: [0, 0, 0, 1, 0, 0, 0, 0], slotStarts: SLOTS, minShiftMinutes: 120,
    });
    expect(shifts).toHaveLength(1);
    expect(shifts[0].minutes).toBeGreaterThanOrEqual(120);
  });

  it('rejects a mismatched curve rather than guessing', () => {
    const { shifts, warnings } = planCoverage({ required: [1, 2], slotStarts: SLOTS });
    expect(shifts).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('planDay — several capabilities at once', () => {
  it('plans host, online and instructors independently', () => {
    const { shifts, byCapability } = planDay({
      slotStarts: SLOTS,
      minShiftMinutes: 120,
      requirements: [
        { capability: 'Host',       required: [1, 1, 1, 1, 1, 1, 1, 1] },
        { capability: 'Online',     required: [1, 1, 1, 1, 1, 1, 1, 1] },
        { capability: 'Instructor', required: [3, 3, 7, 7, 6, 6, 7, 7] },
      ],
    });
    expect(byCapability.Host.shifts).toHaveLength(1);
    expect(byCapability.Online.shifts).toHaveLength(1);
    expect(byCapability.Instructor.shifts).toHaveLength(7);
    // 1 host + 1 online + 7 instructors = the full Monday.
    expect(shifts).toHaveLength(9);
    expect(shifts.filter(s => s.capability === 'Host')[0])
      .toMatchObject({ startTime: '15:00', endTime: '19:00' });
  });

  it('totals the hours so the budget page has a number', () => {
    const { totalMinutes } = planDay({
      slotStarts: SLOTS,
      minShiftMinutes: 120,
      requirements: [{ capability: 'Instructor', required: [3, 3, 7, 7, 6, 6, 7, 7] }],
    });
    // 3 people × 4h + 4 people × 3h = 24h
    expect(totalMinutes).toBe(24 * 60);
  });
});

describe('requiredFromDemand', () => {
  it('rounds UP — a partial group still needs a whole instructor', () => {
    // 3 students at 1:3.5 is not 0.86 of a person.
    expect(requiredFromDemand([3, 7, 8], 3.5)).toEqual([1, 2, 3]);
  });

  it('needs nobody when nobody is booked', () => {
    expect(requiredFromDemand([0, 0], 3.5)).toEqual([0, 0]);
  });

  it('raising the ratio lowers the headcount — the owner\'s dial', () => {
    const demand = [14, 14, 14];
    expect(requiredFromDemand(demand, 3.5)).toEqual([4, 4, 4]);
    expect(requiredFromDemand(demand, 7)).toEqual([2, 2, 2]);
  });

  it('survives junk without producing NaN', () => {
    expect(requiredFromDemand([null, undefined, 'x'], 3.5)).toEqual([0, 0, 0]);
    expect(requiredFromDemand([7], 0)).toEqual([7]); // ratio 0 → treated as 1
  });
});

// End-to-end: the exact path the Coverage Plan panel takes on a real day.
describe('demand → roster, end to end', () => {
  it('turns a booked afternoon into rosterable shifts', () => {
    // Students booked per half-hour, quiet open then a busy evening.
    const booked = [7, 7, 24, 24, 21, 21, 24, 24];
    const required = requiredFromDemand(booked, 3.5); // → [2,2,7,7,6,6,7,7]
    expect(required).toEqual([2, 2, 7, 7, 6, 6, 7, 7]);

    const { shifts, totalMinutes } = planCoverage({
      required, slotStarts: SLOTS, minShiftMinutes: 120,
    });
    // Same shape as the owner's Monday: the 5:00 dip gets held through.
    expect(shifts).toHaveLength(7);
    expect(shifts.every(s => s.minutes >= 120)).toBe(true);
    expect(totalMinutes).toBe((2 * 4 + 5 * 3) * 60); // 2 open at 3:00, 5 join at 4:00
  });
});

describe('slotKeysForDay', () => {
  const cfg = { instructionalHours: {
    Monday:   { start: '15:00', end: '19:00' },
    Saturday: { start: '09:00', end: '15:00' },
  } };

  it('spans the day\'s own instructional hours', () => {
    expect(slotKeysForDay(cfg, 'Monday')).toEqual(SLOTS);
    expect(slotKeysForDay(cfg, 'Saturday')).toHaveLength(12); // 09:00–15:00
    expect(slotKeysForDay(cfg, 'Saturday')[0]).toBe('09:00');
  });

  it('falls back rather than throwing on an unconfigured day', () => {
    expect(slotKeysForDay(cfg, 'Wednesday').length).toBeGreaterThan(0);
    expect(slotKeysForDay(undefined, 'Monday').length).toBeGreaterThan(0);
  });

  it('returns nothing for a day that ends before it starts', () => {
    expect(slotKeysForDay(
      { instructionalHours: { Monday: { start: '19:00', end: '15:00' } } }, 'Monday',
    )).toEqual([]);
  });
});
