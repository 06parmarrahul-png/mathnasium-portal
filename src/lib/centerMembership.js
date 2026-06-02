/**
 * centerMembership.js — Per-centre user state.
 *
 * Background:
 *   A user can belong to multiple centres (their `centerIds` array). For
 *   a long time, operational fields like `instructorType`, `priority`,
 *   `subRoles`, `guaranteed`, `approved`, and `maxDaysPerWeek` lived on
 *   the top-level user doc. That meant editing a user in Centre A would
 *   ALSO change their role/priority in Centre B — they were truly the
 *   same record. For single-centre staff this was fine. For multi-centre
 *   staff (e.g. an instructor at Centre A who works as a host at Centre
 *   B) it was a real bug — changes leaked across centres.
 *
 * Fix:
 *   Move per-centre operational fields into a `centerMemberships` map on
 *   the user doc:
 *
 *     centerMemberships: {
 *       [centerId]: { instructorType, priority, subRoles, guaranteed,
 *                     approved, maxDaysPerWeek }
 *     }
 *
 *   Reads go through `getMembership(user, centerId)`, which merges the
 *   per-centre values OVER the top-level legacy fields. Writes go via
 *   `membershipFieldPath()` which produces the dotted Firestore path
 *   (e.g. 'centerMemberships.cA.priority') so an updateDoc only touches
 *   that one centre's record.
 *
 * Backwards-compat:
 *   Top-level fields are kept as the fallback for users who haven't been
 *   touched since the migration. The first time an admin edits a user
 *   on the new flow, that centre gets its own membership entry. Other
 *   centres the user belongs to continue to read from the top-level
 *   defaults until they're explicitly edited too.
 *
 *   Platform `role` (instructor / admin / owner / super_admin) stays at
 *   the top level. That's a platform-wide identity, not a per-centre
 *   duty — Manage Roles still edits it globally.
 */

// Fields that are now per-centre. Edits to any of these from the Admin
// panel should go through writeMembershipField() rather than touching
// the top-level field.
export const PER_CENTRE_FIELDS = [
  'instructorType',
  'priority',
  'subRoles',
  'guaranteed',
  'approved',
  'maxDaysPerWeek',
  'isVolunteer',
];

/**
 * Returns the user's effective values for the given centre.
 *
 * Order of precedence (highest wins):
 *   1. user.centerMemberships[centerId][field]
 *   2. user[field] (legacy top-level fallback)
 *
 * If no centerId is supplied (e.g. cross-centre views like Manage
 * Roles), we just return the top-level fields — the caller is operating
 * on the global user record.
 */
export function getMembership(user, centerId) {
  if (!user) return {};
  const top = {
    instructorType:  user.instructorType,
    priority:        user.priority,
    subRoles:        user.subRoles,
    guaranteed:      user.guaranteed,
    approved:        user.approved,
    maxDaysPerWeek:  user.maxDaysPerWeek,
    isVolunteer:     user.isVolunteer,
  };
  if (!centerId) return top;
  const m = user.centerMemberships?.[centerId];
  if (!m) return top;
  return {
    instructorType:  m.instructorType  ?? top.instructorType,
    priority:        m.priority        ?? top.priority,
    subRoles:        m.subRoles        ?? top.subRoles,
    guaranteed:      m.guaranteed      ?? top.guaranteed,
    approved:        m.approved        ?? top.approved,
    maxDaysPerWeek:  m.maxDaysPerWeek  ?? top.maxDaysPerWeek,
    isVolunteer:     m.isVolunteer     ?? top.isVolunteer,
  };
}

/**
 * Returns a flat user-like object where per-centre fields are hoisted
 * to the top level for the given centre. Lets existing code that reads
 * `u.priority`, `u.instructorType`, etc. keep working unchanged — the
 * caller just maps users through this once at the top of the component.
 */
export function resolveUserForCenter(user, centerId) {
  if (!user) return user;
  const m = getMembership(user, centerId);
  return { ...user, ...m };
}

/**
 * Returns the dotted Firestore field path for a per-centre field, e.g.
 *   membershipFieldPath('cA', 'priority') === 'centerMemberships.cA.priority'
 *
 * Use with updateDoc:
 *   updateDoc(ref, { [membershipFieldPath(centerId, 'priority')]: 3 })
 *
 * For fields not in PER_CENTRE_FIELDS, callers should write to the
 * top-level field directly instead of calling this.
 */
export function membershipFieldPath(centerId, field) {
  if (!centerId) throw new Error('membershipFieldPath: centerId required');
  if (!field)    throw new Error('membershipFieldPath: field required');
  return `centerMemberships.${centerId}.${field}`;
}

/**
 * Returns true if the field is one of the per-centre operational
 * fields. Callers can branch on this when building update payloads.
 */
export function isPerCentreField(field) {
  return PER_CENTRE_FIELDS.includes(field);
}

/**
 * Builds the initial centerMemberships entry for a brand-new user
 * landing in their first centre. Mirrors the top-level defaults so the
 * read path produces identical results either way.
 */
export function buildInitialMembership(defaults = {}) {
  return {
    instructorType: defaults.instructorType ?? 'Instructor',
    priority:       defaults.priority       ?? 2,
    maxDaysPerWeek: defaults.maxDaysPerWeek ?? 5,
    subRoles:       defaults.subRoles       ?? [],
    guaranteed:     defaults.guaranteed     ?? false,
    approved:       defaults.approved       ?? false,
    isVolunteer:    defaults.isVolunteer    ?? false,
  };
}
