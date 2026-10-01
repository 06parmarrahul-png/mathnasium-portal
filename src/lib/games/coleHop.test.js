import { describe, it, expect } from 'vitest';
import {
  courseFor, questionsFor, questionFor, isTable, explain, tableLabel,
  FIELD, PHYSICS, RANKED_TABLE, TABLES,
} from './coleHop';
import { makeRng, seedFrom } from '../ratioGames';

const SEED = 'langley|2026-10-01|coleHop';

describe('the ladder', () => {
  it('is the same ladder for everyone on the same day', () => {
    expect(courseFor(SEED, 40)).toEqual(courseFor(SEED, 40));
  });

  it('is a different ladder tomorrow', () => {
    const today = courseFor(SEED, 40);
    const tomorrow = courseFor('langley|2026-10-02|coleHop', 40);
    expect(today).not.toEqual(tomorrow);
  });

  it('gives platform N the same shape however many were asked for', () => {
    // A run that climbs further must not be playing a different ladder
    // from the waist down.
    const short = courseFor(SEED, 20);
    const long = courseFor(SEED, 200);
    expect(long.slice(0, 20)).toEqual(short);
  });

  it('starts everyone on the same wide, centred platform', () => {
    const [first] = courseFor(SEED, 5);
    expect(first).toMatchObject({ n: 0, y: PHYSICS.START_Y, w: 80, spring: false });
    expect(first.x + first.w / 2).toBe(FIELD.W / 2);
  });

  it('only ever goes up', () => {
    const course = courseFor(SEED, 120);
    for (let i = 1; i < course.length; i += 1) {
      expect(course[i].y).toBeLessThan(course[i - 1].y);
    }
  });

  it('keeps every platform on the field', () => {
    for (const p of courseFor(SEED, 200)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(FIELD.W);
      expect(p.w).toBeGreaterThan(0);
    }
  });

  it('gets harder: wider gaps, narrower platforms, faster slides', () => {
    const c = courseFor(SEED, 200);
    const gap = (i) => c[i - 1].y - c[i].y;
    const early = [1, 2, 3, 4, 5];
    const late = [120, 121, 122, 123, 124];
    const mean = (ns, f) => ns.reduce((s, i) => s + f(i), 0) / ns.length;
    expect(mean(late, gap)).toBeGreaterThan(mean(early, gap));
    expect(mean(late, i => c[i].w)).toBeLessThan(mean(early, i => c[i].w));
    expect(mean(late, i => Math.abs(c[i].vx))).toBeGreaterThan(mean(early, i => Math.abs(c[i].vx)));
  });
});

describe('the questions', () => {
  it('are the same questions, in the same order, for everyone', () => {
    expect(questionsFor(SEED, 'all', 30)).toEqual(questionsFor(SEED, 'all', 30));
  });

  it('always offers the right answer among the three', () => {
    for (const q of questionsFor(SEED, 'all', 120)) {
      expect(q.options).toHaveLength(3);
      expect(q.options).toContain(q.answer);
      expect(new Set(q.options).size).toBe(3);
      expect(q.a * q.b).toBe(q.answer);
    }
  });

  it('offers decoys worth hesitating over, not obvious throwaways', () => {
    // Every wrong option is within a neighbouring fact's reach — a decoy
    // nobody would pick makes the game "tap the only plausible number".
    for (const q of questionsFor(SEED, 'all', 120)) {
      for (const opt of q.options) {
        if (opt === q.answer) continue;
        const plausible = [q.a * (q.b + 1), q.a * (q.b - 1), (q.a + 1) * q.b, (q.a - 1) * q.b,
          q.answer + 1, q.answer - 1, q.answer + 2, q.answer - 2, q.answer + 10];
        expect(plausible).toContain(opt);
      }
    }
  });

  it('stays inside one table when one is picked, either way round', () => {
    for (const q of questionsFor(SEED, 7, 60)) {
      expect(q.a === 7 || q.b === 7).toBe(true);
      expect(Math.max(q.a, q.b)).toBeLessThanOrEqual(12);
    }
  });

  it('works up to the twelves as the climb goes on', () => {
    const rng = makeRng(seedFrom('fixed'));
    const early = Array.from({ length: 40 }, () => questionFor(rng, 'all', 0));
    const late = Array.from({ length: 40 }, () => questionFor(rng, 'all', 40));
    expect(Math.max(...early.map(q => Math.max(q.a, q.b)))).toBeLessThanOrEqual(9);
    expect(Math.max(...late.map(q => Math.max(q.a, q.b)))).toBeGreaterThan(9);
  });

  it('a ranked run is all tables, not a table somebody picked', () => {
    expect(RANKED_TABLE).toBe('all');
    expect(TABLES[0]).toBe('all');
  });
});

describe('the small print', () => {
  it('knows a real table from a typo', () => {
    expect(isTable('all')).toBe(true);
    expect(isTable(7)).toBe(true);
    expect(isTable(0)).toBe(false);
    expect(isTable(13)).toBe(false);
    expect(isTable('7')).toBe(false);
  });

  it('says the fact out loud after a miss', () => {
    expect(explain({ a: 7, b: 8, answer: 56 })).toBe('7 × 8 = 56');
  });

  it('names the table', () => {
    expect(tableLabel('all')).toBe('All tables');
    expect(tableLabel(7)).toBe('7 times table');
  });
});
