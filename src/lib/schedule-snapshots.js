// Daily schedule snapshots — the historical record that powers the
// "average Tuesday" view in the Forecast tab.
//
// Lifecycle:
//   1. Owner / staff opens the Today tab on a date whose slots have ALL
//      ended (so the analytics are final, not in-progress).
//   2. If no snapshot exists yet for that (centre, date), the page
//      computes day analytics and writes one.
//   3. Snapshots accumulate. Once we have ~4+ samples for the same
//      day-of-week, weekly averages become meaningful.
//
// This is intentionally a LAZY capture model — no cron, no scheduled
// function, no extra Vercel endpoint. A day that never gets opened
// just doesn't get captured, and the missing day shows up as gaps in
// the sample size. We can layer a server-side cron later (existing
// /api/cron/send-shift-reminders handler could host an extra action)
// if "owner never opens the dashboard" becomes a real failure mode.
//
// Path: centers/{centerId}/scheduleSnapshots/{YYYY-MM-DD}

import {
  collection, doc, getDoc, getDocs, query, where, orderBy,
  setDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';

const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function dayOfWeekFor(dateStr) {
  // Parse as local date (not UTC) so 'YYYY-MM-DD' lands on the right
  // weekday in the centre's timezone. Centres in Vancouver run on
  // local time; we don't cross DST inside one day.
  const [y, m, d] = (dateStr || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return DOW[new Date(y, m - 1, d).getDay()];
}

// ─── Read ──────────────────────────────────────────────────────────────

const colRef = (centerId) => collection(db, 'centers', centerId, 'scheduleSnapshots');

export async function getSnapshot(centerId, dateStr) {
  const snap = await getDoc(doc(db, 'centers', centerId, 'scheduleSnapshots', dateStr));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Pull every snapshot in [fromDateStr, toDateStr] inclusive.
 * Both bounds are YYYY-MM-DD; doc IDs are the same shape so a string
 * range query works without parsing.
 */
export async function getSnapshotsInRange(centerId, fromDateStr, toDateStr) {
  const q = query(
    colRef(centerId),
    where('__name__', '>=', fromDateStr),
    where('__name__', '<=', toDateStr),
    orderBy('__name__', 'asc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─── Write ─────────────────────────────────────────────────────────────

/**
 * Persist a final-day analytics snapshot. Idempotent: same date overwrites.
 * `analytics` should be the object computeDayAnalytics() returns with
 * `hasData: true` and a `perSlot` map.
 */
export async function saveSnapshot(centerId, dateStr, analytics) {
  if (!analytics?.hasData) return;
  const dow = dayOfWeekFor(dateStr);
  // Strip the runtime-only `hasData` flag; everything else is the
  // permanent record. Keep numeric fields only — the page recomputes
  // colour / state at read time.
  const payload = {
    date: dateStr,
    dayOfWeek: dow,
    totalScheduled:        analytics.totalScheduled        ?? 0,
    totalPresent:          analytics.totalPresent          ?? 0,
    totalAbsent:           analytics.totalAbsent           ?? 0,
    totalInstructorSlots:  analytics.totalInstructorSlots  ?? 0,
    attendanceRate:        analytics.attendanceRate        ?? null,
    utilisation:           analytics.utilisation           ?? null,
    onTargetSlots:         analytics.onTargetSlots         ?? 0,
    overstaffedSlots:      analytics.overstaffedSlots      ?? 0,
    understaffedSlots:     analytics.understaffedSlots     ?? 0,
    excessInstructorSlots: analytics.excessInstructorSlots ?? 0,
    perSlot:               analytics.perSlot               || {},
    capturedAt: serverTimestamp(),
  };
  await setDoc(doc(db, 'centers', centerId, 'scheduleSnapshots', dateStr), payload, { merge: false });
}

// ─── Aggregation ───────────────────────────────────────────────────────

const MIN_SAMPLES_FOR_AVG = 4;   // need N+ samples before we publish an average
const PAST_WINDOW_DAYS    = 90;  // how far back to pull when computing averages

export function rangeForLookback(daysBack = PAST_WINDOW_DAYS, now = new Date()) {
  const to   = ymd(now);
  const from = ymd(new Date(now.getTime() - daysBack * 24 * 3600 * 1000));
  return { from, to };
}

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Aggregate a set of snapshots into per-(DOW × slotKey) averages.
 *
 * Returns:
 *   {
 *     byDow: {
 *       Monday: {
 *         sampleSize: number,
 *         avgAttendance: 0..1 | null,
 *         avgScheduled: number,
 *         avgPresent: number,
 *         avgInstructors: number,
 *         perSlot: {
 *           'EM|14:00': { sampleSize, avgScheduled, avgPresent, avgInstructors, suggestedInstructors },
 *           ...
 *         },
 *       },
 *       ...
 *     },
 *     totalSnapshots: number,
 *     dateRange: { from, to },
 *   }
 *
 * `suggestedInstructors` = ceil(avgPresent / ratio) — what the auto-
 * scheduler would need at the centre's target ratio. Lets owners
 * spot "we always over-staff Tuesday 4pm" in one glance.
 *
 * Slots / DOW combinations with fewer than MIN_SAMPLES_FOR_AVG records
 * carry their sample size but suppress the average — UI should render
 * "collecting" instead of a misleading number from N=2.
 */
export function computeWeeklyAverages(snapshots, { ratio = 4, minSamples = MIN_SAMPLES_FOR_AVG } = {}) {
  const byDow = {};
  for (const snap of snapshots) {
    const dow = snap.dayOfWeek || dayOfWeekFor(snap.date);
    if (!dow) continue;
    if (!byDow[dow]) byDow[dow] = { samples: [], slotTotals: {} };
    byDow[dow].samples.push(snap);
    for (const [key, slot] of Object.entries(snap.perSlot || {})) {
      if (!byDow[dow].slotTotals[key]) byDow[dow].slotTotals[key] = [];
      byDow[dow].slotTotals[key].push(slot);
    }
  }

  const out = {};
  for (const [dow, bucket] of Object.entries(byDow)) {
    const samples = bucket.samples;
    const n = samples.length;
    const avg = (key) => n > 0 ? samples.reduce((a, s) => a + (s[key] || 0), 0) / n : 0;
    const avgAttendance = n >= minSamples
      ? samples.filter(s => s.attendanceRate != null).reduce((a, s) => a + s.attendanceRate, 0) /
        Math.max(1, samples.filter(s => s.attendanceRate != null).length)
      : null;

    const perSlot = {};
    for (const [key, rows] of Object.entries(bucket.slotTotals)) {
      const sampleSize = rows.length;
      const sum  = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
      const mean = (k) => sampleSize > 0 ? sum(k) / sampleSize : 0;
      const avgPresent     = mean('present');
      const avgScheduled   = mean('scheduled');
      const avgInstructors = mean('instructors');
      perSlot[key] = {
        side: rows[0]?.side || key.split('|')[0],
        slot: rows[0]?.slot || key.split('|')[1],
        sampleSize,
        avgScheduled,
        avgPresent,
        avgInstructors,
        suggestedInstructors: Math.max(1, Math.ceil(avgPresent / Math.max(1, ratio))),
        attendanceRate: avgScheduled > 0 ? avgPresent / avgScheduled : null,
      };
    }

    out[dow] = {
      sampleSize: n,
      avgAttendance,
      avgScheduled:        avg('totalScheduled'),
      avgPresent:          avg('totalPresent'),
      avgInstructors:      avg('totalInstructorSlots'),
      avgOverstaffedSlots: avg('overstaffedSlots'),
      avgUnderstaffedSlots: avg('understaffedSlots'),
      perSlot,
    };
  }
  return {
    byDow: out,
    totalSnapshots: snapshots.length,
    minSamples,
  };
}

export { MIN_SAMPLES_FOR_AVG };
