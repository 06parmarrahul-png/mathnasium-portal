/**
 * deskImport.js — bringing the spreadsheet across.
 *
 * 1,853 notes, 57 gift cards, 129 receipts, 28 referral rows and 15
 * student-of-the-month rows. The value of the history is being able to
 * look up what was decided — "what happened with Harshad's gift card?" —
 * so it comes over rather than being left behind in a file nobody opens.
 *
 * WHY THE MAPPING HAPPENS IN THE APP, NOT IN THE FILE
 *   The sheet addresses people by initials: MY, NG, JW, VB. Turning those
 *   into Ratio accounts needs the live roster, which only exists once
 *   somebody is signed in. So the file carries the initials as written and
 *   these functions resolve them at import time, against the real people
 *   who can open the desk.
 *
 *   Anything that doesn't resolve keeps its initials and is shown as
 *   written. A note must never lose who it was for just because that
 *   person has left — and several of the initials in the history belong
 *   to people who have.
 */

import { initialsOf } from './deskNotes';

/**
 * 'VB/NG' → the uids of those two people, where they still exist.
 *
 * Matches on initials derived from the display name, so it keeps working
 * as people join: nothing is hard-coded to the current team.
 */
export function resolveInitials(label, members) {
  const raw = String(label ?? '').trim();
  if (!raw) return [];
  if (/^all$/i.test(raw)) return [];                 // handled by toAll
  const byInitials = new Map();
  for (const m of members || []) {
    const key = initialsOf(m?.displayName).toUpperCase();
    if (key && !byInitials.has(key)) byInitials.set(key, m.uid);
  }
  const out = [];
  for (const part of raw.split(/[/,&+]/)) {
    const uid = byInitials.get(part.trim().toUpperCase());
    if (uid && !out.includes(uid)) out.push(uid);
  }
  return out;
}

export function isEveryone(label) {
  return /^all$/i.test(String(label ?? '').trim());
}

/**
 * "9/2: Thanks, I've taken note of this! - RR" → { initials: 'RR', text }.
 *
 * The reply columns were headed with a GROUP of initials rather than a
 * person, so the only reliable author is the one some people signed at
 * the end. Where there is no signature the reply keeps no author, which
 * is honest — inventing one would be worse than "Someone".
 */
export function parseReplySignature(text) {
  const s = String(text ?? '').trim();
  const m = /^([\s\S]*?)[\s]*[-–—]\s*([A-Z]{2,3})\s*$/.exec(s);
  if (m && m[1].trim()) return { initials: m[2], text: m[1].trim() };
  return { initials: null, text: s };
}

/**
 * One spreadsheet row → one note document.
 *
 * `row` is the shape the converter produces: plain strings, dates already
 * normalised to ISO. Returns null for a row with nothing in it — the
 * sheets are padded out with hundreds of empty ones.
 */
export function noteFromRow(row, members, { importedAt } = {}) {
  const subject = String(row?.subject ?? '').trim();
  const body = String(row?.body ?? '').trim();
  if (!subject && !body) return null;

  const replies = [];
  for (const r of row?.replies || []) {
    const text = String(r ?? '').trim();
    if (!text) continue;
    const sig = parseReplySignature(text);
    replies.push({
      uid: null,
      name: null,
      initials: sig.initials,
      text: sig.text,
      at: row?.loggedAt || null,
      imported: true,
    });
  }

  const toLabel = String(row?.to ?? '').trim();
  const fromInitials = String(row?.from ?? '').trim();
  const fromUid = resolveInitials(fromInitials, members)[0] || null;

  return {
    toUids: resolveInitials(toLabel, members),
    toLabel: isEveryone(toLabel) ? 'Everyone' : toLabel,
    toAll: isEveryone(toLabel),
    fromUid,
    fromName: fromUid
      ? (members.find(m => m.uid === fromUid)?.displayName || fromInitials)
      : null,
    fromInitials,
    subject: subject || '(no subject)',
    body,
    loggedAt: row?.loggedAt || null,
    createdAt: row?.loggedAt ? `${row.loggedAt}T12:00:00.000Z` : (importedAt || new Date().toISOString()),
    // The sheet's own status, already folded to open/closed by the
    // converter. A row with nothing in the column is open.
    status: row?.status === 'closed' ? 'closed' : 'open',
    replies,
    imported: true,
  };
}

/** Rows → documents, dropping the empties. Order is preserved. */
export function notesFromRows(rows, members, opts) {
  const out = [];
  for (const r of rows || []) {
    const n = noteFromRow(r, members, opts);
    if (n) out.push(n);
  }
  return out;
}

/**
 * What an import is about to do, before it does it.
 *
 * Shown as a confirmation. Writing 1,853 documents into a live centre is
 * not something to do on a button press with no idea of the shape of it.
 */
export function importSummary(payload, members) {
  const notes = notesFromRows(payload?.notes, members);
  const matched = notes.filter(n => n.toAll || n.toUids.length > 0).length;
  return {
    notes: notes.length,
    notesAddressed: matched,
    notesUnmatched: notes.length - matched,
    open: notes.filter(n => n.status === 'open').length,
    giftCards: (payload?.giftCards || []).length,
    receipts: (payload?.receipts || []).length,
    referrals: (payload?.referrals || []).length,
    studentOfMonth: (payload?.studentOfMonth || []).length,
  };
}

/** Firestore takes at most 500 writes per batch. */
export const BATCH_LIMIT = 450;

export function chunk(rows, size = BATCH_LIMIT) {
  const out = [];
  for (let i = 0; i < (rows || []).length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
