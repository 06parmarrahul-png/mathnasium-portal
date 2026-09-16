/**
 * coverageModel.js — "how many floor staff do we WANT in each half hour,
 * and can we actually get them?"
 *
 * WHAT THIS ADDS
 *   Every staffing target in Ratio was a number for a WHOLE DAY:
 *   `perDate['2026-09-17'] > perDay['Thursday'] > minPerDay/maxPerDay`
 *   (see scheduler.js). A day is the wrong unit for the question the
 *   centre actually asks — 3:00 is quiet, 4:30 is the wall — so the
 *   Coverage view could only say "8 instructors today" and never "five at
 *   half four".
 *
 *   The model here is per WEEKDAY and per HALF HOUR:
 *
 *     centerConfig.coverageModel = {
 *       Monday: { '15:00': 4, '15:30': 5, '16:00': 5 },
 *       ...
 *     }
 *
 *   It is a WANT, not a promise, and nothing schedules from it — the
 *   auto-scheduler and the Staffing Board still size days from real
 *   bookings (demand-staffing.js). This is the line the coverage view
 *   measures against.
 *
 * THE TWO SUPPLY LINES
 *   available — people who told us they could work that slot
 *               (their availability rows), minus approved time off.
 *   scheduled — people actually rostered on it.
 *
 *   Both count only staff who fill a ratio slot, and they answer
 *   different questions. Short on `scheduled` with `available` to spare is
 *   a rota to fix this afternoon. Short on `available` is a hiring or
 *   availability problem, and no amount of rota-shuffling will touch it.
 *
 * WHO COUNTS
 *   For a SHIFT, the settled rule: countsInRatio() reads the shift's own
 *   `includedInRatio`. Never re-derived from the role — see ratioCount.js.
 *
 *   Availability has no shift to read, so it needs a person-level test,
 *   and countsOnFloor() is deliberately the same question one step
 *   earlier: "would a shift created for this person default to counting?"
 *   It goes through roleRatioDefault(), so a custom centre role with
 *   "Counts toward the ratio" off is excluded without this module knowing
 *   any role names. It is a DEFAULT, so a person whose real shift gets the
 *   toggle flipped can legitimately differ — that is the toggle working.
 *
 * PURE MODULE — no Firebase, no React, no clock of its own. Same
 * discipline as scheduler.js and demand-staffing.js.
 */

import { availabilityWindows, toMinutes } from './availabilityFit';
import { countsInRatio, defaultIncludedInRatio } from './ratioCount';
import { roleRatioDefault } from './roles';
import { isOffOn } from './timeOff';

export const SLOT_MIN = 30;

/** 'HH:MM' from minutes past midnight. */
export function toHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The half-hour slot keys a day spans, from a `{ start, end }` hours pair.
 * Callers pass the centre's INSTRUCTIONAL hours for that weekday (resolved
 * through resolveInstructionalHours, so a summer override is honoured) —
 * the teaching window is what coverage is about, not the full open day.
 */
export function slotKeysFor(hours) {
  const start = toMinutes(hours?.start);
  const end   = toMinutes(hours?.end);
  if (start == null || end == null || end <= start) return [];
  const keys = [];
  for (let m = start; m < end; m += SLOT_MIN) keys.push(toHHMM(m));
  return keys;
}

/**
 * Read the stored model into a clean { weekday: { 'HH:MM': count } }.
 *
 * Hand-edited or half-written values are dropped rather than trusted: a
 * target of "lots" or -3 would render as a broken column on every screen
 * that reads this. A slot with no usable number simply has no target,
 * which the views show as "—" rather than as zero — "we want nobody at
 * 4pm" and "nobody has said" are different statements.
 */
export function resolveCoverageModel(centerConfig) {
  const raw = centerConfig?.coverageModel;
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [day, slots] of Object.entries(raw)) {
    if (!slots || typeof slots !== 'object') continue;
    const clean = {};
    for (const [slot, value] of Object.entries(slots)) {
      if (!/^\d{2}:\d{2}$/.test(slot)) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) continue;
      clean[slot] = Math.round(n);
    }
    if (Object.keys(clean).length > 0) out[day] = clean;
  }
  return out;
}

/** The wanted count for one slot, or null when nobody has set one. */
export function targetFor(model, weekday, slotKey) {
  const v = model?.[weekday]?.[slotKey];
  return Number.isFinite(v) ? v : null;
}

/** Does the model say anything at all about this weekday? */
export function hasTargets(model, weekday) {
  return Object.keys(model?.[weekday] || {}).length > 0;
}

/**
 * Would a shift for this person count toward the ratio by default?
 *
 * The availability-side twin of countsInRatio(). Volunteers and trainees
 * are excluded by defaultIncludedInRatio; every other title goes through
 * the centre's own role registry.
 *
 * @param {object} user   resolved for the centre (resolveUserForCenter)
 * @param {Array}  roles  the centre role registry (resolveRoles)
 */
export function countsOnFloor(user, roles) {
  if (!user) return false;
  const role = user.instructorType;
  if (user.isVolunteer === true) return false;
  // No registry to consult (a centre that has never opened the role
  // editor): fall through to the built-in default rather than counting
  // everybody.
  if (!roles || roles.length === 0) return defaultIncludedInRatio({ role }, { isVolunteer: user.isVolunteer });
  return roleRatioDefault(roles, { role });
}

/** Does a [start, end) minute window cover the slot beginning at slotMin? */
function coversSlot(startMin, endMin, slotMin) {
  return startMin <= slotMin && endMin >= slotMin + SLOT_MIN;
}

/**
 * One date's supply, per slot.
 *
 * A person is counted once per slot however many availability rows or
 * shifts they have — two rows (10–2, 2–6) are one person, not two, which
 * is why availabilityWindows merges before anything is counted.
 *
 * @returns {Array<{slot, available, scheduled, availableNames, scheduledNames}>}
 */
export function coverageForDate({
  date, slotKeys, users = [], availability = [], shifts = [], timeOffIndex = null, roles = [],
}) {
  const floorUsers = new Map();
  for (const u of users) {
    const uid = u?.uid || u?.id;
    if (uid && countsOnFloor(u, roles)) floorUsers.set(uid, u);
  }

  // Availability rows for this date, merged per person.
  const windowsByUser = new Map();
  for (const row of availability) {
    if (row?.date !== date) continue;
    const uid = row?.userId;
    if (!uid || !floorUsers.has(uid)) continue;
    // An approved day off outranks whatever they submitted earlier. A
    // PENDING request is left alone — undecided is not a no.
    if (timeOffIndex && isOffOn(timeOffIndex, uid, date)) continue;
    if (!windowsByUser.has(uid)) windowsByUser.set(uid, []);
    windowsByUser.get(uid).push(row);
  }
  const merged = new Map();
  for (const [uid, rows] of windowsByUser) merged.set(uid, availabilityWindows(rows));

  // Shifts on this date that fill a ratio slot.
  const dayShifts = shifts.filter(s => s?.date === date && countsInRatio(s));

  return slotKeys.map(slot => {
    const slotMin = toMinutes(slot);
    const availableNames = [];
    for (const [uid, windows] of merged) {
      if (windows.some(([s, e]) => coversSlot(s, e, slotMin))) {
        availableNames.push(floorUsers.get(uid)?.displayName || uid);
      }
    }
    const scheduledNames = new Set();
    for (const s of dayShifts) {
      const start = toMinutes(s.startTime);
      const end   = toMinutes(s.endTime);
      if (start == null || end == null) continue;
      if (coversSlot(start, end, slotMin)) scheduledNames.add(s.userName || s.userId || 'unknown');
    }
    return {
      slot,
      available: availableNames.length,
      scheduled: scheduledNames.size,
      availableNames,
      scheduledNames: [...scheduledNames],
    };
  });
}

/**
 * Average several dates of the same weekday into one row per slot.
 *
 * Averages AND worsts are both kept. An average of 4 across four Mondays
 * can be two fine weeks and two that were two people short, and the
 * average is the number that hides it.
 */
export function summariseSlots(perDate) {
  const bySlot = new Map();
  for (const day of perDate) {
    for (const row of day) {
      if (!bySlot.has(row.slot)) bySlot.set(row.slot, { available: [], scheduled: [] });
      const b = bySlot.get(row.slot);
      b.available.push(row.available);
      b.scheduled.push(row.scheduled);
    }
  }
  const mean = (a) => (a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return [...bySlot.entries()].map(([slot, b]) => ({
    slot,
    samples:      b.available.length,
    available:    mean(b.available),
    scheduled:    mean(b.scheduled),
    worstAvailable: b.available.length > 0 ? Math.min(...b.available) : 0,
    worstScheduled: b.scheduled.length > 0 ? Math.min(...b.scheduled) : 0,
  }));
}

/**
 * What to say about one slot. The distinction that matters is between a
 * rota problem and a people problem:
 *
 *   met        — enough rostered.
 *   fillable   — short on the rota, but enough people are free to fix it.
 *   unstaffable— not enough people are even available. Rota-shuffling
 *                cannot solve this one, so it is called out separately.
 *   none       — no target set for this slot; nothing to judge.
 *
 * Counts are rounded for comparison because an average of 3.8 rostered
 * against a target of 4 is not a shortfall worth shouting about.
 */
export function classifySlot({ target, available, scheduled }) {
  if (!Number.isFinite(target)) return { status: 'none', short: 0, shortAvailable: 0 };
  const have = Math.round(scheduled ?? 0);
  const short = Math.max(0, target - have);

  // NOBODY SUBMITTING IS NOT NOBODY BEING FREE. `available: null` means no
  // availability is on file for the dates being read, and at this centre
  // that is the common case — most shifts have none. Calling those slots
  // unstaffable would paint the whole week red and bury the ones that are
  // genuinely short of people. Same rule as the weekly grid's failsafe in
  // availabilityFit.js: no submission is not evidence.
  if (available == null) {
    return short > 0
      ? { status: 'fillable', short, shortAvailable: 0 }
      : { status: 'met', short: 0, shortAvailable: 0 };
  }

  const free = Math.round(available);
  const shortAvailable = Math.max(0, target - free);
  if (shortAvailable > 0) return { status: 'unstaffable', short, shortAvailable };
  if (short > 0) return { status: 'fillable', short, shortAvailable: 0 };
  return { status: 'met', short: 0, shortAvailable: 0 };
}

/**
 * The next `weeks` dates falling on `weekday`, starting from `from`
 * (inclusive when `from` IS that weekday). Availability is stored per
 * date, not as a repeating weekly pattern, so a weekday view has to read
 * real upcoming dates and average them.
 *
 * Dates are produced as 'YYYY-MM-DD' at local noon to dodge the
 * `new Date('2026-09-17')`-is-the-16th-in-Pacific trap.
 */
export function upcomingDatesFor(weekday, weeks, from, weekdayNames) {
  const names = weekdayNames || ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const idx = names.indexOf(weekday);
  if (idx < 0 || !(weeks > 0)) return [];
  const start = new Date(from);
  start.setHours(12, 0, 0, 0);
  const delta = (idx - start.getDay() + 7) % 7;
  const first = new Date(start);
  first.setDate(first.getDate() + delta);
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const d = new Date(first);
    d.setDate(d.getDate() + w * 7);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Write one slot into the model, or clear it when `value` is blank.
 * Returns a NEW model — callers persist it with a merge write.
 */
export function setSlotTarget(model, weekday, slotKey, value) {
  const next = { ...(model || {}) };
  const day = { ...(next[weekday] || {}) };
  const n = Number(value);
  if (value === '' || value == null || !Number.isFinite(n) || n < 0) delete day[slotKey];
  else day[slotKey] = Math.round(n);
  next[weekday] = day;
  return next;
}

/** Apply one count to every slot of a weekday — the "same all afternoon" case. */
export function fillWeekday(model, weekday, slotKeys, value) {
  let next = model || {};
  for (const slot of slotKeys) next = setSlotTarget(next, weekday, slot, value);
  return next;
}
