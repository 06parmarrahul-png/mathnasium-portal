/**
 * coleHop.js — the times tables, as something to climb.
 *
 * Andy's game. Cole stands on a sliding platform; answer a times-table
 * question and he hops straight up. He does not steer — the only steering
 * is WHEN you answer, because the platform above is sliding too and he
 * lands where it happens to be. So it is recall under light pressure plus
 * a bit of timing, which is a different skill from the four games already
 * here: Sprint tests speed, Ratio Rush the centre's own maths, Mathle and
 * Connections are logic with no clock at all.
 *
 * WHAT CHANGED COMING IN, and why:
 *
 *   SEEDED. The original drew every platform and every question from
 *   Math.random(). A ranked run has a gift card at the end of it, so
 *   everyone at the centre gets the same ladder and the same questions in
 *   the same order, and nobody can reroll a bad one. Same rule as Mathle
 *   and Connections. (Dust puffs and somersaults stay random — they are
 *   decoration and they do not decide anything.)
 *
 *   SCORED ON PLATFORMS, NOT HEIGHT. The original counts pixels climbed,
 *   and the gap between platforms is randomised, so two identical runs on
 *   different days would be worth different amounts — fine for a personal
 *   best, not for a board that adds days together. A platform is a
 *   platform: one correct answer, well timed.
 *
 *   ONE TIMES TABLE IS NOT THE SAME GAME. The original lets you pick the
 *   2× table, which against a prize is just an easier game for the same
 *   points. A RANKED run is always all tables; the picker is practice.
 *
 * PURE MODULE — no React, no canvas, no clock of its own.
 */

import { makeRng, seedFrom } from '../ratioGames';

/** The playfield, in game units. The canvas scales to this. */
export const FIELD = { W: 400, H: 640 };

/**
 * Physics, lifted from the original and left alone. Gravity and jump are
 * what make the hop feel the way it does; changing them changes how far a
 * hop reaches, which changes the game.
 */
export const PHYSICS = {
  GRAVITY: 1800,
  JUMP: -830,
  SPRING: -1350,
  CROUCH: 0.13,          // seconds of anticipation before the launch
  PLATFORM_SPEED: 1.2,   // overall multiplier on how fast platforms slide
  PLAYER_R: 20,
  PLATFORM_H: 14,
  START_Y: FIELD.H - 80,
};

/** What a ranked run always plays. See the note above. */
export const RANKED_TABLE = 'all';

/** The picker, for practice. */
export const TABLES = ['all', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function isTable(value) {
  return value === 'all' || (Number.isInteger(value) && value >= 1 && value <= 12);
}

const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/**
 * How far into the climb we are, 0 → 1.
 *
 * The original ramped on pixels climbed, which cannot be known ahead of
 * time. One platform is one hop, so the index says the same thing and
 * says it while the ladder is still being built.
 */
function ramp(index) {
  return Math.min(1, index / 60);
}

/**
 * Platform `index` of the ladder, counting the one Cole starts on as 0.
 *
 * Gaps widen and platforms narrow and slide faster as you climb, which is
 * what ends a run: eventually the thing you are aiming at is small and
 * moving and a long way up.
 */
function platform(rng, index, prevY) {
  const d = ramp(index);
  const gap = 58 + d * 62 + rng() * (20 + d * 20);
  const w = 78 - d * 22;
  const speed = (70 + d * 150 + rng() * 50) * PHYSICS.PLATFORM_SPEED;
  return {
    n: index,
    y: prevY - gap,
    w,
    h: PHYSICS.PLATFORM_H,
    x: rng() * (FIELD.W - w),
    vx: rng() < 0.5 ? speed : -speed,
    spring: rng() < 0.07,
  };
}

/**
 * The whole ladder, `count` platforms up from the ground.
 *
 * Generated in one pass from one seeded stream so platform N is the same
 * platform for everybody, whatever order a particular run happens to ask
 * for them in. Index 0 is the one Cole is standing on when the game
 * starts; it is deliberately wide, slow and centred, so nobody is killed
 * by the first slide before they have read a question.
 */
export function courseFor(seed, count = 400) {
  const rng = makeRng(seedFrom(`${seed}|course`));
  const first = {
    n: 0,
    y: PHYSICS.START_Y,
    w: 80,
    h: PHYSICS.PLATFORM_H,
    x: FIELD.W / 2 - 40,
    vx: 60 * PHYSICS.PLATFORM_SPEED,
    spring: false,
  };
  const out = [first];
  for (let i = 1; i < count; i += 1) out.push(platform(rng, i, out[i - 1].y));
  return out;
}

/**
 * One question, and three answers to choose between.
 *
 * The wrong ones are NEIGHBOURING FACTS — 7×8 offers 48 and 63, not 12
 * and 99 — because a wrong answer you would never have picked teaches
 * nothing and turns the game into tapping the only plausible number.
 */
export function questionFor(rng, table, index) {
  let a;
  let b;
  if (table === 'all') {
    // All tables, getting bigger as the climb goes on: up to 9s, then
    // 10s, then 12s.
    const top = index < 12 ? 9 : index < 25 ? 10 : 12;
    a = int(rng, 2, top);
    b = int(rng, 2, top);
  } else {
    a = table;
    b = int(rng, 1, 12);
    if (rng() < 0.5) { const t = a; a = b; b = t; }
  }
  const answer = a * b;
  const near = [...new Set(
    [a * (b + 1), a * (b - 1), (a + 1) * b, (a - 1) * b,
      answer + 1, answer - 1, answer + 2, answer - 2, answer + 10]
      .filter(n => n > 0 && n !== answer),
  )];
  // Shuffle in place with the same stream, so the decoys and their
  // positions are part of the day's puzzle rather than a second roll.
  for (let i = near.length - 1; i > 0; i -= 1) {
    const j = int(rng, 0, i);
    const t = near[i]; near[i] = near[j]; near[j] = t;
  }
  const options = [answer, ...near.slice(0, 2)];
  for (let i = options.length - 1; i > 0; i -= 1) {
    const j = int(rng, 0, i);
    const t = options[i]; options[i] = options[j]; options[j] = t;
  }
  return { a, b, answer, options };
}

/**
 * A run's worth of questions, in order.
 *
 * Pre-rolled rather than drawn as you go, for the same reason the ladder
 * is: two people playing the same ranked day answer the same questions in
 * the same order. A wrong answer costs you the NEXT question in the list
 * rather than a reroll of this one.
 */
export function questionsFor(seed, table = RANKED_TABLE, count = 300) {
  const rng = makeRng(seedFrom(`${seed}|q|${table}`));
  return Array.from({ length: count }, (_, i) => questionFor(rng, table, i));
}

/** "7 × 8 = 56", for the line shown after a miss. */
export function explain(q) {
  return `${q.a} × ${q.b} = ${q.answer}`;
}

/** What the picker says. */
export function tableLabel(table) {
  return table === 'all' ? 'All tables' : `${table} times table`;
}
