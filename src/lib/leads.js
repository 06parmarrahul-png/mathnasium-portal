// Leads — the lead-to-student funnel.
//
// A LEAD is a person who has expressed interest in the centre but has
// NOT enrolled yet. Distinct from a STUDENT (already on the roster) and
// from an INTAKE (a scheduled assessment, which is one stop along the
// funnel).
//
// Lifecycle: NEW → CONTACTED → ASSESSED → ENROLLED (or LOST at any stage)
//
//   new        — fresh interest. No contact attempted yet.
//   contacted  — staff has reached out (call/email/in person).
//   assessed   — intake assessment has happened. The biggest commitment
//                signal short of enrolling.
//   enrolled   — became a paying student. Lead is closed (won).
//   lost       — explicitly went elsewhere or stopped responding.
//
// Data model: centers/{centerId}/leads/{leadId}
//
// History is an append-only array of small entries — cheaper than a
// sub-collection and lets the list query render activity inline without
// a second read. Past ~50 entries we'd want to migrate to a sub-col;
// realistic centres won't hit that for years.

import {
  collection, doc, getDoc, setDoc, deleteDoc, addDoc,
  onSnapshot, query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { upsertStudent } from './scheduler-data';

export const LEAD_STATUSES = ['new', 'contacted', 'assessed', 'enrolled', 'lost'];

export const LEAD_STATUS_LABELS = {
  new:       'New',
  contacted: 'Contacted',
  assessed:  'Assessed',
  enrolled:  'Enrolled',
  lost:      'Lost',
};

// Tailwind colour scales per stage. Used by the page for chips, status
// pills, and the funnel header. Kept here so any UI that displays a
// lead can render its status without duplicating the palette.
export const LEAD_STATUS_STYLES = {
  new:       { bg: 'bg-sky-100',     text: 'text-sky-800',     ring: 'ring-sky-200',     dot: 'bg-sky-500' },
  contacted: { bg: 'bg-amber-100',   text: 'text-amber-800',   ring: 'ring-amber-200',   dot: 'bg-amber-500' },
  assessed:  { bg: 'bg-violet-100',  text: 'text-violet-800',  ring: 'ring-violet-200',  dot: 'bg-violet-500' },
  enrolled:  { bg: 'bg-emerald-100', text: 'text-emerald-800', ring: 'ring-emerald-200', dot: 'bg-emerald-500' },
  lost:      { bg: 'bg-gray-100',    text: 'text-gray-700',    ring: 'ring-gray-200',    dot: 'bg-gray-400' },
};

export const LEAD_SOURCES = [
  'website',
  'referral',
  'walk-in',
  'phone',
  'intake-form',
  'social',
  'event',
  'other',
];

export const LEAD_SOURCE_LABELS = {
  website:       'Website',
  referral:      'Referral',
  'walk-in':     'Walk-in',
  phone:         'Phone',
  'intake-form': 'Intake form',
  social:        'Social',
  event:         'Event',
  other:         'Other',
};

const colRef = (centerId) => collection(db, 'centers', centerId, 'leads');

// ───── Read ──────────────────────────────────────────────────────────────

export function watchLeads(centerId, cb) {
  // createdAt DESC = newest first, which is what the list view wants
  // most of the time. Filtering / status grouping happens client-side
  // since the list rarely exceeds a few hundred entries per centre.
  const q = query(colRef(centerId), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
}

export async function getLead(centerId, leadId) {
  const snap = await getDoc(doc(db, 'centers', centerId, 'leads', leadId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ───── Create / Update / Delete ──────────────────────────────────────────

// Trim every string field; an Untitled lead is almost always a misclick.
function clean(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

export async function createLead(centerId, partial, actor) {
  const data = clean(partial);
  if (!data.parentName && !data.childName) {
    throw new Error('Lead needs at least a parent or child name.');
  }
  const now = new Date().toISOString();
  const status = LEAD_STATUSES.includes(data.status) ? data.status : 'new';
  const leadDoc = {
    // Identity
    parentName:  data.parentName  || '',
    parentEmail: data.parentEmail || '',
    parentPhone: data.parentPhone || '',
    childName:   data.childName   || '',
    childGrade:  data.childGrade  || '',
    childSchool: data.childSchool || '',
    // Funnel state
    status,
    source:       data.source       || 'other',
    sourceDetail: data.sourceDetail || '',
    notes:        data.notes        || '',
    assignedTo:   data.assignedTo   || '',
    // Append-only audit of status transitions + free-form events.
    history: [{
      at: now,
      by: actor?.displayName || actor?.email || 'system',
      text: `Created as ${LEAD_STATUS_LABELS[status]}`,
    }],
    // Timestamps (denormalized for sorts; serverTimestamp would be nicer
    // but we'd need to round-trip to read the value back for history).
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  return await addDoc(colRef(centerId), leadDoc);
}

export async function updateLead(centerId, leadId, patch) {
  const ref = doc(db, 'centers', centerId, 'leads', leadId);
  await setDoc(ref, { ...clean(patch), updatedAt: serverTimestamp() }, { merge: true });
}

export async function setLeadStatus(centerId, leadId, nextStatus, actor) {
  if (!LEAD_STATUSES.includes(nextStatus)) {
    throw new Error(`Unknown status: ${nextStatus}`);
  }
  const existing = await getLead(centerId, leadId);
  if (!existing) throw new Error('Lead not found.');
  if (existing.status === nextStatus) return; // no-op
  const now = new Date().toISOString();
  const entry = {
    at: now,
    by: actor?.displayName || actor?.email || 'system',
    text: `Moved from ${LEAD_STATUS_LABELS[existing.status]} → ${LEAD_STATUS_LABELS[nextStatus]}`,
  };
  const patch = {
    status: nextStatus,
    history: [...(existing.history || []), entry],
    updatedAt: serverTimestamp(),
  };
  // Per-stage timestamp surface so analytics can compute funnel timing.
  if (nextStatus === 'contacted') patch.contactedAt = now;
  if (nextStatus === 'assessed')  patch.assessedAt  = now;
  if (nextStatus === 'enrolled')  patch.enrolledAt  = now;
  if (nextStatus === 'lost')      patch.lostAt      = now;
  await setDoc(doc(db, 'centers', centerId, 'leads', leadId), patch, { merge: true });
}

export async function appendLeadNote(centerId, leadId, text, actor) {
  if (!text?.trim()) return;
  const existing = await getLead(centerId, leadId);
  if (!existing) throw new Error('Lead not found.');
  const entry = {
    at: new Date().toISOString(),
    by: actor?.displayName || actor?.email || 'system',
    text: text.trim(),
  };
  await setDoc(doc(db, 'centers', centerId, 'leads', leadId), {
    history: [...(existing.history || []), entry],
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function deleteLead(centerId, leadId) {
  await deleteDoc(doc(db, 'centers', centerId, 'leads', leadId));
}

// ───── Convert lead → student ────────────────────────────────────────────
// Creates a row in schedulerStudents using the same shape importCsv()
// writes, and marks the lead enrolled. Idempotent: re-converting a lead
// just upserts the student row.
export async function convertLeadToStudent(centerId, leadId, actor) {
  const lead = await getLead(centerId, leadId);
  if (!lead) throw new Error('Lead not found.');

  // Pick the student name. Prefer child name; fall back to parent.
  const name = (lead.childName || lead.parentName || '').trim();
  if (!name) throw new Error('Lead has no name to convert.');

  // Map grade to category the same way the CSV importer does — grades
  // 8-12 go to HS, everything else to EM. Hybrid / online status is
  // unknown at this stage (set later from the tracker), so default to
  // centre attendance.
  const grade = (lead.childGrade || '').trim();
  const isHS = /^(8|9|10|11|12)$/i.test(grade);
  const student = {
    name,
    grade,
    status: 'centre',
    category: isHS ? 'HS' : 'EM',
    isHybrid: false,
    hasAssessment: false,
    assignedInstructor: '',
  };
  await upsertStudent(centerId, student);
  await setLeadStatus(centerId, leadId, 'enrolled', actor);
}

// ───── Analytics helpers (pure functions over the in-memory list) ────────

export function funnelCounts(leads) {
  const out = { new: 0, contacted: 0, assessed: 0, enrolled: 0, lost: 0, total: leads.length };
  for (const l of leads) {
    if (LEAD_STATUSES.includes(l.status)) out[l.status]++;
  }
  return out;
}

export function conversionRate(leads) {
  // Conversion = enrolled / (enrolled + lost). Pending leads aren't a
  // success or failure yet, so we exclude them. Without this, the rate
  // would always look terrible until pipelines clear.
  const enrolled = leads.filter(l => l.status === 'enrolled').length;
  const lost     = leads.filter(l => l.status === 'lost').length;
  const closed = enrolled + lost;
  if (closed === 0) return null;
  return enrolled / closed;
}

export function sourceBreakdown(leads) {
  // { source: { total, enrolled, lost, rate } }
  const out = {};
  for (const l of leads) {
    const s = l.source || 'other';
    if (!out[s]) out[s] = { total: 0, enrolled: 0, lost: 0 };
    out[s].total++;
    if (l.status === 'enrolled') out[s].enrolled++;
    if (l.status === 'lost')     out[s].lost++;
  }
  for (const s of Object.keys(out)) {
    const closed = out[s].enrolled + out[s].lost;
    out[s].rate = closed > 0 ? out[s].enrolled / closed : null;
  }
  return out;
}
