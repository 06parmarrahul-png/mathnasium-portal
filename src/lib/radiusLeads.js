/**
 * radiusLeads.js — eleven years of Langley's leads, read out of Radius.
 *
 * The export is one row per lead, 1,303 of them, December 2015 to today.
 * It is the centre's whole history of who enquired, what happened, and —
 * through the grade on the student — how old that child would be now.
 * Ratio had none of it: the funnel began the day the booking page shipped.
 *
 * WHAT THE FILE ACTUALLY LOOKS LIKE, measured rather than assumed:
 *
 *   1,303 rows, Centre always "LangleyBC"
 *   Lead Status   Assessed 335 · Open 245 · Assessment Pending 207 ·
 *                 Assessed - Declined Enrolment 175 · Inactive 138 ·
 *                 Contacted 115 · Do Not Contact 56 · Active 8 ·
 *                 Hold 6 · Visited 4 · blank 14
 *   Grade         College 377 (!) · blank 126 · the rest spread 1–12
 *   Rating        blank 1,212 · Hot 45 · Cold 34 · Warm 12
 *   Lead Source   free text, multi-valued, e.g. "Internet - Search Engine
 *                 Marketing (PPC and Organic), Other - Apptoto"
 *   phone 1,138 · email 1,041 · student name 1,180 · Last Contacted 800
 *
 * COLLEGE IS NOT A GRADE, it is Radius's catch-all, and it is 29% of the
 * file. Mathnasium teaches K–12; the centre's instruction was to drop
 * them, and they are dropped — counted and reported, never silently.
 *
 * DATES ARE DD/MM/YYYY. Read as American they are either wrong by months
 * or invalid, and 1/3/2026 is a date either way round — so there is no
 * crash to tell you, just eleven years of leads filed in the wrong month.
 *
 * PURE MODULE — no React, no Firebase, no file reading.
 */

import { LEAD_STATUSES } from './leads';

/** Radius's own status vocabulary → Ratio's five. */
const STATUS_MAP = {
  'open': 'new',
  'active': 'new',
  'visited': 'contacted',
  'contacted': 'contacted',
  'hold': 'contacted',
  'on hold': 'contacted',
  'assessment pending': 'contacted',
  'asmt. pending': 'contacted',
  'assessed': 'assessed',
  'assessed - declined enrolment': 'lost',
  'assessed & declined': 'lost',
  'inactive': 'lost',
  'do not contact': 'lost',
  'mail only': 'lost',
};

/**
 * What the Radius status said, kept verbatim alongside the mapped one.
 *
 * "Assessed - Declined Enrolment" and "Do Not Contact" both become `lost`,
 * and they are not the same thing at all — one is a family who came in and
 * said no, the other is a family who asked never to be rung again. Ratio's
 * five statuses are what the funnel counts; this is what a person reads
 * before picking up the phone, and losing it would be the whole point of
 * the import thrown away.
 */
export function mapStatus(raw) {
  const key = String(raw || '').trim().toLowerCase();
  const mapped = STATUS_MAP[key];
  if (mapped && LEAD_STATUSES.includes(mapped)) return mapped;
  return 'new';
}

/** Do-not-contact is a promise, not a status. It travels on its own flag. */
export function isDoNotContact(raw) {
  return String(raw || '').trim().toLowerCase() === 'do not contact';
}

/** 'College' and friends are not a school grade. */
export function isCollege(grade) {
  return /college|university|adult|post[- ]?sec/i.test(String(grade || ''));
}

/**
 * A school grade as a NUMBER, or null.
 *
 * Kindergarten and JK are real answers but they are not numbers, so they
 * come back as 0 and -1 — which keeps "one year on" arithmetic working
 * through the only part of school where the next grade has a different
 * kind of name.
 */
export function gradeNumber(grade) {
  const raw = String(grade || '').trim();
  if (!raw || isCollege(raw)) return null;
  if (/^jk|junior/i.test(raw)) return -1;
  if (/^k|kinder/i.test(raw)) return 0;
  const n = Number(raw.replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : null;
}

/** 'dd/mm/yyyy', a Date, or an Excel serial → 'YYYY-MM-DD'. */
export function readDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = String(value ?? '').trim();
  // DAY FIRST. The export is Canadian and 03/10/2026 is the third of
  // October; read the American way it is March, and nothing throws.
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return iso ? iso[0] : null;
}

/**
 * The source string, which is multi-valued free text, reduced to one of
 * Ratio's own sources — and kept whole in sourceDetail either way.
 */
export function mapSource(raw) {
  const s = String(raw || '').toLowerCase();
  if (/apptoto/.test(s)) return 'apptoto';
  if (/referral/.test(s)) return 'referral';
  if (/walk.?by|drive.?by|location|visibility/.test(s)) return 'walk-in';
  if (/social|facebook|instagram/.test(s)) return 'social';
  if (/event/.test(s)) return 'event';
  if (/internet|search engine|ppc|website/.test(s)) return 'website';
  if (/school/.test(s)) return 'referral';
  return 'other';
}

/**
 * EVERY IMPORTED LEAD ARRIVES ARCHIVED. All 926 of them.
 *
 * This started as a 90-day window and the window was the wrong idea.
 * Measured: 687 families on the call sheet with no window, 48 with one —
 * and those 48 were still Radius rows nobody in Ratio had ever worked,
 * on a list meant to say "ring these people today". Radius was the system
 * of record when they came in. Nobody is chasing a two-month-old Radius
 * lead off the back of an import.
 *
 * So the import is REFERENCE DATA. The call sheet starts empty and fills
 * with what actually happens next — a booking through Apptoto or the
 * website, a lead somebody adds, a call-back turned into one. That is a
 * live worklist rather than a backlog, and it is the difference between
 * a page people work and a page people stop opening.
 *
 * Nothing is lost: an archived lead keeps every field, shows in the
 * tracker behind one click, and anybody who disagrees about a particular
 * family can un-archive it.
 */

const clean = (v) => String(v ?? '').trim();

/**
 * One export row → the lead Ratio would have written, or a reason it was
 * skipped. Never both, and never a half-filled lead: a row with no name
 * at all is a row nobody can act on.
 */
export function readRow(row) {
  const name = clean(row['Lead Name']);
  const child = clean(row['Student Name']);
  const grade = clean(row['Grade']);

  if (isCollege(grade)) return { skip: 'college', name: name || child };
  if (!name && !child) return { skip: 'no-name' };

  const status = mapStatus(row['Lead Status']);
  const createdOn = readDate(row['Created Date']);
  return {
    lead: {
      // Reference data, not work. See the note at the top of the file.
      archived: true,
      parentName:  name,
      parentEmail: clean(row['Email']).toLowerCase(),
      parentPhone: clean(row['Mobile Phone']),
      childName:   child,
      childGrade:  grade,
      status,
      source:       mapSource(row['Lead Source']),
      sourceDetail: clean(row['Lead Source']),
      assignedTo:   '',
      lastContactOn: readDate(row['Last Contacted']) || '',
      // Everything Radius knew that Ratio has no column for, said in
      // words rather than dropped. The status especially: "Assessed -
      // Declined Enrolment" is not the same fact as "Do Not Contact",
      // and both land on `lost`.
      outcomeReason: clean(row['Lead Status']),
      doNotContact: isDoNotContact(row['Lead Status']),
      // What makes the re-engagement nudge possible at all: the grade
      // they were in, and the day that was true.
      importedGrade: gradeNumber(grade),
      importedGradeOn: createdOn,
      rating: clean(row['Rating']).toLowerCase() || '',
      source_radiusId: clean(row['Lead Id']),
      createdOn,
    },
  };
}

/**
 * The deterministic document id for an imported lead.
 *
 * Radius's own Lead Id, so re-running the import rewrites the same rows
 * instead of giving the centre a second copy of eleven years. A row with
 * no id falls back to its name and date, which is stable for the same
 * file and is the best that can be done.
 */
export function importId(lead) {
  const rid = clean(lead.source_radiusId);
  if (rid) return `radius_${rid}`;
  const key = `${lead.parentName}|${lead.childName}|${lead.createdOn || ''}`
    .toLowerCase().replace(/[^a-z0-9|]+/g, '');
  return `radius_x_${key}`.slice(0, 120);
}

/**
 * Read the whole export: what would be written, what would be skipped,
 * and the counts somebody should see BEFORE anything is written.
 */
export function readExport(rows) {
  const leads = [];
  const skipped = { college: 0, 'no-name': 0 };
  const byStatus = {};
  for (const row of rows || []) {
    const got = readRow(row);
    if (got.skip) { skipped[got.skip] = (skipped[got.skip] || 0) + 1; continue; }
    leads.push(got.lead);
    byStatus[got.lead.status] = (byStatus[got.lead.status] || 0) + 1;
  }
  const dates = leads.map(l => l.createdOn).filter(Boolean).sort();
  return {
    leads,
    skipped,
    total: (rows || []).length,
    byStatus,
    withPhone: leads.filter(l => l.parentPhone).length,
    withEmail: leads.filter(l => l.parentEmail).length,
    withGrade: leads.filter(l => l.importedGrade !== null).length,
    live: leads.filter(l => !l.archived).length,
    archived: leads.filter(l => l.archived).length,
    doNotContact: leads.filter(l => l.doNotContact).length,
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
  };
}
