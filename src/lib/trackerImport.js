/**
 * trackerImport.js — Vin's Lead Tracker workbook, into Ratio.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE PEOPLE, NOT JUST THE LAYOUT.
 *
 * lib/leadTracker.js makes Ratio LOOK like the spreadsheet. This reads the
 * spreadsheet itself — the real 204 families across June to October — so
 * the screen is not a convincing empty copy of a sheet somebody is still
 * keeping in the other window.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * COLUMNS ARE FOUND BY NAME, NEVER BY POSITION. The tabs disagree with
 * each other: June/August call column D "Lead Call Initial/Date", July
 * calls it "Column 4", September and October call it "Last Contact".
 * August and earlier carry a "Why?" column that September dropped, which
 * moves Days to Assessment from column 12 to column 11. Reading by index
 * would silently import the wrong column for three tabs out of five.
 *
 * A ROW IS A ROW ONLY IF IT HAS A CREATED DATE. Underneath the rows every
 * tab has a summary block — "No assessment booked:", "Tours:", then a
 * name per staff member — and those have text in the first column too.
 * Requiring a real date in Created Date is what separates Rahul the lead
 * from Rahul the row of the tours table.
 *
 * WHAT THE SHEET SAID IS KEPT VERBATIM, under `tracker`. Three of its
 * columns hold more than Ratio's own fields can:
 *   - "Cold" is an Enrolled? value Ratio has no status for.
 *   - "Remedial, ex-Kumon" is richer than the reason dropdown.
 *   - "VB 7/16" is a person AND a date in one cell.
 * Each is stored raw so the tracker can print exactly what the sheet
 * printed, while Ratio's own fields carry the version the rest of the app
 * can reason about. Nothing is lost to make it fit.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own, no xlsx.
 */

import { LEAD_REASONS } from './leadFollowUp';

/** The header that identifies a tracker tab at all. */
const NAME_HEADER = /lead name/i;

const clean = (v) => String(v === null || v === undefined ? '' : v).trim();

/** Collapses the newline inside "Lead Call\nInitial/Date". */
const flat = (v) => clean(v).replace(/\s+/g, ' ').toLowerCase();

/**
 * Which column is which, resolved from the header row by name.
 * Order matters: "Assessment Date" must be claimed before "Notes" looks
 * at "Assessment Notes", or one header answers to both.
 */
const COLUMN_RULES = [
  ['name',     h => NAME_HEADER.test(h)],
  ['created',  h => h.startsWith('created date')],
  ['assess',   h => h.startsWith('assessment date')],
  ['notes',    h => h.endsWith('notes')],
  ['contact',  h => h.startsWith('last contact') || h.startsWith('lead call') || h === 'column 4'],
  ['reason',   h => h.startsWith('trigger')],
  ['tour',     h => h.startsWith('tour by')],
  ['assessor', h => h.startsWith('assessor')],
  ['enrolled', h => h.startsWith('enrolled?')],
  ['why',      h => h.startsWith('why?')],
];

export function headerMap(row) {
  const cols = {};
  const headers = (row || []).map(flat);
  for (const [key, test] of COLUMN_RULES) {
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] && test(headers[i]) && !Object.values(cols).includes(i)) {
        cols[key] = i;
        break;
      }
    }
  }
  return cols;
}

const pad = (n) => String(n).padStart(2, '0');

/** A cell that may be a real Date, an Excel serial, or a typed string. */
export function readDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 20000) {
    // Excel serial: days since 1899-12-30, read as a UTC instant and then
    // printed in UTC — a serial carries no timezone, so converting it
    // through the local one is what shifts dates by a day.
    const at = new Date(Math.round((value - 25569) * 86400000));
    return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  }
  const s = clean(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return '';
}

/**
 * "VB 7/16" → the 16th of July, in the year the lead was created.
 *
 * The column is initials plus a date with no year, which is unambiguous
 * on a tab headed JULY and nowhere else. "Open" and "N/A" are not dates;
 * they are somebody saying the call has not happened, and they come back
 * as no date rather than as a guess.
 */
export function readContact(value, year) {
  const s = clean(value);
  if (!s || /^(open|n\/a|na|-)$/i.test(s)) return { on: '', raw: s };
  const exact = readDate(value);
  if (exact) return { on: exact, raw: s };
  const md = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(s);
  if (md && year) {
    const m = Number(md[1]); const d = Number(md[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { on: `${year}-${pad(m)}-${pad(d)}`, raw: s };
  }
  return { on: '', raw: s };
}

/**
 * The assessment cell. NS and CA are outcomes typed into a date column,
 * which is the whole reason Ratio grew an assessmentOutcome field.
 */
export function readAssessment(value) {
  const s = clean(value);
  if (/^ns$/i.test(s)) return { on: '', outcome: 'no-show' };
  if (/^ca$/i.test(s)) return { on: '', outcome: 'cancelled' };
  if (/^(n\/a|na)$/i.test(s)) return { on: '', outcome: '' };
  const on = readDate(value);
  return { on, outcome: '' };
}

/**
 * "9/1: Extremely pleasant" → one write-up entry, dated.
 *
 * A cell often holds several visits, one per line, each stamped M/D in
 * the house style. They are split so each becomes its own entry rather
 * than one wall of text, and a line with no stamp still becomes an entry
 * — losing a note because it was typed without a date would be worse.
 */
export function readNotes(value, year) {
  const s = clean(value);
  if (!s) return [];
  const out = [];
  for (const line of s.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const m = /^(\d{1,2})\s*\/\s*(\d{1,2})\s*[:.-]\s*(.*)$/.exec(text);
    if (m && year && Number(m[1]) <= 12) {
      out.push({ at: `${year}-${pad(Number(m[1]))}-${pad(Number(m[2]))}T12:00:00`, by: 'Lead Tracker', text: m[3].trim() });
    } else {
      out.push({ at: '', by: 'Lead Tracker', text });
    }
  }
  return out;
}

/** A who-did-this cell, with "N/A" read as nobody. */
const person = (v) => (/^(n\/?a|none|tbd|-|—)$/i.test(clean(v)) ? '' : clean(v));

/** "Rana Alahmad / Omar Mustafa" → the two names the column holds. */
export function readNames(value) {
  const s = clean(value);
  if (!s) return { parentName: '', childName: '' };
  const at = s.indexOf('/');
  if (at < 0) return { parentName: s, childName: '' };
  return { parentName: s.slice(0, at).trim(), childName: s.slice(at + 1).trim() };
}

/**
 * "Remedial, ex-Kumon" → the dropdown value nearest to it.
 *
 * The leading word is the one that carries the meaning; everything after
 * the comma is detail, and the detail is kept verbatim under `tracker`
 * rather than thrown away to make the enum fit.
 */
const REASON_WORDS = [
  [/ex-?kumon|ex-?sylvan|competitor|big brains|another (centre|center)/i, 'ex-competitor'],
  [/pre-?ib|advanced/i,                        'pre-ib'],
  [/return/i,                                  'returning'],
  [/sibling/i,                                 'sibling'],
  [/summer/i,                                  'summer'],
  [/homework/i,                                'homework-help'],
  [/exam|test prep|provincial|final/i,         'exam-prep'],
  [/confidence/i,                              'confidence'],
  [/remedial|falling behind|behind|struggl/i,  'remedial'],
  [/enrich|enjoy|prep for|ahead|gifted/i,      'enrichment'],
];

export function readReason(value) {
  const s = clean(value);
  if (!s) return '';
  for (const [re, key] of REASON_WORDS) if (re.test(s)) return key;
  return 'other';
}

/** The sheet's Enrolled? value → Ratio's own status. */
export function readStatus(enrolled, assess, assessed) {
  const s = clean(enrolled).toLowerCase();
  if (s === 'yes') return 'enrolled';
  // Cold is a family who stopped answering rather than one who said no.
  // Both are off the call sheet, which is what 'lost' means here; the
  // word itself survives verbatim under `tracker` so the column still
  // prints what the sheet printed.
  if (s === 'no' || s === 'cold') return 'lost';
  if (s === 'pending') return 'assessed';
  // Enrolled? left blank. A family who sat the assessment is Assessed
  // whether or not anybody got round to typing the outcome — that is the
  // state they are in, and it is the one the call sheet needs to chase.
  if (assessed) return 'assessed';
  if (assess.outcome === 'no-show' || assess.outcome === 'cancelled') return 'contacted';
  return assess.on ? 'contacted' : 'new';
}

/** A slug stable enough to re-import over, from the two things that identify a row. */
const slug = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

export const importId = (created, name) => `tracker_${created}_${slug(name)}`;

/**
 * One row of one tab → a lead document.
 * Returns null for anything that is not a row of the tracker.
 */
export function readRow(cells, cols, opts = {}) {
  const at = (key) => (cols[key] === undefined ? '' : cells[cols[key]]);

  const created = readDate(at('created'));
  // The summary block under the rows has text in the first column too.
  // A created date is what separates a family from a subtotal.
  if (!created) return null;
  const { parentName, childName } = readNames(at('name'));
  if (!parentName && !childName) return null;

  const year = Number(created.slice(0, 4));
  const assess = readAssessment(at('assess'));
  const contact = readContact(at('contact'), year);
  const notes = readNotes(at('notes'), year);
  const enrolledRaw = clean(at('enrolled'));
  const reasonRaw = clean(at('reason'));

  // Attended is a conclusion the sheet records sideways: a date in the
  // assessment column AND somebody having written an outcome beside it.
  // A date with the rest of the row blank is a booking, not a visit.
  const assessed = Boolean(assess.on) && (Boolean(enrolledRaw) || notes.length > 0 || Boolean(person(at('assessor'))));
  const status = readStatus(enrolledRaw, assess, assessed);
  const outcome = assess.outcome || (assess.on ? (assessed ? 'attended' : 'booked') : '');

  const stamp = (ymd) => (ymd ? `${ymd}T12:00:00` : null);

  return {
    id: importId(created, `${parentName} ${childName}`),
    parentName,
    childName,
    status,
    source: 'other',
    reason: readReason(reasonRaw),
    // "N/A" in a who-did-this column means nobody did, not a person
    // called N/A — and splitting it on the slash invents two staff
    // members. It is stored as nothing, which is what it says.
    assignedTo: person(at('tour')),
    tourBy: person(at('tour')),
    assessedBy: person(at('assessor')),
    assessmentOn: assess.on,
    assessmentOutcome: outcome,
    lastContactOn: contact.on,
    outcomeReason: clean(at('why')),
    assessmentNotes: notes.filter(n => n.at).map(n => ({ ...n })),
    notes: notes.filter(n => !n.at).map(n => n.text).join('\n'),
    createdAt: stamp(created),
    contactedAt: stamp(contact.on),
    assessedAt: assessed ? stamp(assess.on) : null,
    enrolledAt: status === 'enrolled' ? stamp(assess.on || created) : null,
    lostAt: status === 'lost' ? stamp(assess.on || created) : null,
    // Set per tab in readTrackerWorkbook, from the month the tab covers.
    archived: false,
    // Verbatim, so the tracker prints what the sheet printed.
    tracker: {
      enrolled: enrolledRaw,
      reason: reasonRaw,
      lastContact: contact.raw,
      sheet: clean(opts.sheet),
      // Filled in by readTrackerWorkbook once the whole tab is read —
      // see the note there about which month a row belongs to.
      month: '',
    },
  };
}

/**
 * Every tracker tab in the workbook.
 *
 * `sheets` is [{ name, rows }] with rows as arrays of cell values, header
 * row included — which is what xlsx gives for `{ header: 1 }`. A sheet
 * with no recognisable header row is skipped rather than guessed at, so
 * handing it the whole workbook (KPIs, STPS, Follow-up and all) is safe.
 */
export function readTrackerWorkbook(sheets, opts = {}) {
  const leads = [];
  const bySheet = [];
  const seen = new Set();
  let duplicates = 0;

  for (const sheet of sheets || []) {
    const rows = sheet?.rows || [];
    const headerAt = rows.findIndex(r => (r || []).some(c => NAME_HEADER.test(clean(c))));
    if (headerAt < 0) continue;
    const cols = headerMap(rows[headerAt]);
    if (cols.name === undefined || cols.created === undefined) continue;

    const onThisSheet = [];
    for (let i = headerAt + 1; i < rows.length; i++) {
      const lead = readRow(rows[i] || [], cols, { ...opts, sheet: sheet.name });
      if (lead) onThisSheet.push(lead);
    }
    if (onThisSheet.length === 0) continue;

    // WHICH MONTH A ROW BELONGS TO IS THE TAB IT IS ON, not its created
    // date. The June tab carries families who enquired on 26 May and were
    // assessed in June; filing them under May would scatter his month
    // across two tabs and make the totals under each one disagree with
    // his. The tab's month is the commonest created month on it, which
    // needs no guessing at the sheet's name or year.
    const tally = new Map();
    for (const lead of onThisSheet) {
      const m = lead.createdAt.slice(0, 7);
      tally.set(m, (tally.get(m) || 0) + 1);
    }
    const month = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0][0];
    if (opts.from && month < opts.from) continue;

    for (const lead of onThisSheet) {
      lead.tracker.month = month;
      // Archived is about age, and age is the month it was worked in.
      lead.archived = Boolean(opts.liveFrom) && month < opts.liveFrom.slice(0, 7);
      // The same family can appear on two tabs — a June lead chased into
      // July. The later tab is the one that has been kept up, so it wins.
      if (seen.has(lead.id)) duplicates += 1;
      seen.add(lead.id);
      leads.push(lead);
    }
    bySheet.push({ sheet: sheet.name, month, rows: onThisSheet.length });
  }

  // Last write wins for a repeated family, so put the later tab last.
  const byId = new Map();
  for (const lead of leads) byId.set(lead.id, lead);
  const unique = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    leads: unique,
    bySheet,
    duplicates,
    live: unique.filter(l => !l.archived).length,
    archived: unique.filter(l => l.archived).length,
    enrolled: unique.filter(l => l.status === 'enrolled').length,
    months: [...new Set(unique.map(l => l.tracker.month))].sort(),
  };
}
