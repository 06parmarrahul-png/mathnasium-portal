// Case study — the numbers Mathnasium Langley uses to prove Ratio works.
//
// Every metric in here MUST be defensible in front of skeptical franchise
// owners. We over-index on honesty:
//
//   - When we can measure it, we measure it.
//   - When we can only estimate it, the page surfaces it as an estimate.
//   - When there isn't enough history yet (e.g. lead conversion at 0 days),
//     the page shows "data collecting" rather than a misleading rate.
//
// Two-bucket wage model:
//   - hourlyWageAdmin    → drives the prep-time-saved math (Rachel's $23)
//   - hourlyWageInstructor → drives staffing-slack visibility (when we
//                            have the data to compute it)
//
// All functions are pure (centerId + Firestore loader functions in,
// numbers out) so the page can recompute on date-range changes without
// re-subscribing to the underlying collections.

import {
  collection, doc, getDoc, getDocs, query, where,
} from 'firebase/firestore';
import { db } from '../firebase';

// ───── Defaults (Langley baseline) ───────────────────────────────────────
// These ship as the initial values for the case-study config so the page
// renders meaningfully on first load. Owner can override in the UI.
export const DEFAULT_CASE_STUDY_CONFIG = {
  hourlyWageInstructor:  19,    // Langley avg instructor wage
  hourlyWageAdmin:       23,    // Rachel — admin assistant
  prepHoursBeforeWeekly:  5.583, // 4h45min + 50min in decimal hours
  prepHoursAfterWeekly:   0.417, // 25min
  // Lead conversion "data collecting" threshold — until this many leads
  // are closed (enrolled or lost), the page suppresses the rate to avoid
  // a misleading first-week number.
  conversionMinClosedLeads: 10,

  // ── 2025 pre-Ratio baseline (Langley operational reality) ──
  // These are USER-PROVIDED, not measured by Ratio. They live in config
  // because we need them for lift math but cannot compute them ourselves.
  // Defaults below are Langley's actual 2025 figures as reported.
  // Source must be defensible — owner should be ready to point to the
  // Mathnasium ranking / financial statement that backs each one.
  priorYearLabel:           '2025',
  priorYearRevenue:         1100000,
  priorYearLeads:           334,
  priorYearNewStudents:     161,
  priorYearConversionRate:  0.36,   // 36% — definition of denominator must be documented
  priorYearDaysToConvert:   13,
  priorYearAvgStayMonths:   19.1,
  priorYearRankInCanada:    1,      // null if not ranked

  // ── Post-Ratio claims (NOT verified; needs final numbers before pitching) ──
  // Marked separately so the page can render them with a "preliminary"
  // warning until concrete numbers are supplied. Same denominator must
  // match priorYearConversionRate or the comparison is meaningless.
  postRatioConversionRate:  null,   // e.g. 0.91 — leave null until verified
  postRatioDaysToConvert:   null,   // e.g. 5
  postRatioRevenue:         null,
  postRatioStatsVerified:   false,  // owner flips to true once defensible
};

// ───── Config storage (under schedulerSettings) ──────────────────────────
// Co-locating with schedulerSettings means no new collection or rule and
// the page can read+write through the same admin path that already exists.

export async function getCaseStudyConfig(centerId) {
  const snap = await getDoc(doc(db, 'centers', centerId, 'schedulerSettings', 'main'));
  const cfg = snap.exists() ? (snap.data().caseStudy || {}) : {};
  return { ...DEFAULT_CASE_STUDY_CONFIG, ...cfg };
}

export async function saveCaseStudyConfig(centerId, patch) {
  // Merge into the existing settings doc — caseStudy is a single nested
  // map field. Avoid blowing away other settings on the same doc.
  const ref = doc(db, 'centers', centerId, 'schedulerSettings', 'main');
  const snap = await getDoc(ref);
  const existing = snap.exists() ? (snap.data().caseStudy || {}) : {};
  const { setDoc } = await import('firebase/firestore');
  await setDoc(ref, { caseStudy: { ...existing, ...patch } }, { merge: true });
}

// ───── Date range helpers ────────────────────────────────────────────────

export function rangeDays({ from, to }) {
  // Inclusive day count. Used to convert weekly numbers to per-range
  // totals consistently.
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(1, Math.round(ms / (24 * 3600 * 1000)) + 1);
}

export function rangeWeeks(range) {
  return rangeDays(range) / 7;
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function defaultRange() {
  // Default to the last 90 days. Long enough to smooth weekly noise,
  // short enough that the data still reflects current behaviour.
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 89);
  return { from: ymd(from), to: ymd(to) };
}

// ───── Activity proof ────────────────────────────────────────────────────
// "Ratio is actually being used." Pure usage counters from the existing
// collections. The point isn't impressive numbers — it's that the system
// has been touched by real ops, not just by a demo.

export async function computeActivity(centerId, range) {
  const [studentsSnap, leadsSnap, intakesSnap, assignmentsSnap] = await Promise.all([
    getDocs(collection(db, 'centers', centerId, 'schedulerStudents')),
    getDocs(collection(db, 'centers', centerId, 'leads')),
    // centerIntakes is top-level + carries a centerId field.
    getDocs(query(collection(db, 'centerIntakes'), where('centerId', '==', centerId))),
    getDocs(collection(db, 'centers', centerId, 'schedulerInstructorAssignments')),
  ]);

  // Filter by range based on the natural date key on each doc.
  const fromMs = new Date(range.from + 'T00:00:00').getTime();
  const toMs   = new Date(range.to   + 'T23:59:59').getTime();
  const inRange = (iso) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return !isNaN(t) && t >= fromMs && t <= toMs;
  };

  // Assignments are docs named YYYY-MM-DD; each doc's data is a map of
  // {`${side}|${slot}`: [names]}. Count both day coverage and total
  // instructor-slot assignments — both are credible usage signals.
  let daysWithSchedule = 0;
  let totalInstructorAssignments = 0;
  for (const d of assignmentsSnap.docs) {
    const dayStr = d.id;
    const inWindow = dayStr >= range.from && dayStr <= range.to;
    if (!inWindow) continue;
    daysWithSchedule++;
    const data = d.data() || {};
    for (const names of Object.values(data)) {
      if (Array.isArray(names)) totalInstructorAssignments += names.length;
    }
  }

  // Intakes filtered by booking time.
  const intakesBooked = intakesSnap.docs.filter(d => {
    const v = d.data() || {};
    return inRange(v.bookedAt) || inRange(v.slot);
  }).length;

  // Leads filtered by createdAt (Firestore Timestamp or ISO string).
  const leadsCreated = leadsSnap.docs.filter(d => {
    const v = d.data() || {};
    const c = v.createdAt;
    if (!c) return false;
    if (typeof c?.toDate === 'function') {
      const t = c.toDate().getTime();
      return t >= fromMs && t <= toMs;
    }
    return inRange(c);
  }).length;

  return {
    studentsTracked: studentsSnap.size,        // current snapshot — not range-filtered
    leadsCreated,
    intakesBooked,
    daysWithSchedule,
    totalInstructorAssignments,
  };
}

// ───── Funnel ────────────────────────────────────────────────────────────
// Lead pipeline + intake-to-enrolled conversion. Until enough leads have
// CLOSED (enrolled or lost), conversionRate is null and the page shows
// "data collecting" — never a misleading first-week number.

export async function computeFunnel(centerId, range, config) {
  const [leadsSnap, intakesSnap] = await Promise.all([
    getDocs(collection(db, 'centers', centerId, 'leads')),
    getDocs(query(collection(db, 'centerIntakes'), where('centerId', '==', centerId))),
  ]);

  const fromMs = new Date(range.from + 'T00:00:00').getTime();
  const toMs   = new Date(range.to   + 'T23:59:59').getTime();
  const inRangeTs = (v) => {
    if (!v) return false;
    let t;
    if (typeof v?.toDate === 'function') t = v.toDate().getTime();
    else if (typeof v === 'string') t = new Date(v).getTime();
    else if (typeof v === 'number') t = v;
    else return false;
    return !isNaN(t) && t >= fromMs && t <= toMs;
  };

  const leadsInRange = leadsSnap.docs
    .map(d => d.data())
    .filter(l => inRangeTs(l.createdAt));

  const byStatus = { new: 0, contacted: 0, assessed: 0, enrolled: 0, lost: 0 };
  for (const l of leadsInRange) {
    if (l.status in byStatus) byStatus[l.status]++;
  }
  const closed = byStatus.enrolled + byStatus.lost;
  const conversionRate = closed >= (config?.conversionMinClosedLeads || 10)
    ? byStatus.enrolled / closed
    : null;

  const intakesInRange = intakesSnap.docs.filter(d => {
    const v = d.data() || {};
    return inRangeTs(v.bookedAt) || inRangeTs(v.slot);
  }).length;

  return {
    leadsCreated: leadsInRange.length,
    byStatus,
    closed,
    conversionRate,
    dataCollecting: conversionRate == null,
    intakesBooked: intakesInRange,
  };
}

// ───── Time savings (config-driven, no Firestore) ────────────────────────

export function computeTimeSavings(config, range) {
  const before = Math.max(0, config?.prepHoursBeforeWeekly || 0);
  const after  = Math.max(0, config?.prepHoursAfterWeekly  || 0);
  const wage   = Math.max(0, config?.hourlyWageAdmin       || 0);
  const hoursPerWeek = Math.max(0, before - after);
  const weeks = rangeWeeks(range);
  const hoursInRange = hoursPerWeek * weeks;
  const dollarsInRange = hoursInRange * wage;
  const annualHours = hoursPerWeek * 52;
  const annualDollars = annualHours * wage;
  return {
    hoursPerWeek,
    hoursInRange,
    dollarsInRange,
    annualHours,
    annualDollars,
  };
}

// ───── Annual value summary ──────────────────────────────────────────────

export function computeAnnualValue({ timeSavings }) {
  // V1 only includes time savings — the staffing-slack metric becomes a
  // second line item once we have ~3 months of need/have history logged.
  return {
    annualDollars: timeSavings?.annualDollars || 0,
    components: [
      {
        label: 'Admin-assistant time recovered',
        dollars: timeSavings?.annualDollars || 0,
        detail: `${(timeSavings?.hoursPerWeek || 0).toFixed(1)} hrs/week × 52 × $${'0'}/hr`,
      },
    ],
  };
}

// ───── Top-level orchestrator ────────────────────────────────────────────

export async function computeCaseStudy(centerId, range) {
  const config = await getCaseStudyConfig(centerId);
  const [activity, funnel] = await Promise.all([
    computeActivity(centerId, range),
    computeFunnel(centerId, range, config),
  ]);
  const timeSavings = computeTimeSavings(config, range);
  const annualValue = computeAnnualValue({ timeSavings });
  return { config, range, activity, funnel, timeSavings, annualValue };
}

// ───── Money formatter (consistent across the page) ─────────────────────

export function money(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-CA', {
    style: 'currency', currency: 'CAD',
    maximumFractionDigits: 0,
  });
}

export function hours(n) {
  if (n == null || isNaN(n)) return '—';
  if (n === 0) return '0 hrs';
  if (n < 1) return `${Math.round(n * 60)} min`;
  return `${n.toFixed(1)} hrs`;
}

export function pct(n) {
  if (n == null || isNaN(n)) return '—';
  return `${Math.round(n * 100)}%`;
}
