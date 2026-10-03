/**
 * leadTracker.js — Vin's Lead Tracker, read back out of Ratio.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * A CARBON COPY OF THE SPREADSHEET, NOT AN INTERPRETATION OF IT.
 *
 * The sheet is one tab per month, twelve columns, and a summary block
 * under the rows. People have worked it every day for a year; they know
 * where their eye goes. So this module produces those columns, in that
 * order, with the same values in the same shorthand — NS for a no-show,
 * CA for a cancellation, "Yes / Pending / No" for the enrolled column,
 * blank where the sheet leaves blank.
 *
 * It needed no new fields. Ratio was already storing all twelve; they
 * were just never shown together in the arrangement the centre thinks
 * in. Week Ending is the only derived one, and it is derived rather than
 * stored because it is a function of the created date and nothing else.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * NOTHING IS INVENTED. A blank cell in the sheet is a blank cell here.
 * Days to Assessment is absent, not zero, when there is no assessment to
 * have waited for; the rates under the table are null, not 0%, when
 * there is nothing to divide by.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

import { whenOf } from './leadAnalytics';
import { daysToAssessment, scoreboard, splitPeople } from './leadFollowUp';
import { ymdOf } from './leadStory';

/**
 * The first month the tracker shows.
 *
 * Importing eleven years of Radius history gave this screen 130 monthly
 * tabs going back to December 2015 — two hundred pixels of tab list above
 * the thing anybody opened it for. June 2026 is where Vin's own workbook
 * starts, so it is where the tabs start. Nothing is hidden: `all` brings
 * the whole archive back.
 *
 * Raise it when the workbook rolls over to a new year.
 */
export const TRACKER_FROM = '2026-06';

/** The sheet's columns, left to right, exactly as its header row reads. */
export const TRACKER_COLUMNS = [
  { key: 'name',     label: 'Lead Name/Student Name' },
  { key: 'created',  label: 'Created Date',    date: true },
  { key: 'week',     label: 'Week Ending',     date: true },
  { key: 'contact',  label: 'Last Contact' },
  { key: 'reason',   label: 'Trigger/Reason' },
  { key: 'assess',   label: 'Assessment Date', date: true },
  { key: 'notes',    label: 'Notes',           wide: true },
  { key: 'tour',     label: 'Tour by' },
  { key: 'assessor', label: 'Assessor' },
  { key: 'enrolled', label: 'Enrolled?' },
  { key: 'why',      label: 'Why?' },
  { key: 'days',     label: 'Days to Assessment', number: true },
];

/**
 * The Saturday on or after a date — the sheet's Week Ending.
 *
 * Read off the tabs rather than guessed: 1 Oct and 2 Oct both end 3 Oct,
 * 26 May ends 30 May, 29 Aug ends 29 Aug. Every one of those is a
 * Saturday, including the dates that already are one.
 */
export function weekEndingOf(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + ((6 - d.getDay()) % 7));   // 6 = Saturday
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The enrolled column. The sheet's own vocabulary, mapped from the only
 * thing Ratio knows — a lead that has been assessed and not decided is
 * what "Pending" means on the sheet, and a lead nobody has got to yet is
 * blank there too.
 */
export function enrolledCell(lead) {
  // An imported row prints the word the sheet printed. "Cold" is a value
  // Ratio has no status for — the family stopped answering rather than
  // said no — and rendering it as "No" would quietly rewrite his data.
  const raw = clean(lead?.tracker?.enrolled);
  if (raw) return raw;
  if (lead?.status === 'enrolled') return 'Yes';
  if (lead?.status === 'lost') return 'No';
  if (lead?.status === 'assessed') return 'Pending';
  return '';
}

/**
 * The assessment column. NS and CA are values in this column on the real
 * sheet, not missing dates — a no-show and a family who never booked
 * looked identical before Ratio had somewhere to put the difference.
 */
const clean = (v) => String(v === null || v === undefined ? '' : v).trim();

export function assessmentCell(lead) {
  if (lead?.assessmentOutcome === 'no-show') return 'NS';
  if (lead?.assessmentOutcome === 'cancelled') return 'CA';
  return lead?.assessmentOn || '';
}

/**
 * The notes column, in the sheet's own house style: each entry stamped
 * with the day it was written, newest last, one per line.
 *   "9/1: Extremely pleasant, mum sold on the spot"
 */
export function notesCell(lead) {
  const notes = (lead?.assessmentNotes || []).filter(n => n && n.text);
  if (notes.length === 0) return '';
  return notes.map((n) => {
    const on = ymdOf(n.at);
    if (!on) return n.text;
    const [, mm, dd] = on.split('-');
    return `${Number(mm)}/${Number(dd)}: ${n.text}`;
  }).join('\n');
}

/** One row of the sheet. Every cell a string, except the day count. */
export function trackerRow(lead) {
  const created = ymdOf(lead?.createdAt);
  const parent = String(lead?.parentName || '').trim();
  const child = String(lead?.childName || '').trim();
  return {
    id: lead?.id,
    lead,
    name: parent && child ? `${parent} / ${child}` : parent || child || '',
    created,
    week: weekEndingOf(created),
    // "VB 7/16" is a person and a date in one cell, and "Remedial,
    // ex-Kumon" is richer than the dropdown. Both print as typed.
    contact: clean(lead?.tracker?.lastContact) || lead?.lastContactOn || '',
    contactIsDate: !clean(lead?.tracker?.lastContact),
    reason: clean(lead?.tracker?.reason) || lead?.reason || '',
    assess: assessmentCell(lead),
    notes: notesCell(lead),
    tour: lead?.tourBy || '',
    assessor: lead?.assessedBy || '',
    enrolled: enrolledCell(lead),
    why: lead?.outcomeReason || '',
    // Absent, not zero: a lead with no assessment has not waited 0 days
    // for one, it has no measurement.
    days: daysToAssessment(lead),
  };
}

/**
 * Which month's tab a lead belongs on.
 *
 * For an imported row that is the tab it was typed on, not the day it
 * came in: his June tab carries families who enquired on 26 May and were
 * worked in June, and filing those under May would split his month in
 * two and make the totals disagree with the ones he reads. Everything
 * else falls back to the day it came in.
 */
export const monthOf = (lead) => clean(lead?.tracker?.month) || ymdOf(lead?.createdAt).slice(0, 7);

/**
 * Every month that has leads in it, newest first — the sheet's tabs.
 * Floored at TRACKER_FROM unless `all`, which reveals the imported
 * archive behind it.
 */
export function trackerMonths(leads, { all = false } = {}) {
  const seen = new Set();
  for (const l of leads || []) {
    const m = monthOf(l);
    if (m && (all || m >= TRACKER_FROM)) seen.add(m);
  }
  return [...seen].sort().reverse();
}

/** How many months the floor is holding back, so the toggle can say so. */
export function monthsBefore(leads) {
  const seen = new Set();
  for (const l of leads || []) {
    const m = monthOf(l);
    if (m && m < TRACKER_FROM) seen.add(m);
  }
  return seen.size;
}

/** 'YYYY-MM' → 'September 2026'. */
export function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  return new Date(Number(m[1]), Number(m[2]) - 1, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * One month's rows, oldest first — the order the sheet is typed in, and
 * the order somebody reading down it expects.
 */
export function trackerRows(leads, monthKey) {
  return (leads || [])
    .filter(l => !monthKey || monthOf(l) === monthKey)
    .map(trackerRow)
    .sort((a, b) => a.created.localeCompare(b.created) || a.name.localeCompare(b.name));
}

const rate = (n, d) => (d > 0 ? n / d : null);

/**
 * The block under the rows — HIS numbers, by HIS definitions.
 *
 * Every one of these is a formula read out of the June tab rather than a
 * sensible-looking metric invented to sit near them, because these are
 * the numbers the centre is judged on and a dashboard that quietly means
 * something slightly different is worse than no dashboard:
 *
 *   No assessment booked      COUNTBLANK(Assessment Date)   out of LEADS
 *   Cancellations / no shows  COUNTIF("*NS*") + ("*CA*")    out of ASSESSMENTS
 *   Days to assessment        AVERAGE(Days to Assessment)
 *   Leads Assessed Rate       (assessments - broken) / leads
 *   Leads Converted           COUNTIF(Enrolled?, "Yes")
 *   Lead Conversion Rate      converted / assessments
 *   Assessment Conversion     converted / non-blank Enrolled?
 *
 * NOTE THE TWO DENOMINATORS ARE DIFFERENT, and deliberately so: the sheet
 * prints "2 out of 48" against one and "7 out of 46" against the other.
 * Assessments is every row with ANYTHING in the assessment column — a
 * date, an NS or a CA — which is why a no-show counts towards it.
 */
export function trackerSummary(rows) {
  const leads = (rows || []).map(r => r.lead).filter(Boolean);
  const total = leads.length;

  // Anything typed in the assessment column: a date, NS, or CA.
  const assessments = leads.filter(l => (
    Boolean(l.assessmentOn)
    || l.assessmentOutcome === 'no-show'
    || l.assessmentOutcome === 'cancelled'
  )).length;
  const noAssessment = total - assessments;
  const broken = leads.filter(l => l.assessmentOutcome === 'no-show' || l.assessmentOutcome === 'cancelled').length;

  // "Yes" in the enrolled column — the sheet's own word, so an imported
  // row counts exactly as it counted there.
  const converted = (rows || []).filter(r => r.enrolled === 'Yes').length;
  const decided = (rows || []).filter(r => clean(r.enrolled)).length;

  const waits = (rows || []).map(r => r.days).filter(n => n !== null && n >= 0);

  return {
    leads: total,
    total,
    assessments,
    noAssessment,
    broken,
    converted,
    decided,
    // Rates are null, never 0, when there is nothing to divide by —
    // "0%" and "nothing happened yet" are different facts.
    leadsAssessedRate:       rate(assessments - broken, total),
    leadConversionRate:      rate(converted, assessments),
    assessmentConversionRate: rate(converted, decided),
    noAssessmentRate:        rate(noAssessment, total),
    brokenRate:              rate(broken, assessments),
    daysToAssessment: waits.length > 0 ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
    daysToAssessmentSample: waits.length,
    tours: scoreboard(leads, 'tourBy'),
    assessors: scoreboard(leads, 'assessedBy'),
  };
}

/**
 * The KPI Tracking tab: tours and enrolments per person per month, with
 * a total — the year at a glance rather than one month at a time.
 *
 * Its own tab in the workbook, because "how is Sabrina doing" is a
 * question about the year and the monthly block cannot answer it.
 */
export function trackerKpis(leads, months) {
  const want = [...(months || [])].sort();
  const build = (field) => {
    const byPerson = new Map();
    for (const lead of leads || []) {
      const month = monthOf(lead);
      if (!want.includes(month)) continue;
      // "Sabrina / Vin" credits both, which is what the two of them did.
      // "N/A" credits nobody — see splitPeople().
      for (const person of splitPeople(lead?.[field])) {
        const row = byPerson.get(person) || { person, months: {}, total: 0, enrolled: 0 };
        row.months[month] = (row.months[month] || 0) + 1;
        row.total += 1;
        if (lead.status === 'enrolled') row.enrolled += 1;
        byPerson.set(person, row);
      }
    }
    return [...byPerson.values()]
      .map(r => ({ ...r, rate: rate(r.enrolled, r.total) }))
      .sort((a, b) => b.total - a.total || a.person.localeCompare(b.person));
  };
  return { months: want, tours: build('tourBy'), assessments: build('assessedBy') };
}

/** Newest createdAt in a set — "last updated" for the month. */
export function lastTouched(leads) {
  let best = null;
  for (const l of leads || []) {
    const at = whenOf(l?.createdAt);
    if (at !== null && (best === null || at > best)) best = at;
  }
  return best;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The month as a CSV, columns in the sheet's order.
 *
 * Because the sheet is not going away the day Ratio copies it, and a
 * tracker you cannot get back out of is one people keep a parallel copy
 * of — which is the problem this is meant to end.
 */
export function trackerCsv(rows) {
  const head = TRACKER_COLUMNS.map(c => csvCell(c.label)).join(',');
  const body = (rows || []).map(r => TRACKER_COLUMNS
    .map(c => csvCell(c.key === 'days' ? (r.days ?? '') : r[c.key]))
    .join(','));
  return [head, ...body].join('\n');
}
