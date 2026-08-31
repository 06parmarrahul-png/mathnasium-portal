/**
 * demand-snapshots.js
 *
 * Persistent daily snapshots of student demand + instructor supply per
 * 30-min slot, per side (Elementary / Highschool). Two purposes:
 *   1. Owner can edit any cell on the Supply & Demand page and have
 *      those numbers survive a refresh — usable as historical truth
 *      after the fact (walk-ins, cancellations, etc. that don't show
 *      up in Acuity).
 *   2. The auto-scheduler can look back at recent snapshots to answer
 *      "what does a typical Monday need?" — feeding smarter per-day
 *      min/max recommendations instead of relying on a single global
 *      guess.
 *
 * Firestore layout:
 *   centers/{centerId}/demandSnapshots/{yyyy-MM-dd}
 *   Fields: {
 *     date: 'yyyy-MM-dd',
 *     EM: { demand: [10,...], supply: [7,...], forecastRatio: 3 },
 *     HS: { demand: [8,...],  supply: [3,...], forecastRatio: 4 },
 *     updatedAt: serverTimestamp,
 *     updatedBy: uid,
 *   }
 *
 * Arrays always have SLOT_COUNT entries (default 10 for a 3pm-8pm day).
 */

import { doc, setDoc, getDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { format, subDays } from 'date-fns';

const SLOT_COUNT = 10;

function normalizeSide(v) {
  return {
    demand: Array.isArray(v?.demand) ? v.demand.slice(0, SLOT_COUNT) : new Array(SLOT_COUNT).fill(0),
    supply: Array.isArray(v?.supply) ? v.supply.slice(0, SLOT_COUNT) : new Array(SLOT_COUNT).fill(0),
    forecastRatio: Number(v?.forecastRatio) || null,
  };
}

/**
 * Fetch the snapshot doc for a specific date. Returns null when none
 * exists yet — caller falls back to live Acuity numbers.
 */
export async function getSnapshot(centerId, dateStr) {
  if (!centerId || !dateStr) return null;
  const ref = doc(db, 'centers', centerId, 'demandSnapshots', dateStr);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  const data = snap.data() || {};
  return {
    date: dateStr,
    EM: normalizeSide(data.EM),
    HS: normalizeSide(data.HS),
  };
}

/**
 * Save the current view's demand + supply per side. Overwrites; the
 * caller passes the FULL current state so we don't have to merge cells.
 */
export async function saveSnapshot(centerId, dateStr, { EM, HS, updatedBy }) {
  if (!centerId || !dateStr) throw new Error('centerId + dateStr required');
  await setDoc(
    doc(db, 'centers', centerId, 'demandSnapshots', dateStr),
    {
      date: dateStr,
      EM: normalizeSide(EM),
      HS: normalizeSide(HS),
      updatedAt: serverTimestamp(),
      updatedBy: updatedBy || null,
    },
    { merge: false },
  );
}

/**
 * Read the last N weeks' snapshots and compute average demand per slot
 * grouped by weekday. Used by the auto-scheduler + the "typical
 * Monday" comparison on the Supply & Demand page.
 *
 * Returns:
 *   {
 *     Monday:  { EM: { demand: [avg, avg, ...], samples: 4 }, HS: {...} },
 *     Tuesday: {...}, ...
 *   }
 *
 * Days with zero samples aren't included so callers can distinguish
 * "no data" from "average of zero".
 */
export async function computeTypicalDemand(centerId, lookbackDays = 56) {
  if (!centerId) return {};
  const start = format(subDays(new Date(), lookbackDays), 'yyyy-MM-dd');
  const end   = format(new Date(), 'yyyy-MM-dd');
  const q = query(
    collection(db, 'centers', centerId, 'demandSnapshots'),
    where('date', '>=', start),
    where('date', '<=', end),
  );
  const snap = await getDocs(q);
  const byDow = {}; // dayName -> { EM: {sum: [...], count}, HS: {sum, count} }
  for (const d of snap.docs) {
    const data = d.data() || {};
    if (!data.date) continue;
    const dayName = new Date(data.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    if (!byDow[dayName]) byDow[dayName] = {
      EM: { sum: new Array(SLOT_COUNT).fill(0), count: 0 },
      HS: { sum: new Array(SLOT_COUNT).fill(0), count: 0 },
    };
    for (const side of ['EM', 'HS']) {
      const arr = data[side]?.demand;
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < SLOT_COUNT; i++) byDow[dayName][side].sum[i] += Number(arr[i]) || 0;
      byDow[dayName][side].count++;
    }
  }
  // Convert sums to averages.
  const out = {};
  for (const [dow, sides] of Object.entries(byDow)) {
    out[dow] = {};
    for (const side of ['EM', 'HS']) {
      const { sum, count } = sides[side];
      if (count === 0) continue;
      out[dow][side] = {
        demand: sum.map(v => Math.round((v / count) * 10) / 10),
        samples: count,
      };
    }
  }
  return out;
}

/**
 * Convenience wrapper: given a typical-demand map + a target ratio, work
 * out how many instructors that day-of-week needs at peak to hit the
 * ratio. Used by the auto-scheduler's "Load from history" button.
 */
export function recommendedStaffFromTypical(typicalForDay, ratio = { EM: 3, HS: 4 }) {
  if (!typicalForDay) return { peakStudents: 0, recommendedMin: 0, recommendedMax: 0 };
  const peakEM = Math.max(0, ...(typicalForDay.EM?.demand || [0]));
  const peakHS = Math.max(0, ...(typicalForDay.HS?.demand || [0]));
  // Recommended supply = ceil(peak / ratio). Combine EM + HS at their
  // separate ratios. Min = 80% of that (allows fair-day slack), Max = 120%.
  const staffEM = Math.ceil(peakEM / (ratio.EM || 3));
  const staffHS = Math.ceil(peakHS / (ratio.HS || 4));
  const total = staffEM + staffHS;
  return {
    peakStudents: peakEM + peakHS,
    recommendedMin: Math.max(1, Math.round(total * 0.8)),
    recommendedMax: Math.max(total, Math.round(total * 1.2)),
    peakEM, peakHS, staffEM, staffHS,
  };
}
