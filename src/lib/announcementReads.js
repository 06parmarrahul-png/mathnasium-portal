/**
 * announcementReads.js — which announcements a person has already read.
 *
 * WHY A STORED MARKER AND NOT localStorage
 *   The front desk runs one browser that half the staff sign into. A marker
 *   in localStorage belongs to the DEVICE, so the first person to read an
 *   announcement would clear the badge for everyone who used that tablet
 *   after them — and their own phone would still show it. "Read" is a fact
 *   about a person, so it lives with the person:
 *
 *     users/{uid}/private/reads  →  { announcementsSeenAt: <ISO string> }
 *
 *   That subtree is already readable and writable by the user themselves
 *   plus owner / super-admin / admin (firestore.rules, `private/{doc=**}`),
 *   so this needs no rules change. Nothing sensitive is in it either way —
 *   it records only when somebody last looked.
 *
 * WHY THE MARKER IS AN ANNOUNCEMENT'S DATE, NOT "NOW"
 *   Storing the moment of the tap means a phone whose clock runs a few
 *   minutes fast can mark an announcement read before it was posted, and
 *   the next one silently never counts as new. Storing the newest date the
 *   person actually saw compares like with like — both values come from the
 *   same field, so no clock but the poster's is involved.
 */

import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../firebase';

const readsRef = (uid) => doc(db, 'users', uid, 'private', 'reads');

/**
 * An announcement's date as one comparable ISO string.
 *
 * `date` is written as an ISO string and has been for the life of the
 * collection, which is why `orderBy('date')` works at all. A Firestore
 * Timestamp is still handled, because one legacy document of the wrong
 * shape should not make the badge lie.
 */
export function dateKey(a) {
  const d = a?.date;
  if (!d) return '';
  if (typeof d === 'string') return d;
  if (d instanceof Date) return d.toISOString();
  if (typeof d.toDate === 'function') {
    try { return d.toDate().toISOString(); } catch { return ''; }
  }
  return '';
}

/** The newest date in a list of announcements, or '' if there are none. */
export function newestDate(rows) {
  let newest = '';
  for (const r of rows || []) {
    const k = dateKey(r);
    if (k && k > newest) newest = k;
  }
  return newest;
}

/**
 * How many are newer than what this person last saw.
 *
 * No marker means they have never opened them, so everything counts. That
 * is the honest reading — a new starter genuinely has not read any of it —
 * and one tap clears it.
 */
export function unreadCount(rows, seenAt) {
  return (rows || []).filter(r => {
    const k = dateKey(r);
    return k && (!seenAt || k > seenAt);
  }).length;
}

/**
 * What the badge says. '' when there is nothing to say.
 *
 * The home page fetches only the few most recent announcements, so a count
 * that fills the fetch might be an undercount. Showing "5" when there are
 * seven is a small lie; "5+" is not.
 */
export function unreadLabel(count, fetched, limit) {
  if (count <= 0) return '';
  if (limit && count >= limit && fetched >= limit) return `${limit}+`;
  return String(count);
}

/** Subscribe to the signed-in user's own marker. Returns an unsubscribe. */
export function watchLastSeen(uid, cb) {
  if (!uid) { cb(null); return () => {}; }
  return onSnapshot(
    readsRef(uid),
    (snap) => cb(snap.exists() ? (snap.data()?.announcementsSeenAt ?? null) : null),
    // Not knowing is the same state as never having read anything: the
    // badge shows, a tap clears it. Better than a page that breaks.
    () => cb(null),
  );
}

/**
 * Record that they have seen everything up to `seenAt`.
 *
 * Never moves the marker backwards — opening an old announcement after a
 * new one arrived must not make the new one unread again.
 */
export async function markSeen(uid, seenAt, previous = '') {
  if (!uid || !seenAt) return;
  if (previous && seenAt <= previous) return;
  await setDoc(readsRef(uid), {
    announcementsSeenAt: seenAt,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}
