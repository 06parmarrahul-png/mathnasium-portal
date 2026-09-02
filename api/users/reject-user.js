// POST /api/users/reject-user
//
// THREE MODES, on one route. Vercel Hobby caps this project at 12
// serverless functions and api/ is exactly at 12, so termination is
// multiplexed here rather than added as a 13th file (see CLAUDE.md).
//
//   mode: 'reject'    (default) — the original behaviour, unchanged.
//   mode: 'preview'   — collect everything the person owns and return it.
//                       Deletes NOTHING. The client downloads this as the
//                       termination record before committing.
//   mode: 'terminate' — collect, return, and then erase all of it plus the
//                       Auth account. Irreversible.
//   mode: 'orphans'   — list names that have records but NO user account.
//                       Read-only.
//   mode: 'orphan-purge' — export and erase one orphan's records.
//
// The orphan modes exist because deleting a user's PROFILE used to leave
// everything else behind: 189 documents across ten people were still in
// the database with no account attached, invisible to Manage Staff and so
// impossible to clean up from the app.
//
// Why preview is a separate round trip: the export has to be safely in the
// admin's hands BEFORE anything is deleted. Returning it from the same
// call that deletes would mean a dropped response destroyed the only copy.
//
// Rejects a pending instructor: disables their Firebase Auth account
// (so the login itself stops working) and removes their Firestore profile.
//
// Why this is a server route, not a client write:
//   The client SDK can't disable another user's Auth account — only the
//   Admin SDK can. Without disabling the Auth side, a "rejected" user could
//   still authenticate; they'd just hit the pending screen instead of the
//   app. That's enough UX-wise but it leaves a stale credential on the
//   platform, which is the kind of soft-edge audit reviewers (and centre
//   owners pitching to other Mathnasiums) tend to ask about.
//
// Auth model:
//   - Super-admins can reject any user at any centre.
//   - Owners and admins can reject pending users that belong to *their*
//     centre. They cannot reject users at other centres, nor users with a
//     higher role (you can't kick out an owner via this endpoint).
//
// Request body:  { uid: 'user-uid-to-reject' }
// Response:      200 { ok: true, deletedAuth: true, deletedProfile: true }
//                403 { error: 'Not authorized' }
//                404 { error: 'User not found' }

import { authenticateRequest, getAuth, getFirestore } from '../_lib/firebase-admin.js';

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Centre access helper — mirrors the Firestore rules' hasCenterAccess(): a
// user is "at" a centre if its id is in their centerIds array OR if it's
// their legacy single centerId field.
// Every collection that carries a person's data, and the fields that point
// at them. Field names verified against the live database rather than
// assumed — availabilityLog uses targetUid/actorUid, auditLog uses
// actorUid/targetUserId, openShifts uses claimedBy/originalUserId, and
// getting one wrong would leave that data orphaned but still on screen.
const OWNED_COLLECTIONS = [
  { col: 'shifts',                  idFields: ['userId'],                     nameFields: ['userName'] },
  { col: 'availability',            idFields: ['userId'],                     nameFields: ['userName'] },
  { col: 'openShifts',              idFields: ['claimedBy', 'originalUserId'] },
  { col: 'timeOffRequests',         idFields: ['userId'],                     nameFields: ['userName'] },
  { col: 'chat',                    idFields: ['userId', 'acceptedBy'] },
  { col: 'availabilityLog',         idFields: ['targetUid', 'actorUid'] },
  { col: 'notificationPreferences', idFields: ['userId'] },
  { col: 'auditLog',                idFields: ['actorUid', 'targetUserId'] },
];

/**
 * Find every document belonging to this person, keyed by collection.
 *
 * Queried per field and de-duplicated by document id, because a doc can
 * match on more than one field (an availabilityLog row where they are both
 * actor and target) and deleting it twice in one batch is an error.
 *
 * The name sweep is deliberate: documents written before the uid fields
 * existed carry only a display name, and a uid-only scan would leave them
 * behind — visible on the schedule under a person who no longer exists.
 */
async function collectOwnedDocs(db, uid, displayName) {
  const out = {};
  for (const { col, idFields, nameFields } of OWNED_COLLECTIONS) {
    const seen = new Map();
    for (const f of idFields) {
      const snap = await db.collection(col).where(f, '==', uid).get();
      snap.forEach(d => seen.set(d.id, { id: d.id, ...d.data() }));
    }
    for (const f of (displayName ? nameFields || [] : [])) {
      const snap = await db.collection(col).where(f, '==', displayName).get();
      snap.forEach(d => seen.set(d.id, { id: d.id, ...d.data() }));
    }
    // A doc keyed by uid — notificationPreferences uses the uid as its id.
    try {
      const direct = await db.collection(col).doc(uid).get();
      if (direct.exists) seen.set(direct.id, { id: direct.id, ...direct.data() });
    } catch { /* not all collections allow a doc() lookup by this id */ }
    if (seen.size > 0) out[col] = [...seen.values()];
  }
  return out;
}

/** Delete everything collectOwnedDocs found. Chunked — batches cap at 500. */
async function deleteOwnedDocs(db, owned) {
  let deleted = 0;
  for (const [col, docs] of Object.entries(owned)) {
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      for (const d of docs.slice(i, i + 400)) batch.delete(db.collection(col).doc(d.id));
      await batch.commit();
      deleted += Math.min(400, docs.length - i);
    }
  }
  return deleted;
}

// Names the scan must never offer as orphans. The app posts chat messages
// as itself with `userId: 'system'` — those aren't a person, and deleting
// them would gut the chat history.
const SYSTEM_UIDS = new Set(['system', 'System']);

/**
 * Every name that has records but no user account.
 *
 * A person is an orphan when NEITHER their uid NOR their display name
 * matches a live account. Both halves matter: matching on uid alone misses
 * legacy rows that only carry a name, and matching on name alone would
 * mistake a renamed staffer for a stranger.
 */
async function findOrphans(db) {
  const users = await db.collection('users').get();
  const liveUids = new Set(users.docs.map(d => d.id));
  const liveNames = new Set(users.docs.map(d => norm(d.data().displayName)).filter(Boolean));

  const found = new Map();
  for (const { col, idFields, nameFields } of OWNED_COLLECTIONS) {
    const snap = await db.collection(col).get();
    snap.forEach(d => {
      const x = d.data();
      const name = x.userName || x.targetName || x.claimedByName || x.displayName || null;
      const uid = idFields.map(f => x[f]).find(Boolean) || null;
      if (!name) return;
      if (uid && SYSTEM_UIDS.has(uid)) return;             // the app itself
      if (uid && liveUids.has(uid)) return;                // belongs to a live account
      if (liveNames.has(norm(name))) return;               // ditto, by name
      const k = norm(name);
      if (!found.has(k)) found.set(k, { name, uids: new Set(), counts: {}, total: 0, firstDate: '', lastDate: '' });
      const o = found.get(k);
      if (uid) o.uids.add(uid);
      o.counts[col] = (o.counts[col] || 0) + 1;
      o.total += 1;
      if (x.date) {
        if (!o.firstDate || x.date < o.firstDate) o.firstDate = x.date;
        if (x.date > o.lastDate) o.lastDate = x.date;
      }
      void nameFields;
    });
  }
  return [...found.values()]
    .map(o => ({ ...o, uids: [...o.uids] }))
    .sort((a, b) => b.total - a.total);
}

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Collect an orphan's documents, matched by their uids AND their name. */
async function collectOrphanDocs(db, orphan) {
  const out = {};
  for (const { col, idFields, nameFields } of OWNED_COLLECTIONS) {
    const seen = new Map();
    for (const uid of orphan.uids) {
      for (const f of idFields) {
        const snap = await db.collection(col).where(f, '==', uid).get();
        snap.forEach(d => seen.set(d.id, { id: d.id, ...d.data() }));
      }
      try {
        const direct = await db.collection(col).doc(uid).get();
        if (direct.exists) seen.set(direct.id, { id: direct.id, ...direct.data() });
      } catch { /* id isn't a valid doc path here */ }
    }
    for (const f of nameFields || []) {
      const snap = await db.collection(col).where(f, '==', orphan.name).get();
      snap.forEach(d => seen.set(d.id, { id: d.id, ...d.data() }));
    }
    if (seen.size > 0) out[col] = [...seen.values()];
  }
  return out;
}

function userIsAtCenter(profile, centerId) {
  if (!profile || !centerId) return false;
  if (Array.isArray(profile.centerIds) && profile.centerIds.includes(centerId)) return true;
  if (profile.centerId === centerId) return true;
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await authenticateRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const caller = session.profile;
  const callerRole = caller?.role || '';
  // Anyone without admin-panel access has no business here.
  if (!['super_admin', 'owner', 'admin_assistant', 'admin'].includes(callerRole)) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const mode = String(body.mode || 'reject').trim();
  if (!['reject', 'preview', 'terminate', 'orphans', 'orphan-purge'].includes(mode)) {
    return res.status(400).json({ error: 'Unknown mode' });
  }
  // Termination erases payroll history and cannot be undone, so it sits
  // with the people who own the centre — the same group that holds the
  // 'centre.settings' permission on the client. A plain Admin can still
  // reject a pending signup; they cannot terminate an employee.
  if (mode !== 'reject' && !['super_admin', 'owner', 'director', 'admin_assistant'].includes(callerRole)) {
    return res.status(403).json({
      error: 'Terminating staff is limited to the Centre Director, Director of Education, Admin Assistant and Owner.',
    });
  }

  const db0 = getFirestore();

  // ── ORPHAN MODES ───────────────────────────────────────────────────
  // These run BEFORE the uid lookup below: an orphan has no user document
  // by definition, so that lookup's 404 would turn them away.
  if (mode === 'orphans' || mode === 'orphan-purge') {
    const orphans = await findOrphans(db0);

    if (mode === 'orphans') {
      return res.status(200).json({
        ok: true, mode, orphans,
        total: orphans.reduce((n, o) => n + o.total, 0),
      });
    }

    // Purge takes a NAME and re-derives the orphan list server-side, then
    // only acts on a name that scan actually produced. A caller cannot
    // hand over arbitrary uids and have them deleted, and a live account
    // can never appear in the list to begin with.
    const wanted = norm(body.name);
    if (!wanted) return res.status(400).json({ error: 'name required' });
    const orphan = orphans.find(o => norm(o.name) === wanted);
    if (!orphan) {
      return res.status(404).json({
        error: 'No orphaned records under that name — it may already be cleaned up, '
          + 'or the name now belongs to a live account.',
      });
    }

    const owned = await collectOrphanDocs(db0, orphan);
    const counts = Object.fromEntries(Object.entries(owned).map(([c, d]) => [c, d.length]));
    const total = Object.values(counts).reduce((n, v) => n + v, 0);
    const payload = {
      exportedAt: new Date().toISOString(),
      exportedBy: { uid: session.decoded.uid, name: caller?.displayName || null, role: callerRole },
      reason: 'Orphaned records — account was removed without clearing their data',
      person: { name: orphan.name, uids: orphan.uids },
      counts, total, collections: owned,
    };

    if (body.previewOnly) {
      return res.status(200).json({ ok: true, mode, counts, total, export: payload });
    }

    let deleted = 0;
    try {
      deleted = await deleteOwnedDocs(db0, owned);
    } catch (err) {
      console.error('[orphan-purge] delete failed', { name: orphan.name, message: err?.message });
      return res.status(207).json({
        ok: true, mode, counts, total, deleted, export: payload,
        warning: 'Some records could not be deleted: ' + (err?.message || '') + ' — run it again to finish.',
      });
    }

    try {
      await db0.collection('auditLog').add({
        action: 'staff.orphans_purged',
        actorUid: session.decoded.uid,
        actorName: caller?.displayName || null,
        actorRole: callerRole,
        targetUserId: null,
        centerId: caller?.centerId || null,
        createdAt: new Date(),
        details: { orphanName: orphan.name, documentsDeleted: total, byCollection: counts },
      });
    } catch (err) {
      console.error('[orphan-purge] audit write failed', { message: err?.message });
    }

    return res.status(200).json({ ok: true, mode, counts, total, deleted, export: payload });
  }

  const uid = String(body.uid || '').trim();
  if (!uid) return res.status(400).json({ error: 'uid required' });
  if (uid === session.decoded.uid) {
    return res.status(400).json({ error: 'You cannot reject your own account.' });
  }

  const db = db0;
  const targetSnap = await db.collection('users').doc(uid).get();
  if (!targetSnap.exists) {
    return res.status(404).json({ error: 'User not found' });
  }
  const target = { id: targetSnap.id, ...targetSnap.data() };

  // Don't allow rejecting a higher-privileged account. Even a super-admin
  // shouldn't be removed through this endpoint — that should be a deliberate
  //, audited Firestore action, not a one-click button.
  const targetRole = target.role || 'instructor';
  if (targetRole === 'super_admin') {
    return res.status(403).json({ error: 'Cannot reject a super-admin from this endpoint.' });
  }
  if (callerRole !== 'super_admin') {
    // Owners can't reject other owners. Admins can't reject owners or admins.
    // AA sits between admin and owner — has owner-level data access but
    // is not an owner. For rejection privilege, treat them as a notch
    // above admin: an AA can be rejected by an owner or super-admin, but
    // not by an admin or another AA.
    // 'director' was missing from this map. Because the lookup falls back
    // to 0, a director TARGET scored 0 (so anyone could remove them) and a
    // director CALLER scored 0 (so they could remove nobody, since every
    // target scored >= 0). Directors are owner-equivalent, so they sit
    // with owner at 3.
    const PRIVILEGE = {
      instructor: 1, admin: 2, admin_assistant: 2.5, director: 3, owner: 3, super_admin: 4,
    };
    if ((PRIVILEGE[targetRole] || 0) >= (PRIVILEGE[callerRole] || 0)) {
      return res.status(403).json({
        error: 'You cannot reject a user with equal or higher privilege.',
      });
    }
    // And they must share at least one centre with the target — otherwise
    // an owner of one centre could remove an instructor from another.
    const callerCenters = Array.isArray(caller.centerIds)
      ? caller.centerIds
      : (caller.centerId ? [caller.centerId] : []);
    const shareCenter = callerCenters.some(c => userIsAtCenter(target, c));
    if (!shareCenter) {
      return res.status(403).json({
        error: 'Target user is not at any centre you administer.',
      });
    }
  }

  // ── PREVIEW / TERMINATE ────────────────────────────────────────────
  if (mode === 'preview' || mode === 'terminate') {
    const owned = await collectOwnedDocs(db, uid, target.displayName);
    const counts = Object.fromEntries(Object.entries(owned).map(([c, d]) => [c, d.length]));
    const total = Object.values(counts).reduce((n, v) => n + v, 0);

    const payload = {
      exportedAt: new Date().toISOString(),
      exportedBy: { uid: session.decoded.uid, name: caller?.displayName || null, role: callerRole },
      reason: 'Staff termination from Ratio — Manage Staff',
      person: { uid, ...target },
      counts,
      total,
      collections: owned,
    };

    if (mode === 'preview') {
      return res.status(200).json({ ok: true, mode, counts, total, export: payload });
    }

    // Auth first: it's the security-critical half. If it fails, everything
    // is still on record and the admin can retry, rather than the data
    // being gone while the person can still sign in.
    let killedAuth = false;
    try {
      await getAuth().deleteUser(uid);
      killedAuth = true;
    } catch (err) {
      if (err?.code === 'auth/user-not-found') killedAuth = true;
      else {
        console.error('[terminate] deleteUser failed', { uid, code: err?.code });
        return res.status(500).json({
          error: 'Could not delete the sign-in account, so nothing else was removed: '
            + (err?.message || 'unknown error'),
        });
      }
    }

    let deletedDocs = 0;
    try {
      deletedDocs = await deleteOwnedDocs(db, owned);
      await db.collection('users').doc(uid).delete();
    } catch (err) {
      console.error('[terminate] data delete failed', { uid, message: err?.message });
      return res.status(207).json({
        ok: true, mode, counts, total, deletedAuth: killedAuth, deletedDocs,
        warning: 'Sign-in was removed but some data could not be deleted: '
          + (err?.message || '') + ' — run the termination again to finish.',
      });
    }

    // The termination itself is recorded. It is the one trace that stays,
    // and it has to: someone has to be able to answer who removed whom.
    try {
      await db.collection('auditLog').add({
        action: 'staff.terminated',
        actorUid: session.decoded.uid,
        actorName: caller?.displayName || null,
        actorRole: callerRole,
        targetUserId: null,                       // the account no longer exists
        centerId: target.centerId || null,
        createdAt: new Date(),
        details: {
          terminatedName: target.displayName || null,
          terminatedEmail: target.email || null,
          documentsDeleted: total,
          byCollection: counts,
        },
      });
    } catch (err) {
      console.error('[terminate] audit write failed', { uid, message: err?.message });
    }

    return res.status(200).json({
      ok: true, mode, counts, total, deletedAuth: killedAuth, deletedDocs, deletedProfile: true,
    });
  }

  // Best-effort disable of the Auth account. We try this first because it's
  // the security-critical half: if it fails we want the Firestore profile
  // to still be there so an admin can see something went wrong and retry.
  let deletedAuth = false;
  try {
    await getAuth().deleteUser(uid);
    deletedAuth = true;
  } catch (err) {
    // 'auth/user-not-found' — they may have already been removed from Auth
    // (e.g., manually in Firebase Console). Treat as success so we can
    // still clean up the orphaned Firestore profile.
    if (err?.code === 'auth/user-not-found') {
      deletedAuth = true;
    } else {
      console.error('[reject-user] deleteUser failed', { uid, code: err?.code, message: err?.message });
      return res.status(500).json({
        error: 'Failed to disable Firebase Auth account: ' + (err?.message || 'unknown error'),
      });
    }
  }

  // Now remove the Firestore profile. ProtectedRoute treats a missing
  // profile as "not approved" and shows the pending screen, but combined
  // with the disabled Auth account they won't even reach that screen — the
  // login itself rejects them.
  let deletedProfile = false;
  try {
    await db.collection('users').doc(uid).delete();
    deletedProfile = true;
  } catch (err) {
    console.error('[reject-user] Firestore delete failed', { uid, message: err?.message });
    // Auth is already disabled, so the user is effectively rejected even
    // if this cleanup failed. Report partial success so the admin can see
    // and retry without panicking.
    return res.status(207).json({
      ok: true,
      deletedAuth,
      deletedProfile: false,
      warning: 'Auth account disabled, but Firestore profile delete failed: ' + (err?.message || ''),
    });
  }

  return res.status(200).json({ ok: true, deletedAuth, deletedProfile });
}
