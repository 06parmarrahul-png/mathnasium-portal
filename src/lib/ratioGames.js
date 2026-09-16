/**
 * ratioGames.js — the scoring and puzzle rules behind Ratio Games.
 *
 * WHAT THIS IS
 *   Staff play a short maths game, a score row is written, and a monthly
 *   leaderboard decides who gets the gift card. This module is everything
 *   that has to be the same on every screen: what a question looks like,
 *   what a run is worth, and how a month adds up.
 *
 * EVERYONE PLAYS. There is no eligibility check in here and the route has
 * no permission on it — volunteers and trainees included, who otherwise
 * get the barest portal in the app. Who is eligible for the PRIZE is a
 * judgement the centre makes when it hands the card over, not something
 * the code decides; keeping it out of the code means it can change without
 * a deploy.
 *
 * THE THREE CAPS, AND WHY EACH EXISTS
 *   best 3 games a day    — otherwise the winner is whoever had the
 *                           quietest shift, not the sharpest head.
 *   best 12 days a month  — someone working two shifts a week can still
 *                           field a full card. Without it the board just
 *                           ranks hours worked, which would be unfair to
 *                           part-timers and would look it.
 *   streak bonus max 60   — enough to bring people back tomorrow, never
 *                           enough to decide the month on its own.
 *
 * SEEDED, NOT RANDOM. A daily puzzle is drawn from (date + centre), so
 * everyone at the centre gets the same one, nobody can reroll until they
 * like it, and a test can ask for a specific puzzle. Math.random() appears
 * nowhere in this file.
 *
 * PURE MODULE — no Firebase, no React, no clock of its own. Same
 * discipline as scheduler.js and coverageModel.js.
 */

/** The ceiling on a single run. The Firestore rules refuse anything above it. */
export const MAX_POINTS = 120;

/** Games count for at most this many runs a day, best first. */
export const GAMES_PER_DAY = 3;

/** A month counts your best this-many days. */
export const DAYS_PER_MONTH = 12;

export const STREAK_STEP = 3;
export const STREAK_BONUS = 10;
export const MAX_STREAK_BONUS = 60;

/**
 * The registry. `par` is a good run by a competent player — points are
 * measured against it, so a minute of Sprint and ten minutes of
 * Cross-number end up worth about the same.
 */
export const GAMES = {
  sprint60: {
    id: 'sprint60',
    name: 'Sprint 60',
    blurb: 'Sixty seconds of mental arithmetic. It speeds up as your streak grows.',
    seconds: 60,
    par: 18,
    unit: 'correct',
  },
};

export function gameById(id) {
  return GAMES[id] || null;
}

// ─── Dates ───────────────────────────────────────────────────────────────
// Centre-local wall clock throughout. `new Date('2026-09-17')` is the 16th
// in Pacific, so dates are built from parts and parsed at local noon —
// the same trap centreEvents.js and coverageModel.js document.

/** 'YYYY-MM-DD' for a Date, in local time. */
export function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM' for a Date or a 'YYYY-MM-DD' string. */
export function monthKey(date) {
  return (typeof date === 'string' ? date : dayKey(date)).slice(0, 7);
}

/** Every day in a month that has happened by `today`, oldest first. */
export function daysElapsed(month, today) {
  const [y, m] = month.split('-').map(Number);
  const end = new Date(y, m, 0).getDate();          // day 0 of next month
  const todayKey = dayKey(today);
  const out = [];
  for (let d = 1; d <= end; d += 1) {
    const key = `${month}-${String(d).padStart(2, '0')}`;
    if (key > todayKey) break;
    out.push(key);
  }
  return out;
}

/**
 * The score document's id, and the reason one run a day is enforceable.
 *
 * The id carries the person, the game and the date, and the rules only
 * allow CREATE — so a second run hits a document that already exists and
 * is refused. The rules also check the id matches the fields inside, or a
 * second run could simply be filed under a different name.
 */
export function scoreDocId(uid, gameId, date) {
  return `${uid}_${gameId}_${typeof date === 'string' ? date : dayKey(date)}`;
}

// ─── Scoring ─────────────────────────────────────────────────────────────

/**
 * What one run is worth: a percentage of par, capped.
 *
 * The cap is what stops a forged row being worth a whole month, and the
 * Firestore rules enforce the same number — a row above it never lands.
 */
export function pointsFor(result, par) {
  const r = Number(result);
  const p = Number(par);
  if (!Number.isFinite(r) || !Number.isFinite(p) || p <= 0 || r <= 0) return 0;
  return Math.min(MAX_POINTS, Math.round((100 * r) / p));
}

/** Points for one day: the best few runs, not all of them. */
export function dayTotal(scores) {
  return [...scores]
    .map(s => Number(s?.points) || 0)
    .sort((a, b) => b - a)
    .slice(0, GAMES_PER_DAY)
    .reduce((sum, n) => sum + n, 0);
}

/**
 * Runs of consecutive days played, longest first. A run is calendar days
 * in a row — not shifts worked, because the centre is closed on Sundays
 * and nobody should lose a streak to that.
 */
export function playedRuns(dates) {
  const sorted = [...new Set(dates)].sort();
  const runs = [];
  let run = 0;
  let prev = null;
  for (const key of sorted) {
    if (prev && nextDay(prev) === key) run += 1;
    else run = 1;
    runs.push(run);
    prev = key;
  }
  // Collapse the running tally into the length of each finished run.
  const lengths = [];
  for (let i = 0; i < runs.length; i += 1) {
    if (i === runs.length - 1 || runs[i + 1] === 1) lengths.push(runs[i]);
  }
  return lengths.sort((a, b) => b - a);
}

/** The day after a 'YYYY-MM-DD', as a 'YYYY-MM-DD'. */
export function nextDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  date.setDate(date.getDate() + 1);
  return dayKey(date);
}

/** Bonus for coming back: every three days in a row, up to a ceiling. */
export function streakBonus(dates) {
  const total = playedRuns(dates).reduce((sum, len) => sum + Math.floor(len / STREAK_STEP), 0);
  return Math.min(MAX_STREAK_BONUS, total * STREAK_BONUS);
}

/** The longest run of consecutive days, for the board's Streak column. */
export function longestStreak(dates) {
  return playedRuns(dates)[0] || 0;
}

/**
 * The month's board.
 *
 * @param {Array} scores rows of { uid, userName, gameId, date, points }
 * @returns {Array} one entry per player, highest points first
 *
 * Ties break on fewer runs played — sharper, not longer. Somebody who hit
 * 900 in eight days beats somebody who needed twelve to get there.
 */
export function standings(scores) {
  const byUser = new Map();
  for (const s of scores || []) {
    if (!s?.uid) continue;
    if (!byUser.has(s.uid)) byUser.set(s.uid, { uid: s.uid, userName: s.userName || s.uid, rows: [] });
    const entry = byUser.get(s.uid);
    entry.rows.push(s);
    // The most recent name wins — people do get renamed, and the board
    // should not keep calling them the old thing.
    if (s.userName) entry.userName = s.userName;
  }

  const out = [];
  for (const entry of byUser.values()) {
    const byDay = new Map();
    for (const row of entry.rows) {
      if (!row.date) continue;
      if (!byDay.has(row.date)) byDay.set(row.date, []);
      byDay.get(row.date).push(row);
    }
    const dayTotals = [...byDay.entries()]
      .map(([date, rows]) => ({ date, points: dayTotal(rows) }))
      .sort((a, b) => b.points - a.points);
    const counted = dayTotals.slice(0, DAYS_PER_MONTH);
    const base = counted.reduce((sum, d) => sum + d.points, 0);
    const bonus = streakBonus([...byDay.keys()]);
    const best = [...entry.rows].sort((a, b) => (b.points || 0) - (a.points || 0))[0] || null;
    out.push({
      uid: entry.uid,
      userName: entry.userName,
      points: base + bonus,
      base,
      bonus,
      daysPlayed: byDay.size,
      daysCounted: counted.length,
      runs: entry.rows.length,
      streak: longestStreak([...byDay.keys()]),
      bestPoints: best ? best.points : 0,
      bestGameId: best ? best.gameId : null,
    });
  }

  return out.sort((a, b) => (b.points - a.points) || (a.runs - b.runs) || a.userName.localeCompare(b.userName));
}

/** Where one person sits, 1-based, or null if they haven't played. */
export function rankOf(board, uid) {
  const at = board.findIndex(row => row.uid === uid);
  return at === -1 ? null : at + 1;
}

// ─── Seeded randomness ───────────────────────────────────────────────────

/** A 32-bit hash of a string, for turning 'langley|2026-09-16' into a seed. */
export function seedFrom(text) {
  let h = 2166136261;
  for (let i = 0; i < String(text).length; i += 1) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, and good enough for a maths quiz. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, lo, hi) => Math.floor(rng() * (hi - lo + 1)) + lo;

// ─── Sprint 60 ───────────────────────────────────────────────────────────

/**
 * Which rung of the ladder a streak has earned. Getting harder is the
 * reward for a streak: the points come from how many you answer, so an
 * easy run and a hard one are worth the same per question — the hard one
 * just proves more.
 */
export function sprintLevel(streak) {
  if (streak < 4) return 1;
  if (streak < 9) return 2;
  return 3;
}

/**
 * One question. Deterministic given the same rng state, so a run can be
 * replayed exactly — which is what makes the generator testable.
 *
 * Every answer is a whole number or a tidy decimal: this is played on a
 * phone between students, and "13.333…" is a typing puzzle, not a maths one.
 */
export function sprintQuestion(rng, streak = 0) {
  const level = sprintLevel(streak);
  if (level === 1) {
    const a = pick(rng, 12, 89);
    const b = pick(rng, 11, 79);
    if (rng() < 0.5) return { text: `${a} + ${b}`, answer: a + b, level };
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return { text: `${hi} − ${lo}`, answer: hi - lo, level };
  }
  if (level === 2) {
    const a = pick(rng, 3, 19);
    const b = pick(rng, 4, 12);
    if (rng() < 0.6) return { text: `${a} × ${b}`, answer: a * b, level };
    // Built from the product so it always divides exactly.
    return { text: `${a * b} ÷ ${b}`, answer: a, level };
  }
  const roll = rng();
  if (roll < 0.34) {
    const a = pick(rng, 2, 15);
    return { text: `${a}²`, answer: a * a, level };
  }
  if (roll < 0.67) {
    const a = pick(rng, 20, 90) * 2;               // even, so 25% lands whole
    const pct = [10, 20, 25, 50][pick(rng, 0, 3)];
    return { text: `${pct}% of ${a}`, answer: Math.round((a * pct) / 100), level };
  }
  const a = pick(rng, 6, 24);
  const b = pick(rng, 3, 12);
  const c = pick(rng, 2, 9);
  return { text: `${a} × ${b} − ${c}`, answer: a * b - c, level };
}

/**
 * The row a finished run writes. Shaped here rather than in the page so
 * the fields the Firestore rules check are decided in one place.
 */
export function buildScoreRow({ uid, userName, centerId, gameId, date, result, durationMs, seed }) {
  const game = gameById(gameId);
  return {
    uid,
    userName: userName || '',
    centerId,
    gameId,
    date: typeof date === 'string' ? date : dayKey(date),
    result: Math.max(0, Math.round(Number(result) || 0)),
    points: pointsFor(result, game ? game.par : 0),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    seed: String(seed ?? ''),
    createdAt: new Date().toISOString(),
  };
}
