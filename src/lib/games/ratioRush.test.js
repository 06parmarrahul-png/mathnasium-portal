import { describe, it, expect } from 'vitest';
import { roundsFor, roundFor, explain, aimNote, ROUNDS, FLOOR_RATIO } from './ratioRush';
import { makeRng, seedFrom } from '../ratioGames';
import { requiredForSlot } from '../demand-staffing';
import { DEFAULT_TARGET_RATIO } from '../subRoles';

describe('the rounds', () => {
  it('are the same run given the same seed', () => {
    expect(roundsFor('langley|2026-09-20')).toEqual(roundsFor('langley|2026-09-20'));
  });

  it('are a different run on a different day', () => {
    const a = roundsFor('langley|2026-09-20').map(r => r.students).join();
    expect(roundsFor('langley|2026-09-21').map(r => r.students).join()).not.toBe(a);
  });

  it('asks ten by default', () => {
    expect(roundsFor('x')).toHaveLength(ROUNDS);
    expect(roundsFor('x', 4)).toHaveLength(4);
  });

  it('asks at the floor, 1:4 — the one you can do in your head', () => {
    for (const round of roundsFor('langley|2026-09-20', 50)) {
      expect(round.ratio).toBe(FLOOR_RATIO);
      expect(round.ratio).toBe(4);
    }
  });

  it('uses the centre’s own rule, not a rule of its own', () => {
    // The Staffing Board sizes real days with requiredForSlot. If this
    // game disagreed with it, it would be teaching the wrong thing.
    for (const round of roundsFor('langley|2026-09-20', 50)) {
      expect(round.answer).toBe(requiredForSlot(round.students, FLOOR_RATIO));
    }
  });

  it('always rounds up — half an instructor covers nobody', () => {
    const rng = makeRng(seedFrom('rounding'));
    for (let i = 0; i < 200; i += 1) {
      const round = roundFor(rng);
      expect(round.answer).toBe(Math.ceil(round.students / round.ratio));
      expect(Number.isInteger(round.answer)).toBe(true);
    }
  });

  it('never asks about an empty room', () => {
    for (const round of roundsFor('langley|2026-09-20', 100)) {
      expect(round.students).toBeGreaterThan(0);
      expect(round.answer).toBeGreaterThan(0);
    }
  });

  it('carries what the AIM would want, for the explanation', () => {
    for (const round of roundsFor('langley|2026-09-20', 30)) {
      expect(round.atAim).toBe(requiredForSlot(round.students, DEFAULT_TARGET_RATIO));
      // The aim is the stricter of the two, so it never needs FEWER
      // people than the floor the game asks in.
      expect(round.atAim).toBeGreaterThanOrEqual(round.answer);
    }
  });
});

describe('the explanation after a miss', () => {
  it('shows the division, not just the answer', () => {
    expect(explain({ students: 16, ratio: 4, answer: 4 })).toBe('16 ÷ 4 = 4 → 4');
    expect(explain({ students: 17, ratio: 4, answer: 5 })).toMatch(/rounded up/);
  });

  it('says what the aim would have wanted, when that is a different number', () => {
    // 16 students: four at the floor, five at the aim. Worth saying, or
    // the easy number starts to look like the one we staff to.
    expect(aimNote({ answer: 4, atAim: 5 })).toBe('The aim of 1:3.5 would want 5.');
  });

  it('stays quiet when both ratios want the same people', () => {
    expect(aimNote({ answer: 3, atAim: 3 })).toBe('');
    expect(aimNote({ answer: 3 })).toBe('');
  });
});
