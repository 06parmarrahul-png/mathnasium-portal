import { countsInRatio } from './ratioCount';

/**
 * floorSupply.js — how many instructors are on each side, per half hour.
 *
 * WHERE SUPPLY COMES FROM
 *   The Student Scheduler. Neeru puts each instructor on a side — High
 *   School or Elementary — for every half hour, and that is the real
 *   floor: `centers/{id}/schedulerInstructorAssignments/{date}`, a flat
 *   map keyed `"<side>|<HH:MM>"` holding display names.
 *
 *   Supply & Demand used to count SHIFTS instead, against the whole
 *   centre's demand. One instructor then appeared to cover both sides at
 *   once, which is not a thing a person can do, so the page read
 *   over-staffed nearly every slot. Counting the sides separately is the
 *   whole point: four instructors on Elementary are no help to nine high
 *   schoolers.
 *
 * WHEN THERE ARE NO ASSIGNMENTS
 *   Sides are set the day before, so a week out there is nothing to read.
 *   `supplyFromShifts` is the fallback — the old behaviour, each shift's
 *   own sub-role deciding its side — and `hasAny` tells the page which of
 *   the two it is looking at, so it can say so rather than showing an
 *   empty floor.
 *
 * WHO DOESN'T COUNT
 *   Trainees and volunteers never fill a ratio slot (a settled rule), but
 *   they ARE on the sheet. `skip` lets the caller exclude them from the
 *   count while they stay visible in `skipped`, so the number and the
 *   names under it agree.
 */

export const SIDE_KEYS = ['EM', 'HS'];

export const SIDE_LABELS = {
  EM: 'Elementary / Middle',
  HS: 'High School',
};

const normName = (n) => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** A shift's side, from the sub-role it was scheduled under. */
export function sideOfSubRole(subRole) {
  const s = String(subRole ?? '').trim().toLowerCase();
  if (s === 'elementary') return 'EM';
  if (s === 'highschool' || s === 'high school') return 'HS';
  return null;
}

/** Where a "HH:MM" slot sits in the day window, or -1 if outside it. */
export function slotIndexFor(slot, dayWindow) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slot ?? '').trim());
  if (!m || !dayWindow) return -1;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const idx = Math.round((mins - dayWindow.startMin) / 30);
  return idx >= 0 && idx < dayWindow.slotCount ? idx : -1;
}

const blankSide = (slotCount) => ({
  counts: new Array(slotCount).fill(0),
  names: Array.from({ length: slotCount }, () => []),
});

const emptyResult = (slotCount) => ({
  EM: blankSide(slotCount),
  HS: blankSide(slotCount),
  hasAny: false,
  outsideWindow: 0,
  skipped: [],
  source: 'scheduler',
});

/**
 * Per-side, per-slot supply from one day's Student Scheduler assignments.
 *
 * @param assignments the assignment document: { "EM|15:00": ["Name", …] }
 * @param dayWindow   { startMin, slotCount } — the chart's half hours
 * @param skip        (name) => reason string to leave them out, or null
 */
export function supplyFromAssignments(assignments, dayWindow, { skip = () => null } = {}) {
  const slotCount = dayWindow?.slotCount || 0;
  const out = emptyResult(slotCount);
  const skipped = new Map();

  for (const [key, value] of Object.entries(assignments || {})) {
    const [side, slot] = String(key).split('|');
    if (!SIDE_KEYS.includes(side)) continue;
    // The same person twice in one slot is one person.
    const seen = new Map();
    for (const raw of (Array.isArray(value) ? value : [])) {
      const name = String(raw ?? '').trim();
      if (name) seen.set(normName(name), name);
    }
    const names = [...seen.values()];
    if (names.length > 0) out.hasAny = true;

    const idx = slotIndexFor(slot, dayWindow);
    if (idx < 0) { out.outsideWindow += names.length; continue; }

    for (const name of names) {
      const why = skip(name);
      if (why) { skipped.set(normName(name), { name, why }); continue; }
      if (out[side].names[idx].some(n => normName(n) === normName(name))) continue;
      out[side].names[idx].push(name);
      out[side].counts[idx] += 1;
    }
  }

  for (const side of SIDE_KEYS) {
    for (const list of out[side].names) list.sort((a, b) => a.localeCompare(b));
  }
  out.skipped = [...skipped.values()].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * The fallback: supply from the day's shifts, each shift on the side of
 * its own sub-role. Drafts, cancellations and sick days are not presence;
 * whether somebody counts toward the ratio is the shift's own
 * `includedInRatio`, read through countsInRatio — never guessed here.
 *
 * A shift has to cover at least half a slot to count for it, which is the
 * rule the page has always used.
 */
export function supplyFromShifts(shifts, dayWindow) {
  const slotCount = dayWindow?.slotCount || 0;
  const out = { ...emptyResult(slotCount), source: 'shifts' };
  const toMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };

  for (const s of (shifts || [])) {
    if (s?.status === 'draft' || s?.status === 'cancelled') continue;
    if (s?.sickPay === true) continue;
    const side = sideOfSubRole(s?.subRole);
    if (!side) continue;
    if (!countsInRatio(s)) continue;
    const start = toMin(s.startTime);
    const end = toMin(s.endTime);
    if (start == null || end == null) continue;
    const name = s.userName || s.userId || 'Unknown';
    for (let i = 0; i < slotCount; i++) {
      const slotStart = dayWindow.startMin + i * 30;
      const overlap = Math.min(end, slotStart + 30) - Math.max(start, slotStart);
      if (overlap < 15) continue;
      if (out[side].names[i].some(n => normName(n) === normName(name))) continue;
      out[side].names[i].push(name);
      out[side].counts[i] += 1;
      out.hasAny = true;
    }
  }

  for (const side of SIDE_KEYS) {
    for (const list of out[side].names) list.sort((a, b) => a.localeCompare(b));
  }
  return out;
}

/** Assignments when the sides have been set, otherwise the shifts. */
export function floorSupply({ assignments, shifts, dayWindow, skip }) {
  const fromSheet = supplyFromAssignments(assignments, dayWindow, { skip });
  if (fromSheet.hasAny) return fromSheet;
  return supplyFromShifts(shifts, dayWindow);
}

/** Everyone on the floor that day, once each, across both sides. */
export function uniqueOnFloor(supply) {
  const names = new Set();
  for (const side of SIDE_KEYS) {
    for (const list of (supply?.[side]?.names || [])) {
      for (const n of list) names.add(normName(n));
    }
  }
  return names;
}
