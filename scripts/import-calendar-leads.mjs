#!/usr/bin/env node
/**
 * The Google Calendar's assessment bookings, in as leads.
 *
 *   npx vite-node scripts/import-calendar-leads.mjs                  # dry run
 *   npx vite-node scripts/import-calendar-leads.mjs --apply
 *   npx vite-node scripts/import-calendar-leads.mjs --apply --from=2026-07-01
 *
 * Run from inside `Ratio Website/`. It is .mjs and goes through vite-node
 * because it reuses src/lib/icsImport.js rather than parsing the calendar
 * a second time — that module already knows this centre's exact format,
 * including the snake_case description keys and the "[NOT COMING]" title.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LEADS ONLY. It does NOT write centerIntakes.
 *
 * centerIntakes is what holds an hour off the public booking page, and
 * writing a back-fill of three months into it would take slots off sale
 * for appointments that have already happened. The centre asked for the
 * people, not the bookings.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * IT GUESSES NO STATUSES. Every lead comes in as Contacted with the
 * assessment date the calendar shows, and the outcome is either
 * `cancelled` (the title said so) or BLANK. A blank outcome on a past
 * date is what makes the call sheet ask "that was N days ago — did they
 * come in?", which is exactly the question being handed back to the
 * centre. Marking them Assessed would answer it on their behalf.
 *
 * `createdAt` is the booking's own "Created:" line, not the day the file
 * was read — otherwise every lead looks like it enquired today and
 * "days to assessment" is nonsense.
 *
 * NOBODY IS RUNG BY THIS. `contactedAt` is left empty: these families
 * booked themselves online, and stamping a call that never happened
 * would draw a Lead Call on a timeline nobody made.
 *
 * Re-runnable: each lead is keyed on the calendar event's own UID.
 */
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseIcs, buildRows, labelledFields } from '../src/lib/icsImport.js';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

const arg = (name, fallback) =>
  (process.argv.find(a => a.startsWith(`--${name}=`)) || `--${name}=${fallback}`).split('=').slice(1).join('=');

const APPLY = process.argv.includes('--apply');
const FROM = arg('from', '2026-07-01');
const CENTER = arg('center', 'langley');
const FILE = arg('file', path.join(process.env.HOME, 'Downloads',
  'langleybc@mathnasium.ca.ical', 'langleybc@mathnasium.ca.ics'));

function serviceAccount() {
  const dir = path.resolve(process.cwd(), '..', 'Pricing and Codes');
  const hit = readdirSync(dir).find(f => /^mathnasium-langley-firebase-adminsdk-.*\.json$/.test(f));
  if (!hit) throw new Error(`No service account JSON in ${dir}`);
  return require(path.join(dir, hit));
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** "Monday June 29, 2026 7:14 AM" → '2026-06-29'. */
export function createdDay(value) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(String(value || ''));
  if (!m) return '';
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi < 0) return '';
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** A calendar UID, made safe for a Firestore document id. */
const idFor = (uid) => `gcal_${String(uid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120)}`;

const chunk = (xs, n) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const text = await readFile(FILE, 'utf8');
const rows = buildRows(parseIcs(text), { from: FROM });
const today = todayISO();

const leads = [];
const noName = [];

for (const r of rows) {
  if (!r.include || r.target !== 'intake') continue;
  const parent = String(r.guardianName || '').trim();
  const child = String(r.childName || '').trim();
  // A lead with neither name on it is a blank row in the list. It is
  // counted and named here rather than written and wondered about later.
  if (!parent && !child) { noName.push(r); continue; }

  const fields = labelledFields(r.rawDescription || '');
  const created = createdDay(fields.created) || r.date;
  const cancelled = r.status === 'cancelled';

  leads.push({
    id: idFor(r.uid || `${r.date}-${child}`),
    parentName: parent,
    childName: child,
    childGrade: String(r.childGrade || ''),
    parentPhone: String(r.phone || ''),
    parentEmail: String(r.email || ''),
    status: 'contacted',
    source: 'apptoto',
    assessmentOn: r.date,
    // Cancelled when the title said so. Otherwise BLANK — including for
    // a date that has gone by, because whether they walked in is the
    // thing the centre is about to tell us, not something to assume.
    assessmentOutcome: cancelled ? 'cancelled' : '',
    createdOn: created,
    past: r.date < today,
    startTime: r.startTime || '',
    sourceSummary: r.rawSummary || '',
  });
}

const cancelled = leads.filter(l => l.assessmentOutcome === 'cancelled');
const past = leads.filter(l => l.past && !l.assessmentOutcome);
const upcoming = leads.filter(l => !l.past && !l.assessmentOutcome);
const byMonth = {};
for (const l of leads) byMonth[l.createdOn.slice(0, 7)] = (byMonth[l.createdOn.slice(0, 7)] || 0) + 1;

console.log(APPLY ? '\n*** APPLYING ***\n' : '\nDRY RUN — nothing written. Add --apply.\n');
console.log(`file     ${FILE}`);
console.log(`centre   ${CENTER}`);
console.log(`from     ${FROM}\n`);
console.log(`leads to write          ${leads.length}`);
console.log(`  cancelled / no-show   ${cancelled.length}`);
console.log(`  past, outcome blank   ${past.length}   <- the centre's triage list`);
console.log(`  still to come         ${upcoming.length}`);
console.log(`with a phone number     ${leads.filter(l => l.parentPhone).length}`);
console.log(`with an email           ${leads.filter(l => l.parentEmail).length}`);
console.log(`with a grade            ${leads.filter(l => l.childGrade).length}`);
console.log(`skipped, no name at all ${noName.length}`);
console.log(`\nby month enquired: ${JSON.stringify(byMonth)}`);
for (const r of noName) console.log(`  skipped: ${r.date} "${r.rawSummary.slice(0, 48)}"`);

console.log('\nfirst five:');
for (const l of leads.slice(0, 5)) {
  console.log(`  ${l.createdOn} -> ${l.assessmentOn} ${String(l.startTime).padEnd(5)} `
    + `${l.childName.padEnd(20)} | ${l.parentName.padEnd(20)} | gr ${String(l.childGrade).padEnd(3)} `
    + `| ${l.parentPhone.padEnd(13)} | ${l.assessmentOutcome || 'outcome blank'}`);
}

if (!APPLY) {
  console.log(`\nWould write ${leads.length} leads. Re-run with --apply.`);
  process.exit(0);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount()) });
const db = admin.firestore();
const col = db.collection('centers').doc(CENTER).collection('leads');

let written = 0;
for (const batchLeads of chunk(leads, 400)) {
  const batch = db.batch();
  for (const l of batchLeads) {
    const { id, createdOn, past: _past, startTime: _st, ...rest } = l;
    batch.set(col.doc(id), {
      ...rest,
      sourceDetail: 'Google Calendar',
      notes: '',
      reason: '',
      assignedTo: '',
      tourBy: '',
      assessedBy: '',
      followUpOn: '',
      lastContactOn: '',
      outcomeReason: '',
      enrolmentLinkSentOn: '',
      assessmentNotes: [],
      intakeId: null,
      archived: false,
      imported: 'google-calendar',
      // The day they actually enquired, off the booking's own Created
      // line — not the day this file was read.
      createdAt: new Date(`${createdOn}T12:00:00`),
      // Left null on purpose: they booked themselves online, and nobody
      // has rung them. See the note at the top.
      contactedAt: null,
      assessedAt: null,
      enrolledAt: null,
      lostAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      history: [{
        at: new Date().toISOString(),
        by: 'system',
        text: `Imported from Google Calendar — ${l.sourceSummary || 'Appointment Booked'} on ${l.assessmentOn}`,
      }],
    }, { merge: true });
    written += 1;
  }
  await batch.commit();
}
console.log(`\nDone. ${written} leads written to ${CENTER}.`);
process.exit(0);
