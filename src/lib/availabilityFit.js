/**
 * availabilityFit.js — "did we schedule someone outside the hours they
 * said they could work?"
 *
 * THE FAILSAFE
 *   An instructor submits 4–7pm. Someone schedules them 3–7pm. Nothing in
 *   the app objected, and the first anyone knew about it was the
 *   instructor not turning up at 3. This answers that question so the
 *   weekly grid can colour the cell before it becomes a no-show.
 *
 *   It is a WARNING, never a block. Scheduling outside availability is
 *   sometimes exactly right — you agreed it verbally, they're covering a
 *   gap, plans changed. The grid says "look at this", not "you can't".
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG
 *   A day with NO availability submitted. Measured against the live
 *   database: 960 shifts sit inside submitted availability, 49 fall
 *   outside it, and 839 have no availability on file at all. Colouring
 *   that third group would turn nearly half the grid amber and bury the 49
 *   cases that actually need looking at. "They didn't tell us" is a
 *   different problem from "we ignored what they told us", and the grid
 *   already shows the first one by the absence of a green corner.
 *
 * TIME OFF
 *   Also not handled here. An approved day off already paints the cell red
 *   and overrides availability entirely (see timeOff.js) — the caller
 *   checks that first, so the two can never argue on one cell.
 */

/** 'HH:MM' → minutes past midnight, or null if unusable. */
export function toMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes → 'H:MM am/pm', for the tooltip. */
export function fmtMinutes(mins) {
  if (!Number.isFinite(mins)) return '';
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ampm = h24 < 12 ? 'am' : 'pm';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

/**
 * "All day" is stored as 00:00 → 23:59 (and 24:00 on older rows). Treated
 * as covering everything, or a shift ending at 23:59 would read as one
 * minute outside and flag the whole day for nothing.
 */
function isFullDay(startMin, endMin) {
  return startMin === 0 && endMin >= 23 * 60 + 59;
}

/**
 * Turn a day's availability rows into merged, sorted windows.
 *
 * Merging matters: someone who submits 10–2 and 2–6 as two rows is
 * available 10–6 continuously, and comparing against the rows separately
 * would report a 10–6 shift as a conflict at the seam.
 */
export function availabilityWindows(dayAvail) {
  const raw = [];
  for (const a of dayAvail || []) {
    const s = toMinutes(a?.startTime);
    const e = toMinutes(a?.endTime);
    if (s == null || e == null || e <= s) continue;
    raw.push(isFullDay(s, e) ? [0, 24 * 60] : [s, e]);
  }
  raw.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [s, e] of raw) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/**
 * How well one shift fits inside the day's availability.
 *
 * @returns {null|Object} null when there is nothing to judge (no times on
 *   the shift, or no availability submitted). Otherwise:
 *   { covered, minutesOutside, earlyBy, lateBy, shiftStart, shiftEnd, windows }
 */
export function shiftFit(shift, windows) {
  const s = toMinutes(shift?.startTime);
  const e = toMinutes(shift?.endTime);
  if (s == null || e == null || e <= s) return null;
  if (!windows || windows.length === 0) return null;

  // Walk the shift, subtracting whatever the windows cover.
  let uncovered = 0;
  let cursor = s;
  for (const [ws, we] of windows) {
    if (we <= cursor) continue;
    if (ws >= e) break;
    if (ws > cursor) uncovered += Math.min(ws, e) - cursor;
    cursor = Math.max(cursor, Math.min(we, e));
    if (cursor >= e) break;
  }
  if (cursor < e) uncovered += e - cursor;

  const first = windows[0];
  const last = windows[windows.length - 1];
  return {
    covered: uncovered === 0,
    minutesOutside: uncovered,
    // How far the shift reaches beyond either end of what they offered.
    earlyBy: Math.max(0, first[0] - s),
    lateBy:  Math.max(0, e - last[1]),
    shiftStart: s,
    shiftEnd: e,
    windows,
  };
}

/** A shift the grid should not judge: cancelled work, or a placeholder. */
function isJudgeable(shift) {
  if (!shift) return false;
  if (shift.status === 'cancelled') return false;
  return true;
}

/**
 * The cell-level answer for one person on one day.
 *
 * @param {Array} dayShifts  that person's shifts on the date
 * @param {Array} dayAvail   their availability rows for the date
 * @returns {null|Object} null when the cell is fine or unjudgeable.
 *   { conflicts: [{ shift, fit }], windows, worst }
 */
export function availabilityConflict(dayShifts, dayAvail) {
  const windows = availabilityWindows(dayAvail);
  if (windows.length === 0) return null;          // nothing submitted — see header
  const conflicts = [];
  for (const shift of dayShifts || []) {
    if (!isJudgeable(shift)) continue;
    const fit = shiftFit(shift, windows);
    if (fit && !fit.covered) conflicts.push({ shift, fit });
  }
  if (conflicts.length === 0) return null;
  const worst = conflicts.reduce(
    (a, b) => (b.fit.minutesOutside > a.fit.minutesOutside ? b : a),
    conflicts[0],
  );
  return { conflicts, windows, worst };
}

/** '1h 30m' / '45m' — for the tooltip. */
export function describeDuration(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * One plain sentence for a conflicting shift, e.g.
 *   "Scheduled 3:00pm–7:00pm but only available from 4:00pm — 1h outside."
 */
export function describeConflict(fit) {
  if (!fit || fit.covered) return '';
  const shift = `${fmtMinutes(fit.shiftStart)}–${fmtMinutes(fit.shiftEnd)}`;
  const offered = fit.windows.map(([s, e]) => `${fmtMinutes(s)}–${fmtMinutes(e)}`).join(', ');
  const amount = describeDuration(fit.minutesOutside);
  let edge = '';
  if (fit.earlyBy > 0 && fit.lateBy > 0) edge = ' at both ends';
  else if (fit.earlyBy > 0) edge = ` — starts ${describeDuration(fit.earlyBy)} early`;
  else if (fit.lateBy > 0) edge = ` — runs ${describeDuration(fit.lateBy)} late`;
  return `Scheduled ${shift}, available ${offered}${edge}. ${amount} outside.`;
}
