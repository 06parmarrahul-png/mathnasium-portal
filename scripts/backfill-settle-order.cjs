/**
 * backfill-settle-order.cjs — one-off. Gives the notes already imported
 * into the Management Desk the settle order the spreadsheet kept.
 *
 * Settled is sorted most recently SETTLED first. The spreadsheet never
 * recorded a settle date, but its Settled Notes tab was kept newest-settled
 * at the top, so a row's position is the settle order. The first import
 * didn't store that position; this adds it as `sheetOrder`,
 * the same field new imports now write (deskImport.js).
 *
 * Writes ONE field and nothing else. Dry run unless --apply.
 *
 *   node scripts/backfill-settle-order.cjs                 # dry run
 *   node scripts/backfill-settle-order.cjs --apply
 *
 * Optional: a different workbook path as the first argument.
 * Run from inside `Ratio Website/` so firebase-admin resolves.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

const CENTRE = 'langley';
const APPLY = process.argv.includes('--apply');
const xlsx = process.argv.slice(2).find(a => !a.startsWith('--'))
  || path.join(os.homedir(), 'Downloads', 'Management Team Post It Notes.xlsx');

// The converter's JSON is full of students' and parents' names: written to
// the OS temp dir and deleted the moment it has been read.
const tmp = path.join(os.tmpdir(), `desk-order-${process.pid}.json`);
execFileSync('python3', [path.join(__dirname, 'desk_import_convert.py'), xlsx, tmp], { stdio: 'ignore' });
const rows = JSON.parse(fs.readFileSync(tmp, 'utf8')).notes;
fs.unlinkSync(tmp);

const t = (v) => String(v ?? '').trim();
// The same fields, normalised the same way, that noteFromRow stored.
const rowKey = (r) => [t(r.from), t(r.subject) || '(no subject)', t(r.body), r.loggedAt || ''].join('\u0000');
const docKey = (d) => [t(d.fromInitials), t(d.subject), t(d.body), d.loggedAt || ''].join('\u0000');

const queue = new Map();
rows.forEach((r, i) => {
  const k = rowKey(r);
  if (!queue.has(k)) queue.set(k, []);
  queue.get(k).push(i);
});

const dir = path.resolve(__dirname, '../../Pricing and Codes');
const keyFile = fs.readdirSync(dir).find(f => f.startsWith('mathnasium-langley-firebase-adminsdk') && f.endsWith('.json'));
admin.initializeApp({ credential: admin.credential.cert(require(path.join(dir, keyFile))) });
const db = admin.firestore();

(async () => {
  const snap = await db.collection(`centers/${CENTRE}/notes`).where('imported', '==', true).get();
  // Identical rows can't be told apart, and don't need to be: sorted by id
  // so a second run hands out the same positions.
  const docs = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const updates = []; let unchanged = 0; let unmatched = 0;
  const order = new Map();
  for (const d of docs) {
    const q = queue.get(docKey(d));
    if (!q || !q.length) { unmatched++; continue; }
    const pos = q.shift();
    order.set(d.id, pos);
    if (d.sheetOrder === pos) unchanged++;
    else updates.push({ ref: d.ref, pos });
  }

  // Settled in Ratio since the import: those sort by their real settle
  // time, above all of this, so they're left out of the preview.
  const settled = docs.filter(d => d.status === 'closed' && !d.settledAt && order.has(d.id))
    .sort((a, b) => order.get(a.id) - order.get(b.id));

  console.log(`workbook rows            ${rows.length}`);
  console.log(`imported notes in Ratio  ${docs.length}`);
  console.log(`matched to a row         ${docs.length - unmatched}`);
  console.log(`not matched (left as is) ${unmatched}`);
  console.log(`already correct          ${unchanged}`);
  console.log(`to write                 ${updates.length}`);
  // Logged dates only — no names. Should read like the top of the Settled
  // Notes tab: 28 Aug, 2 Sep, 1 Sep, 13 Aug, 3 Sep…
  console.log(`first imported, logged   ${settled.slice(0, 8).map(d => d.loggedAt).join('  ')}`);

  if (!APPLY) { console.log('\nDry run. Nothing written. Add --apply to write.'); process.exit(0); }

  for (let i = 0; i < updates.length; i += 450) {
    const batch = db.batch();
    for (const u of updates.slice(i, i + 450)) batch.update(u.ref, { sheetOrder: u.pos });
    await batch.commit();
  }
  console.log(`\nWrote sheetOrder on ${updates.length} notes.`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
