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

export function nameKey(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
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

// ───── Check-ins (per day) ───────────────────────────────────────────────
export function watchCheckIns(centerId, dateStr, cb) {
  const ref = doc(db, 'centers', centerId, 'schedulerCheckIns', dateStr);
  return onSnapshot(ref, snap => cb(snap.exists() ? snap.data() : {}));
}

export async function setCheckIn(centerId, dateStr, studentId, status) {
  const ref = doc(db, 'centers', centerId, 'schedulerCheckIns', dateStr);
  const snap = await getDoc(ref);
  const current = snap.exists() ? snap.data() : {};
  if (status) current[studentId] = status; else delete current[studentId];
  await setDoc(ref, current);
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
