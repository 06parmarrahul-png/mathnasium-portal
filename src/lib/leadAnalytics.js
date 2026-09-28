/**
 * leadAnalytics.js — the lead funnel, read across a district.
 *
 * Everything here is derived from ONE collection: the lead documents
 * themselves. That is the line this codebase draws. Enrolment and revenue
 * are barred from being derived because their sources are not in Ratio;
 * a lead's own history IS in Ratio, written by the staff working it, so
 * counting it is reporting rather than guessing.
 *
 * WHAT IS ALREADY IN leads.js AND IS NOT REPEATED HERE:
 * funnelCounts(), conversionRate() and sourceBreakdown() are pure and
 * correct, including the one subtlety worth keeping — conversion counts
 * enrolled against CLOSED leads, not against every lead, or a healthy
 * pipeline would read as failure simply for being busy.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TIMING IS MEASURED ON THE LEADS THAT CAN BE MEASURED, AND SAYS SO.
 *
 * `contactedAt` / `assessedAt` / `enrolledAt` are stamped by
 * setLeadStatus(). A lead whose status was set before those stamps
 * existed, or imported straight in at a later stage, simply has no time
 * to report. Every timing figure therefore carries the number of leads
 * behind it, so "1.4 days to first contact" can never quietly mean "we
 * found two leads that had the fields".
 * ═══════════════════════════════════════════════════════════════════════
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

import { LEAD_STATUSES, funnelCounts, conversionRate, sourceBreakdown } from './leads';

export { LEAD_STATUSES, funnelCounts, conversionRate, sourceBreakdown };

/** The stages a lead moves through, in order. 'lost' is an exit, not a stage. */
export const FUNNEL_ORDER = ['new', 'contacted', 'assessed', 'enrolled'];

/** How long a new lead may sit untouched before it is worth chasing. */
export const CHASE_AFTER_DAYS = 3;

const DAY = 86400000;

/** Firestore Timestamp, ISO string, Date or millis → millis, else null. */
export function whenOf(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Days between two stamps, or null when either is missing or reversed. */
export function gapInDays(from, to) {
  const a = whenOf(from);
  const b = whenOf(to);
  if (a === null || b === null || b < a) return null;
  return (b - a) / DAY;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * How long the funnel takes, and how many leads that is based on.
 *
 * Median rather than mean: one lead that sat over a summer would drag an
 * average into uselessness, and the question being asked is "what usually
 * happens", which is what a median answers.
 */
export function timingStats(leads) {
  const toContact = [];
  const toEnrol = [];
  for (const l of leads || []) {
    const c = gapInDays(l.createdAt, l.contactedAt);
    if (c !== null) toContact.push(c);
    const e = gapInDays(l.createdAt, l.enrolledAt);
    if (e !== null) toEnrol.push(e);
  }
  return {
    daysToContact: median(toContact),
    daysToContactFrom: toContact.length,
    daysToEnrol: median(toEnrol),
    daysToEnrolFrom: toEnrol.length,
    total: (leads || []).length,
  };
}

/**
 * Leads sitting in `new` that nobody has touched.
 *
 * The single most actionable number on a district page: a lead that has
 * gone cold is money already spent and not yet lost, and it is the one
 * thing a district manager can do something about this afternoon.
 */
export function goneCold(leads, now = Date.now(), afterDays = CHASE_AFTER_DAYS) {
  return (leads || []).filter(l => {
    if (l.status !== 'new') return false;
    const born = whenOf(l.createdAt);
    if (born === null) return false;
    return (now - born) / DAY >= afterDays;
  });
}

/** Oldest first — the ones that have been waiting longest want naming. */
export function byAge(leads, now = Date.now()) {
  return [...(leads || [])]
    .map(l => ({ lead: l, ageDays: Math.floor((now - (whenOf(l.createdAt) ?? now)) / DAY) }))
    .sort((a, b) => b.ageDays - a.ageDays);
}

/**
 * Leads created and enrolled per calendar month, oldest first.
 *
 * Direction beats position for a district manager: "forty this month
 * against fifty-five last" is a conversation, and a single total is not.
 */
export function monthlyTrend(leads, months = 6, now = Date.now()) {
  const keys = [];
  const end = new Date(now);
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const blank = () => ({ created: 0, enrolled: 0 });
  const buckets = Object.fromEntries(keys.map(k => [k, blank()]));

  const keyFor = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  for (const l of leads || []) {
    const born = whenOf(l.createdAt);
    if (born !== null && buckets[keyFor(born)]) buckets[keyFor(born)].created += 1;
    const won = whenOf(l.enrolledAt);
    if (won !== null && buckets[keyFor(won)]) buckets[keyFor(won)].enrolled += 1;
  }
  return keys.map(k => ({ month: k, ...buckets[k] }));
}

/** Everything one centre's funnel has to say, in one object. */
export function centreFunnel(centreId, leads, now = Date.now()) {
  const list = leads || [];
  return {
    centreId,
    total: list.length,
    counts: funnelCounts(list),
    conversion: conversionRate(list),
    timing: timingStats(list),
    cold: goneCold(list, now).length,
    open: list.filter(l => l.status !== 'enrolled' && l.status !== 'lost').length,
  };
}

/**
 * The district's funnel: every centre's leads added together, plus the
 * per-centre rows so one centre cannot hide inside the total.
 *
 * A centre with no leads is `total: 0` and is still a row — unlike the
 * hand-entered figures elsewhere, a lead list genuinely CAN be empty, and
 * an empty funnel is a finding rather than a gap in the data.
 */
export function rollUpLeads(byCentre, now = Date.now()) {
  const centres = Object.entries(byCentre || {})
    .map(([centreId, leads]) => centreFunnel(centreId, leads, now));
  const all = Object.values(byCentre || {}).flat();
  return {
    centres: centres.sort((a, b) => b.total - a.total),
    total: all.length,
    counts: funnelCounts(all),
    conversion: conversionRate(all),
    timing: timingStats(all),
    sources: sourceBreakdown(all),
    cold: goneCold(all, now),
    open: all.filter(l => l.status !== 'enrolled' && l.status !== 'lost').length,
  };
}

/** "62%" — or a dash, because no closed leads is not nought per cent. */
export function asPercent(rate) {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

/** "1.4 days" / "same day" / a dash when nothing could be measured. */
export function asDays(value) {
  if (value === null || value === undefined) return '—';
  if (value < 0.5) return 'same day';
  if (value < 1.5) return '1 day';
  return `${value.toFixed(value < 10 ? 1 : 0)} days`;
}
