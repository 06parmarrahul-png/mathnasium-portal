/**
 * slotDemand.js — how many students are on each side, per half hour.
 *
 * THE THREE SOURCES, WHICH HAVE TO AGREE WITH THE STUDENT SCHEDULER
 *   1. Acuity bookings, from the day's parsed cache — fanned across every
 *      half hour the booking covers, so a 60-minute 3:00 booking is still
 *      there at 3:30.
 *   2. Walk-ins and call-ins: `centers/{id}/scheduleAddOns/{date}`, keyed
 *      "<side>|<HH:MM>" → the people staff add on the day.
 *   3. Check-ins: `centers/{id}/schedulerCheckIns/{date}`, a map of
 *      studentId → { status }. A no-show or a cancellation is still
 *      listed, struck through, but not counted.
 *
 * WHY THIS FILE EXISTS
 *   Supply & Demand was reading two paths that do not exist —
 *   `walkIns/{date}/entries` and `schedulerCheckIns/{date}/students` (a
 *   sub-collection; check-ins are a single document). Both silently
 *   returned nothing, so walk-ins never reached the chart and a no-show
 *   never came off it. On 16 Sept 2026 that was four people the scheduler
 *   had and the chart didn't; adding them made all sixteen half hours
 *   match the numbers read off the Student Scheduler.
 *
 *   The page now reads through scheduler-data.js's own watchers, and this
 *   library does the counting, so the two screens can't drift again.
 */

export const SIDE_KEYS = ['EM', 'HS'];

const SLOT_MIN = 30;

const spanOf = (duration) => Math.max(1, Math.round((Number(duration) > 0 ? Number(duration) : 60) / SLOT_MIN));

const isGone = (status) => status === 'noshow' || status === 'cancel';

/** Where a "HH:MM" slot sits in the day window, or -1 if outside it. */
function slotIndex(slot, dayWindow) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slot ?? '').trim());
  if (!m || !dayWindow) return -1;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const idx = Math.round((mins - dayWindow.startMin) / SLOT_MIN);
  return idx >= 0 && idx < dayWindow.slotCount ? idx : -1;
}

const blank = (slotCount) => ({
  counts: new Array(slotCount).fill(0),
  students: Array.from({ length: slotCount }, () => []),
});

/**
 * @param slots     the day cache's `slots` array (row.students.EM / .HS)
 * @param checkIns  { studentId: { status } } — the check-in document
 * @param addOns    the scheduleAddOns document: { "EM|15:00": [ … ] }
 * @param dayWindow { startMin, slotCount }
 * @returns { EM: { counts, students }, HS: { … }, walkIns: n, notCounted: n }
 */
export function demandBySide({ slots = [], checkIns = {}, addOns = {}, dayWindow } = {}) {
  const slotCount = dayWindow?.slotCount || 0;
  const out = { EM: blank(slotCount), HS: blank(slotCount), walkIns: 0, notCounted: 0 };
  const statusOf = (id) => {
    const v = checkIns?.[id];
    return (typeof v === 'string' ? v : v?.status) || null;
  };

  const add = (side, idx, entry, counted) => {
    out[side].students[idx].push(entry);
    if (counted) out[side].counts[idx] += 1;
  };

  for (const row of (slots || [])) {
    const start = slotIndex(row?.slot, dayWindow);
    if (start < 0) continue;
    for (const side of SIDE_KEYS) {
      const bucket = row?.students?.[side];
      if (!bucket) continue;
      for (const st of [...(bucket.onHour || []), ...(bucket.halfHour || [])]) {
        const dur = Number(st?.duration) > 0 ? Number(st.duration) : 60;
        const status = statusOf(st?.id || st?.uniqueId);
        const gone = isGone(status);
        if (gone) out.notCounted += 1;
        for (let k = 0; k < spanOf(dur); k++) {
          const idx = start + k;
          if (idx >= slotCount) break;
          add(side, idx, {
            name: st?.name || st?.displayName || 'Unknown',
            source: k === 0 ? 'Acuity' : `Acuity (rollover · ${dur}min)`,
            status,
          }, !gone);
        }
      }
    }
  }

  // Walk-ins and call-ins. The document also holds a `slotOverrides` key,
  // which is not a side and is skipped by the key check.
  for (const [key, value] of Object.entries(addOns || {})) {
    const [side, slot] = String(key).split('|');
    if (!SIDE_KEYS.includes(side)) continue;
    const start = slotIndex(slot, dayWindow);
    if (start < 0) continue;
    for (const w of (Array.isArray(value) ? value : [])) {
      const dur = Number(w?.duration) > 0 ? Number(w.duration) : 60;
      const status = statusOf(w?.id);
      const gone = isGone(status);
      out.walkIns += 1;
      if (gone) out.notCounted += 1;
      for (let k = 0; k < spanOf(dur); k++) {
        const idx = start + k;
        if (idx >= slotCount) break;
        add(side, idx, {
          name: w?.name || 'Walk-in',
          source: k === 0 ? 'Walk-in' : `Walk-in (rollover · ${dur}min)`,
          status,
        }, !gone);
      }
    }
  }

  return out;
}
