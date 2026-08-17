/**
 * Availability change log.
 *
 * THE PROBLEM THIS SOLVES
 *   Schedules get built in advance. An instructor marks themselves
 *   available for a Thursday, gets scheduled for it, then quietly pulls
 *   the availability back down — and two weeks later shows up saying
 *   "my availability isn't in, why am I scheduled?" Without a record,
 *   that's one person's memory against another's, and the admin always
 *   loses the argument.
 *
 *   Every add, change and removal now writes an immutable row: who,
 *   when, which date, and the exact before → after. The Availability Log
 *   page then cross-references live shifts, so a removal on a day the
 *   person is already scheduled is flagged the moment you look at it.
 *
 * WHY A TOP-LEVEL COLLECTION
 *   `availabilityLog/{entryId}` sits at the root with a `centerId` field
 *   rather than under `centers/{id}/…`, for the same reason
 *   `centerIntakes` does: the recursive `match /{document=**}` grant
 *   inside `/centers/{centerId}` hands READ to every signed-in staff
 *   account, and Firestore rules are ADDITIVE — a narrower rule further
 *   down cannot take that back. At the root, the admin-only read rule is
 *   the only rule that matches, so it actually holds.
 *
 * WHO CAN DO WHAT
 *   read   — admin, admin_assistant, director, owner, super_admin
 *   create — any signed-in user, but only stamped as themselves
 *            (rules enforce actorUid == request.auth.uid), because the
 *            instructor's own browser is what writes the row when they
 *            edit their availability
 *   update/delete — super_admin only. A history someone can quietly
 *            revise is not a history.
 *
 * NEVER BLOCKS THE SAVE
 *   Logging is best-effort. If the log write fails, the availability
 *   change still goes through — an audit trail that can stop people
 *   updating their availability would be worse than the problem.
 */

import {
  collection, addDoc, onSnapshot, query, where, orderBy, limit,
} from 'firebase/firestore';
import { db } from '../firebase';

export const AVAILABILITY_LOG = 'availabilityLog';

export const AVAIL_ACTIONS = {
  ADDED:   'added',
  CHANGED: 'changed',
  REMOVED: 'removed',
};

export const ACTION_STYLE = {
  added:   { label: 'Added',   chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500' },
  changed: { label: 'Changed', chip: 'bg-amber-50 text-amber-900 border-amber-300',       dot: 'bg-amber-500'   },
  removed: { label: 'Removed', chip: 'bg-red-50 text-red-800 border-red-200',             dot: 'bg-red-600'     },
};

// The fields on an availability doc worth tracking. Anything not in this
// list (bulkSet, userName, centerId…) is bookkeeping, not a change the
// admin team needs to see.
const TRACKED = ['startTime', 'endTime', 'comment', 'preferredAssignment'];

export const FIELD_LABEL = {
  startTime:           'Start time',
  endTime:             'End time',
  comment:             'Note',
  preferredAssignment: 'Preference',
};

/** Reduce an availability doc to just the bits we record. */
export function snapshotOf(avail) {
  if (!avail) return null;
  return {
    startTime:           avail.startTime || '',
    endTime:             avail.endTime || '',
    comment:             avail.comment || '',
    preferredAssignment: avail.preferredAssignment || 'either',
  };
}

/** Which tracked fields differ between two snapshots. */
export function diffFields(before, after) {
  if (!before || !after) return [];
  return TRACKED.filter(k => (before[k] ?? '') !== (after[k] ?? ''));
}

function actionFor(before, after) {
  if (!before && after)  return AVAIL_ACTIONS.ADDED;
  if (before && !after)  return AVAIL_ACTIONS.REMOVED;
  return AVAIL_ACTIONS.CHANGED;
}

/**
 * Append one row.
 *
 * @param {object} profile   the signed-in user (the actor)
 * @param {string} centerId
 * @param {object} args
 * @param {string} args.date      the availability date, YYYY-MM-DD
 * @param {object} [args.before]  raw availability doc before, or null
 * @param {object} [args.after]   raw availability doc after, or null
 * @param {object} [args.target]  whose availability, if not the actor's
 *                                — { uid, name }. Defaults to the actor.
 * @param {string} [args.source]  'day' | 'weekly' — which UI did it
 * @param {string} [args.batchId] groups one weekly bulk save together
 *
 * Returns true when a row was written, false when there was nothing to
 * say (a "change" that changed nothing) or the write failed.
 */
export async function logAvailabilityChange(profile, centerId, {
  date, before = null, after = null, target = null, source = 'day', batchId = null,
} = {}) {
  if (!profile?.uid || !centerId || !date) return false;

  const beforeSnap = snapshotOf(before);
  const afterSnap  = snapshotOf(after);
  if (!beforeSnap && !afterSnap) return false;

  const action = actionFor(beforeSnap, afterSnap);
  const fields = action === AVAIL_ACTIONS.CHANGED ? diffFields(beforeSnap, afterSnap) : [];

  // Saving the modal without touching anything is not an event. Logging
  // it would bury the real changes in noise.
  if (action === AVAIL_ACTIONS.CHANGED && fields.length === 0) return false;

  const targetUid  = target?.uid  || profile.uid;
  const targetName = target?.name || profile.displayName || profile.email || 'Unknown';

  try {
    await addDoc(collection(db, AVAILABILITY_LOG), {
      centerId,
      date,
      action,
      fields,
      before: beforeSnap,
      after:  afterSnap,
      targetUid,
      targetName,
      // actorUid MUST be the signed-in user — Firestore rules reject the
      // write otherwise, which is what stops anyone forging a row that
      // names someone else as the person who made the change.
      actorUid:    profile.uid,
      actorName:   profile.displayName || profile.email || 'Unknown',
      actorIsSelf: targetUid === profile.uid,
      source,
      batchId,
      at: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    // Best-effort by design. See the header.
    console.warn('[availabilityLog] write skipped:', err?.message || err);
    return false;
  }
}

/** Convenience for a weekly bulk save — one shared batchId, N rows. */
export async function logAvailabilityBatch(profile, centerId, changes, source = 'weekly') {
  const batchId = newBatchId();
  let written = 0;
  for (const c of changes) {
    const ok = await logAvailabilityChange(profile, centerId, { ...c, source, batchId });
    if (ok) written += 1;
  }
  return written;
}

function newBatchId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `b${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

// ─── Reading ───────────────────────────────────────────────────────────

/**
 * Live feed of changes for a centre, newest first.
 *
 * Needs the composite index (centerId ASC, at DESC) — it's in
 * firestore.indexes.json. Without it Firestore returns an error carrying
 * a one-click "create index" URL.
 */
export function subscribeAvailabilityLog(centerId, { max = 400 } = {}, onEntries, onError) {
  return onSnapshot(
    query(
      collection(db, AVAILABILITY_LOG),
      where('centerId', '==', centerId),
      orderBy('at', 'desc'),
      limit(max),
    ),
    snap => onEntries(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => { if (onError) onError(err); },
  );
}

// ─── Conflict detection ────────────────────────────────────────────────
//
// The whole reason the log exists. Times are 'HH:MM' 24-hour strings, so
// plain string comparison orders them correctly — no Date parsing needed.

/** Does an availability window fully contain a shift? */
export function covers(availSnap, shift) {
  if (!availSnap?.startTime || !availSnap?.endTime) return false;
  if (!shift?.startTime || !shift?.endTime) return false;
  return availSnap.startTime <= shift.startTime && availSnap.endTime >= shift.endTime;
}

/**
 * Index shifts as `${userId}|${date}` → [shift]. Built once per render of
 * the log page rather than scanned per row.
 */
export function indexShifts(shifts) {
  const m = new Map();
  for (const s of shifts || []) {
    if (!s.userId || !s.date) continue;
    const k = `${s.userId}|${s.date}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  return m;
}

/**
 * Is this log entry a problem? Returns null when it's fine, otherwise
 * the shifts it clashes with and why.
 *
 *   removed-while-scheduled — they pulled the day entirely but are on
 *                             the schedule for it
 *   narrowed-below-shift    — they kept the day but shortened the window
 *                             so it no longer covers the shift they have
 *
 * Deliberately computed HERE, at read time on the admin's screen, rather
 * than stamped on the row when it's written: a shift assigned AFTER the
 * availability change would otherwise never be flagged, and the flag
 * doesn't depend on the instructor's own browser being honest.
 */
export function conflictFor(entry, shiftIndex) {
  const shifts = shiftIndex.get(`${entry.targetUid}|${entry.date}`) || [];
  if (shifts.length === 0) return null;

  if (entry.action === AVAIL_ACTIONS.REMOVED) {
    return { kind: 'removed-while-scheduled', shifts };
  }
  if (entry.action === AVAIL_ACTIONS.CHANGED) {
    const uncovered = shifts.filter(s => !covers(entry.after, s));
    if (uncovered.length > 0) return { kind: 'narrowed-below-shift', shifts: uncovered };
  }
  return null;
}

export const CONFLICT_TEXT = {
  'removed-while-scheduled': 'Removed availability for a day they are scheduled',
  'narrowed-below-shift':    'New hours no longer cover their scheduled shift',
};

// ─── Display helpers ───────────────────────────────────────────────────

export function fmtTime(t) {
  if (!t) return '—';
  const [hStr, mStr] = String(t).split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h)) return String(t);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m ? `${h}:${String(m).padStart(2, '0')} ${ampm}` : `${h} ${ampm}`;
}

export function fmtWindow(snap) {
  if (!snap) return 'not available';
  if (!snap.startTime && !snap.endTime) return 'not available';
  return `${fmtTime(snap.startTime)} – ${fmtTime(snap.endTime)}`;
}

export function fmtDay(iso) {
  if (!iso) return '';
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch { return iso; }
}

export function fmtWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

const PREF_LABEL = { either: 'Either', centre: 'Centre', online: 'Online' };

/** One-line description of what changed, for the row and the CSV. */
export function describeChange(entry) {
  switch (entry.action) {
    case AVAIL_ACTIONS.ADDED:
      return `Added ${fmtWindow(entry.after)}`;
    case AVAIL_ACTIONS.REMOVED:
      return `Removed ${fmtWindow(entry.before)}`;
    case AVAIL_ACTIONS.CHANGED: {
      const parts = (entry.fields || []).map(f => {
        if (f === 'startTime' || f === 'endTime') return null; // covered by the window line
        if (f === 'comment') {
          const to = entry.after?.comment;
          return to ? `note "${to}"` : 'note cleared';
        }
        if (f === 'preferredAssignment') {
          return `preference ${PREF_LABEL[entry.after?.preferredAssignment] || entry.after?.preferredAssignment}`;
        }
        return f;
      }).filter(Boolean);

      const timeChanged = (entry.fields || []).some(f => f === 'startTime' || f === 'endTime');
      const bits = [];
      if (timeChanged) bits.push(`${fmtWindow(entry.before)} → ${fmtWindow(entry.after)}`);
      bits.push(...parts);
      return bits.join(', ') || 'Updated';
    }
    default:
      return 'Updated';
  }
}

// ─── CSV ───────────────────────────────────────────────────────────────

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function logToCsv(rows) {
  const header = [
    'Changed at', 'Instructor', 'Date affected', 'Action', 'What changed',
    'Before', 'After', 'Changed by', 'Conflict',
  ];
  const body = rows.map(r => [
    fmtWhen(r.at),
    r.targetName,
    r.date,
    ACTION_STYLE[r.action]?.label || r.action,
    describeChange(r),
    fmtWindow(r.before),
    fmtWindow(r.after),
    r.actorIsSelf ? `${r.actorName} (self)` : r.actorName,
    r._conflict ? CONFLICT_TEXT[r._conflict.kind] : '',
  ]);
  return [header, ...body].map(row => row.map(csvCell).join(',')).join('\n');
}
