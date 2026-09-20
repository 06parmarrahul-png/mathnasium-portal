import { describe, it, expect } from 'vitest';
import { roundsFor, roundFor, explain, ROUNDS, FLOOR_RATIO } from './ratioRush';
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

  it('uses the centre’s own rule, not a rule of its own', () => {
    // The Staffing Board sizes real days with requiredForSlot. If this
    // game disagreed with it, it would be teaching the wrong thing.
    for (const round of roundsFor('langley|2026-09-20', 50)) {
      expect(round.answer).toBe(requiredForSlot(round.students, DEFAULT_TARGET_RATIO));
      expect(round.ratio).toBe(DEFAULT_TARGET_RATIO);
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

  it('carries what the floor ratio would allow, for the explanation', () => {
    for (const round of roundsFor('langley|2026-09-20', 30)) {
      expect(round.atFloor).toBe(requiredForSlot(round.students, FLOOR_RATIO));
      // The floor is the more permissive of the two, so it never needs
      // MORE people than the aim does.
      expect(round.atFloor).toBeLessThanOrEqual(round.answer);
    }
  });
});

describe('the explanation after a miss', () => {
  it('shows the division, not just the answer', () => {
    expect(explain({ students: 14, ratio: 3.5, answer: 4 })).toBe('14 ÷ 3.5 = 4 → 4');
    expect(explain({ students: 15, ratio: 3.5, answer: 5 })).toMatch(/rounded up/);
  });
});
