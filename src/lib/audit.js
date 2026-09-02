/**
 * Audit log — a tamper-evident record of sensitive platform-operator
 * actions, written to the `auditLog` Firestore collection.
 *
 * What gets logged:
 *   - Super-admin center switches (god-view into another centre)
 *   - Center creation
 *   - Billing edits (Platform Revenue tab)
 *   - Anything else that should be visible to a centre owner asking
 *     "what can the platform operator do to my data"
 *
 * What is NOT logged:
 *   Regular app actions (posting shifts, sub-role toggles, sending chat
 *   messages). Those are part of the normal app activity stream and
 *   don't belong here.
 *
 * Why this lives client-side: every action we log is initiated by a
 * signed-in user, and Firestore rules enforce that the actor uid on each
 * row matches request.auth.uid. The server can't lie about who did
 * something because the row is written under the user's own credentials.
 *
 * Each entry is append-only (Firestore rules forbid update/delete) so
 * once written, it cannot be revised by the actor.
 */

import { collection, addDoc } from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';

/**
 * @param {Object} profile  - the actor's profile (from useAuth)
 * @param {Object} args
 * @param {string} args.action       - dotted identifier, e.g. 'super_admin.center_switch'
 * @param {string} [args.centerId]   - the centre this action affected
 * @param {string} [args.targetUserId] - if the action affected another user
 * @param {Object} [args.details]    - small free-form bag of context (kept short)
 *
 * Returns the new auditLog doc id, or null if the write failed (audit
 * writes never throw — a missed log line shouldn't break the action it
 * was recording).
 */
export async function logAuditEvent(profile, { action, centerId, targetUserId, details } = {}) {
  if (!profile?.uid || !action) return null;
  try {
    const ref = await addDoc(collection(db, 'auditLog'), {
      actorUid:   profile.uid,
      actorName:  profile.displayName || profile.email || profile.uid,
      actorRole:  profile.role || 'unknown',
      action,
      centerId:   centerId || null,
      targetUserId: targetUserId || null,
      details:    details || null,
      createdAt:  serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    // Fail silently. The audit log is a "nice to have" alongside the
    // action; we never want a logging hiccup to surface to the user.
    console.warn('[audit] failed to write entry', { action, error: err?.message });
    return null;
  }
}

/**
 * Common action identifiers. Using constants instead of bare strings
 * keeps the read-side panel stable when we rename things.
 */
export const AUDIT_ACTIONS = {
  CENTER_SWITCH:   'super_admin.center_switch',
  CENTER_CREATE:   'super_admin.center_create',
  BILLING_UPDATE:  'super_admin.billing_update',
  BILLING_MARK_PAID: 'super_admin.billing_mark_paid',
  // Role management from the Manage Roles screen. The role string
  // is left as 'super_admin' in the action code (internal identifier) to
  // keep the prefix stable across the codebase, even though the UI now
  // labels that role "Enterprise".
  ROLE_CHANGE:     'super_admin.role_change',
  PROMOTE_CODE_SET: 'super_admin.promote_code_set',
  // Centre access changes from the Manage Roles screen — when an
  // Enterprise user updates which centres a member belongs to.
  CENTER_ASSIGNMENT: 'super_admin.center_assignment',
  // Written by api/users/reject-user.js (mode: 'terminate'), not from the
  // client — the account is gone by then. Listed here so the code is
  // discoverable and AuditLogs.jsx has something to match on.
  STAFF_TERMINATED: 'staff.terminated',
  // Clearing data left behind by an account deleted before Terminate
  // existed. Also written server-side.
  STAFF_ORPHANS_PURGED: 'staff.orphans_purged',
};
