/**
 * ratioRush.js — how many instructors does this half hour need?
 *
 * THE ONE THAT IS ACTUALLY THE JOB. A half hour of bookings appears and
 * the player says how many instructors the floor needs for it, always
 * rounding UP, because half an instructor cannot cover a student.
 *
 * IT ASKS AT 1:4, THE FLOOR — not the 1:3.5 aim it opened with. Dividing
 * by four is something you can do standing on the floor with a queue in
 * front of you; dividing by three and a half against a sixty-second clock
 * is a different skill, and not the one worth drilling. The aim is still
 * the number the centre staffs to, and the explanation after a miss says
 * what it would have wanted, so nobody learns the floor as the target.
 *
 * The maths is `requiredForSlot()` in demand-staffing.js — the same
 * function the Staffing Board sizes real days with — so practising here
 * is practising the thing, and a person who gets good at this can read a
 * booking curve the way the board does.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

import { makeRng, seedFrom } from '../ratioGames';
import { requiredForSlot } from '../demand-staffing';
import { DEFAULT_TARGET_RATIO } from '../subRoles';

export const ROUNDS = 10;

/**
 * The floor: nobody covers more than this many students at once. It is
 * also what the game asks in — see the note above.
 */
export const FLOOR_RATIO = 4;

/**
 * One round.
 *
 * `students` is what walks in; `answer` is what the floor needs at the
 * ratio being asked. The ratio is stated on screen every round rather
 * than assumed — the game is arithmetic under time pressure, not a memory
 * test about which ratio is which.
 */
export function roundFor(rng, ratio = FLOOR_RATIO) {
  const students = Math.floor(rng() * 22) + 3;   // 3–24, the real spread
  return {
    students,
    ratio,
    answer: requiredForSlot(students, ratio),
    // What the AIM would have wanted, for the explanation after a miss —
    // so the easier number never reads as the number we staff to.
    atAim: requiredForSlot(students, DEFAULT_TARGET_RATIO),
  };
}

/** A whole game's worth, so a run can be replayed exactly. */
export function roundsFor(seed, count = ROUNDS, ratio = FLOOR_RATIO) {
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

/**
 * The same slot at the aim, when the aim wants somebody the floor doesn't.
 * Only worth saying when the two numbers differ — otherwise it is noise
 * on top of an answer the player already has.
 */
export function aimNote(round) {
  const atAim = round?.atAim;
  if (!atAim || atAim === round.answer) return '';
  return `The aim of 1:${DEFAULT_TARGET_RATIO} would want ${atAim}.`;
}
