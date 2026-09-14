/**
 * managers-take-over-admin.cjs — one-off. Retires the Admin platform role
 * into the Manager job title (decided 2026-09-14).
 *
 * Two changes, and nothing else:
 *
 *   1. Every centre's saved role registry gives the Manager role what the
 *      Admin role had: full admin access, analytics, the Student Scheduler,
 *      taking shifts, Team Chat and the Management Desk. (A centre that has
 *      never saved its roles already gets this from the built-in defaults.)
 *   2. Every account on the Admin role that is a MANAGER somewhere moves to
 *      the ordinary staff role. Their Manager title now carries the access.
 *      Accounts on the Admin role with no Manager title (the shared "Admin
 *      Team" login) are left alone and listed, for a person to decide.
 *
 * Step 2 refuses to run until the deployed Firestore rules contain
 * isAdminOrManagerAt — switching someone before the rules know about
 * Managers would lock them out of announcements, Management Chat and more.
 *
 * Dry run unless --apply. Run from inside `Ratio Website/`:
 *
 *   node scripts/managers-take-over-admin.cjs
 *   node scripts/managers-take-over-admin.cjs --apply
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const ADMIN_GRANTS = ['admin.panel', 'admin.operations', 'analytics.view', 'scheduler.run', 'shifts.take', 'chat.access', 'notes.access'];

const dir = path.resolve(__dirname, '../../Pricing and Codes');
const keyFile = fs.readdirSync(dir).find(f => f.startsWith('mathnasium-langley-firebase-adminsdk') && f.endsWith('.json'));
admin.initializeApp({ credential: admin.credential.cert(require(path.join(dir, keyFile))) });
const db = admin.firestore();

const titleAt = (u, c) => (u.centerMemberships?.[c]?.instructorType) || u.instructorType || '';
const centresOf = (u) => (Array.isArray(u.centerIds) ? u.centerIds : (u.centerId ? [u.centerId] : []));

(async () => {
  console.log(APPLY ? 'APPLYING\n' : 'DRY RUN — nothing will be written\n');

  // ── 1. Role registries ──────────────────────────────────────────────
  const centres = await db.collection('centers').get();
  const registryWrites = [];
  for (const c of centres.docs) {
    const ref = db.doc(`centers/${c.id}/config/main`);
    const cfg = (await ref.get()).data() || {};
    if (!Array.isArray(cfg.staffRoles)) continue;           // built-in defaults already cover it
    const i = cfg.staffRoles.findIndex(r => String(r?.name || '').trim().toLowerCase() === 'manager');
    if (i < 0) continue;
    const had = cfg.staffRoles[i].permissions || [];
    const next = [...new Set([...had, ...ADMIN_GRANTS])];
    const added = next.filter(p => !had.includes(p));
    if (!added.length) { console.log(`registry  ${c.id}: Manager already has everything`); continue; }
    console.log(`registry  ${c.id}: Manager gains ${added.join(', ')}`);
    const staffRoles = cfg.staffRoles.map((r, j) => (j === i ? { ...r, permissions: next } : r));
    // The flat map the rules read. Never write one without the other.
    const staffRolePermissions = { ...(cfg.staffRolePermissions || {}), [cfg.staffRoles[i].name]: next };
    registryWrites.push({ ref, staffRoles, staffRolePermissions });
  }

  // ── 2. Accounts on the Admin role ───────────────────────────────────
  const admins = await db.collection('users').where('role', '==', 'admin').get();
  const switches = [];
  for (const d of admins.docs) {
    const u = d.data();
    const managed = centresOf(u).filter(c => titleAt(u, c) === 'Manager');
    if (managed.length) {
      console.log(`account   ${u.displayName}: admin → instructor (Manager at ${managed.join(', ')})`);
      switches.push({ ref: d.ref, uid: d.id, name: u.displayName, managed });
    } else {
      console.log(`account   ${u.displayName}: LEFT ON ADMIN — no Manager title. Decide separately (retire, or give a title).`);
    }
  }

  // ── Safety: the deployed rules must already know about Managers ────
  let rulesReady = false;
  try {
    const ruleset = await admin.securityRules().getFirestoreRuleset();
    rulesReady = ruleset.source.some(f => String(f.content).includes('isAdminOrManagerAt'));
  } catch (e) {
    console.log(`\ncould not read the deployed rules: ${e.message}`);
  }
  console.log(`\ndeployed Firestore rules include the Manager change: ${rulesReady ? 'yes' : 'NO'}`);

  if (!APPLY) {
    console.log('\nDry run. Add --apply to write.');
    process.exit(0);
  }

  for (const w of registryWrites) {
    await w.ref.set({ staffRoles: w.staffRoles, staffRolePermissions: w.staffRolePermissions }, { merge: true });
  }
  console.log(`\nUpdated ${registryWrites.length} role registr${registryWrites.length === 1 ? 'y' : 'ies'}.`);

  if (!rulesReady) {
    console.log('Accounts NOT switched: deploy the rules first —  firebase deploy --only firestore:rules  — then run this again.');
    process.exit(1);
  }
  for (const s of switches) {
    await s.ref.update({ role: 'instructor' });
    await db.collection('auditLog').add({
      actorUid: 'system:managers-take-over-admin', actorName: 'Admin role retirement (script)', actorRole: 'system',
      action: 'super_admin.role_change', centerId: s.managed[0], targetUserId: s.uid,
      details: { fromRole: 'admin', toRole: 'instructor', targetName: s.name, reason: 'Admin role retired; Manager title carries the access' },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  console.log(`Switched ${switches.length} account${switches.length === 1 ? '' : 's'} to instructor.`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
