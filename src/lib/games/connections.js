/**
 * connections.js — sixteen numbers, four sets of four.
 *
 * THE OVERLAPS ARE THE PUZZLE. 64 is a perfect square AND a power of two;
 * 81 is a square AND a multiple of nine. A set of categories that never
 * overlap is a sorting exercise, not a game. But an overlap that leaves
 * TWO valid answers is unfair, so every board is checked for a unique
 * solution before it is handed out — see hasUniqueSolution below.
 *
 * GENERATED, NOT WRITTEN. Fourteen properties, four per board, drawn from
 * the date and centre id so everyone at the centre argues about the same
 * sixteen numbers.
 *
 * WHAT PLAYERS ACTUALLY REMEMBER IS THE CATEGORIES, not the numbers. The
 * first version had eight properties and picked four at random each day.
 * Measured over a year that gave 364 distinct boards — and only 24
 * distinct category sets, the commonest landing 21 times, roughly every
 * seventeen days. It read as repetitive because it WAS repetitive in the
 * one dimension anybody notices.
 *
 * Two things fix it, and both are needed:
 *
 *   MORE COMBINATIONS. Fourteen properties give 1001 possible sets of
 *   four, 691 of which can be drawn cleanly (see usableCombos). Twenty-nine
 *   times the old 24.
 *
 *   A ROTATION, NOT A DICE ROLL. 691 sets drawn independently still
 *   collide about ninety times a year — that is the birthday problem, not
 *   bad luck. So the daily board WALKS a fixed shuffle of the 691 instead
 *   of sampling it: no category set can return until all 691 have been
 *   used, which is just under two years. The numbers inside each set are
 *   still drawn from the centre and the date, so two centres on the same
 *   day get the same four categories with different tiles.
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
const isCube = (n) => { const r = Math.round(Math.cbrt(n)); return r * r * r === n; };
const digitSum = (n) => String(n).split('').reduce((a, d) => a + Number(d), 0);
const isPalindrome = (n) => String(n) === [...String(n)].reverse().join('');
const FIBS = [13, 21, 34, 55, 89, 144, 233, 377];

/**
 * The properties a set can be built from.
 *
 * Each says what it is in the words the player will see when the set is
 * solved — "Multiple of nine", not "n % 9 === 0" — because the reveal is
 * the moment the game teaches something.
 */
export const PROPERTIES = [
  { id: 'prime', name: 'Prime', test: isPrime, pool: range(11, 97).filter(isPrime) },
  { id: 'square', name: 'Perfect square', test: isSquare, pool: range(4, 20).map(n => n * n) },
  { id: 'cube', name: 'Cube number', test: isCube, pool: [8, 27, 64, 125, 216, 343, 512, 729] },
  { id: 'pow2', name: 'Power of two', test: isPowerOf(2), pool: [8, 16, 32, 64, 128, 256, 512, 1024] },
  { id: 'pow3', name: 'Power of three', test: isPowerOf(3), pool: [9, 27, 81, 243, 729] },
  { id: 'mult7', name: 'Multiple of seven', test: (n) => n % 7 === 0, pool: range(2, 20).map(n => n * 7) },
  { id: 'mult9', name: 'Multiple of nine', test: (n) => n % 9 === 0, pool: range(2, 16).map(n => n * 9) },
  { id: 'mult11', name: 'Multiple of eleven', test: (n) => n % 11 === 0, pool: range(2, 13).map(n => n * 11) },
  { id: 'mult12', name: 'Multiple of twelve', test: (n) => n % 12 === 0, pool: range(2, 12).map(n => n * 12) },
  { id: 'mult25', name: 'Multiple of twenty-five', test: (n) => n % 25 === 0, pool: range(1, 8).map(n => n * 25) },
  { id: 'triangular', name: 'Triangular number', test: isTriangular, pool: [10, 15, 21, 28, 36, 45, 55, 66, 78, 91, 105, 120, 136] },
  { id: 'fib', name: 'Fibonacci number', test: (n) => FIBS.includes(n), pool: FIBS },
  // Two that are about the DIGITS rather than the arithmetic. They give a
  // board a different flavour, and they are the two a younger student can
  // spot without knowing any of the vocabulary above.
  { id: 'palindrome', name: 'Reads the same backwards', test: isPalindrome,
    pool: [11, 22, 33, 44, 55, 66, 77, 88, 99, 101, 111, 121, 131, 141, 151, 161, 171, 181, 191] },
  { id: 'digitsum10', name: 'Digits add up to ten', test: (n) => digitSum(n) === 10,
    pool: [19, 28, 37, 46, 55, 64, 73, 82, 91, 109, 118, 127, 136, 145, 154, 163, 172, 181, 190] },
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

/** The numbers only this property claims, given the other three. */
function cleanPool(prop, combo) {
  return prop.pool.filter(n => combo.filter(p => p.test(n)).length === 1);
}

/**
 * Every set of four properties that can actually make a fair board.
 *
 * "Can" means each of the four still has GROUP_SIZE numbers that none of
 * the other three claim — otherwise a tile would belong to two sets and
 * the board would have no single answer.
 *
 * Computed once. It is 1001 candidate sets against a handful of small
 * pools, which is nothing, but it is also the same answer every time.
 */
let COMBO_CACHE = null;
export function usableCombos() {
  if (COMBO_CACHE) return COMBO_CACHE;
  const out = [];
  const n = PROPERTIES.length;
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      for (let c = b + 1; c < n; c += 1) {
        for (let d = c + 1; d < n; d += 1) {
          const combo = [PROPERTIES[a], PROPERTIES[b], PROPERTIES[c], PROPERTIES[d]];
          if (combo.every(p => cleanPool(p, combo).length >= GROUP_SIZE)) out.push(combo);
        }
      }
    }
  }
  COMBO_CACHE = out;
  return out;
}

/**
 * The order the daily board walks those sets in.
 *
 * A fixed shuffle, seeded by a constant rather than by the day: the POINT
 * is that consecutive days land on different entries of one permutation,
 * so nothing can come back around until everything has had a turn. Seed it
 * by the date and it would be a fresh dice roll every morning, which is
 * the behaviour this replaced.
 *
 * Shared by every centre, deliberately. The categories are the same
 * everywhere on a given day; the sixteen numbers under them are not,
 * because those are drawn from the centre and the date.
 */
let ORDER_CACHE = null;
function comboOrder() {
  if (ORDER_CACHE) return ORDER_CACHE;
  const rng = makeRng(seedFrom('ratio-connections-rotation'));
  const idx = usableCombos().map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  ORDER_CACHE = idx;
  return idx;
}

/**
 * "2026-09-28" → a day number, or null if that is not a date.
 *
 * Whole days since the epoch, read as UTC so it does not slide by one
 * either side of midnight depending on where the reader is standing. It
 * only has to advance by exactly one per calendar day; what it counts from
 * does not matter.
 */
export function dayIndexFor(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

/**
 * The day's board.
 *
 * `dayIndex` is a day number — any integer that advances by one per day.
 * Given one, the four categories come off the rotation above and cannot
 * repeat until every combination has been used. Without one (a practice
 * game, which wants a fresh board on demand rather than today's) they are
 * picked from the seed instead.
 *
 * The numbers are always drawn from the seed, so a practice board and the
 * ranked board differ even when they share categories.
 */
export function dailyBoard(seed, dayIndex = null) {
  const rng = makeRng(seedFrom(seed));
  const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const combos = usableCombos();
  if (combos.length > 0) {
    let chosen;
    if (Number.isInteger(dayIndex)) {
      const order = comboOrder();
      // Modulo twice: JS keeps the sign of a negative dividend, and a date
      // before the epoch is a perfectly ordinary thing for a test to pass.
      const at = ((dayIndex % order.length) + order.length) % order.length;
      chosen = combos[order[at]];
    } else {
      chosen = combos[Math.floor(rng() * combos.length)];
    }

    const groups = chosen.map(prop => ({
      id: prop.id,
      name: prop.name,
      items: shuffle(cleanPool(prop, chosen)).slice(0, GROUP_SIZE).sort((a, b) => a - b),
    }));

    if (hasUniqueSolution(groups)) {
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
