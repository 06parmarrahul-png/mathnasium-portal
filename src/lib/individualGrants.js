/**
 * individualGrants.js — access given to a PERSON, not to a role.
 *
 * THE GAP THIS FILLS
 *   Everything a person can do comes from their title: change what an
 *   Instructor may do and you change it for every instructor at the
 *   centre. So "Ainsley, Kaitlyn and Homer can run the Student Scheduler,
 *   nobody else at their level can" had two bad answers — promote all
 *   three to a title they have not got, or hand the Student Scheduler to
 *   twenty instructors to reach three.
 *
 *   An individual grant is the third answer: this permission, this person,
 *   this centre. It is ADDITIVE ONLY — a grant can give somebody something
 *   their title does not, and can never take away something it does. Taking
 *   away belongs to the role, where it is visible to everyone at once.
 *
 * PER CENTRE, DELIBERATELY. Grants live in
 * `centerMemberships[centerId].extraPermissions`, beside the title they
 * extend. Somebody trusted with the scheduler at Langley is not thereby
 * trusted with it at Burnaby, and a grant that followed a person between
 * centres would be a quiet surprise to the second centre's owner.
 *
 * THE ESCALATION BOUNDARY IS THE SAME ONE ROLES HAVE. `roles.manage` and
 * `district.view` are platform-only and cannot be granted here any more
 * than a centre role can grant them — see PLATFORM_ONLY_PERMISSIONS. And
 * the employment-state rules still win: a grant cannot put a volunteer on
 * a shift, because resolvePermissions applies those last.
 *
 * PURE MODULE — no React, no Firebase.
 */

import { PERMISSIONS, PLATFORM_ONLY_PERMISSIONS, assignablePermissions } from './roles';

const PERMISSION_IDS = new Set(PERMISSIONS.map(p => p.id));

/** The permissions that may be handed to one person. */
export function grantablePermissions() {
  // Exactly what a centre role may grant. One list, so a permission can
  // never be grantable one way and not the other.
  return assignablePermissions();
}

/**
 * A stored list → the grants to honour.
 *
 * Unknown ids are dropped rather than carried: a permission that was
 * removed from the registry should stop granting anything, and a typo
 * should grant nothing rather than sit there looking like access.
 */
export function resolveGrants(stored) {
  if (!Array.isArray(stored)) return [];
  const out = [];
  for (const id of stored) {
    if (typeof id !== 'string') continue;
    if (!PERMISSION_IDS.has(id)) continue;
    if (PLATFORM_ONLY_PERMISSIONS.has(id)) continue;
    if (out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** What this person has been given at this centre, individually. */
export function grantsFor(user, centerId) {
  const membership = user?.centerMemberships?.[centerId];
  return resolveGrants(membership?.extraPermissions);
}

/** Add or remove one, returning a new list. */
export function toggleGrant(grants, id) {
  const list = resolveGrants(grants);
  if (!PERMISSION_IDS.has(id) || PLATFORM_ONLY_PERMISSIONS.has(id)) return list;
  return list.includes(id) ? list.filter(g => g !== id) : [...list, id];
}

/** The catalogue entry, for a label on screen. */
export function permissionLabel(id) {
  return PERMISSIONS.find(p => p.id === id)?.label || id;
}

/**
 * Everyone at this centre carrying a grant, for the summary line.
 *
 * Sorted by name so the list reads the same every time somebody opens it.
 */
export function peopleWithGrants(users, centerId) {
  return (users || [])
    .map(u => ({ user: u, grants: grantsFor(u, centerId) }))
    .filter(row => row.grants.length > 0)
    .sort((a, b) => String(a.user.displayName || '').localeCompare(String(b.user.displayName || '')));
}

/**
 * Is this grant doing anything the person's title does not already do?
 *
 * A grant that duplicates the title is not wrong, but it is noise — it
 * looks like the reason they have the access when it isn't, and removing
 * it would change nothing. The screen says so rather than hiding it.
 */
export function isRedundant(id, rolePermissions) {
  if (!rolePermissions) return false;
  return rolePermissions instanceof Set
    ? rolePermissions.has(id)
    : (rolePermissions || []).includes(id);
}
