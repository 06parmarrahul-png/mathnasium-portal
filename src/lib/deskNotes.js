/**
 * deskNotes.js — the management team's post-it notes.
 *
 * WHAT THIS REPLACES
 *   A shared spreadsheet with two tabs: "General" for live notes and
 *   "Settled Notes" for closed ones, 1,853 rows between them. A note is
 *   addressed TO somebody, FROM somebody, about an account or a student,
 *   and stays Open until whoever it was for has dealt with it.
 *
 * WHAT THE SPREADSHEET COULDN'T DO, AND THIS HAS TO
 *   - "What's open for ME?" meant reading 121 rows looking for your own
 *     initials. It is the only question anyone actually asks, so it is
 *     what the app opens on.
 *   - Status was typed by hand: 'Closed', 'closed' and 'CLOSED' all
 *     appear, and 18 rows sat in the settled tab still marked Open.
 *     normaliseStatus() below is the whole of that problem, solved once.
 *   - Replies lived in TWO columns, split by which half of the team was
 *     answering ("AY MY JW NG Response" / "RR SK DP RP VB Response").
 *     That is a workaround for two people not being able to type in one
 *     cell, not a real distinction — so replies here are one thread with
 *     an author on each.
 *
 * PEOPLE, AND WHY BOTH A UID AND A LABEL
 *   Live notes address real Ratio accounts. Imported ones carry initials
 *   for people who may have left — MY, JW, VS, DP and others appear in
 *   the history with no current account. Both are kept: `toUids` drives
 *   "open for me", `toLabel` is what the note actually said. A note must
 *   never lose who it was for just because they no longer work here.
 */

import { resolvePermissions } from './roles';
import { resolveUserForCenter } from './centerMembership';

/**
 * The titles that run the desk, and the platform roles that do.
 *
 * MUST STAY IDENTICAL TO canUseDeskAt() IN firestore.rules. The rules are
 * the boundary; this is only what the app shows. When they disagree the
 * result is one of two bad days: a page that loads and then refuses every
 * read, or — what happened to Rahul — a person the rules would happily
 * let in who cannot find the door.
 */
export const DESK_TITLES = [
  'Manager', 'Host', 'Admin',
  'Center Director', 'Centre Director',
  'Dir. of Education', 'Director of Education',
];

export const DESK_PLATFORM_ROLES = [
  'owner', 'super_admin', 'admin_assistant', 'director', 'admin',
];

/**
 * Can this person open the desk?
 *
 * DELIBERATELY NOT just `permissions.has('notes.access')`.
 *
 * A centre that has ever saved its roles from Manage Roles has a stored
 * registry, and the editor writes the WHOLE list back — so those stored
 * arrays were frozen with the permissions that existed on the day they
 * were saved. `notes.access` did not exist then, so it is absent, and the
 * stored entry shadows the built-in grant. Rahul is a Host at a centre
 * that had customised its roles, so the permission never reached him.
 *
 * The title check is what the rules do, so it is what this does. The
 * permission is still honoured on top: that is the path a centre uses to
 * put somebody else on the desk from Manage Roles.
 */
export function canUseDesk({ platformRole, instructorType, permissions } = {}) {
  if (DESK_PLATFORM_ROLES.includes(String(platformRole || ''))) return true;
  if (DESK_TITLES.includes(String(instructorType || '').trim())) return true;
  return !!permissions?.has?.('notes.access');
}

/**
 * Who can be sent a note.
 *
 * Only people who can actually OPEN the desk. Addressing a note to an
 * instructor would file it somewhere they have no way to read, which is
 * worse than not offering them: the sender would believe it had been
 * passed on.
 *
 * Asked of the same resolver the rest of the app uses, so a role granted
 * `notes.access` in Manage Roles appears in this list with no code change.
 */
export function deskMembers(users, centerId, centreRoles) {
  return (users || [])
    .filter(u => {
      const at = resolveUserForCenter(u, centerId);
      return canUseDesk({
        platformRole: u?.role,
        instructorType: at?.instructorType,
        permissions: resolvePermissions({
          platformRole: u?.role,
          instructorType: at?.instructorType,
          isVolunteer: at?.isVolunteer === true,
          roles: centreRoles || [],
        }),
      });
    })
    .sort((a, b) => String(a?.displayName || '').localeCompare(String(b?.displayName || '')));
}

/** Anything that isn't recognisably closed is open — including blank. */
export function normaliseStatus(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'closed' || s === 'settled' || s === 'complete') return 'closed';
  return 'open';
}

export function isOpen(note) {
  return normaliseStatus(note?.status) === 'open';
}

/** "Rahul Parmar" → "RP". Falls back to one letter, then to nothing. */
export function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  // "Jieun (Joanne) Lee" — a bracketed preferred name is not an initial.
  const real = parts.filter(p => !p.startsWith('('));
  const use = real.length > 0 ? real : parts;
  return (use[0][0] + (use.length > 1 ? use[use.length - 1][0] : '')).toUpperCase();
}

/**
 * Is this note addressed to me?
 *
 * `toAll` covers the 82 notes addressed to "ALL" — everyone's business,
 * so everyone's inbox.
 */
export function isForMe(note, uid) {
  if (!note || !uid) return false;
  if (note.toAll) return true;
  return (note.toUids || []).includes(uid);
}

/** Did I write it? Used to show "waiting on them" rather than "to do". */
export function isFromMe(note, uid) {
  return !!uid && note?.fromUid === uid;
}

/** Everything this note can be searched by, folded to lower case once. */
export function searchBlob(note) {
  return [
    note?.subject, note?.body, note?.fromName, note?.fromInitials,
    note?.toLabel, ...(note?.replies || []).map(r => `${r.name} ${r.text}`),
  ].filter(Boolean).join(' • ').toLowerCase();
}

export function matchesQuery(note, q) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return true;
  // Every word has to appear somewhere. "harshad gift" finds the note
  // about Harshad's gift card without needing the words adjacent.
  const blob = searchBlob(note);
  return needle.split(/\s+/).every(w => blob.includes(w));
}

/**
 * Newest first, by the date it was LOGGED rather than created.
 *
 * Imported rows carry the date from the spreadsheet; a note logged today
 * about something that happened last week can say so. createdAt breaks
 * the tie so two notes on one day keep a stable order.
 */
export function sortNotes(notes) {
  return [...(notes || [])].sort((a, b) => {
    const ad = String(a?.loggedAt || ''); const bd = String(b?.loggedAt || '');
    if (ad !== bd) return ad < bd ? 1 : -1;
    return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
  });
}

export const NOTE_VIEWS = {
  mine:   { key: 'mine',   label: 'For me' },
  open:   { key: 'open',   label: 'All open' },
  sent:   { key: 'sent',   label: 'I sent' },
  closed: { key: 'closed', label: 'Settled' },
};

/**
 * The list for one view.
 *
 * "For me" is open notes only — a settled note is not a thing you have
 * to do, and leaving them in the list is how an inbox stops being read.
 */
export function filterNotes(notes, { view = 'mine', uid = null, q = '' } = {}) {
  const rows = (notes || []).filter(n => matchesQuery(n, q));
  const byView = {
    mine:   rows.filter(n => isOpen(n) && isForMe(n, uid)),
    open:   rows.filter(isOpen),
    sent:   rows.filter(n => isFromMe(n, uid)),
    closed: rows.filter(n => !isOpen(n)),
  };
  return sortNotes(byView[view] || byView.mine);
}

/** How many open notes are waiting on this person. Drives the badge. */
export function myOpenCount(notes, uid) {
  return (notes || []).filter(n => isOpen(n) && isForMe(n, uid)).length;
}

/** What a note needs before it can be saved. Returns an error, or null. */
export function validateNote(draft) {
  if (!String(draft?.subject || '').trim()) return 'Give it a subject — an account, a student, or what it’s about.';
  if (!String(draft?.body || '').trim()) return 'Say what the note is.';
  if (!draft?.toAll && (draft?.toUids || []).length === 0) return 'Pick who it’s for.';
  if (!draft?.loggedAt) return 'Pick the date.';
  return null;
}

/**
 * Who a note is for, in words.
 *
 * Prefers live accounts, falls back to whatever the spreadsheet said —
 * an imported note addressed to somebody long gone still has to render.
 */
export function recipientNames(note, nameByUid = {}) {
  if (note?.toAll) return 'Everyone';
  const named = (note?.toUids || []).map(u => nameByUid[u]).filter(Boolean);
  if (named.length > 0) return named.join(', ');
  return note?.toLabel || 'Unassigned';
}
