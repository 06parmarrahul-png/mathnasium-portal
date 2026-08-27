/**
 * Scheduler templates — reusable staffing SHAPES.
 *
 * A template stores what a week should look like — "Mondays want 10
 * in-centre + 2 online, Saturdays want 6" — not who works it. The
 * auto-scheduler then fills that shape from whoever is actually
 * available and holds the right sub-roles.
 *
 * Storing the shape rather than the roster is the whole point:
 *   • it survives staff turnover, which at a tutoring centre is constant.
 *     A saved roster full of people who left looks right and isn't.
 *   • it sidesteps the calendar entirely. Because the shape is keyed by
 *     WEEKDAY, a month with five Mondays needs no special handling, and
 *     "what if that person has time off" is answered by the scheduler's
 *     existing availability logic instead of by us.
 *
 * What's saved is exactly the `config` object generateSchedule() already
 * accepts, so applying a template is just seeding the form — there is no
 * second code path that can drift from the real one.
 *
 * Path: centers/{centerId}/schedulerTemplates/{templateId}
 */

import {
  collection, doc, addDoc, deleteDoc, getDocs, onSnapshot,
  query, orderBy, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';

const colRef = (centerId) => collection(db, 'centers', centerId, 'schedulerTemplates');

/**
 * The scheduler-config fields a template owns. Anything outside this list
 * (a future one-off toggle, say) is deliberately NOT persisted — a
 * template should describe a staffing shape, not silently carry along
 * unrelated run settings.
 */
export const TEMPLATE_CONFIG_FIELDS = [
  'minPerDay', 'maxPerDay', 'maxDaysPerWeek', 'fairDistribution', 'perDay',
  // Coverage mode: per-weekday required-headcount curves, one number per
  // half-hour slot. A template saved in Classic mode simply has none, and
  // a template saved in Coverage mode carries both — so switching modes
  // after loading one doesn't lose the other side's settings.
  'curvesByWeekday',
];

/** Strip a live schedConfig down to just the templatable fields. */
export function toTemplateConfig(schedConfig = {}) {
  const out = {};
  for (const key of TEMPLATE_CONFIG_FIELDS) {
    if (schedConfig[key] !== undefined) out[key] = schedConfig[key];
  }
  // perDay always round-trips as an object so applying a template that
  // had no per-day overrides clears any left over from the last run,
  // rather than quietly inheriting them.
  out.perDay = out.perDay || {};
  return out;
}

/**
 * Merge a saved template back over the live config. Only the templated
 * fields move; everything else on schedConfig is left alone.
 */
export function applyTemplateConfig(schedConfig, template) {
  return { ...schedConfig, ...toTemplateConfig(template?.config || {}) };
}

/** Live list of a centre's templates, newest first. */
export function subscribeTemplates(centerId, onData, onError) {
  if (!centerId) return () => {};
  return onSnapshot(
    query(colRef(centerId), orderBy('createdAt', 'desc')),
    (snap) => onData(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    onError,
  );
}

export async function listTemplates(centerId) {
  if (!centerId) return [];
  const snap = await getDocs(query(colRef(centerId), orderBy('createdAt', 'desc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Save the current staffing shape under a name.
 * @param {string} centerId
 * @param {string} name       - what the owner calls it ("Term time", "Summer")
 * @param {Object} schedConfig - the live scheduler config
 * @param {Object} actor      - { uid, displayName } for provenance
 */
export async function saveTemplate(centerId, name, schedConfig, actor = {}) {
  const clean = String(name || '').trim();
  if (!centerId) throw new Error('No centre selected.');
  if (!clean)    throw new Error('Give the template a name.');
  return addDoc(colRef(centerId), {
    name: clean,
    config: toTemplateConfig(schedConfig),
    centerId,
    createdAt: serverTimestamp(),
    createdBy: actor.uid || null,
    createdByName: actor.displayName || '',
  });
}

export async function deleteTemplate(centerId, templateId) {
  if (!centerId || !templateId) return;
  return deleteDoc(doc(db, 'centers', centerId, 'schedulerTemplates', templateId));
}

/**
 * One-line human summary of what a template asks for, for the picker.
 * Reads the shape rather than restating the numbers, so a template with
 * per-day overrides says so instead of showing a misleading global range.
 */
export function describeTemplate(template) {
  const c = template?.config || {};
  const curveDays = Object.keys(c.curvesByWeekday || {}).length;
  if (curveDays > 0) {
    return `coverage curve · ${curveDays} day${curveDays === 1 ? '' : 's'}`;
  }
  const days = Object.keys(c.perDay || {}).length;
  const base = `${c.minPerDay ?? '?'}–${c.maxPerDay ?? '?'} per day`;
  return days > 0 ? `${base} · ${days} day${days === 1 ? '' : 's'} customised` : base;
}
