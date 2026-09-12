/**
 * deskParse.js — reading a line the way it actually gets written.
 *
 * THE GRAMMAR IS NOT INVENTED. It was measured against all 1,750 notes:
 *   99.8% address somebody by INITIALS, or ALL
 *   99.9% are FROM somebody by initials
 *   47%   name a person in the subject
 * The four exceptions are things like "NG for DP/VB" — still initials.
 *
 * So: initials mean a colleague, a full name means a family. That is the
 * centre's own convention and it holds almost without exception, which is
 * why this can read a line reliably rather than hopefully.
 *
 * TWO ROSTERS, DELIBERATELY SEPARATE
 *   "Who it's FOR" is matched only against people who can open the Desk.
 *   "Who it's ABOUT" is matched only against students.
 *
 *   They must never share a pool. Built from all 53 staff, "MY" resolved to
 *   a volunteer who is ALSO a student at the centre — and a lot of the
 *   volunteers are students, so that is a permanent hazard rather than one
 *   odd record. Keeping the rosters apart is what stops a teenage volunteer
 *   being credited with the director's post-its.
 *
 * IT NEVER INVENTS A PERSON. An unrecognised name is offered, not applied.
 */

import { topicOf, labelsOf, mentionsFamily } from './deskVocab';

/** "Rahul Parmar" → "RP". Bracketed preferred names are not initials. */
export function initialsOf(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  const real = parts.filter(p => !p.startsWith('('));
  const use = real.length > 0 ? real : parts;
  if (use.length === 0) return '';
  return (use[0][0] + (use.length > 1 ? use[use.length - 1][0] : '')).toUpperCase();
}

export const firstNameOf = (name) => String(name ?? '').split(/[\s.]+/).filter(Boolean)[0] || '';

/**
 * Addressed to the whole team.
 *
 * "ALL" is how the sheet writes it — 82 notes — and "Everyone" is how a
 * person types it. `everyone` and `team` are safe as bare words: a note
 * opening "Everyone needs to check their DWPs" IS for everyone, so reading
 * it that way is right either way. Lower-case "all" is NOT safe — "All the
 * gift cards arrived" is a sentence, not an address — so it only counts
 * when shouted (ALL) or punctuated (All,).
 */
const EVERYONE_RE = [
  /^\s*(?:everyone|all staff|team)\b\s*[,:\-–—]?\s*/i,
  /^\s*ALL\b\s*[,:\-–—]?\s*/,
  /^\s*all\s*[,:\-–—]\s*/i,
];

const ADDRESS_RE = /^\s*((?:[A-Z]{2,3})(?:\s*[/,&+]\s*[A-Z]{2,3})*)\s*[,:\-–—]?\s/;

/**
 * @param text    what was typed
 * @param staff   [{ uid, displayName }] — DESK MEMBERS ONLY
 * @param students ['Lexie Liu', …] — names only
 */
export function parseNote(text, { staff = [], students = [] } = {}) {
  const raw = String(text ?? '').trim();
  const out = {
    toUids: [], toNames: [], toAll: false, unknownCodes: [],
    about: null, nearMiss: null, family: false,
    topic: null, labels: [], body: '',
  };
  if (!raw) return out;

  const byCode = new Map();
  const byFirst = new Map();
  for (const s of staff) {
    const code = initialsOf(s?.displayName);
    if (code && !byCode.has(code)) byCode.set(code, s);
    const first = firstNameOf(s?.displayName).toLowerCase();
    if (first && !byFirst.has(first)) byFirst.set(first, s);
  }

  // A salutation is not part of the address. 172 notes open with "Hi".
  let rest = raw.replace(/^\s*(hi|hey|hello)\s+/i, '');

  const add = (s) => {
    if (s && !out.toUids.includes(s.uid)) {
      out.toUids.push(s.uid);
      out.toNames.push(s.displayName);
    }
  };

  // @Name
  rest = rest.replace(/@([A-Za-z.]+)/g, (m, nm) => {
    const hit = byFirst.get(nm.toLowerCase().replace(/\.$/, ''));
    if (hit) { add(hit); return ' '; }
    return m;
  });

  // Everyone / ALL / Team
  for (const re of EVERYONE_RE) {
    const m = rest.match(re);
    if (m) { out.toAll = true; rest = rest.slice(m[0].length); break; }
  }

  // Leading initials, possibly several: "VB/NG", "RR, SK"
  const lead = rest.match(ADDRESS_RE);
  if (lead) {
    let used = false;
    for (const code of lead[1].split(/[/,&+]/).map(c => c.trim()).filter(Boolean)) {
      const hit = byCode.get(code);
      if (hit) { add(hit); used = true; continue; }
      // A code the centre uses that has no Ratio account. The note still
      // files and still says who it is for; it simply cannot land in
      // anybody's list until that account exists — and the moment it does,
      // the code resolves on its own, because initials are derived from the
      // display name.
      if (!out.unknownCodes.includes(code)) out.unknownCodes.push(code);
      used = true;
    }
    if (used) rest = rest.slice(lead[0].length);
  }

  // Who it's about. Longest match wins so "Lexie Liu" beats "Lexie".
  const low = rest.toLowerCase();
  let best = null;
  for (const name of students) {
    const at = low.indexOf(String(name).toLowerCase());
    if (at >= 0 && (!best || String(name).length > best.name.length)) best = { name, at };
  }
  if (best) {
    // The name STAYS in the sentence. Lifting it out turned "complete a
    // care call for Lexie Liu" into "complete a care call for".
    out.about = best.name;
  } else {
    const cand = rest.match(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/);
    if (cand) {
      const close = nearestStudent(cand[0], students);
      if (close) out.nearMiss = { typed: cand[0], suggestion: close };
    }
  }

  out.family = mentionsFamily(raw);
  out.topic = topicOf(raw);
  out.labels = labelsOf(raw);
  out.body = rest.replace(/^[\s,:\-–—]+/, '').replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * "Lexi Lu" → "Lexie Liu", or null.
 *
 * Deliberately timid: a suggestion the reader can accept is useful, a silent
 * correction is not. Only offered when the two are close in length and agree
 * on most characters.
 */
export function nearestStudent(typed, students) {
  const a = String(typed).toLowerCase().replace(/\s/g, '');
  if (a.length < 5) return null;
  let best = null;
  for (const name of students) {
    const b = String(name).toLowerCase().replace(/\s/g, '');
    if (Math.abs(a.length - b.length) > 3) continue;
    const d = editDistance(a, b);
    // Two edits on a short name, three on a longer one. A prefix-match
    // score was tried first and could not see "Lexi Lu" / "Lexie Liu",
    // because one missing letter throws every later character out of step.
    const allow = b.length >= 10 ? 3 : 2;
    if (d <= allow && (!best || d < best.d)) best = { name, d };
  }
  return best ? best.name : null;
}

/** Levenshtein. Small strings only — names. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** Can this be sent? It needs somebody to be for, and something to say. */
export function canSend(parsed) {
  if (!parsed) return false;
  const addressed = parsed.toAll || parsed.toUids.length > 0 || parsed.unknownCodes.length > 0;
  return addressed && !!parsed.body;
}

/** Who it's for, in words. */
export function addressLabel(parsed) {
  if (!parsed) return '';
  if (parsed.toAll) return 'Everyone';
  const names = [...parsed.toNames.map(firstNameOf), ...parsed.unknownCodes];
  return names.join(' & ');
}
