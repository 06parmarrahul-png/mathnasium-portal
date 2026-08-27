/**
 * booked-demand.js — students actually booked, per half-hour, for a
 * specific DATE.
 *
 * The auto-scheduler's coverage mode originally leaned on saved Supply &
 * Demand snapshots to guess a "typical Monday". That only works for a
 * centre that has been opening Supply & Demand for weeks, and it answers
 * the wrong question anyway: when you schedule Sep 7–13 you want the
 * students booked on *those dates*, not an average of past Mondays.
 *
 * This reads the same Acuity-backed endpoint the Student Scheduler and
 * Supply & Demand already use, and fans each booking across the slots its
 * duration covers — a 60-minute booking occupies two half-hour slots, a
 * 90-minute one occupies three. Counting only the slot a booking starts
 * in undercounts the floor badly at exactly the busy times.
 */

import { auth } from '../firebase';
import { toMinutes, toHHMM } from './coverage-planner';

const SLOT_MIN = 30;

/**
 * Fetch one date's appointments.
 * Returns null (not a throw) when the centre has no Acuity connection or
 * the call fails — a missing integration should degrade to "no demand
 * known", never break scheduling.
 */
export async function fetchDayAppointments(centerId, dateStr) {
  if (!centerId || !dateStr) return null;
  try {
    const token = await auth.currentUser?.getIdToken();
    const r = await fetch(
      `/api/scheduler/appointments?centerId=${encodeURIComponent(centerId)}&date=${encodeURIComponent(dateStr)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Turn an appointments payload into students-per-slot, keyed by clock
 * time so callers never have to reason about array offsets.
 *
 * @returns {Object} { 'HH:MM': studentCount }
 */
export function bookedByTime(apptData) {
  const out = {};
  if (!apptData) return out;
  for (const row of (apptData.slots || [])) {
    const rowStart = toMinutes(row?.slot);
    if (rowStart == null) continue;
    for (const sideKey of ['EM', 'HS']) {
      const bucket = row?.students?.[sideKey];
      if (!bucket) continue;
      const all = [...(bucket.onHour || []), ...(bucket.halfHour || [])];
      for (const student of all) {
        const dur = Number(student?.duration) > 0 ? Number(student.duration) : 60;
        const span = Math.max(1, Math.round(dur / SLOT_MIN));
        for (let k = 0; k < span; k++) {
          const key = toHHMM(rowStart + k * SLOT_MIN);
          out[key] = (out[key] || 0) + 1;
        }
      }
    }
  }
  return out;
}

/** Line a by-time demand map up with a specific day's slot keys. */
export function demandForSlots(byTime, slotKeys = []) {
  return slotKeys.map(k => Number(byTime?.[k]) || 0);
}

/**
 * Load booked demand for several dates at once.
 *
 * Requests run in parallel but are capped, so scheduling a month doesn't
 * fire thirty simultaneous calls at the integration.
 *
 * @returns {Object} { 'YYYY-MM-DD': { 'HH:MM': students } }
 */
export async function fetchBookedDemand(centerId, dateStrs = [], { concurrency = 4 } = {}) {
  const out = {};
  const queue = [...dateStrs];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const dateStr = queue.shift();
      const data = await fetchDayAppointments(centerId, dateStr);
      out[dateStr] = bookedByTime(data);
    }
  });
  await Promise.all(workers);
  return out;
}
