/**
 * Training staff — a paid employee who is invisible to the staffing math.
 *
 * WHAT IT IS
 *   Someone learning the floor. They're a normal employee in every way
 *   that matters to them: paid hourly like anyone else, full instructor
 *   access to the portal, on the schedule, in payroll. What makes them
 *   different is what they DON'T do — they don't cover a slot.
 *
 *   Concretely: a trainee shadows a real instructor. If the ratio maths
 *   counted them, the centre would look staffed when in truth one person
 *   is teaching and the other is watching. So they're excluded from
 *   coverage, from instructor:student ratios, and from the hours budget
 *   you manage against — while still being paid.
 *
 *   The nearest existing concept is the per-centre `isVolunteer` flag,
 *   with the pay behaviour inverted:
 *
 *                    Paid    Portal access    Counts toward ratios/budget
 *     Volunteer       no      bare-bones       no
 *     Training        YES     full instructor  no
 *     Instructor      yes     full             yes
 *
 * HOW IT'S STORED
 *   As an `instructorType` value — the same per-centre field that holds
 *   Lead / Host / Admin / Volunteer. NOT a top-level `role`: their portal
 *   access is meant to be identical to an instructor's, and every access
 *   check in the app tests `role === 'instructor'`, so making Training a
 *   role would mean revisiting all of them for no gain.
 *
 *   Because a shift's `role` is stamped from the person's instructorType
 *   at creation (see Admin.jsx), a trainee's shifts carry role:'Training'
 *   automatically — which is what keeps them out of STAFFING_COUNT_ROLES
 *   ('Instructor' | 'Lead') without touching the scheduler's internals.
 *
 * REVERSIBLE
 *   Training is a phase, not a person. Switch the dropdown back to
 *   Instructor when they're signed off and everything from that moment
 *   counts normally. Shifts already worked keep their Training tag, which
 *   is correct — that IS what happened.
 */

import { resolveUserForCenter } from './centerMembership';

export const TRAINING_TYPE = 'Training';

/** Tolerant of casing / stray whitespace in stored values. */
export function isTrainingType(value) {
  return String(value || '').trim().toLowerCase() === 'training';
}

/** Is this person in training AT THIS CENTRE? */
export function isTrainingUser(user, centerId) {
  if (!user) return false;
  return isTrainingType(resolveUserForCenter(user, centerId)?.instructorType);
}

/**
 * Is this SHIFT a training shift? Reads the shift's own role rather than
 * looking the person up, so a shift worked while training stays tagged
 * after they're promoted out of it.
 */
export function isTrainingShift(shift) {
  return isTrainingType(shift?.role);
}

/** Display names of everyone training at this centre. */
export function trainingNames(users, centerId) {
  const set = new Set();
  for (const u of users || []) {
    const r = resolveUserForCenter(u, centerId);
    if (isTrainingType(r?.instructorType) && r?.displayName) set.add(r.displayName);
  }
  return set;
}

/** uids of everyone training at this centre. */
export function trainingIds(users, centerId) {
  const set = new Set();
  for (const u of users || []) {
    if (u?.uid && isTrainingType(resolveUserForCenter(u, centerId)?.instructorType)) set.add(u.uid);
  }
  return set;
}

/**
 * True when this shift should count toward coverage / ratios. Training
 * and Volunteer are present and (for Training) paid, but neither one
 * covers a slot.
 */
export function countsTowardCoverage(shift, isVolunteer = false) {
  if (isVolunteer) return false;
  if (isTrainingShift(shift)) return false;
  return true;
}
