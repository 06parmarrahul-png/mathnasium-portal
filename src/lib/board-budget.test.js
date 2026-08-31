/**
 * Unit tests for board-budget.
 *
 * This decides whether the owner is told they have room for another body or
 * that they're over budget. Getting it wrong either burns payroll or leaves
 * the floor thin, so the arithmetic is pinned down here rather than eyeballed
 * in the UI.
 */

import { describe, it, expect } from 'vitest';
import { boardBudget, slotHours, slotBuckets, roleForSlot, BOARD_BUCKETS } from './board-budget.js';
import { WEEKDAY_DEFAULTS } from './budgetBuckets.js';

const WED_WINDOW = { start: '15:00', end: '19:00' };

const slot = (start, end, opts = {}) => ({
  start, end, kind: opts.kind || 'coverage',
  assigned: opts.empty ? null : { uid: 'u1', name: 'Someone' },
});

describe('slotHours', () => {
  it('measures a shift in hours', () => {
    expect(slotHours({ start: '15:00', end: '19:00' })).toBe(4);
    expect(slotHours({ start: '16:30', end: '19:00' })).toBe(2.5);
  });

  it('returns 0 for unreadable or inverted times', () => {
    expect(slotHours({ start: '19:00', end: '15:00' })).toBe(0);
    expect(slotHours({ start: 'nope', end: '19:00' })).toBe(0);
    expect(slotHours(null)).toBe(0);
  });
});

describe('boardBudget — the day allotment', () => {
  it('reads the real Wednesday budget: 52h total, 44h the board can spend', () => {
    const b = boardBudget({ dayName: 'Wednesday', instrWindow: WED_WINDOW, slots: [] });
    expect(b.fullDay).toBe(52);            // 31 + 4 + 4 + 4 + 4 + 5
    expect(b.boardAllotted).toBe(44);      // instructional 31 + host 4 + adminAssistant 4 + adminHours 5
    expect(b.elsewhere).toBe(8);           // online 4 + steam 4
  });

  it('has no admin-assistant allotment on Saturday, matching the real budget', () => {
    // Rachel is the only admin assistant and doesn't work weekends; the
    // budget reflects that, so the board must not offer the slot.
    expect(WEEKDAY_DEFAULTS.Saturday.adminAssistant).toBeUndefined();
    const b = boardBudget({ dayName: 'Saturday', slots: [] });
    expect(b.buckets.find(x => x.key === 'adminAssistant')).toBeUndefined();
  });

  it('puts an admin shift in the adminAssistant bucket, whatever the clock says', () => {
    // 10:00-14:00 is entirely outside the 15:00-19:00 instructional window.
    // Without a whole-shift rule it would land in Admin Hours instead.
    const b = boardBudget({
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [slot('10:00', '14:00', { kind: 'admin' })],
    });
    expect(b.used.adminAssistant).toBe(4);
    expect(b.used.adminHours).toBeUndefined();
    expect(b.used.instructional).toBeUndefined();
  });

  it('matches weekdayBudgetTotal for every open day', () => {
    for (const day of ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']) {
      const b = boardBudget({ dayName: day, slots: [] });
      const expected = Object.values(WEEKDAY_DEFAULTS[day])
        .reduce((n, v) => n + (Number(v) || 0), 0);
      expect(b.fullDay).toBe(expected);
      expect(b.boardAllotted + b.elsewhere).toBe(b.fullDay);
    }
  });

  it('treats a closed day as zero budget rather than throwing', () => {
    const b = boardBudget({ dayName: 'Sunday', slots: [] });
    expect(b.fullDay).toBe(0);
    expect(b.boardAllotted).toBe(0);
  });

  it('survives an unknown weekday', () => {
    expect(boardBudget({ dayName: 'Blursday', slots: [] }).fullDay).toBe(0);
    expect(boardBudget(null).boardUsed).toBe(0);
  });
});

describe('boardBudget — what placements cost', () => {
  it('counts only assigned slots', () => {
    const b = boardBudget({
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [slot('15:00', '19:00'), slot('15:00', '19:00', { empty: true })],
    });
    expect(b.boardUsed).toBe(4);
    expect(b.remaining).toBe(40);
  });

  it('puts a host shift in the host bucket, not instructional', () => {
    const b = boardBudget({
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [slot('15:00', '19:00', { kind: 'host' })],
    });
    expect(b.used.host).toBe(4);
    expect(b.used.instructional).toBeUndefined();
  });

  it('splits a floor shift that runs past the instructional window', () => {
    // 2:00–7:00 against a 3:00–7:00 window: one admin hour, four instructional.
    const b = boardBudget({
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [slot('14:00', '19:00')],
    });
    expect(b.used.instructional).toBeCloseTo(4, 5);
    expect(b.used.adminHours).toBeCloseTo(1, 5);
    expect(b.boardUsed).toBeCloseTo(5, 5);
  });

  it('treats the whole shift as instructional when the window is unknown', () => {
    const b = boardBudget({
      dayName: 'Wednesday', instrWindow: null,
      slots: [slot('15:00', '19:00')],
    });
    expect(b.used.adminHours).toBeCloseTo(4, 5);
  });

  it('adds up a realistic Wednesday and leaves room for another body', () => {
    // The real Wed 23 Sept shape: host all day, three full shifts, two short.
    const b = boardBudget({
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [
        slot('15:00', '19:00', { kind: 'host' }),
        slot('15:00', '19:00'),
        slot('15:00', '19:00'),
        slot('15:00', '19:00'),
        slot('16:30', '19:00'),
        slot('17:00', '19:00'),
      ],
    });
    expect(b.used.host).toBe(4);
    expect(b.used.instructional).toBeCloseTo(16.5, 5); // 4+4+4+2.5+2
    expect(b.boardUsed).toBeCloseTo(20.5, 5);
    expect(b.remaining).toBeCloseTo(23.5, 5);
    expect(b.over).toBe(false);
  });

  it('flags going over budget', () => {
    const many = Array.from({ length: 12 }, () => slot('15:00', '19:00'));
    const b = boardBudget({ dayName: 'Wednesday', instrWindow: WED_WINDOW, slots: many });
    expect(b.boardUsed).toBe(48);
    expect(b.boardAllotted).toBe(44);
    expect(b.over).toBe(true);
    expect(b.remaining).toBeLessThan(0);
  });

  it('never reports a bucket the board cannot create', () => {
    const b = boardBudget({
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [slot('15:00', '19:00'), slot('15:00', '19:00', { kind: 'host' })],
    });
    for (const bucket of b.buckets) expect(BOARD_BUCKETS).toContain(bucket.key);
  });

  it('reports each bucket with its own allotment for the legend', () => {
    const b = boardBudget({
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [slot('15:00', '19:00', { kind: 'host' })],
    });
    const host = b.buckets.find(x => x.key === 'host');
    expect(host.allotted).toBe(4);
    expect(host.used).toBe(4);
    expect(host.label).toBe('Host');
  });
});

describe('boardBudget — salaried staff', () => {
  it('keeps salaried hours off the hourly budget but still reports them', () => {
    // Neeru and Vinod are on centerConfig.salaryStaff. The Staffing Budget
    // page drops them from the hourly total; the board must agree or every
    // day reads as over budget.
    const day = {
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [
        { start: '15:00', end: '19:00', kind: 'coverage', assigned: { name: 'Neeru Gill' } },
        { start: '15:00', end: '19:00', kind: 'coverage', assigned: { name: 'Someone Hourly' } },
      ],
    };
    const b = boardBudget(day, { excludeNames: ['Neeru Gill'] });
    expect(b.boardUsed).toBe(4);                 // only the hourly person
    expect(b.excludedHours).toBe(4);
    expect(b.excluded[0].name).toBe('Neeru Gill');
  });

  it('counts everyone when no exclusions are passed', () => {
    const day = {
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [{ start: '15:00', end: '19:00', kind: 'coverage', assigned: { name: 'Neeru Gill' } }],
    };
    expect(boardBudget(day).boardUsed).toBe(4);
    expect(boardBudget(day).excludedHours).toBe(0);
  });

  it('accepts a Set as well as an array', () => {
    const day = {
      dayName: 'Wednesday', instrWindow: WED_WINDOW,
      slots: [{ start: '15:00', end: '19:00', kind: 'coverage', assigned: { name: 'Vinod Bandla' } }],
    };
    expect(boardBudget(day, { excludeNames: new Set(['Vinod Bandla']) }).boardUsed).toBe(0);
  });
});

describe('slotBuckets — what one fixed shift costs', () => {
  it("splits Sabrina's 11-7 into 4h instructional and 4h admin", () => {
    // The Manager is on the floor for the whole instructional window and doing
    // admin either side of it. Showing eight undifferentiated hours would hide
    // exactly the thing the owner wants to see.
    const b = slotBuckets(
      { start: '11:00', end: '19:00', kind: 'fixed', fixedRole: 'Manager' },
      WED_WINDOW,
    );
    expect(b.instructional).toBeCloseTo(4, 5);
    expect(b.adminHours).toBeCloseTo(4, 5);
  });

  it("puts Rachel's 10-2 entirely in Administrative Assistant", () => {
    const b = slotBuckets({ start: '10:00', end: '14:00', kind: 'admin' }, WED_WINDOW);
    expect(b.adminAssistant).toBe(4);
    expect(b.adminHours).toBeUndefined();
  });

  it("splits a Lead's 2-7 into 1h admin and 4h instructional", () => {
    // A Lead doing prep before open — the case the demand curve can't produce.
    const b = slotBuckets({ start: '14:00', end: '19:00', kind: 'coverage' }, WED_WINDOW);
    expect(b.adminHours).toBeCloseTo(1, 5);
    expect(b.instructional).toBeCloseTo(4, 5);
  });

  it('returns nothing for a zero-length or inverted shift', () => {
    expect(slotBuckets({ start: '15:00', end: '15:00', kind: 'coverage' }, WED_WINDOW)).toEqual({});
  });
});

describe('roleForSlot', () => {
  it('prices a fixed shift with the person real title', () => {
    expect(roleForSlot({ kind: 'fixed', fixedRole: 'Dir. of Education' })).toBe('Dir. of Education');
    expect(roleForSlot({ kind: 'fixed' })).toBe('Manager');
  });

  it('maps the desks to the roles the rest of the app stores', () => {
    expect(roleForSlot({ kind: 'host' })).toBe('Host');
    expect(roleForSlot({ kind: 'admin' })).toBe('Admin');
    expect(roleForSlot({ kind: 'coverage' })).toBe('Instructor');
    expect(roleForSlot(null)).toBe('Instructor');
  });
});
