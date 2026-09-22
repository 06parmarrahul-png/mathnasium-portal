#!/usr/bin/env node
/**
 * Undo a Google Calendar import.
 *
 *   node scripts/clear-calendar-import.cjs                 # dry run
 *   node scripts/clear-calendar-import.cjs --apply         # actually delete
 *   node scripts/clear-calendar-import.cjs --apply --all-entries
 *
 * Run it from inside `Ratio Website/` so firebase-admin resolves.
 *
 * WHAT IT WILL NOT TOUCH, AND WHY THAT MATTERS
 *   `centerIntakes` holds real bookings families made on the public
 *   website — they got a confirmation email and they are turning up. Those
 *   carry `source: 'web'`. This script only ever deletes documents stamped
 *   `source: 'google-import'`, so a blanket "clear the calendar" cannot
 *   quietly erase a family who booked properly.
 *
 *   Hand-made calendar entries (no `source`) are kept too, unless
 *   --all-entries is passed. Somebody built those on purpose.
 *
 * A lead created alongside an imported assessment is removed with it,
 * matched on the intake's own `leadId` rather than by guessing from a
 * name — deleting a lead somebody typed in by hand would be unrecoverable.
 *
 * Dry run unless --apply, and it prints what it is about to do either way.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const ALL_ENTRIES = process.argv.includes('--all-entries');
const CENTER = (process.argv.find(a => a.startsWith('--center=')) || '--center=langley').split('=')[1];
const SOURCE = 'google-import';

function serviceAccount() {
  const dir = path.resolve(__dirname, '..', '..', 'Pricing and Codes');
  const hit = fs.readdirSync(dir).find(f => /^mathnasium-langley-firebase-adminsdk-.*\.json$/.test(f));
  if (!hit) throw new Error(`No service account JSON in ${dir}`);
  return require(path.join(dir, hit));
}

const chunk = (xs, n) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

(async () => {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount()) });
  const db = admin.firestore();

  const intakeSnap = await db.collection('centerIntakes').where('centerId', '==', CENTER).get();
  const calSnap = await db.collection(`centers/${CENTER}/calendar`).get();

  const intakes = intakeSnap.docs.filter(d => d.data().source === SOURCE);
  const keptIntakes = intakeSnap.docs.filter(d => d.data().source !== SOURCE);
  const entries = calSnap.docs.filter(d => ALL_ENTRIES || d.data().source === SOURCE);
  const keptEntries = calSnap.docs.filter(d => !(ALL_ENTRIES || d.data().source === SOURCE));

  const leadIds = [...new Set(intakes.map(d => d.data().leadId).filter(Boolean))];

  console.log(`\nCentre: ${CENTER}   ${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be deleted'}\n`);
  console.log(`Assessments (centerIntakes)`);
  console.log(`  delete ${intakes.length} imported`);
  console.log(`  KEEP   ${keptIntakes.length} not from the import:`);
  for (const d of keptIntakes) {
    const v = d.data();
    console.log(`           ${v.slot}  ${v.childName || '(no name)'}  [source: ${v.source || 'none'}]`);
  }
  console.log(`\nCalendar entries`);
  console.log(`  delete ${entries.length}${ALL_ENTRIES ? ' (--all-entries: hand-made ones too)' : ' imported'}`);
  console.log(`  KEEP   ${keptEntries.length}${keptEntries.length ? ':' : ''}`);
  for (const [title, n] of Object.entries(keptEntries.reduce((a, d) => {
    const t = d.data().title || '(untitled)'; a[t] = (a[t] || 0) + 1; return a;
  }, {}))) console.log(`           ${n} x ${title}`);
  console.log(`\nLeads created by the import: ${leadIds.length}`);

  const total = intakes.length + entries.length + leadIds.length;
  if (!APPLY) {
    console.log(`\n${total} documents would be deleted. Re-run with --apply to do it.\n`);
    process.exit(0);
  }
  if (!total) { console.log('\nNothing to delete.\n'); process.exit(0); }

  const refs = [
    ...intakes.map(d => d.ref),
    ...entries.map(d => d.ref),
    ...leadIds.map(id => db.doc(`centers/${CENTER}/leads/${id}`)),
  ];
  let done = 0;
  for (const group of chunk(refs, 400)) {
    const batch = db.batch();
    for (const ref of group) batch.delete(ref);
    await batch.commit();
    done += group.length;
    console.log(`  deleted ${done}/${refs.length}`);
  }
  console.log(`\nDone. ${done} deleted, ${keptIntakes.length} real bookings untouched.\n`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
