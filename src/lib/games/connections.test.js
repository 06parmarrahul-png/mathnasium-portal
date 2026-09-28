import { describe, it, expect } from 'vitest';
import {
  dailyBoard, judgeGuess, hasUniqueSolution, propertyById, PROPERTIES,
  usableCombos, dayIndexFor, GROUP_SIZE, GROUPS,
} from './connections';

const boards = Array.from({ length: 300 }, (_, i) => dailyBoard(`langley|seed-${i}`));

describe('the day’s board', () => {
  it('is the same for everyone at the centre, all day', () => {
    const a = dailyBoard('langley|2026-09-20');
    const b = dailyBoard('langley|2026-09-20');
    expect(a.tiles).toEqual(b.tiles);
    expect(a.groups.map(g => g.id)).toEqual(b.groups.map(g => g.id));
  });

  it('differs by day and by centre', () => {
    const today = dailyBoard('langley|2026-09-20').tiles.join();
    expect(dailyBoard('langley|2026-09-21').tiles.join()).not.toBe(today);
    expect(dailyBoard('burnaby|2026-09-20').tiles.join()).not.toBe(today);
  });

  it('is always sixteen tiles in four sets of four', () => {
    for (const board of boards) {
      expect(board.tiles).toHaveLength(GROUPS * GROUP_SIZE);
      expect(board.groups).toHaveLength(GROUPS);
      for (const g of board.groups) expect(g.items).toHaveLength(GROUP_SIZE);
    }
  });

  it('never repeats a number on the board', () => {
    for (const board of boards) {
      expect(new Set(board.tiles).size).toBe(board.tiles.length);
    }
  });

  it('is shuffled, not laid out in its answer', () => {
    const inOrder = boards.filter(b => b.tiles.join() === b.groups.flatMap(g => g.items).join());
    expect(inOrder).toHaveLength(0);
  });

  it('has exactly one solution — every tile belongs to one set only', () => {
    // The properties overlap on purpose (64 is a square AND a power of
    // two), so the generator has to pick numbers that only one chosen
    // property claims. This is the test that makes the puzzle fair.
    for (const board of boards) {
      expect(hasUniqueSolution(board.groups)).toBe(true);
      const props = board.groups.map(g => propertyById(g.id));
      for (const tile of board.tiles) {
        expect(props.filter(p => p.test(tile))).toHaveLength(1);
      }
    }
  });

  it('names each set in words a player learns something from', () => {
    for (const board of boards) {
      for (const g of board.groups) {
        expect(g.name).toBeTruthy();
        expect(g.name).not.toMatch(/[%=<>]/);   // not the code behind it
      }
    }
  });

  it('draws on more than one set of properties across the year', () => {
    const seen = new Set(boards.flatMap(b => b.groups.map(g => g.id)));
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });
});

describe('spotting a bad board', () => {
  it('rejects one where a tile fits two chosen sets', () => {
    // 64 is a perfect square and a power of two — with both properties in
    // play, a board holding it has no single answer.
    const bad = [
      { id: 'square', name: 'Perfect square', items: [25, 36, 49, 64] },
      { id: 'pow2', name: 'Power of two', items: [32, 128, 256, 512] },
      { id: 'prime', name: 'Prime', items: [13, 29, 41, 53] },
      { id: 'mult7', name: 'Multiple of seven', items: [14, 35, 77, 91] },
    ];
    expect(hasUniqueSolution(bad)).toBe(false);
  });

  it('rejects a board that is not four sets', () => {
    expect(hasUniqueSolution([{ id: 'prime', name: 'Prime', items: [13, 29, 41, 53] }])).toBe(false);
  });
});

describe('judging a guess', () => {
  const board = {
    groups: [
      { id: 'prime', name: 'Prime', items: [13, 29, 41, 53] },
      { id: 'square', name: 'Perfect square', items: [49, 100, 121, 169] },
      { id: 'pow2', name: 'Power of two', items: [16, 32, 128, 256] },
      { id: 'mult9', name: 'Multiple of nine', items: [27, 45, 63, 99] },
    ],
  };

  it('accepts a set and names it', () => {
    const out = judgeGuess(board, [13, 29, 41, 53]);
    expect(out.status).toBe('solved');
    expect(out.group.name).toBe('Prime');
  });

  it('says one away without saying which one', () => {
    const out = judgeGuess(board, [13, 29, 41, 16]);
    expect(out.status).toBe('one-away');
    expect(out.group).toBeNull();
  });

  it('says nothing useful about a guess that is nowhere near', () => {
    expect(judgeGuess(board, [13, 49, 16, 27]).status).toBe('wrong');
  });

  it('waits for four', () => {
    expect(judgeGuess(board, [13, 29]).status).toBe('incomplete');
    expect(judgeGuess(board, null).status).toBe('incomplete');
  });

  it('does not care what order they were picked in', () => {
    expect(judgeGuess(board, [53, 13, 41, 29]).status).toBe('solved');
  });
});

describe('the properties themselves', () => {
  it('each holds enough numbers to draw a set from', () => {
    for (const p of PROPERTIES) {
      expect(p.pool.length).toBeGreaterThanOrEqual(GROUP_SIZE);
      for (const n of p.pool) expect(p.test(n)).toBe(true);
    }
  });
});

describe('how often a board comes back around', () => {
  /**
   * The complaint this answers: "it's a lot of repeats".
   *
   * What a player recognises is the four CATEGORIES, not which four primes
   * turned up under them. The first version had eight properties and rolled
   * four fresh each day: 24 distinct category sets in a year, the commonest
   * landing 21 times. The numbers were nearly all different and it still
   * felt repetitive, because the part anybody remembers was not.
   */
  const catsOn = (dayIndex, seed = 'langley|x|connections') =>
    dailyBoard(seed, dayIndex).groups.map(g => g.id).sort().join('+');

  it('has hundreds of category sets to draw on, not a couple of dozen', () => {
    expect(usableCombos().length).toBeGreaterThan(500);
  });

  it('never repeats a category set until every one has been used', () => {
    const n = usableCombos().length;
    const seen = new Set();
    for (let i = 0; i < n; i += 1) seen.add(catsOn(i));
    expect(seen.size).toBe(n);
  });

  it('comes back round to the start once they have all been used', () => {
    const n = usableCombos().length;
    expect(catsOn(n)).toBe(catsOn(0));
    expect(catsOn(n + 1)).toBe(catsOn(1));
  });

  it('runs a year of real dates without repeating a category set', () => {
    const seen = new Set();
    for (let i = 0; i < 365; i += 1) {
      const iso = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      seen.add(catsOn(dayIndexFor(iso), `langley|${iso}|connections`));
    }
    expect(seen.size).toBe(365);
  });

  it('survives a day index from before the epoch', () => {
    // Negative dividends keep their sign in JS; a naive % would index off
    // the front of the rotation and hand back undefined.
    expect(() => dailyBoard('langley|x', -1)).not.toThrow();
    expect(dailyBoard('langley|x', -1).groups).toHaveLength(GROUPS);
  });
});

describe('the same day, seen from different places', () => {
  const day = '2026-06-15';
  const at = (centre) => dailyBoard(`${centre}|${day}|connections`, dayIndexFor(day));

  it('gives every centre the same four categories', () => {
    const cats = ['langley', 'chilliwack', 'abbotsford']
      .map(c => at(c).groups.map(g => g.id).sort().join('+'));
    expect(new Set(cats).size).toBe(1);
  });

  it('but not the same sixteen numbers', () => {
    const tiles = ['langley', 'chilliwack', 'abbotsford']
      .map(c => at(c).tiles.slice().sort((a, b) => a - b).join(','));
    expect(new Set(tiles).size).toBe(3);
  });
});

describe('practice, which wants a new board rather than today’s', () => {
  it('varies without a day index, on one date', () => {
    const cats = Array.from({ length: 5 }, (_, i) =>
      dailyBoard(`langley|2026-06-15|connections|practice-${i}`)
        .groups.map(g => g.id).sort().join('+'));
    expect(new Set(cats).size).toBeGreaterThan(1);
  });
});

describe('every combination the rotation can land on', () => {
  it('makes a board with exactly one answer', () => {
    // Not a sample — all of them. The rotation will reach every one, so a
    // single unfair combination is a board somebody gets handed one day.
    const bad = [];
    usableCombos().forEach((_, i) => {
      const board = dailyBoard(`langley|check-${i}`, i);
      if (!hasUniqueSolution(board.groups)) bad.push(board.groups.map(g => g.id).join('+'));
      if (new Set(board.tiles).size !== GROUPS * GROUP_SIZE) bad.push(`dupe tile: ${board.tiles}`);
    });
    expect(bad).toEqual([]);
  });
});

describe('dayIndexFor', () => {
  it('advances by exactly one per calendar day', () => {
    expect(dayIndexFor('2026-09-29') - dayIndexFor('2026-09-28')).toBe(1);
    expect(dayIndexFor('2027-01-01') - dayIndexFor('2026-12-31')).toBe(1);
  });

  it('does not slide across a daylight-saving change', () => {
    // Read as UTC on purpose: the clocks going forward must not make two
    // days share an index, or the rotation stalls for a day.
    expect(dayIndexFor('2026-03-09') - dayIndexFor('2026-03-08')).toBe(1);
    expect(dayIndexFor('2026-11-02') - dayIndexFor('2026-11-01')).toBe(1);
  });

  it('is null for anything that is not a date, so the board falls back', () => {
    for (const junk of [null, undefined, '', 'today', '2026-9-8', '2026-09-08T10:00']) {
      expect(dayIndexFor(junk), String(junk)).toBeNull();
    }
  });
});
