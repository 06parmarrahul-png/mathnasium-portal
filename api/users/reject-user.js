// POST /api/users/reject-user
//
// Fully rejects a pending instructor: disables their Firebase Auth account
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

  const uid = String(body.uid || '').trim();
  if (!uid) return res.status(400).json({ error: 'uid required' });
  if (uid === session.decoded.uid) {
    return res.status(400).json({ error: 'You cannot reject your own account.' });
  }

  const db = getFirestore();
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
    const PRIVILEGE = { instructor: 1, admin: 2, admin_assistant: 2.5, owner: 3, super_admin: 4 };
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
