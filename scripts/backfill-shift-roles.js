/**
 * backfill-shift-roles.js — one-off. Repairs the upcoming shifts of
 * everyone whose job title changed BEFORE the app started carrying the
 * change across (see propagateRole in src/pages/Admin.jsx).
 *
 * The bug it cleans up: a shift stores a COPY of the person's title when
 * it is created, and the coverage grid reads that copy. Promote someone
 * to Lead and every shift already on the calendar keeps showing the title
 * they held when it was made — Luke promoted to Lead, still drawn as HS.
 *
 * WHAT IT WILL NOT DO
 *   Past shifts are never touched. A worked shift records the job that
 *   was done, and payroll reads the same field.
 *
 *   It will not guess. A future shift whose role differs from the
 *   person's title might be stale, or might be the LEAD 11-3 / HOST 3-7
 *   day the grid is built around — there is no way to tell from the data.
 *   So a plain run only REPORTS what disagrees, grouped by the role the
 *   shifts carry, and you decide which of those groups was staleness by
 *   naming it with --from.
 *
 * HOW TO RUN — from inside `Ratio Website/`
 *
 *   1. See what disagrees, across every centre:
 *        node scripts/backfill-shift-roles.js
 *
 *   2. Read the report. For each group ask: "was this the title they used
 *      to hold, or is it a role they are genuinely scheduled in?"
 *
 *   3. Dry-run the repair for one of those titles:
 *        node scripts/backfill-shift-roles.js --from Instructor
 *
 *   4. Same command with --apply once the list looks right:
 *        node scripts/backfill-shift-roles.js --from Instructor --apply
 *
 *   Narrow it further with --centre <centreId> or --who <name or uid>.
 *
 * The rule for what moves is imported from src/lib/roleBackfill.js — the
 * same module the live promotion path uses, so this cannot drift from it.
 */
import admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { shiftsToRelabel, disagreeingShiftsByRole, batches } from '../src/lib/roleBackfill.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const FROM_TITLE = flag('--from');
const ONLY_CENTRE = flag('--centre');
const ONLY_WHO = (flag('--who') || '').toLowerCase();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyDir = path.resolve(__dirname, '../../Pricing and Codes');
const keyFile = fs.readdirSync(keyDir)
  .find(f => f.startsWith('mathnasium-langley-firebase-adminsdk') && f.endsWith('.json'));
if (!keyFile) {
  console.error(`No service-account key found in ${keyDir}`);
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(fs.readFileSync(path.join(keyDir, keyFile), 'utf8'))),
});
const db = admin.firestore();

const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const titleAt = (u, centre) => u.centerMemberships?.[centre]?.instructorType || u.instructorType || 'Instructor';
const centresOf = (u) => (Array.isArray(u.centerIds) ? u.centerIds : (u.centerId ? [u.centerId] : []));

(async () => {
  const TODAY = todayISO();
  console.log(APPLY ? 'APPLYING\n' : 'DRY RUN — nothing will be written\n');
  console.log(`Upcoming means ${TODAY} or later.\n`);

  // One range query on a single field, so no composite index is needed.
  const shiftSnap = await db.collection('shifts').where('date', '>=', TODAY).get();
  const byUser = new Map();
  let orphaned = 0;
  for (const d of shiftSnap.docs) {
    const s = { id: d.id, ref: d.ref, ...d.data() };
    if (!s.userId) { orphaned += 1; continue; }
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }
  console.log(`${shiftSnap.size} upcoming shifts; ${byUser.size} people hold one.`);
  if (orphaned) {
    console.log(`${orphaned} have no userId and cannot be matched to an account — skipped.`);
  }
  console.log('');

  const userSnap = await db.collection('users').get();
  const toWrite = [];
  let reported = 0;

  for (const doc of userSnap.docs) {
    const u = { uid: doc.id, ...doc.data() };
    const shifts = byUser.get(u.uid) || [];
    if (!shifts.length) continue;
    if (ONLY_WHO && !`${u.displayName || ''} ${u.uid}`.toLowerCase().includes(ONLY_WHO)) continue;

    for (const centre of centresOf(u)) {
      if (ONLY_CENTRE && centre !== ONLY_CENTRE) continue;
      const title = titleAt(u, centre);

      if (FROM_TITLE) {
        // A named repair: treat FROM_TITLE as the title they used to hold.
        // Identical rule to the live promotion path, including leaving
        // any other role alone.
        const stale = shiftsToRelabel(shifts, {
          oldTitle: FROM_TITLE, newTitle: title, centerId: centre, from: TODAY,
        });
        if (!stale.length) continue;
        const dates = stale.map(s => s.date).sort();
        console.log(`  ${u.displayName || u.uid} @ ${centre} — ${stale.length} shift(s) `
          + `"${FROM_TITLE}" -> "${title}"  (${dates[0]} .. ${dates[dates.length - 1]})`);
        toWrite.push(...stale.map(s => ({ ref: s.ref, role: title })));
        reported += 1;
        continue;
      }

      // No --from: report only, grouped by the role the shifts carry.
      const groups = disagreeingShiftsByRole(shifts, { title, centerId: centre, from: TODAY });
      if (!groups.size) continue;
      console.log(`  ${u.displayName || u.uid} @ ${centre} — holds "${title}"`);
      for (const [role, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
        const dates = list.map(s => s.date).sort();
        console.log(`      ${String(list.length).padStart(3)} shift(s) say "${role}"`
          + `  (${dates[0]} .. ${dates[dates.length - 1]})`);
      }
      reported += 1;
    }
  }

  console.log('');
  if (!reported) {
    console.log(FROM_TITLE
      ? `Nothing upcoming still says "${FROM_TITLE}". Done.`
      : 'Every upcoming shift already agrees with the title its person holds. Done.');
    process.exit(0);
  }

  if (!FROM_TITLE) {
    console.log(`${reported} person/centre pair(s) have upcoming shifts that disagree with their title.`);
    console.log('Decide which of those roles was a stale title rather than a real assignment,');
    console.log('then re-run with --from "<that role>" to see exactly what would change.');
    process.exit(0);
  }

  console.log(`${toWrite.length} shift(s) across ${reported} person/centre pair(s).`);
  if (!APPLY) {
    console.log('Dry run — re-run with --apply to write.');
    process.exit(0);
  }

  let written = 0;
  for (const group of batches(toWrite)) {
    const batch = db.batch();
    for (const w of group) batch.update(w.ref, { role: w.role });
    await batch.commit();
    written += group.length;
    console.log(`  committed ${written}/${toWrite.length}`);
  }
  console.log(`\nDone. ${written} shift(s) updated.`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
