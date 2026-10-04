#!/usr/bin/env node
/**
 * One family who booked four times is one lead, not four.
 *
 *   node scripts/merge-duplicate-leads.cjs            # dry run
 *   node scripts/merge-duplicate-leads.cjs --apply
 *
 * Run from inside `Ratio Website/`.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * A FAMILY IS FOUND THREE WAYS; A STUDENT IS FOUND INSIDE IT.
 *
 * Phone alone is not enough — the Goilavs booked under two numbers AND two
 * emails, one of them typo'd ".con". So records are unioned when they
 * share a phone, OR an email, OR a parent's full name (two words or more;
 * a lone "michelle" is not evidence of anything).
 *
 * THEN, inside one family, records are clustered by the CHILD. Siblings
 * share a phone and an email and a parent, and merging Bushra Popal into
 * Yusra Popal would lose a student. Two children are the same child only
 * when one's first name is a prefix of the other's — Alex / Alexandra /
 * Alex Goilav is one person, Bushra / Yusra is two.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * THE SURVIVOR CARRIES THE WHOLE STORY. It keeps the EARLIEST enquiry date
 * (when they first came to the centre) and the LATEST booking (where they
 * are now), and every folded booking is written into its history — so
 * "cancelled twice, then came in on the third" is still readable. A merge
 * that kept only the newest row would quietly turn three no-shows into a
 * clean first visit.
 *
 * The fullest version of each name wins: "Alexandra Goilav" over "Alex",
 * "Shawna Hopkins" over "Shawna.hopkins".
 *
 * REVERSIBLE. Everything here came from the calendar and is keyed on the
 * event UID, so re-running import-calendar-leads.mjs restores any lead
 * this folds away.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const CENTER = (process.argv.find(a => a.startsWith('--center=')) || '--center=langley').split('=')[1];

function serviceAccount() {
  const dir = path.resolve(__dirname, '..', '..', 'Pricing and Codes');
  const hit = fs.readdirSync(dir).find(f => /^mathnasium-langley-firebase-adminsdk-.*\.json$/.test(f));
  if (!hit) throw new Error(`No service account JSON in ${dir}`);
  return require(path.join(dir, hit));
}

const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
const firstTok = (s) => norm(s).split(' ')[0] || '';
const prefixy = (a, b) => Boolean(a) && Boolean(b) && (a.startsWith(b) || b.startsWith(a));

/**
 * The fullest, best-typed version of a name.
 *
 * Most words wins, because "Alexandra Goilav" beats "Alex" — EXCEPT when
 * the extra words are a second child. "Kelly and Kevin" and "Bella & Liam"
 * are two students sharing one booking, not anybody's name, so they are
 * pushed to the bottom and "Kelly Jiang" wins instead.
 *
 * Capitalisation breaks the remaining ties, which is how "Bushra Popal"
 * beats "Bushra popal" and "Shawna Hopkins" beats "Shawna.hopkins".
 */
const TWO_PEOPLE = /\s(and|&|\+)\s|&/i;

function bestName(values) {
  const caps = (s) => String(s).split(/[\s.]+/).filter(w => /^[A-Z]/.test(w)).length;
  const score = (s) => (TWO_PEOPLE.test(s) ? -100 : 0)
    + norm(s).split(' ').length * 10
    + caps(s) * 2
    + String(s).length * 0.01;
  return [...new Set(values.filter(v => String(v || '').trim()))]
    .sort((a, b) => score(b) - score(a))[0] || '';
}

/** Prefer an address whose domain is not an obvious typo. */
function bestEmail(values) {
  const all = [...new Set(values.map(v => String(v || '').trim().toLowerCase()).filter(Boolean))];
  return all.find(e => /\.(com|ca|net|org|edu|io|co\.uk)$/.test(e)) || all[0] || '';
}

/** Union-find, so a chain of weak links still lands in one family. */
function unionFind(n) {
  const parent = [...Array(n).keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { const x = find(a); const y = find(b); if (x !== y) parent[x] = y; };
  return { find, union };
}

(async () => {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount()) });
  const db = admin.firestore();
  const col = db.collection('centers').doc(CENTER).collection('leads');
  const snap = await col.get();
  const leads = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const uf = unionFind(leads.length);
  const byKey = new Map();
  leads.forEach((l, i) => {
    const keys = [];
    const ph = digits(l.parentPhone);
    if (ph.length >= 7) keys.push(`p:${ph}`);
    const em = String(l.parentEmail || '').trim().toLowerCase();
    if (em) keys.push(`e:${em}`);
    const pn = norm(l.parentName);
    // A full name is evidence; a single first name is not.
    if (pn.split(' ').length >= 2) keys.push(`n:${pn}`);
    for (const k of keys) {
      if (byKey.has(k)) uf.union(i, byKey.get(k)); else byKey.set(k, i);
    }
  });

  const families = new Map();
  leads.forEach((l, i) => {
    const root = uf.find(i);
    if (!families.has(root)) families.set(root, []);
    families.get(root).push(l);
  });

  const merges = [];
  for (const fam of families.values()) {
    if (fam.length < 2) continue;
    const clusters = [];
    for (const l of fam) {
      const t = firstTok(l.childName);
      const into = clusters.find(c => prefixy(firstTok(c[0].childName), t));
      if (into) into.push(l); else clusters.push([l]);
    }
    for (const c of clusters) if (c.length > 1) merges.push(c);
  }

  console.log(APPLY ? '\n*** APPLYING ***\n' : '\nDRY RUN — nothing written. Add --apply.\n');
  console.log(`${leads.length} leads, ${merges.length} students booked more than once.\n`);

  const writes = [];
  for (const group of merges) {
    const byDate = [...group].sort((a, b) =>
      String(a.assessmentOn || '').localeCompare(String(b.assessmentOn || '')));
    const latest = byDate[byDate.length - 1];
    // Earliest enquiry: when this family first came to the centre.
    const createdAts = group.map(l => l.createdAt?.toDate?.() || null).filter(Boolean);
    const firstSeen = createdAts.length ? new Date(Math.min(...createdAts.map(d => d.getTime()))) : null;

    const survivor = latest;
    const folded = group.filter(l => l.id !== survivor.id);

    const patch = {
      parentName: bestName(group.map(l => l.parentName)),
      childName:  bestName(group.map(l => l.childName)),
      childGrade: bestName(group.map(l => l.childGrade)),
      parentPhone: group.map(l => l.parentPhone).find(Boolean) || '',
      parentEmail: bestEmail(group.map(l => l.parentEmail)),
      // Where they are NOW.
      assessmentOn: latest.assessmentOn || '',
      assessmentOutcome: latest.assessmentOutcome || '',
      ...(firstSeen ? { createdAt: firstSeen } : {}),
      history: [
        ...(survivor.history || []),
        ...byDate.map(l => ({
          at: new Date().toISOString(),
          by: 'system',
          text: `Booked ${l.assessmentOn}${l.assessmentOutcome ? ` — ${l.assessmentOutcome}` : ''}`,
        })),
        {
          at: new Date().toISOString(),
          by: 'system',
          text: `Merged ${group.length} calendar bookings into one lead.`,
        },
      ],
    };

    console.log(`${patch.childName} (${patch.parentName}) — ${group.length} bookings`);
    for (const l of byDate) {
      console.log(`    ${l.id === survivor.id ? 'keep ' : 'fold '} ${l.assessmentOn} ${(l.assessmentOutcome || 'outcome blank').padEnd(14)} ${l.childName} / ${l.parentName}`);
    }
    if (patch.parentEmail !== latest.parentEmail) console.log(`    email -> ${patch.parentEmail}`);
    console.log('');

    writes.push({ survivor, patch, folded });
  }

  const foldedCount = writes.reduce((n, w) => n + w.folded.length, 0);
  console.log(`${writes.length} leads kept, ${foldedCount} folded away → ${leads.length - foldedCount} leads afterwards.`);

  if (!APPLY) { console.log('\nRe-run with --apply.'); process.exit(0); }

  const batch = db.batch();
  for (const w of writes) {
    batch.set(col.doc(w.survivor.id), w.patch, { merge: true });
    for (const f of w.folded) batch.delete(col.doc(f.id));
  }
  await batch.commit();
  console.log(`\nDone. ${foldedCount} folded away.`);
  process.exit(0);
})().catch(e => { console.error(`\n${e.message}\n`); process.exit(1); });
