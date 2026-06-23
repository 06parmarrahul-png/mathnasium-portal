// User contact privacy layer.
//
// Sensitive PII (email, phone) physically lives under
//   users/{uid}/private/contact
// rather than on the user doc, so Firestore rules can restrict reads
// to "self + admin / admin_assistant / owner / super_admin". Other
// signed-in users (instructors) can NEVER read another user's private
// sub-doc — Firestore rules make it return permission-denied at the
// database layer, not just hidden in the UI.
//
// Opt-in sharing: when a user toggles `emailPublic` (or `phonePublic`)
// to true, we mirror that value to `users/{uid}.publicEmail` (or
// publicPhone). The parent user doc IS signed-in-readable, so the
// mirror is what makes the contact visible to peers. Toggling off
// deletes the mirror.
//
// Source of truth: the sub-doc. Mirrors derive from it.

import {
  doc, getDoc, setDoc, deleteField, onSnapshot, updateDoc,
} from 'firebase/firestore';
import { db } from '../firebase';

// ─── Reads ───────────────────────────────────────────────────────────

const privateRef = (uid) => doc(db, 'users', uid, 'private', 'contact');

/**
 * Subscribe to the signed-in user's OWN private contact. Used by
 * AccountDetails to populate the email / phone form fields.
 */
export function watchOwnContact(uid, cb) {
  return onSnapshot(privateRef(uid), (snap) => {
    cb(snap.exists() ? snap.data() : { email: '', phone: '' });
  });
}

/**
 * Admin lookup — fetch any user's private contact. Used by
 * UserProfileModal when the viewer is admin+. Throws permission-denied
 * for non-admin callers reading other users (Firestore rules enforce).
 */
export async function getContact(uid) {
  const snap = await getDoc(privateRef(uid));
  return snap.exists() ? snap.data() : { email: '', phone: '' };
}

/**
 * Batch helper for admin-triggered notification flows (schedule posted,
 * shift edit, etc.). Returns each input user with `email` resolved —
 * either from the user doc (legacy / unmigrated profiles) OR from the
 * private contact sub-doc (post-migration). Falls back to '' silently
 * for users with no contact info anywhere.
 *
 * Caller must be admin+ for the cross-user reads to succeed; rule
 * enforcement returns permission-denied otherwise and we leave email
 * blank rather than crashing the whole batch.
 */
export async function attachEmails(users) {
  if (!Array.isArray(users) || users.length === 0) return [];
  return Promise.all(users.map(async (u) => {
    if (u.email) return u; // legacy / not migrated yet
    try {
      const c = await getContact(u.uid);
      return { ...u, email: c?.email || '' };
    } catch {
      return { ...u, email: '' };
    }
  }));
}

// ─── Writes ──────────────────────────────────────────────────────────

/**
 * Save the user's email / phone to the private sub-doc AND, if the
 * corresponding public toggle is on, mirror to the user doc so peers
 * can see the value. Toggle-off paths delete the mirror.
 *
 * Pass `null` / undefined to a field to leave it unchanged.
 *
 * @param {string} uid                  — target user UID (must be self unless admin+)
 * @param {Object} params
 * @param {string} [params.email]       — new email value
 * @param {string} [params.phone]       — new phone value
 * @param {boolean} [params.emailPublic] — flip mirror on/off
 * @param {boolean} [params.phonePublic] — flip mirror on/off
 */
export async function saveContact(uid, { email, phone, emailPublic, phonePublic }) {
  // 1. Persist source-of-truth values to the private sub-doc.
  const privatePatch = {};
  if (email !== undefined) privatePatch.email = (email || '').trim();
  if (phone !== undefined) privatePatch.phone = (phone || '').trim();
  if (emailPublic !== undefined) privatePatch.emailPublic = !!emailPublic;
  if (phonePublic !== undefined) privatePatch.phonePublic = !!phonePublic;
  if (Object.keys(privatePatch).length > 0) {
    await setDoc(privateRef(uid), privatePatch, { merge: true });
  }

  // 2. Update the parent user doc's mirror fields so other signed-in
  //    users can see the values when the user opted in. We always read
  //    the *resulting* private values (post-write) so the mirror stays
  //    consistent even if the caller only flipped a toggle without
  //    passing email/phone.
  const snap = await getDoc(privateRef(uid));
  const current = snap.exists() ? snap.data() : {};
  const userPatch = {};
  // Email
  if (current.emailPublic && current.email) {
    userPatch.publicEmail = current.email;
    userPatch.emailPublic = true;
  } else {
    userPatch.publicEmail = deleteField();
    userPatch.emailPublic = false;
  }
  // Phone
  if (current.phonePublic && current.phone) {
    userPatch.publicPhone = current.phone;
    userPatch.phonePublic = true;
  } else {
    userPatch.publicPhone = deleteField();
    userPatch.phonePublic = false;
  }
  await updateDoc(doc(db, 'users', uid), userPatch);
}

// ─── Migration helper ────────────────────────────────────────────────
// Older accounts have email + phone stored DIRECTLY on the user doc.
// On the user's next visit to AccountDetails, we lazily migrate those
// values into the private sub-doc and clear them from the parent. Run
// once per user; subsequent visits are no-ops.
export async function lazyMigrateContact(uid, legacyUserDoc) {
  if (!legacyUserDoc) return;
  const hasLegacy = (legacyUserDoc.email || legacyUserDoc.phone) &&
                    !(legacyUserDoc.publicEmail || legacyUserDoc.publicPhone);
  if (!hasLegacy) return;
  // Check whether the private sub-doc already exists. If yes, the
  // migration already ran on a different device — just clear legacy.
  const privSnap = await getDoc(privateRef(uid));
  if (!privSnap.exists()) {
    await setDoc(privateRef(uid), {
      email: (legacyUserDoc.email || '').trim(),
      phone: (legacyUserDoc.phone || '').trim(),
      emailPublic: false,
      phonePublic: false,
    });
  }
  // Strip the legacy fields from the user doc. Keep the displayName /
  // etc; only the sensitive duplicates go. The mirrored publicEmail /
  // publicPhone fields stay off by default (privacy-first migration).
  await updateDoc(doc(db, 'users', uid), {
    email: deleteField(),
    phone: deleteField(),
  });
}
