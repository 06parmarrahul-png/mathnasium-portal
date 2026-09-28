/**
 * district.js — several centres, seen by the person who answers for all of
 * them.
 *
 * A district manager is not a centre manager with a wider net. A centre
 * manager asks "is my floor covered today"; a district manager asks "which
 * of my eight centres needs me this week". That is a question about
 * EXCEPTIONS, and it is only answerable if the numbers underneath it are
 * trustworthy — which is the whole subject of this file.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * NOT REPORTED IS NOT ZERO.
 *
 * Four of the figures here — active, inactive and on-hold students, and
 * monthly revenue — are typed in by hand, because Ratio has no source for
 * them. Radius does, but the integration request on file explicitly asks
 * for read-only enrolment and explicitly does NOT ask for billing, so
 * there is no path to the money until that ask is widened.
 *
 * So a centre that has never entered a number has `null`, not `0`, and a
 * roll-up that sums six centres out of eight must SAY six out of eight.
 * Quietly treating silence as zero is how a district total reads 480
 * students when the real answer is "we do not know, and two centres are
 * missing" — and a wrong number in front of a district manager costs the
 * credibility of every other number on the page.
 *
 * This codebase has been here before. The leadership board was deleted
 * once for exactly this, and its replacement carries the scar in a comment:
 * "a dashboard that is confidently wrong is worse than no dashboard".
 * ═══════════════════════════════════════════════════════════════════════
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

/** The figures a person types in. Everything else on the page is live. */
export const VITAL_KEYS = [
  'activeStudents', 'inactiveStudents', 'onHoldStudents', 'monthlyRevenue',
];

/**
 * How old a hand-entered number may get before it stops being evidence.
 *
 * Centres are asked for these monthly, so a fortnight is still current and
 * six weeks means a month-end has been missed. The page shows the age
 * either way — these thresholds only decide how loudly.
 */
export const FRESH_DAYS = 14;
export const STALE_DAYS = 45;

/** Firestore Timestamp, Date, or millis → millis. Anything else → null. */
export function millisOf(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const cleanNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : null;
};

/**
 * The hand-entered figures for one centre, read off its config doc.
 *
 * Falls back to `activeStudentCount` / `studentCountUpdatedAt`, which is
 * where the single manual student number has lived since before there was
 * a district view. A centre that filled that in has reported its active
 * students and nothing else — which is exactly what this returns.
 */
export function readVitals(config) {
  const v = (config && config.vitals) || {};
  const out = {};
  for (const key of VITAL_KEYS) out[key] = cleanNumber(v[key]);

  let updatedAt = millisOf(v.updatedAt);
  let updatedBy = v.updatedByName || null;

  if (out.activeStudents === null) {
    const legacy = cleanNumber(config && config.activeStudentCount);
    // 0 is a real answer, but the field defaults to 0 for every centre that
    // has never been near it — so only a stamp makes it a report.
    const legacyAt = millisOf(config && config.studentCountUpdatedAt);
    if (legacy !== null && legacyAt !== null) {
      out.activeStudents = legacy;
      if (updatedAt === null) { updatedAt = legacyAt; updatedBy = updatedBy || null; }
    }
  }

  const reported = VITAL_KEYS.some(k => out[k] !== null);
  return { ...out, updatedAt, updatedByName: updatedBy, reported };
}

/**
 * What a typed-in box becomes on its way to Firestore.
 *
 * Lives next to readVitals deliberately: the two are one contract. An
 * empty box is `null` — "we do not have this" — and a typed 0 is 0, "we
 * looked and the answer is none". The roll-up shows a dash for the first
 * and a nought for the second, and it can only do that if the save keeps
 * them apart.
 */
export function toFigure(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

/** Whole days since the figures were last touched, or null if never. */
export function ageInDays(vitals, now = Date.now()) {
  const at = vitals && vitals.updatedAt;
  if (!at) return null;
  return Math.max(0, Math.floor((now - at) / 86400000));
}

/** How much weight to give it: 'never' | 'fresh' | 'ageing' | 'stale'. */
export function freshnessOf(ageDays) {
  if (ageDays === null || ageDays === undefined) return 'never';
  if (ageDays <= FRESH_DAYS) return 'fresh';
  if (ageDays <= STALE_DAYS) return 'ageing';
  return 'stale';
}

/** "as of 3 days ago" — the line that stops a stale number lying. */
export function asOfLabel(ageDays) {
  if (ageDays === null || ageDays === undefined) return 'never entered';
  if (ageDays === 0) return 'as of today';
  if (ageDays === 1) return 'as of yesterday';
  if (ageDays < 31) return `as of ${ageDays} days ago`;
  const months = Math.round(ageDays / 30);
  return `as of ${months} month${months === 1 ? '' : 's'} ago`;
}

/**
 * Add the centres up, and say how many of them answered.
 *
 * `reporting` and `total` are not decoration. A district total is only
 * readable next to the number of centres standing behind it — see the
 * banner at the top of this file.
 */
export function rollUp(rows, now = Date.now()) {
  const totals = {};
  for (const key of VITAL_KEYS) totals[key] = null;

  const missing = [];
  const stale = [];
  let reporting = 0;

  for (const row of rows || []) {
    const vitals = row.vitals || {};
    if (!vitals.reported) { missing.push(row.centreId); continue; }
    reporting += 1;
    if (freshnessOf(ageInDays(vitals, now)) === 'stale') stale.push(row.centreId);
    for (const key of VITAL_KEYS) {
      if (vitals[key] === null || vitals[key] === undefined) continue;
      totals[key] = (totals[key] === null ? 0 : totals[key]) + vitals[key];
    }
  }

  return {
    ...totals,
    reporting,
    total: (rows || []).length,
    missing,
    stale,
    /** True when every centre has answered — the only time a total is whole. */
    complete: reporting === (rows || []).length && reporting > 0,
  };
}

/** Head count and a role breakdown for one centre, from the user docs. */
export function staffAt(users, centreId) {
  const rows = (users || []).filter(u => (
    u && Array.isArray(u.centerIds) && u.centerIds.includes(centreId)
      && u.approved === true && u.status !== 'terminated'
  ));
  const byRole = {};
  for (const u of rows) {
    const role = u.instructorType || u.role || 'Unassigned';
    byRole[role] = (byRole[role] || 0) + 1;
  }
  return { count: rows.length, byRole };
}
