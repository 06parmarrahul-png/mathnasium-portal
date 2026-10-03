/**
 * leadFollowUp.js — who needs chasing, and what to say when you call.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THIS IS VIN'S SPREADSHEET, READ BACK AS A WORKLIST.
 *
 * The Lead Tracker has a row per family and columns for the things that
 * actually decide whether they enrol: when the lead arrived, when the
 * assessment is, who toured them, who assessed, whether they said yes,
 * and — the column that does the most work — WHY. Underneath it he
 * computes the numbers the centre is judged on: days to assessment,
 * leads assessed rate, conversion, no-shows.
 *
 * None of that is a dashboard. It is a list of people to ring today, and
 * the reason to ring each one. So that is what this module produces: a
 * prioritised worklist where every item carries the sentence a person
 * would say out loud about it.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * IT ONLY READS WHAT RATIO ACTUALLY HOLDS. Every item below is derived
 * from fields on the lead document, written by the staff working it or
 * stamped when a booking arrives. Nothing here infers enrolment, revenue
 * or attendance — those live outside Ratio, and a worklist that invents
 * them is the confidently-wrong dashboard this codebase already deleted
 * once. Where a figure cannot be computed it is absent, not zero.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

import { whenOf } from './leadAnalytics';

const DAY = 86400000;

/**
 * Why the family called. Vin's "Trigger/Reason" column, with the values
 * his own sheet actually contains — read off ten months of rows rather
 * than invented. It is the most useful marketing field in the tracker
 * and Ratio had nowhere to put it.
 */
export const LEAD_REASONS = [
  'remedial', 'enrichment', 'confidence', 'homework-help', 'exam-prep',
  'returning', 'sibling', 'ex-competitor', 'pre-ib', 'summer', 'other',
];

export const LEAD_REASON_LABELS = {
  remedial:        'Remedial — falling behind',
  enrichment:      'Enrichment — ahead, wants more',
  confidence:      'Confidence',
  'homework-help': 'Homework support',
  'exam-prep':     'Exam or test prep',
  returning:       'Returning student',
  sibling:         'Sibling of a student',
  'ex-competitor': 'Came from Kumon / Sylvan / other',
  'pre-ib':        'Pre-IB or advanced track',
  summer:          'Summer programme',
  other:           'Other',
};

/**
 * What happened to the assessment.
 *
 * NS and CA are real values in Vin's Assessment Date column — they are
 * not missing dates, they are outcomes, and they are the two that most
 * need a phone call afterwards. Ratio had no way to record either: a
 * no-show and a family who never booked looked identical.
 */
export const ASSESSMENT_OUTCOMES = ['booked', 'attended', 'no-show', 'cancelled'];

export const ASSESSMENT_OUTCOME_LABELS = {
  booked:     'Booked',
  attended:   'Attended',
  'no-show':  'No show',
  cancelled:  'Cancelled',
};

/** How long a new lead may sit with no assessment booked before it is chased. */
export const BOOK_WITHIN_DAYS = 3;
/** How long after an assessment a family may go undecided before a nudge. */
export const DECIDE_WITHIN_DAYS = 2;
/** Vin's own target, off the KPI sheet: lead in, assessed within four days. */
export const DAYS_TO_ASSESSMENT_GOAL = 4;

/** 'YYYY-MM-DD' → millis at local noon, which is the only safe way to read one. */
export function dayMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return Number.isNaN(at.getTime()) ? null : at.getTime();
}

/** Whole days from `now` to a 'YYYY-MM-DD'. Negative is in the past. */
export function daysUntil(ymd, now = Date.now()) {
  const at = dayMs(ymd);
  if (at === null) return null;
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  return Math.round((at - today.getTime()) / DAY);
}

/** Whole days since a timestamp of any of the shapes leads carry. */
export function daysSince(value, now = Date.now()) {
  const at = whenOf(value);
  if (at === null) return null;
  return Math.floor((now - at) / DAY);
}

/**
 * Lead in → assessment booked, in days. Vin's headline number, goal <4.
 *
 * Measured to the assessment DATE rather than to when it was booked,
 * because that is the wait the family experiences and the one the sheet
 * reports.
 */
export function daysToAssessment(lead) {
  const born = whenOf(lead?.createdAt);
  const at = dayMs(lead?.assessmentOn);
  if (born === null || at === null) return null;
  const from = new Date(born);
  from.setHours(12, 0, 0, 0);
  return Math.round((at - from.getTime()) / DAY);
}

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

/** "the Geci family", or the child, or something rather than nothing. */
export function familyLabel(lead) {
  const parent = String(lead?.parentName || '').trim();
  const child = String(lead?.childName || '').trim();
  if (parent && child) return `${parent} · ${child}`;
  return parent || child || 'Unnamed lead';
}

/**
 * ONE ITEM OF THE WORKLIST.
 *
 * `why` is a sentence, not a label. The difference matters: a column
 * headed "Follow up" with a date in it tells somebody there is work;
 * "Assessed 3 days ago and hasn't decided" tells them what to say when
 * the parent picks up. The spreadsheet got this right by having a Notes
 * column people actually wrote in, and the thing to preserve is that the
 * screen talks the way the staff do.
 */
const item = (lead, kind, urgency, why, dueOn = null) => ({
  id: lead.id, lead, kind, urgency, why, dueOn,
});

/**
 * Urgency, low number first. Someone walking through the door today
 * outranks a lead that has been quiet for a week, however annoying the
 * week is.
 */
export const URGENCY = {
  today: 0, overdue: 1, soon: 2, stale: 3,
};

/**
 * What needs doing about this one lead right now, or null.
 *
 * AT MOST ONE ITEM PER LEAD, deliberately. A family that no-showed AND
 * has an overdue follow-up is one phone call, and a worklist that lists
 * them twice is a worklist people stop trusting the length of. The
 * checks are in the order a person would think of them.
 */
export function actionFor(lead, now = Date.now()) {
  if (!lead || lead.status === 'enrolled' || lead.status === 'lost') return null;
  // ARCHIVED IS NOT WORK. Importing eleven years of Radius leads put 687
  // families on this list, every one of them "nobody has booked them in",
  // going back to 2015 — a call sheet nobody can use and therefore
  // nobody does. History stays in the tracker; it does not ring a phone.
  if (lead.archived === true) return null;

  const name = familyLabel(lead);
  const who = firstName(lead.parentName) || name;
  const outcome = lead.assessmentOutcome || (lead.assessmentOn ? 'booked' : null);

  // ── Somebody is coming in ──
  if (outcome === 'booked' && lead.assessmentOn) {
    const days = daysUntil(lead.assessmentOn, now);
    if (days === 0) return item(lead, 'assessment-today', URGENCY.today, `Assessment today${lead.tourBy ? ` — ${lead.tourBy} is touring` : ' — nobody is down to tour them'}.`, lead.assessmentOn);
    if (days === 1) return item(lead, 'assessment-tomorrow', URGENCY.soon, 'Assessment tomorrow. Confirm they are still coming.', lead.assessmentOn);
    // The appointment has been and gone and nobody said what happened.
    if (days !== null && days < 0) {
      return item(lead, 'assessment-unrecorded', URGENCY.overdue,
        `Assessment was ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago and the outcome is blank. Did they come in?`,
        lead.assessmentOn);
    }
  }

  // ── They did not turn up, or pulled out ──
  if (outcome === 'no-show') {
    return item(lead, 'no-show', URGENCY.overdue, `${who} did not turn up. Rebook it before the week is out.`, lead.assessmentOn);
  }
  if (outcome === 'cancelled') {
    return item(lead, 'cancelled', URGENCY.overdue, `${who} cancelled. Worth one call to find another time.`, lead.assessmentOn);
  }

  // ── A date somebody set by hand ──
  const due = daysUntil(lead.followUpOn, now);
  if (due !== null && due <= 0) {
    return item(lead, 'follow-up-due', due < 0 ? URGENCY.overdue : URGENCY.today,
      due === 0 ? 'Follow-up due today.' : `Follow-up was due ${Math.abs(due)} day${Math.abs(due) === 1 ? '' : 's'} ago.`,
      lead.followUpOn);
  }

  // ── Assessed, and nobody has asked them yet ──
  if (lead.status === 'assessed' && outcome !== 'booked') {
    const since = daysSince(lead.assessedAt, now);
    if (since !== null && since >= DECIDE_WITHIN_DAYS) {
      return item(lead, 'assessed-undecided', URGENCY.overdue,
        `Assessed ${since} days ago and still undecided. Ask them where they have got to.`);
    }
  }

  // ── In, but never booked in ──
  if (!lead.assessmentOn && !outcome) {
    const age = daysSince(lead.createdAt, now);
    if (age !== null && age >= BOOK_WITHIN_DAYS) {
      return item(lead, 'no-assessment', age >= BOOK_WITHIN_DAYS * 2 ? URGENCY.overdue : URGENCY.stale,
        lead.status === 'new'
          ? `In ${age} days and nobody has reached them yet.`
          : `Contacted, but ${age} days in with no assessment booked.`);
    }
  }

  return null;
}

/**
 * The whole worklist, most urgent first, then by how long it has waited.
 */
export function worklist(leads, now = Date.now()) {
  const out = [];
  for (const lead of leads || []) {
    const it = actionFor(lead, now);
    if (it) out.push(it);
  }
  return out.sort((a, b) => (
    a.urgency - b.urgency
    || (daysSince(b.lead.createdAt, now) ?? 0) - (daysSince(a.lead.createdAt, now) ?? 0)
    || familyLabel(a.lead).localeCompare(familyLabel(b.lead))
  ));
}

/** The worklist, grouped by kind, for a screen that wants headings. */
export function worklistByKind(leads, now = Date.now()) {
  const groups = new Map();
  for (const it of worklist(leads, now)) {
    if (!groups.has(it.kind)) groups.set(it.kind, []);
    groups.get(it.kind).push(it);
  }
  return [...groups.entries()].map(([kind, items]) => ({ kind, items }));
}

/** Only the ones a named person owns. '' means nobody is on it. */
export function ownedBy(items, person) {
  const want = String(person || '').trim().toLowerCase();
  return (items || []).filter(it => String(it.lead.assignedTo || '').trim().toLowerCase() === want);
}

/** Leads nobody is down to work. The thing a director checks on a Monday. */
export function unassigned(leads) {
  return (leads || []).filter(l => (
    !String(l.assignedTo || '').trim()
    && l.status !== 'enrolled' && l.status !== 'lost'
  ));
}

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * The block of numbers under Vin's table, computed the way he computes
 * them — and each one carrying how many leads it was measured on, so a
 * rate can never quietly mean "the two rows that had the fields".
 */
export function monthKpis(leads, now = Date.now()) {
  const rows = (leads || []).filter(l => l.status !== undefined);
  const assessed = rows.filter(l => ['attended'].includes(l.assessmentOutcome) || l.status === 'assessed' || l.status === 'enrolled');
  const enrolled = rows.filter(l => l.status === 'enrolled');
  const noShows = rows.filter(l => l.assessmentOutcome === 'no-show');
  const cancelled = rows.filter(l => l.assessmentOutcome === 'cancelled');
  const never = rows.filter(l => !l.assessmentOn && !l.assessmentOutcome);
  const waits = rows.map(daysToAssessment).filter(n => n !== null && n >= 0);

  const rate = (n, d) => (d > 0 ? n / d : null);

  return {
    leads: rows.length,
    assessed: assessed.length,
    enrolled: enrolled.length,
    noShows: noShows.length,
    cancelled: cancelled.length,
    noAssessmentBooked: never.length,
    // Rates are null, never 0, when there is nothing to divide by —
    // "0%" and "nothing happened yet" are different facts.
    assessedRate: rate(assessed.length, rows.length),
    conversionRate: rate(enrolled.length, rows.length),
    assessedToEnrolled: rate(enrolled.length, assessed.length),
    daysToAssessment: mean(waits),
    daysToAssessmentSample: waits.length,
    meetsAssessmentGoal: waits.length > 0 ? mean(waits) <= DAYS_TO_ASSESSMENT_GOAL : null,
    now,
  };
}

/**
 * Tours and assessments per person, the way the KPI sheet counts them.
 *
 * `field` is 'tourBy' or 'assessedBy'. Vin's sheet credits BOTH names in
 * "Sabrina / Vin", so a slash-separated cell gives each of them the tour
 * — which is what the two of them did.
 */
export function scoreboard(leads, field) {
  const tally = new Map();
  for (const lead of leads || []) {
    const raw = String(lead?.[field] || '').trim();
    if (!raw) continue;
    for (const part of raw.split('/')) {
      const person = part.trim();
      if (!person) continue;
      const row = tally.get(person) || { person, total: 0, enrolled: 0 };
      row.total += 1;
      if (lead.status === 'enrolled') row.enrolled += 1;
      tally.set(person, row);
    }
  }
  return [...tally.values()]
    .map(r => ({ ...r, rate: r.total > 0 ? r.enrolled / r.total : null }))
    .sort((a, b) => b.enrolled - a.enrolled || b.total - a.total || a.person.localeCompare(b.person));
}
