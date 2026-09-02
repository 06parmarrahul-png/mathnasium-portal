/**
 * ratioCount.js — "Does this shift count toward the instructor:student ratio?"
 *
 * THE PROBLEM THIS REPLACES
 *   Until now, seven different places in the app each answered that question
 *   their own way, all by guessing from the shift's role:
 *
 *     scheduler.js       STAFFING_COUNT_ROLES = {Instructor, Lead}   (dead — no callers)
 *     staffTypes.js      countsTowardCoverage()                      (dead — no callers)
 *     scheduler.js       COUNTS_TOWARD_RATIO_BY_ROLE = {Manager, Lead, Instructor}
 *     SupplyDemand.jsx   ON_FLOOR_ROLES = {Instructor, Lead, Manager}
 *                        + countsAsFloorSupply(): Leads dropped from the first
 *                          half-hour, Managers from the first AND the last
 *     CoverageGrid.jsx   TEACHING_ROLES = {Instructor, Lead}
 *     TodaysSnapshot.jsx inline ['Instructor', 'Lead']
 *     StaffingBoard.jsx  slot kind + fixedStaff.countsTowardRatio
 *
 *   They disagreed. A Manager counted on Supply & Demand but not on the
 *   Coverage Grid or Today's Snapshot. A Lead counted at 3:30 but not at
 *   3:00. That is the "leads sometimes and Sabrina sometimes" the centre
 *   director asked us to get rid of.
 *
 * THE MODEL NOW
 *   Whether a body counts is a property OF THE SHIFT, stored on the shift
 *   document as an explicit boolean:
 *
 *     includedInRatio: true | false
 *
 *   It is set when the shift is created — every creation path stamps it —
 *   and flipped from a toggle on the Add/Edit Shift modals. Nothing infers
 *   it from the role after that point. One shift, one answer, every screen.
 *
 * LEGACY SHIFTS
 *   Documents written before this field existed have no `includedInRatio`.
 *   For those, and ONLY those, defaultIncludedInRatio() reproduces the
 *   intended behaviour from the role. That keeps historical weeks reading
 *   the way they always did instead of every director and host suddenly
 *   counting as teaching supply.
 *
 * WHAT THIS DOES NOT DECIDE
 *   Presence. Whether a shift is a draft, cancelled, sick or a no-show is a
 *   separate question with its own existing handling at each call site, and
 *   this module deliberately leaves it alone. Ask this module "should this
 *   role fill a ratio slot", not "was this person in the building".
 */

/** The shift-document field. One name, referenced rather than retyped. */
export const RATIO_FIELD = 'includedInRatio';

/**
 * Roles whose shifts are floor work, and so default to counted.
 *
 * Manager is in this set on purpose. Sabrina is on the floor running
 * sessions every day, which is why the fixed-staff config carries an
 * explicit `countsTowardRatio: true` for her — Supply & Demand already
 * agreed, while the Coverage Grid and Today's Snapshot did not. Counted
 * is the settled answer.
 */
export const DEFAULT_IN_RATIO_ROLES = new Set(['Instructor', 'Lead', 'Manager']);

/**
 * Roles that are present, usually paid, and explicitly NOT ratio supply:
 * a trainee shadows rather than covers, and a volunteer never fills a slot.
 * Kept separate from "everything else" so the intent is legible.
 */
export const NEVER_IN_RATIO_ROLES = new Set(['Training', 'Volunteer']);

const norm = (v) => String(v ?? '').trim().toLowerCase();

const inSet = (set, value) => {
  const n = norm(value);
  if (!n) return false;
  for (const entry of set) if (norm(entry) === n) return true;
  return false;
};

/**
 * What the "Included in Ratio" toggle should start as for a shift with
 * this role — and the answer used for legacy documents that never got the
 * field written.
 *
 * Order matters:
 *   1. LEGACY: a `flexRole` (STEAM / Summer Camp). That feature was
 *      removed and nothing writes the field any more, but 58 shift
 *      documents from summer 2026 still carry it and must stay out of
 *      the ratio on historical coverage views. Do not add a new writer —
 *      make a centre role with "Counts toward the ratio" off instead.
 *   2. Training and Volunteer never fill a slot.
 *   3. A volunteer by per-centre membership, even on an untagged shift.
 *   4. Instructor / Lead / Manager are floor roles → counted.
 *   5. No role recorded at all → counted. Legacy shifts predate the role
 *      field, and every surface already default-allowed them rather than
 *      silently dropping a real instructor.
 *   6. Everything else — Host, Admin, Centre Director, Dir. of Education,
 *      Online Instructor — is off-floor or off-ratio → not counted.
 *
 * @param {object} shift              shift-like: { role, flexRole }
 * @param {object} [opts]
 * @param {boolean} [opts.isVolunteer] per-centre volunteer flag for the
 *        person, when the caller has resolved it (it lives on the user's
 *        centre membership, not on the shift).
 */
export function defaultIncludedInRatio(shift, opts = {}) {
  if (!shift) return false;
  if (shift.flexRole) return false;                    // legacy — see above
  if (inSet(NEVER_IN_RATIO_ROLES, shift.role)) return false;
  if (opts.isVolunteer) return false;
  if (inSet(DEFAULT_IN_RATIO_ROLES, shift.role)) return true;
  if (!norm(shift.role)) return true;
  return false;
}

/**
 * Does this shift count toward the instructor:student ratio?
 *
 * The stored boolean wins outright — that is the whole point of the
 * toggle, so a Host explicitly marked in-ratio counts and an Instructor
 * explicitly marked out does not. Only a shift with no stored value falls
 * back to the role-derived default.
 */
export function countsInRatio(shift, opts = {}) {
  if (!shift) return false;
  if (typeof shift[RATIO_FIELD] === 'boolean') return shift[RATIO_FIELD];
  return defaultIncludedInRatio(shift, opts);
}

/**
 * Stamp the field onto a shift payload about to be written, so newly
 * created shifts always carry an explicit value and the legacy fallback
 * above only ever applies to documents that predate the feature.
 *
 * An explicit boolean already on the payload is respected, which is how
 * the Add Shift modal passes the toggle through.
 */
export function withRatioDefault(shiftData, opts = {}) {
  if (!shiftData) return shiftData;
  if (typeof shiftData[RATIO_FIELD] === 'boolean') return shiftData;
  return { ...shiftData, [RATIO_FIELD]: defaultIncludedInRatio(shiftData, opts) };
}

/**
 * Has someone deliberately overridden the role's default for this shift?
 *
 * Used to decide whether the Add/Edit Shift toggle should keep re-seeding
 * itself as the role dropdown changes. A shift saved with a value that
 * MATCHES its role default is indistinguishable from one that was never
 * touched, and that's fine — re-seeding it produces the same answer.
 */
export function isRatioOverridden(shift) {
  if (!shift) return false;
  if (typeof shift[RATIO_FIELD] !== 'boolean') return false;
  return shift[RATIO_FIELD] !== defaultIncludedInRatio(shift);
}

/**
 * What the toggle should read after the role or flex role changes.
 *
 * The rule that matters: once a human has moved the toggle, changing the
 * role must never move it back. Picking "Lead" after deliberately marking
 * a shift out of ratio would otherwise silently re-count it, and nobody
 * would see that happen.
 *
 * @param {boolean} touched  has the user moved the toggle themselves
 * @param {boolean} current  what it reads now
 * @param {object}  next     the shift-like it's changing to ({ role, flexRole })
 */
export function reseedRatioValue(touched, current, next) {
  if (touched) return current;
  return defaultIncludedInRatio(next);
}

/**
 * Wording for the toggle's helper line. Lives here rather than in the two
 * modals so Add and Edit can never drift apart.
 */
export function ratioHint(included) {
  return included
    ? 'Counts toward the instructor:student ratio on every coverage screen.'
    : 'Present and paid, but not counted as teaching supply.';
}
