import { describe, it, expect } from 'vitest';
import {
  dailyBoard, judgeGuess, hasUniqueSolution, propertyById, PROPERTIES,
  GROUP_SIZE, GROUPS,
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
