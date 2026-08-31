/**
 * Unit tests for board-budget.
 *
 * This decides whether the owner is told they have room for another body or
 * that they're over budget. Getting it wrong either burns payroll or leaves
 * the floor thin, so the arithmetic is pinned down here rather than eyeballed
 * in the UI.
 */

import { describe, it, expect } from 'vitest';
import { boardBudget, slotHours, BOARD_BUCKETS } from './board-budget.js';
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
  it('reads the real Wednesday budget: 52h total, 40h the board can spend', () => {
    const b = boardBudget({ dayName: 'Wednesday', instrWindow: WED_WINDOW, slots: [] });
    expect(b.fullDay).toBe(52);            // 31 + 4 + 4 + 4 + 4 + 5
    expect(b.boardAllotted).toBe(40);      // instructional 31 + host 4 + adminHours 5
    expect(b.elsewhere).toBe(12);          // online 4 + steam 4 + adminAssistant 4
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
    expect(b.remaining).toBe(36);
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
    expect(b.remaining).toBeCloseTo(19.5, 5);
    expect(b.over).toBe(false);
  });

  it('flags going over budget', () => {
    const many = Array.from({ length: 12 }, () => slot('15:00', '19:00'));
    const b = boardBudget({ dayName: 'Wednesday', instrWindow: WED_WINDOW, slots: many });
    expect(b.boardUsed).toBe(48);
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
