// Firestore helpers for the Scheduler Creation page.
//
// All data is per-centre, stored under: centers/{centerId}/scheduler*/...
//
//   schedulerSettings/main                   { icalUrls, studentsPerInstructor,
//                                              minInstructors, instructorPool }
//   schedulerStudents/{nameKey}              { name, grade, status, category,
//                                              assignedInstructor }
//   schedulerAliases/{nameKey}               { parentName, replacements: [...] }
//   schedulerCheckIns/{YYYY-MM-DD}           { [studentId]: 'in'|'late'|'noshow'|'cancel' }
//   schedulerInstructorAssignments/{YYYY-MM-DD}  { ["HS|14:00"]: ["Joanne",...] }
//
// nameKey is the lowercased name with whitespace collapsed.

import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  writeBatch, onSnapshot,
} from 'firebase/firestore';
import { db } from '../firebase';

// Used as the Firestore document ID for students and aliases. Firestore
// rejects forward slashes and a few other special tokens — sanitize here
// so names like "Phillip / Tricia Mak" don't crash the import. The
// original (unsanitized) name is still kept on the document body under
// `name` / `parentName`, so what staff sees is unaffected.
export function nameKey(s) {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[/\\]/g, '_')          // / and \ are illegal in Firestore IDs
    .replace(/^\.+$/, '_')           // bare "." or ".." also illegal
    .replace(/^__(.*)__$/, '_$1_');  // reserved __anything__ pattern
}

// ───── Settings ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  icalUrls: [],
  studentsPerInstructor: 4,
  minInstructors: 1,
  instructorPool: [],
};

export async function getSettings(centerId) {
  const ref = doc(db, 'centers', centerId, 'schedulerSettings', 'main');
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...snap.data() };
}

export async function saveSettings(centerId, partial) {
  const ref = doc(db, 'centers', centerId, 'schedulerSettings', 'main');
  await setDoc(ref, partial, { merge: true });
}

// ───── Google Sheets auto-sync ───────────────────────────────────────────
// One token per centre. The token authenticates the Apps Script in the
// owner's Student Assessment Tracker so it can POST roster updates to
// /api/scheduler/appointments?action=sync-students without a Firebase
// identity. We rotate via generateSyncToken() — old token instantly stops
// working the moment we write the new one.
//
// Stored under: schedulerSettings/main.sheetSync = { token, lastSyncedAt, ... }

export function generateSyncToken() {
  // 32 bytes of crypto randomness → URL-safe base64-ish string. Long enough
  // to be infeasible to brute-force even without rate limiting.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function enableSheetSync(centerId) {
  const token = generateSyncToken();
  const ref = doc(db, 'centers', centerId, 'schedulerSettings', 'main');
  await setDoc(ref, {
    sheetSync: {
      token,
      enabledAt: new Date().toISOString(),
    },
  }, { merge: true });
  return token;
}

export async function rotateSheetSyncToken(centerId) {
  // Rotate keeps the historical lastSyncedAt / counts so the UI doesn't
  // wipe the "Last synced …" line just because the user clicked rotate.
  const token = generateSyncToken();
  const ref = doc(db, 'centers', centerId, 'schedulerSettings', 'main');
  await setDoc(ref, {
    sheetSync: { token, rotatedAt: new Date().toISOString() },
  }, { merge: true });
  return token;
}

export async function disableSheetSync(centerId) {
  // Clear the token AND the historical metadata — disabling means the user
  // wants the connection gone, not just paused.
  const ref = doc(db, 'centers', centerId, 'schedulerSettings', 'main');
  // setDoc with merge can't unset fields cleanly, so write an explicit null
  // marker. The server treats a missing/falsy token as "not configured".
  await setDoc(ref, { sheetSync: null }, { merge: true });
}

// ───── Students ──────────────────────────────────────────────────────────
export async function getStudents(centerId) {
  const snap = await getDocs(collection(db, 'centers', centerId, 'schedulerStudents'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function watchStudents(centerId, cb) {
  return onSnapshot(collection(db, 'centers', centerId, 'schedulerStudents'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function upsertStudent(centerId, student) {
  const id = nameKey(student.name);
  const ref = doc(db, 'centers', centerId, 'schedulerStudents', id);
  await setDoc(ref, student, { merge: true });
}

export async function deleteStudent(centerId, id) {
  await deleteDoc(doc(db, 'centers', centerId, 'schedulerStudents', id));
}

// Bulk write from a parsed CSV. Used by the "Import roster" button.
export async function bulkImportStudents(centerId, students) {
  // Firestore batch limit is 500. Chunk to be safe.
  const chunks = [];
  for (let i = 0; i < students.length; i += 400) chunks.push(students.slice(i, i + 400));
  for (const chunk of chunks) {
    const batch = writeBatch(db);
    for (const s of chunk) {
      const id = nameKey(s.name);
      if (!id) continue;
      batch.set(doc(db, 'centers', centerId, 'schedulerStudents', id), s, { merge: true });
    }
    await batch.commit();
  }
}

// ───── Aliases ───────────────────────────────────────────────────────────
export async function getAliases(centerId) {
  const snap = await getDocs(collection(db, 'centers', centerId, 'schedulerAliases'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function watchAliases(centerId, cb) {
  return onSnapshot(collection(db, 'centers', centerId, 'schedulerAliases'),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function upsertAlias(centerId, { parentName, replacements }) {
  const id = nameKey(parentName);
  const ref = doc(db, 'centers', centerId, 'schedulerAliases', id);
  await setDoc(ref, { parentName, replacements }, { merge: true });
}

export async function deleteAlias(centerId, id) {
  await deleteDoc(doc(db, 'centers', centerId, 'schedulerAliases', id));
}

// ───── Check-ins + per-day student metadata ──────────────────────────────
//
// Doc shape: { [studentId]: { status?, tag?, desk? } | <legacy string status> }
//
// Legacy entries (where the value is a plain string like 'in') predate the
// tag/desk feature — the watch + helpers normalise them transparently so
// nothing breaks if you upgrade an old day's doc.

function normalizeEntries(raw) {
  const out = {};
  for (const [id, v] of Object.entries(raw || {})) {
    if (typeof v === 'string') out[id] = { status: v };
    else out[id] = v || {};
  }
  return out;
}

export function watchCheckIns(centerId, dateStr, cb) {
  const ref = doc(db, 'centers', centerId, 'schedulerCheckIns', dateStr);
  return onSnapshot(ref, snap => cb(normalizeEntries(snap.exists() ? snap.data() : {})));
}

async function patchEntry(centerId, dateStr, studentId, patch) {
  const ref = doc(db, 'centers', centerId, 'schedulerCheckIns', dateStr);
  const snap = await getDoc(ref);
  const current = normalizeEntries(snap.exists() ? snap.data() : {});
  const next = { ...(current[studentId] || {}), ...patch };
  // Strip empty fields so deletes work cleanly.
  for (const k of Object.keys(next)) {
    if (next[k] === '' || next[k] == null) delete next[k];
  }
  if (Object.keys(next).length === 0) delete current[studentId];
  else current[studentId] = next;
  await setDoc(ref, current);
}

export async function setCheckIn(centerId, dateStr, studentId, status) {
  await patchEntry(centerId, dateStr, studentId, { status: status || '' });
}

export async function setStudentTag(centerId, dateStr, studentId, tag) {
  await patchEntry(centerId, dateStr, studentId, { tag: tag || '' });
}

export async function setStudentDesk(centerId, dateStr, studentId, desk) {
  await patchEntry(centerId, dateStr, studentId, { desk: desk || '' });
}

// ───── Walk-in / manually-added students per slot (per day) ──────────────
// Lets staff add a student to a specific time slot mid-day — for the call-in
// "can you fit my kid in at 4?" case. Stored as ONE doc per date with a map
// keyed by `${side}|${slot}` → [{id, name, isAssessment, addedAt, addedBy}].
// Merged with the iCal-sourced students client-side at render time so the
// page treats them identically (check-in, presumed-absent inference, etc).

export function watchWalkIns(centerId, dateStr, cb) {
  const ref = doc(db, 'centers', centerId, 'scheduleAddOns', dateStr);
  return onSnapshot(ref, snap => cb(snap.exists() ? snap.data() : {}));
}

export async function addWalkIn(centerId, dateStr, side, slot, { name, isAssessment, duration, addedByName, tag }) {
  if (!name?.trim()) throw new Error('Walk-in needs a name.');
  const ref = doc(db, 'centers', centerId, 'scheduleAddOns', dateStr);
  const snap = await getDoc(ref);
  const current = snap.exists() ? snap.data() : {};
  const key = `${side}|${slot}`;
  // Locally-unique ID — prefix with `wi_` so check-in / classify code can
  // tell walk-ins apart from iCal-sourced students if it ever needs to.
  const id = `wi_${dateStr}_${side}_${slot}_${Math.random().toString(36).slice(2, 8)}`;
  // Duration in minutes — defaults to 60 for back-compat. HS's 1.5 hr
  // column stores 90-min walk-ins so ratio math projects them across
  // three slots (start + two overflow) instead of the standard two.
  const dur = duration === 90 ? 90 : 60;
  const entry = {
    id,
    name: name.trim(),
    isAssessment: !!isAssessment,
    // Optional label for un-enrolled drop-ins placed from the Uncategorized
    // banner: 'FS' (first session) or 'NEW' (free trial).
    tag: tag === 'FS' || tag === 'NEW' ? tag : null,
    duration: dur,
    addedAt: new Date().toISOString(),
    addedBy: addedByName || '',
  };
  const next = { ...current, [key]: [...((current[key]) || []), entry] };
  await setDoc(ref, next, { merge: false });
  return id;
}

export async function removeWalkIn(centerId, dateStr, side, slot, walkInId) {
  const ref = doc(db, 'centers', centerId, 'scheduleAddOns', dateStr);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const current = snap.data();
  const key = `${side}|${slot}`;
  const list = (current[key] || []).filter(w => w.id !== walkInId);
  const next = { ...current, [key]: list };
  if (list.length === 0) delete next[key];
  await setDoc(ref, next, { merge: false });
}

// ───── Slot overrides (move student between slots, same side) ────────────
// When a student booked for 3:30 arrives at 3:00 (or asks to swap), we
// don't touch the iCal source — instead, we save an override that says
// "for THIS date, render this student at this other slot." Render code
// (SideTable in SchedulerCreation.jsx) applies the override before
// passing the slot rows down to SlotRow.
//
// Stored as a single map on the date's scheduleAddOns doc:
//   slotOverrides: { [studentId]: 'HH:MM' }    // same side as original
//
// Side is implicit from the student's original placement — we don't
// support cross-side moves (HS↔EM) in V1; owners use cancel + add
// walk-in for those rare cases.

export async function setSlotOverride(centerId, dateStr, studentId, newSlotKey) {
  if (!studentId || !newSlotKey) throw new Error('Move needs a student and target slot.');
  const ref = doc(db, 'centers', centerId, 'scheduleAddOns', dateStr);
  const snap = await getDoc(ref);
  const current = snap.exists() ? snap.data() : {};
  const overrides = { ...(current.slotOverrides || {}), [studentId]: newSlotKey };
  await setDoc(ref, { ...current, slotOverrides: overrides }, { merge: false });
}

export async function clearSlotOverride(centerId, dateStr, studentId) {
  const ref = doc(db, 'centers', centerId, 'scheduleAddOns', dateStr);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const current = snap.data();
  const overrides = { ...(current.slotOverrides || {}) };
  if (!(studentId in overrides)) return;
  delete overrides[studentId];
  await setDoc(ref, { ...current, slotOverrides: overrides }, { merge: false });
}

// ───── Instructor assignments (per day) ──────────────────────────────────
// Key format: "<side>|<slotHHMM>" e.g. "HS|14:00"
export function watchInstructorAssignments(centerId, dateStr, cb) {
  const ref = doc(db, 'centers', centerId, 'schedulerInstructorAssignments', dateStr);
  return onSnapshot(ref, snap => cb(snap.exists() ? snap.data() : {}));
}

export async function setInstructorAssignment(centerId, dateStr, side, slot, names) {
  const ref = doc(db, 'centers', centerId, 'schedulerInstructorAssignments', dateStr);
  const key = `${side}|${slot}`;
  const snap = await getDoc(ref);
  const current = snap.exists() ? snap.data() : {};
  if (names && names.length) current[key] = names;
  else delete current[key];
  await setDoc(ref, current);
}
