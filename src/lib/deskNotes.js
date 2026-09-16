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

import { resolvePermissions, isDirectorTitle } from './roles';
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

/**
 * The four states a note can be in.
 *
 * It used to be two — open or closed — and the other two are SUB-STATES OF
 * OPEN, not new top-level things. `isOpen()` still means "not settled", so
 * the sidebar badge, the "for me" inbox, the settled archive and all 1,853
 * imported rows carry on working without knowing these exist.
 *
 * `waiting` earns its place by saying something the desk could not say
 * before: this is not neglected, it is blocked on somebody outside the
 * room. The amber rail on the card already meant "somebody else's" — this
 * is that, written down, so a note nobody can move stops reading as a note
 * nobody has touched.
 */
/**
 * Who may ERASE a note, as opposed to settling one.
 *
 * MUST STAY IDENTICAL TO the notes rule in firestore.rules, which reads
 * `isOwnerLike() || isSuperAdmin()` — the owner, the admin assistant, a
 * director (by role, or by the legacy top-level title, which is what
 * isDirector() matches) and Enterprise. Managers and Hosts run the desk
 * and cannot clear it; tests/rules/desk.rules.test.js pins that.
 *
 * The desk's stance is that a note is SETTLED, not erased — the value of
 * the 1,853 rows carried over from the spreadsheet is being able to look
 * up what was decided. Deleting is for the other case: test rows, or a
 * note typed into the wrong centre. That is why it is a deliberate mode
 * rather than a cross on every card.
 */
export const NOTE_DELETE_ROLES = ['owner', 'admin_assistant', 'director', 'super_admin'];

export function canDeleteNotes({ platformRole, instructorType } = {}) {
  if (NOTE_DELETE_ROLES.includes(String(platformRole || ''))) return true;
  return isDirectorTitle(instructorType);
}

export const NOTE_STATUSES = [
  { key: 'open',        label: 'Open',        short: 'Open' },
  { key: 'in_progress', label: 'In progress', short: 'In progress' },
  { key: 'waiting',     label: 'Waiting on someone', short: 'Waiting' },
  { key: 'closed',      label: 'Settled',     short: 'Settled' },
];

/**
 * The statuses the live listener asks Firestore for.
 *
 * THE QUERY IS AN EXACT MATCH, and it used to be `status == 'open'`. A note
 * moved to "in progress" under that query simply disappeared off the desk —
 * so this list and the query that reads it have to stay in step. Firestore
 * `in` takes up to 30 values; there are three.
 */
export const LIVE_STATUSES = ['open', 'in_progress', 'waiting'];

/**
 * Anything that isn't recognisably one of the others is open — including
 * blank, which is what the oldest imported rows have.
 */
export function normaliseStatus(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'closed' || s === 'settled' || s === 'complete') return 'closed';
  if (s === 'in_progress' || s === 'inprogress' || s === 'doing') return 'in_progress';
  if (s === 'waiting' || s === 'blocked' || s === 'on_hold') return 'waiting';
  return 'open';
}

/** Not settled. In progress and waiting are still open work. */
export function isOpen(note) {
  return normaliseStatus(note?.status) !== 'closed';
}

export function statusLabel(note) {
  const key = normaliseStatus(note?.status);
  return (NOTE_STATUSES.find(s => s.key === key) || NOTE_STATUSES[0]).short;
}

/**
 * The fields a status change writes.
 *
 * Settling stamps who and when, because the archive is sorted by it.
 * Moving back out of settled CLEARS both — a note that was reopened and
 * settled again would otherwise keep the first date and sort to the wrong
 * place in an archive of 1,730.
 */
export function statusFields(status, who) {
  const key = normaliseStatus(status);
  return key === 'closed'
    ? { status: key, settledAt: new Date().toISOString(), settledByName: who || 'Someone' }
    : { status: key, settledAt: null, settledByName: null };
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

/**
 * Settled, most recently SETTLED first — not by the date it was logged.
 *
 * Three kinds of note are in there, and only one of them knows when it
 * was settled:
 *
 *   1. Settled in Ratio: `settledAt`. Newest first.
 *   2. Imported: the spreadsheet never recorded a settle date, but the
 *      Settled Notes tab was kept newest-settled at the TOP — a note
 *      logged 13 Aug sat fourth, among September ones. `sheetOrder` is
 *      that row position; lower is more recent.
 *   3. Imported before `sheetOrder` existed: the logged date is all
 *      there is.
 *
 * Every note in (1) was settled after the import, so all of them go
 * above (2) and (3) without needing to compare a time with a row number.
 */
export function sortSettled(notes) {
  const tier = (n) => (n?.settledAt ? 0 : Number.isFinite(n?.sheetOrder) ? 1 : 2);
  return [...(notes || [])].sort((a, b) => {
    const ta = tier(a); const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 0) return String(b.settledAt).localeCompare(String(a.settledAt));
    if (ta === 1 && a.sheetOrder !== b.sheetOrder) return a.sheetOrder - b.sheetOrder;
    const ad = String(a?.loggedAt || ''); const bd = String(b?.loggedAt || '');
    if (ad !== bd) return ad < bd ? 1 : -1;
    return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
  });
}

/**
 * The settled list after a write to one note.
 *
 * Settled is fetched once rather than listened to (1,730 documents), so
 * nothing else tells it that a note was just marked done, reopened or
 * replied to. Without this a note you had just settled was missing from
 * Settled until a reload — the one note most likely to be looked for —
 * and a reopened one stayed there as well as in Open.
 *
 * `null` stays null: not fetched yet, and the fetch will include it.
 */
export function applyToArchive(archive, note, fields) {
  if (!archive) return archive;
  const merged = { ...note, ...fields };
  const rest = archive.filter(n => n.id !== note.id);
  return isOpen(merged) ? rest : [merged, ...rest];
}

// ─── Due dates ───────────────────────────────────────────────────────────
//
// Optional, and deliberately quiet. A note without one behaves exactly as
// it always has. An overdue one turns red and floats to the top of your
// own list — it does not email anybody and it does not close itself. A due
// date here is a promise made to a parent, not an alarm.
//
// 'YYYY-MM-DD', centre-local, parsed at noon: `new Date('2026-09-17')` is
// the 16th in Pacific, which is the same trap shift.date documents.

/** Days from `today` until the due date. Negative means it has passed. */
export function daysUntilDue(note, today) {
  const due = String(note?.dueDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  const at = (ymd) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0).getTime();
  };
  const now = typeof today === 'string' ? at(today) : at(ymdOf(today || new Date()));
  return Math.round((at(due) - now) / 86400000);
}

/** 'YYYY-MM-DD' for a Date, in local time. */
export function ymdOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * How a due date should read: null when there isn't one, and never
 * 'overdue' on a settled note — a thing that is done cannot be late.
 */
export function dueState(note, today) {
  if (!isOpen(note)) return note?.dueDate ? 'settled' : null;
  const days = daysUntilDue(note, today);
  if (days === null) return null;
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 6) return 'soon';
  return 'later';
}

/** The words on the chip. */
export function dueLabel(note, today) {
  const state = dueState(note, today);
  if (!state) return '';
  const days = daysUntilDue(note, today);
  if (state === 'settled') return `Was due ${shortDate(note.dueDate)}`;
  if (state === 'overdue') {
    const late = Math.abs(days);
    return late === 1 ? 'Overdue by a day' : `Overdue by ${late} days`;
  }
  if (state === 'today') return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due ${shortDate(note.dueDate)}`;
}

/** '2026-09-19' → 'Fri 19 Sep'. */
export function shortDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

/** The quick picks on the due-date control, as offsets in days. */
export function dueSuggestions(today) {
  const base = typeof today === 'string' ? today : ymdOf(today || new Date());
  const [y, m, d] = base.split('-').map(Number);
  const plus = (n) => {
    const date = new Date(y, m - 1, d, 12);
    date.setDate(date.getDate() + n);
    return ymdOf(date);
  };
  return [
    { label: 'Today', date: plus(0) },
    { label: 'Tomorrow', date: plus(1) },
    { label: shortDate(plus(3)), date: plus(3) },
    { label: 'Next week', date: plus(7) },
  ];
}

/**
 * Your own list, ordered by what is actually pressing: overdue first
 * (most overdue at the top), then today, then the rest by due date, then
 * everything undated in the order the desk already uses.
 *
 * Undated notes go LAST rather than first. They are not less important —
 * but a list that puts "no idea when" above "late since Tuesday" is a list
 * that gets skimmed instead of worked.
 */
export function sortByDue(notes, today) {
  const rank = (n) => {
    const days = daysUntilDue(n, today);
    return days === null ? 1 : 0;
  };
  return [...(notes || [])].sort((a, b) => {
    const ra = rank(a); const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      const da = daysUntilDue(a, today); const db = daysUntilDue(b, today);
      if (da !== db) return da - db;
    }
    const ad = String(a?.loggedAt || ''); const bd = String(b?.loggedAt || '');
    if (ad !== bd) return ad < bd ? 1 : -1;
    return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
  });
}

/** How old an open note is, in days. The desk shows it as "day 11". */
export function ageInDays(note, today) {
  const logged = String(note?.loggedAt || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(logged)) return null;
  return -daysUntilDue({ dueDate: logged }, today);
}

/**
 * The four figures above the list, and the same ones the home card reads.
 * Counts only what is waiting on THIS person: a desk-wide number is not
 * something anybody can act on.
 */
export function deskSummary(notes, uid, today) {
  const mine = (notes || []).filter(n => isOpen(n) && isForMe(n, uid));
  const overdue = mine.filter(n => dueState(n, today) === 'overdue');
  const thisWeek = mine.filter(n => ['today', 'soon'].includes(dueState(n, today)));
  const ages = mine.map(n => ageInDays(n, today)).filter(n => Number.isFinite(n));
  return {
    onYou: mine.length,
    overdue: overdue.length,
    dueThisWeek: thisWeek.length,
    oldestDays: ages.length > 0 ? Math.max(...ages) : 0,
    items: sortByDue(mine, today),
  };
}

export const NOTE_VIEWS = {
  mine:     { key: 'mine',     label: 'For me' },
  open:     { key: 'open',     label: 'All open' },
  progress: { key: 'progress', label: 'In progress' },
  waiting:  { key: 'waiting',  label: 'Waiting' },
  sent:     { key: 'sent',     label: 'I sent' },
  closed:   { key: 'closed',   label: 'Settled' },
};

/**
 * The list for one view.
 *
 * "For me" is open notes only — a settled note is not a thing you have
 * to do, and leaving them in the list is how an inbox stops being read.
 */
export function filterNotes(notes, { view = 'mine', uid = null, q = '', today = null } = {}) {
  const rows = (notes || []).filter(n => matchesQuery(n, q));
  const byView = {
    mine:     rows.filter(n => isOpen(n) && isForMe(n, uid)),
    open:     rows.filter(isOpen),
    progress: rows.filter(n => normaliseStatus(n.status) === 'in_progress'),
    waiting:  rows.filter(n => normaliseStatus(n.status) === 'waiting'),
    sent:     rows.filter(n => isFromMe(n, uid)),
    closed:   rows.filter(n => !isOpen(n)),
  };
  // Your own list leads with what is late; every other view keeps the
  // desk's existing order.
  if (view === 'mine') return sortByDue(byView.mine, today);
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

/** Who sent it, in as few words as read naturally. */
export function firstNameOrLabel(note) {
  const name = String(note?.fromName || '').trim();
  if (name) return name.split(/\s+/)[0];
  return note?.fromInitials || 'someone';
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
