/**
 * ratioRush.js — how many instructors does this half hour need?
 *
 * THE ONE THAT IS ACTUALLY THE JOB. A half hour of bookings appears and
 * the player says how many instructors the floor needs for it, using the
 * centre's own rule: aim 1:3.5, floor 1:4, always rounding UP because
 * half an instructor cannot cover a student.
 *
 * That is `requiredForSlot()` in demand-staffing.js — the same function
 * the Staffing Board sizes real days with — so practising here is
 * practising the thing, and a person who gets good at this can read a
 * booking curve the way the board does.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

import { makeRng, seedFrom } from '../ratioGames';
import { requiredForSlot } from '../demand-staffing';
import { DEFAULT_TARGET_RATIO } from '../subRoles';

export const ROUNDS = 10;

/** The floor: nobody covers more than this many students at once. */
export const FLOOR_RATIO = 4;

/**
 * One round.
 *
 * `students` is what walks in; `answer` is what the floor needs at the
 * aim ratio. The ratio is stated on screen every round rather than
 * assumed — the game is arithmetic under time pressure, not a memory test
 * about which ratio is which.
 */
export function roundFor(rng, ratio = DEFAULT_TARGET_RATIO) {
  const students = Math.floor(rng() * 22) + 3;   // 3–24, the real spread
  return {
    students,
    ratio,
    answer: requiredForSlot(students, ratio),
    // What the floor rule would allow, for the explanation after a miss.
    atFloor: requiredForSlot(students, FLOOR_RATIO),
  };
}

/** A whole game's worth, so a run can be replayed exactly. */
export function roundsFor(seed, count = ROUNDS, ratio = DEFAULT_TARGET_RATIO) {
  const rng = makeRng(seedFrom(seed));
  return Array.from({ length: count }, () => roundFor(rng, ratio));
}

/**
 * Why the answer is the answer, in one line, shown after a wrong guess.
 * A game that only says "wrong" teaches nothing.
 */
export function explain(round) {
  const exact = round.students / round.ratio;
  const rounded = Number.isInteger(exact) ? `${exact}` : `${exact.toFixed(2)}, rounded up`;
  return `${round.students} ÷ ${round.ratio} = ${rounded} → ${round.answer}`;
}
