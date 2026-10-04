#!/usr/bin/env node
/**
 * Wipe the leads collection, so a centre can start it again by hand.
 *
 *   node scripts/clear-leads.cjs                        # dry run — counts only
 *   node scripts/clear-leads.cjs --apply                # delete the imports
 *   node scripts/clear-leads.cjs --apply --everything   # delete ALL leads
 *   node scripts/clear-leads.cjs --apply --everything --former-students
 *   node scripts/clear-leads.cjs --apply --center=langley
 *
 * Run it from inside `Ratio Website/` so firebase-admin resolves.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IT WILL NOT TOUCH BY DEFAULT, AND WHY THAT MATTERS
 *
 * A lead carrying an `intakeId`, or `source: 'apptoto'`, is a REAL FAMILY
 * WHO BOOKED. They filled in the form or rang the centre, they got a
 * confirmation, and somebody is expecting them. Nothing generated them —
 * they are the only leads in here that cannot be recreated from a file.
 *
 * So the default deletes only what an import put there: documents whose id
 * starts `radius_` or `tracker_`, or that carry an `imported` stamp. A
 * blanket "clear the leads" therefore cannot quietly erase a family who is
 * turning up on Saturday.
 *
 * --everything removes those bookings too. It is a separate flag because
 * it is a separate decision, and there is no undo for either.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * DRY RUN UNLESS --apply, and it prints what it is about to do either way.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const EVERYTHING = process.argv.includes('--everything');
// The call-back list, loaded from the student export. Its own flag because
// it is its own collection and its own decision — and it is the one thing
// here that IS re-importable, straight from that file.
const FORMER = process.argv.includes('--former-students');
const CENTER = (process.argv.find(a => a.startsWith('--center=')) || '--center=').split('=')[1];

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

/** Where a lead came from — and whether a person or a file put it there. */
function originOf(id, lead) {
  if (id.startsWith('radius_')) return { label: 'Radius import', generated: true };
  if (id.startsWith('tracker_')) return { label: 'Lead Tracker import', generated: true };
  if (lead.imported) return { label: `import: ${lead.imported}`, generated: true };
  if (lead.intakeId) return { label: 'BOOKED — an assessment booking', generated: false };
  if (lead.source === 'apptoto') return { label: 'BOOKED — through Apptoto', generated: false };
  if (lead.formerStudentId) return { label: 'made from a call-back', generated: false };
  return { label: 'made in Ratio by hand', generated: false };
}

(async () => {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount()) });
  const db = admin.firestore();

  const centres = (await db.collection('centers').get()).docs
    .filter(d => !CENTER || d.id === CENTER);
  if (centres.length === 0) throw new Error(CENTER ? `No centre "${CENTER}".` : 'No centres.');

  console.log(APPLY ? '\n*** APPLYING — this cannot be undone ***\n' : '\nDRY RUN — nothing will be deleted. Add --apply to do it.\n');
  console.log(EVERYTHING
    ? 'Scope: EVERY lead, including families who booked.\n'
    : 'Scope: imported leads only. Families who booked are kept (--everything removes those too).\n');

  let totalGone = 0; let totalKept = 0; let totalFormer = 0;

  for (const centre of centres) {
    const col = db.collection('centers').doc(centre.id).collection('leads');
    const snap = await col.get();
    if (snap.empty) { console.log(`${centre.id}: no leads.`); continue; }

    const by = new Map();
    const doomed = [];
    let kept = 0;

    for (const d of snap.docs) {
      const origin = originOf(d.id, d.data() || {});
      const row = by.get(origin.label) || { n: 0, generated: origin.generated };
      row.n += 1;
      by.set(origin.label, row);
      if (EVERYTHING || origin.generated) doomed.push(d.ref); else kept += 1;
    }

    console.log(`${centre.id}: ${snap.size} leads`);
    for (const [label, row] of [...by.entries()].sort((a, b) => b[1].n - a[1].n)) {
      const going = EVERYTHING || row.generated;
      console.log(`  ${going ? 'delete' : 'KEEP  '}  ${String(row.n).padStart(5)}  ${label}`);
    }
    console.log(`  → ${doomed.length} to delete, ${kept} kept\n`);

    totalGone += doomed.length; totalKept += kept;

    if (APPLY && doomed.length > 0) {
      for (const batchRefs of chunk(doomed, 400)) {
        const batch = db.batch();
        for (const ref of batchRefs) batch.delete(ref);
        await batch.commit();
      }
      console.log(`  deleted ${doomed.length} leads from ${centre.id}\n`);
    }

    if (FORMER) {
      const fs2 = await db.collection('centers').doc(centre.id).collection('formerStudents').get();
      if (!fs2.empty) {
        console.log(`${centre.id}: ${fs2.size} former students${APPLY ? '' : ' would go'}`);
        if (APPLY) {
          for (const batchRefs of chunk(fs2.docs.map(d => d.ref), 400)) {
            const batch = db.batch();
            for (const ref of batchRefs) batch.delete(ref);
            await batch.commit();
          }
          console.log(`  deleted ${fs2.size} former students from ${centre.id}\n`);
        }
        totalFormer += fs2.size;
      }
    }
  }

  const former = FORMER ? `, ${totalFormer} former students` : '';
  console.log(APPLY
    ? `Done. ${totalGone} leads deleted${former}, ${totalKept} leads kept.`
    : `Would delete ${totalGone} leads${former}, keep ${totalKept}. Re-run with --apply.`);
  process.exit(0);
})().catch(e => { console.error(`\n${e.message}\n`); process.exit(1); });
