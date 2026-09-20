/**
 * connections.js — sixteen numbers, four sets of four.
 *
 * THE OVERLAPS ARE THE PUZZLE. 64 is a perfect square AND a power of two;
 * 81 is a square AND a multiple of nine. A set of categories that never
 * overlap is a sorting exercise, not a game. But an overlap that leaves
 * TWO valid answers is unfair, so every board is checked for a unique
 * solution before it is handed out — see hasUniqueSolution below.
 *
 * GENERATED, NOT WRITTEN. Eight properties, four drawn per day from the
 * date and centre id, so it never runs out, never repeats next week, and
 * everyone at the centre argues about the same board.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

import { makeRng, seedFrom } from '../ratioGames';

export const GROUP_SIZE = 4;
export const GROUPS = 4;
export const LIVES = 4;

const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

const isPrime = (n) => {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d += 1) if (n % d === 0) return false;
  return true;
};

const isSquare = (n) => Number.isInteger(Math.sqrt(n));
const isPowerOf = (base) => (n) => {
  if (n < base) return false;
  let v = base;
  while (v < n) v *= base;
  return v === n;
};
const isTriangular = (n) => isSquare(8 * n + 1);
const FIBS = [13, 21, 34, 55, 89, 144, 233];

/**
 * The properties a set can be built from.
 *
 * Each says what it is in the words the player will see when the set is
 * solved — "Multiple of nine", not "n % 9 === 0" — because the reveal is
 * the moment the game teaches something.
 */
export const PROPERTIES = [
  { id: 'prime', name: 'Prime', test: isPrime, pool: range(11, 97).filter(isPrime) },
  { id: 'square', name: 'Perfect square', test: isSquare, pool: [16, 25, 36, 49, 64, 81, 100, 121, 144, 169] },
  { id: 'pow2', name: 'Power of two', test: isPowerOf(2), pool: [16, 32, 64, 128, 256, 512] },
  { id: 'pow3', name: 'Power of three', test: isPowerOf(3), pool: [9, 27, 81, 243] },
  { id: 'mult9', name: 'Multiple of nine', test: (n) => n % 9 === 0, pool: range(2, 12).map(n => n * 9) },
  { id: 'mult7', name: 'Multiple of seven', test: (n) => n % 7 === 0, pool: range(2, 14).map(n => n * 7) },
  { id: 'triangular', name: 'Triangular number', test: isTriangular, pool: [10, 15, 21, 28, 36, 45, 55, 66, 78] },
  { id: 'fib', name: 'Fibonacci number', test: (n) => FIBS.includes(n), pool: FIBS },
];

export function propertyById(id) {
  return PROPERTIES.find(p => p.id === id) || null;
}

/**
 * Is this board solvable exactly one way?
 *
 * Brute force over every way of splitting sixteen numbers into four
 * labelled sets would be astronomical, so this asks the question that
 * actually matters: can any number be swapped into another set? A tile
 * that satisfies two of the four chosen properties makes the board
 * ambiguous, because the partition it came from is no longer the only one
 * that works.
 *
 * That is stricter than "there exists another complete solution" — a
 * board can have a doubly-qualifying tile and still resolve by counting —
 * and stricter is the right side to err on for a puzzle with a prize
 * attached to the month it sits in.
 */
export function hasUniqueSolution(groups) {
  const props = groups.map(g => propertyById(g.id)).filter(Boolean);
  if (props.length !== GROUPS) return false;
  for (const group of groups) {
    for (const value of group.items) {
      const matches = props.filter(p => p.test(value));
      if (matches.length !== 1) return false;
    }
  }
  return true;
}

/**
 * The day's board.
 *
 * Draws four properties, then four numbers for each that ONLY that
 * property claims. If a draw cannot be made cleanly it starts again with
 * different properties rather than shipping an unfair board.
 */
export function dailyBoard(seed) {
  const rng = makeRng(seedFrom(seed));
  const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const chosen = shuffle(PROPERTIES).slice(0, GROUPS);
    const groups = [];
    let ok = true;

    for (const prop of chosen) {
      // Only numbers this property alone claims, so the board stays
      // unambiguous even though the properties themselves overlap.
      const clean = prop.pool.filter(n => chosen.filter(p => p.test(n)).length === 1);
      if (clean.length < GROUP_SIZE) { ok = false; break; }
      groups.push({ id: prop.id, name: prop.name, items: shuffle(clean).slice(0, GROUP_SIZE).sort((a, b) => a - b) });
    }

    if (ok && hasUniqueSolution(groups)) {
      return { groups, tiles: shuffle(groups.flatMap(g => g.items)) };
    }
  }

  // Unreachable with the properties above; a real board beats a blank
  // screen if somebody adds a property that cannot be drawn cleanly.
  const fallback = [
    { id: 'prime', name: 'Prime', items: [13, 29, 41, 53] },
    { id: 'square', name: 'Perfect square', items: [49, 100, 121, 169] },
    { id: 'pow2', name: 'Power of two', items: [16, 32, 128, 256] },
    { id: 'mult9', name: 'Multiple of nine', items: [27, 45, 63, 99] },
  ];
  return { groups: fallback, tiles: shuffle(fallback.flatMap(g => g.items)) };
}

/**
 * What a submitted four adds up to.
 *
 * "One away" is the hint the original game is built on: it tells you the
 * idea was right without telling you which tile to move, which is the
 * whole of the difficulty.
 */
export function judgeGuess(board, picked) {
  if (!Array.isArray(picked) || picked.length !== GROUP_SIZE) {
    return { status: 'incomplete' };
  }
  for (const group of board.groups) {
    const hits = picked.filter(v => group.items.includes(v)).length;
    if (hits === GROUP_SIZE) return { status: 'solved', group };
    if (hits === GROUP_SIZE - 1) return { status: 'one-away', group: null };
  }
  return { status: 'wrong', group: null };
}
