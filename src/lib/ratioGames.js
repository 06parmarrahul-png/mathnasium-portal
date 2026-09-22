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

/**
 * Is Ratio Games switched on at this centre?
 *
 * OFF UNTIL SOMEBODY TURNS IT ON, per centre. A feature that appears in
 * everyone's sidebar because a deploy landed is the thing the new-look
 * home was careful not to do; this is the same courtesy one level up. It
 * also means the code can ship well before the centre is ready to run a
 * competition — which is exactly why the switch exists.
 *
 * The switch is `gamesEnabled` on centers/{id}/config/main, and the
 * Firestore rules let only the OWNER and Enterprise change it: everyone
 * else who can write the centre config (the Admin Assistant, a Director, a
 * Manager, a role granted centre.settings) can save every other setting
 * without being able to start or stop a contest with a prize attached.
 *
 * Turning it off hides the page, the sidebar link and the home card. It
 * deletes nothing — scores keep sitting where they are, and the board is
 * whole again the moment it comes back on.
 */
export function gamesEnabled(centerConfig) {
  return centerConfig?.gamesEnabled === true;
}

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
 * The registry.
 *
 * Every game scores itself, because "better" means something different in
 * each: more correct answers in Sprint, FEWER guesses in Mathle, fewer
 * mistakes in Connections. What they share is the scale — 0 to 120, with
 * 100 for a good run by a competent player — so a minute of Sprint and
 * four minutes of Connections are worth about the same, and no single
 * game can carry a month on its own.
 *
 * `score(outcome)` takes that game's own outcome object and returns the
 * points. `resultOf(outcome)` picks the one integer worth storing and
 * showing on the board — the Firestore rules require `result` to be a
 * non-negative int, and one number per run is all the board needs.
 */
export const GAMES = {
  sprint60: {
    id: 'sprint60',
    name: 'Sprint 60',
    blurb: 'Sixty seconds of mental arithmetic. It speeds up as your streak grows.',
    kind: 'timed',
    seconds: 60,
    par: 18,
    unit: 'correct',
    minutes: 1,
    // Linear against par: 18 correct is a hundred points.
    score: ({ correct = 0 } = {}) => clampPoints((100 * correct) / 18),
    resultOf: ({ correct = 0 } = {}) => Math.max(0, Math.round(correct)),
    summary: ({ correct = 0 } = {}) => `${correct} correct`,
  },

  mathle: {
    id: 'mathle',
    name: 'Mathle',
    blurb: 'Find the hidden equation in six tries. Everyone here gets the same one.',
    kind: 'daily',
    par: 4,
    unit: 'guesses',
    minutes: 3,
    // Fewer guesses is better, and failing still beats not playing —
    // a zero for turning up is how you teach people not to turn up.
    score: ({ solved = false, guesses = 6 } = {}) =>
      (solved ? clampPoints(130 - 10 * guesses) : 20),
    resultOf: ({ solved = false, guesses = 0 } = {}) => (solved ? Math.max(1, guesses) : 0),
    summary: ({ solved, guesses } = {}) =>
      (solved ? `solved in ${guesses}` : 'not solved'),
  },

  connections: {
    id: 'connections',
    name: 'Connections',
    blurb: 'Sixteen numbers, four sets of four. The overlaps are the puzzle.',
    kind: 'daily',
    par: 4,
    unit: 'groups',
    minutes: 4,
    // Twenty-five a group, five off per mistake, and twenty for a clean
    // sweep — so a perfect round is 120 and a scrappy four is still worth
    // more than giving up at two.
    score: ({ groups = 0, mistakes = 0 } = {}) =>
      clampPoints((25 * groups) - (5 * mistakes) + (groups === 4 && mistakes === 0 ? 20 : 0)),
    resultOf: ({ groups = 0 } = {}) => Math.max(0, Math.min(4, Math.round(groups))),
    summary: ({ groups = 0, mistakes = 0 } = {}) =>
      `${groups} of 4${mistakes > 0 ? `, ${mistakes} wrong` : ' clean'}`,
  },

  ratioRush: {
    id: 'ratioRush',
    name: 'Ratio Rush',
    blurb: 'A half hour of bookings appears. How many instructors does the floor need, at 1:4?',
    kind: 'timed',
    seconds: 60,
    par: 8,
    unit: 'right',
    minutes: 2,
    // Ten rounds; par is eight right. It is the centre's own maths, asked
    // at the floor of 1:4 — the ratio you can divide by in your head —
    // so the game teaches the thing it tests.
    score: ({ correct = 0 } = {}) => clampPoints((100 * correct) / 8),
    resultOf: ({ correct = 0 } = {}) => Math.max(0, Math.round(correct)),
    summary: ({ correct = 0, asked = 10 } = {}) => `${correct} of ${asked} right`,
  },
};

/** Every game, in the order the page lists them. */
export const GAME_LIST = Object.values(GAMES);

/**
 * Today's pick, cycling through the roster by date.
 *
 * It is a SUGGESTION, not a gate: every game stays playable every day,
 * each with its own one ranked run. Locking games to weekdays would mean
 * somebody who only works Tuesdays never plays anything but Connections.
 */
export const ROTATION = ['mathle', 'connections', 'ratioRush', 'sprint60'];

export function featuredGameId(date) {
  const key = typeof date === 'string' ? date : dayKey(date);
  const [y, m, d] = key.split('-').map(Number);
  if (!Number.isFinite(y)) return ROTATION[0];
  // Days since an arbitrary fixed date, so the cycle is stable and does
  // not restart at the turn of a month or a year.
  const days = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  return ROTATION[((days % ROTATION.length) + ROTATION.length) % ROTATION.length];
}

/**
 * A non-negative integer, or zero.
 *
 * Every game's `resultOf` goes through this on the way to the row: one of
 * them returning NaN (Math.round('lots')) would be a value Firestore
 * cannot store and the rules would refuse anyway, and the run would be
 * lost at the last step with nothing to show for it.
 */
export function clampResult(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v);
}

/** Round and clamp into the range the Firestore rules will accept. */
export function clampPoints(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_POINTS, Math.round(v));
}

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
 * EVERY ANSWER IS A WHOLE NUMBER. The box takes digits and nothing else,
 * so a question whose answer isn't whole is a question that cannot be
 * answered — see the percentage branch below, which is where that went
 * wrong. Divisions are built from their own product, percentages from a
 * number the percentage divides exactly.
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
    // The PERCENTAGE is drawn first, then a number it divides exactly.
    //
    // This used to draw any even number and round the answer, on the
    // grounds that "even, so 25% lands whole" — which isn't true: 25% of
    // 158 is 39.5. So the game asked "10% of 158", whose answer is 15.8,
    // and accepted only 16. There was no way to be right on purpose, and
    // the box takes whole numbers only, so there was no way to be right
    // at all. Every percentage question now comes out exact.
    const pct = [10, 20, 25, 50][pick(rng, 0, 3)];
    const step = { 10: 10, 20: 5, 25: 4, 50: 2 }[pct];
    const a = pick(rng, Math.ceil(40 / step), Math.floor(180 / step)) * step;
    return { text: `${pct}% of ${a}`, answer: (a * pct) / 100, level };
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
export function buildScoreRow({ uid, userName, centerId, gameId, date, outcome = {}, durationMs, seed }) {
  const game = gameById(gameId);
  return {
    uid,
    userName: userName || '',
    centerId,
    gameId,
    date: typeof date === 'string' ? date : dayKey(date),
    // One integer for the board, and the points the game worked out for
    // itself. Both are validated by the Firestore rules.
    result: game ? clampResult(game.resultOf(outcome)) : 0,
    points: game ? clampPoints(game.score(outcome)) : 0,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    seed: String(seed ?? ''),
    createdAt: new Date().toISOString(),
  };
}
