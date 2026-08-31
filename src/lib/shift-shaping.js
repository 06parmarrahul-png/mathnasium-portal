/**
 * shift-shaping.js — turn a day's demand curve into actual shift blocks.
 *
 * WHAT PROBLEM THIS SOLVES
 *   demand-staffing.js answers "how many people does this date need?".
 *   generateSchedule then picks WHO. But it gives everyone the same block:
 *   their availability clamped to instructional hours. On a day that runs
 *   3:00–7:00 with the rush at 3:00–4:30, that puts every instructor on the
 *   floor for four hours to cover a ninety-minute peak.
 *
 *   This module reshapes those shifts to follow the curve, so people can be
 *   staggered into the rush and out of the quiet tail.
 *
 * IT ASSIGNS NOBODY NEW
 *   generateSchedule has already decided who works today, weighing rank,
 *   fairness, sub-role balance and weekly caps. Re-deciding that here would
 *   fight it. This only adjusts the START and END of shifts for people who
 *   are already on the day, and it never drops anyone: someone the curve
 *   doesn't strictly need still gets the longest block they can cover,
 *   because over-staffing is cheap — an idle instructor does a training
 *   module — and un-scheduling a person who was told they're working is not.
 *
 * HOW THE BLOCKS ARE DERIVED
 *   Layer decomposition. Layer k is every slot needing at least k people; each
 *   contiguous run in that layer is one block. Stacking the layers reproduces
 *   the curve using the fewest contiguous blocks.
 *
 *     3:00 3:30 4:00 4:30 5:00 5:30 6:00 6:30
 *       4    4    3    3    3    2    2    2      required
 *     └──────────── layer 1: 3:00–7:00 ────────┘
 *     └──────────── layer 2: 3:00–7:00 ────────┘
 *     └────── layer 3: 3:00–6:00 ──────┘
 *     └ layer 4: 3:00–4:00 ┘  → widened to the 2h minimum
 *
 *   A run shorter than the legal minimum is widened rather than dropped. You
 *   cannot roster a one-hour shift, and the choice between "fill the trough"
 *   and "fragment the day" is settled by the minimum shift length itself —
 *   no hand-tuned threshold needed.
 */

import { closeValleys } from './demand-staffing';

const SLOT_MIN = 30;

/** 'HH:MM' → minutes since midnight. Null when unparseable. */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** minutes since midnight → 'HH:MM'. */
export function toHHMM(mins) {
  const m = Math.max(0, Math.round(mins));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Decompose a required-per-slot curve into contiguous blocks.
 *
 * @param {number[]} required   instructors needed per slot
 * @param {string[]} slotKeys   'HH:MM' per slot, same length as `required`
 * @param {number} minShiftSlots  legal minimum shift, in slots
 * @returns {Array<{startMin,endMin,start,end,layer,widened,slots}>}
 */
export function blocksFromCurve(required, slotKeys, minShiftSlots = 4) {
  const n = Math.min(required.length, slotKeys.length);
  if (n === 0) return [];

  // Close short valleys HERE rather than trusting the caller to have done it.
  // Without this, a single dipped slot splits a layer into two runs — which
  // is precisely "send them home at 4:30 and call someone back at 5:00", the
  // thing this module exists to prevent. Closing is safe to re-apply: it only
  // ever raises a value, and an already-closed curve is unchanged.
  const curve = closeValleys(required.slice(0, n), minShiftSlots);

  const dayStart = toMinutes(slotKeys[0]);
  const dayEnd = toMinutes(slotKeys[n - 1]) + SLOT_MIN;
  const peak = Math.max(0, ...curve);
  const out = [];

  for (let layer = 1; layer <= peak; layer++) {
    let runStart = null;
    for (let i = 0; i <= n; i++) {
      const active = i < n && curve[i] >= layer;
      if (active && runStart === null) runStart = i;
      if (!active && runStart !== null) {
        out.push(makeBlock(runStart, i, layer, slotKeys, dayStart, dayEnd, minShiftSlots));
        runStart = null;
      }
    }
  }

  // Longest first within a start time, so the widest blocks are handed to the
  // highest-ranked people rather than whoever happens to sort first.
  return out.sort(
    (a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin)
  );
}

function makeBlock(startIdx, endIdx, layer, slotKeys, dayStart, dayEnd, minShiftSlots) {
  let s = startIdx;
  let e = endIdx;
  let widened = false;
  // Stretch a too-short run to the legal minimum. Extend later first (the
  // instructor stays on past the rush), then earlier if the day runs out.
  while (e - s < minShiftSlots) {
    if (e < slotKeys.length) { e += 1; widened = true; }
    else if (s > 0) { s -= 1; widened = true; }
    else break; // the day itself is shorter than one legal shift
  }
  const startMin = toMinutes(slotKeys[s]);
  const endMin = Math.min(dayEnd, startMin + (e - s) * SLOT_MIN);
  return {
    layer,
    widened,
    slots: e - s,
    startMin,
    endMin,
    start: toHHMM(startMin),
    end: toHHMM(endMin),
    hours: (endMin - startMin) / 60,
    _dayStart: dayStart,
  };
}

/** Can this person cover [startMin, endMin) in full? */
function covers(person, startMin, endMin) {
  return person.availStart <= startMin && person.availEnd >= endMin;
}

/**
 * The largest sub-window of a block that a person can actually cover, or null
 * if the overlap is shorter than the legal minimum.
 */
function bestOverlap(person, block, minMinutes) {
  const start = Math.max(person.availStart, block.startMin);
  const end = Math.min(person.availEnd, block.endMin);
  return end - start >= minMinutes ? { start, end } : null;
}

/**
 * Shape one day's shifts around its demand curve.
 *
 * @param {Object} params
 * @param {number[]} params.required   instructors needed per slot (raw is fine —
 *        short valleys are closed internally)
 * @param {string[]} params.slotKeys   'HH:MM' per slot
 * @param {Array} params.people        who is already scheduled today:
 *        { name, rank, hoursSoFar, availStart, availEnd, isHost }
 *        rank: lower wins (lead 0, instructor 1). availStart/availEnd in minutes.
 * @param {number} params.minShiftHours  legal minimum (default 2)
 * @returns {{ shifts: Object, blocks: Array, uncovered: Array, notes: Array }}
 */
export function shapeShifts({ required, slotKeys, people = [], minShiftHours = 2 }) {
  const notes = [];
  const shifts = {};
  const uncovered = [];

  if (!slotKeys.length || !people.length) {
    return { shifts, blocks: [], uncovered, notes };
  }

  const minMinutes = minShiftHours * 60;
  const minShiftSlots = Math.max(1, Math.round(minMinutes / SLOT_MIN));
  const dayStart = toMinutes(slotKeys[0]);
  const dayEnd = toMinutes(slotKeys[slotKeys.length - 1]) + SLOT_MIN;

  // The host runs the desk for the whole day and sits outside the rotation,
  // so they're never spent on a coverage block.
  const hosts = people.filter(p => p.isHost);
  for (const h of hosts) {
    const start = Math.max(h.availStart, dayStart);
    const end = Math.min(h.availEnd, dayEnd);
    shifts[h.name] = { start: toHHMM(start), end: toHHMM(end), role: 'host', block: null };
    if (end - start < dayEnd - dayStart) {
      notes.push(`${h.name} hosts ${toHHMM(start)}–${toHHMM(end)}, not the full day — their availability is shorter.`);
    }
  }

  const pool = people.filter(p => !p.isHost);
  const blocks = blocksFromCurve(required, slotKeys, minShiftSlots);

  // Leads before instructors; within a rank, fewest hours first, so the
  // rotation stays fair. Name last purely so runs are deterministic.
  const byRank = (a, b) =>
    (a.rank - b.rank) || (a.hoursSoFar - b.hoursSoFar) || a.name.localeCompare(b.name);

  const unplaced = [...pool].sort(byRank);
  const placed = new Set();

  for (const block of blocks) {
    const candidate = unplaced
      .filter(p => !placed.has(p.name) && covers(p, block.startMin, block.endMin))
      .sort(byRank)[0];

    if (!candidate) {
      uncovered.push({
        start: block.start, end: block.end, layer: block.layer,
        reason: describeGap(unplaced, placed, block),
      });
      continue;
    }

    placed.add(candidate.name);
    shifts[candidate.name] = {
      start: block.start, end: block.end, role: 'coverage', block: block.layer,
    };
    if (block.widened) {
      notes.push(`${candidate.name}'s block was stretched to ${block.hours}h to meet the ${minShiftHours}-hour minimum.`);
    }
  }

  // Anyone the curve didn't need is still working today — generateSchedule
  // already told them so. Give them the longest stretch they can cover rather
  // than dropping them; the surplus is training-module time.
  for (const p of unplaced) {
    if (placed.has(p.name)) continue;
    const span = bestOverlap(p, { startMin: dayStart, endMin: dayEnd }, minMinutes);
    if (!span) {
      notes.push(`${p.name} is on today but can't cover a full ${minShiftHours}-hour block within opening hours — set their shift by hand.`);
      continue;
    }
    shifts[p.name] = { start: toHHMM(span.start), end: toHHMM(span.end), role: 'surplus', block: null };
  }

  return { shifts, blocks, uncovered, notes };
}

/** Say why a block went unfilled — "uncovered" on its own tells a manager nothing. */
function describeGap(pool, placed, block) {
  let busy = 0;
  let tooShort = 0;
  for (const p of pool) {
    if (placed.has(p.name)) { busy++; continue; }
    if (!covers(p, block.startMin, block.endMin)) tooShort++;
  }
  const parts = [];
  if (busy) parts.push(`${busy} already on a block`);
  if (tooShort) parts.push(`${tooShort} not available ${block.start}–${block.end}`);
  return parts.length ? parts.join(', ') : 'nobody scheduled today can cover it';
}

/** Format shaped shifts back into the 'HH:MM - HH:MM' strings the app stores. */
export function toShiftTimeStrings(shifts) {
  const out = {};
  for (const [name, s] of Object.entries(shifts || {})) {
    out[name] = `${s.start} - ${s.end}`;
  }
  return out;
}
