/**
 * mathle.js — guess the hidden equation in six tries.
 *
 * Wordle's rules with an arithmetic alphabet: eight characters, digits and
 * + − × ÷ =, and every guess has to be an equation that is actually TRUE.
 * That last rule is the whole game — it turns each guess into a small
 * calculation rather than a spelling attempt.
 *
 * SEEDED, SO THE CENTRE SHARES A PUZZLE. The equation comes from the date
 * and the centre id, so everyone at Langley gets the same one, nobody can
 * reroll until they like it, and a test can ask for a specific day.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

import { makeRng, seedFrom } from '../ratioGames';

export const LENGTH = 8;
export const TRIES = 6;

/** Digits and operators, in keyboard order. */
export const KEYS = [
  ['1', '2', '3', '4', '5'],
  ['6', '7', '8', '9', '0'],
  ['+', '-', '*', '/', '='],
];

const isDigit = (c) => c >= '0' && c <= '9';

/**
 * Work out what an expression comes to.
 *
 * A tiny two-pass evaluator rather than eval(): × and ÷ first, then + and
 * −. Nothing here ever runs a player's string as code.
 *
 * Returns null when the expression is malformed — a trailing operator, a
 * division by zero, an empty side.
 */
export function evaluate(expr) {
  const text = String(expr || '');
  if (!text || !isDigit(text[0]) || !isDigit(text[text.length - 1])) return null;
  // Anything outside the alphabet is refused outright rather than skipped.
  // Matching tokens out of an unchecked string silently dropped whatever
  // it did not recognise, so "1;2" read as 1.
  if (!/^[0-9+\-*/]+$/.test(text)) return null;

  const tokens = text.match(/\d+|[+\-*/]/g);
  if (!tokens) return null;

  // Strict alternation: number, operator, number, … Two of either in a
  // row is malformed, and "12+*3" tokenises happily without this.
  for (let i = 0; i < tokens.length; i += 1) {
    const wantNumber = i % 2 === 0;
    if (isDigit(tokens[i][0]) !== wantNumber) return null;
  }
  if (tokens.length % 2 === 0) return null;   // must end on a number

  const values = [];
  const ops = [];
  for (const tk of tokens) {
    if (!isDigit(tk[0])) { ops.push(tk); continue; }
    let num = Number(tk);
    const last = ops[ops.length - 1];
    if (last === '*' || last === '/') {
      ops.pop();
      const prev = values.pop();
      if (last === '/' && num === 0) return null;
      num = last === '*' ? prev * num : prev / num;
    }
    values.push(num);
  }

  let total = values[0];
  let at = 1;
  for (const op of ops) {
    if (op === '+') total += values[at];
    else if (op === '-') total -= values[at];
    else return null;
    at += 1;
  }
  return Number.isFinite(total) ? total : null;
}

/**
 * Is this a legal guess? Returns null when it is, or the reason it isn't,
 * written the way it should be shown to the player.
 */
export function checkGuess(guess) {
  const text = String(guess || '');
  if (text.length !== LENGTH) {
    return `Eight characters — you have ${text.length}.`;
  }
  if (!/^[0-9+\-*/=]+$/.test(text)) {
    return 'Digits and + − × ÷ = only.';
  }
  const sides = text.split('=');
  if (sides.length !== 2 || !sides[0] || !sides[1]) {
    return 'One equals sign, with something on both sides.';
  }
  const left = evaluate(sides[0]);
  const right = evaluate(sides[1]);
  if (left === null || right === null) return "That isn't a well-formed equation.";
  if (Math.abs(left - right) > 1e-9) {
    return `It has to be true: ${sides[0]} isn't ${sides[1]}.`;
  }
  return null;
}

/**
 * Wordle's two-pass marking, which is the part everyone gets wrong.
 *
 * Exact matches are taken first and removed from the pool; only then are
 * the leftovers offered to "present". Without that, a guess of "11" against
 * an answer holding one 1 paints both amber.
 */
export function markGuess(guess, answer) {
  const marks = new Array(LENGTH).fill('absent');
  const pool = {};
  for (let i = 0; i < LENGTH; i += 1) {
    if (guess[i] === answer[i]) marks[i] = 'exact';
    else pool[answer[i]] = (pool[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < LENGTH; i += 1) {
    if (marks[i] === 'exact') continue;
    const ch = guess[i];
    if (pool[ch] > 0) { marks[i] = 'present'; pool[ch] -= 1; }
  }
  return marks;
}

/** The best mark each key has earned so far, for colouring the keyboard. */
export function keyboardMarks(rows) {
  const rank = { absent: 0, present: 1, exact: 2 };
  const out = {};
  for (const row of rows || []) {
    const marks = markGuess(row.guess, row.answer);
    for (let i = 0; i < LENGTH; i += 1) {
      const ch = row.guess[i];
      if (!out[ch] || rank[marks[i]] > rank[out[ch]]) out[ch] = marks[i];
    }
  }
  return out;
}

/**
 * The day's equation.
 *
 * Built rather than drawn from a list, so it never runs out and never
 * repeats a week later. Three shapes, all of which fit eight characters
 * exactly and all of which a person can do in their head:
 *
 *   ab + cd = efg     two-digit sum
 *   ab - cd = ef      two-digit difference
 *   a * bc = def      a times table past the ones people know cold
 *
 * The generator keeps drawing until one fits the width, which is cheaper
 * to read than the algebra required to guarantee it first time.
 */
export function dailyEquation(seed) {
  const rng = makeRng(seedFrom(seed));
  const pick = (lo, hi) => Math.floor(rng() * (hi - lo + 1)) + lo;

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const shape = Math.floor(rng() * 3);
    let text = '';
    if (shape === 0) {
      const a = pick(11, 89);
      const b = pick(11, 89);
      text = `${a}+${b}=${a + b}`;
    } else if (shape === 1) {
      const a = pick(30, 99);
      const b = pick(11, a - 10);
      text = `${a}-${b}=${a - b}`;
    } else {
      const a = pick(3, 9);
      const b = pick(11, 49);
      text = `${a}*${b}=${a * b}`;
    }
    if (text.length === LENGTH) return text;
  }
  // Every shape above can produce eight characters, so this is only ever
  // reached if the generator is changed badly. A real equation beats a
  // blank screen.
  return '12+34=46';
}
