/**
 * Who may add, approve and remove staff — the server's side of it.
 *
 * Managers are the admin tier (2026-09-14). The Admin platform role was
 * retired and the Manager job title took over everything it granted, at
 * that centre only. The Firestore rules say the same in isManagerOfCentre;
 * the client in src/lib/managementTier.js. API routes can't import from
 * src/, so the few lines that matter are repeated here.
 *
 * Also fixed here: Directors were missing from both staff endpoints'
 * first check, so the Centre Director and Director of Education — who are
 * owner-level everywhere else — could not add a staff member at all.
 *
 * Files under api/_lib are not routed, so this costs nothing against the
 * 12-function cap.
 */

/** Platform roles that manage staff wherever they belong. */
const STAFF_ROLES = new Set(['super_admin', 'owner', 'director', 'admin_assistant', 'admin']);

/** Owner-level: may also terminate, and create director accounts. */
const OWNER_TIER = new Set(['super_admin', 'owner', 'director', 'admin_assistant']);

const DIRECTOR_TITLES = new Set(['center director', 'centre director', 'dir. of education', 'director of education']);

export function centreIdsOf(profile) {
  if (Array.isArray(profile?.centerIds)) return profile.centerIds;
  return profile?.centerId ? [profile.centerId] : [];
}

/** The title at a centre: that centre's membership, else the legacy top-level field. */
export function titleAt(profile, centerId) {
  const member = profile?.centerMemberships?.[centerId];
  if (member && typeof member.instructorType === 'string' && member.instructorType) return member.instructorType;
  return profile?.instructorType || '';
}

/** Manager of exactly this centre: a member of it, titled Manager there. */
export function isManagerOfCentre(profile, centerId) {
  return !!centerId && centreIdsOf(profile).includes(centerId) && titleAt(profile, centerId) === 'Manager';
}

/** The centres this person may manage staff at. */
export function staffCentresOf(profile) {
  if (STAFF_ROLES.has(profile?.role)) return centreIdsOf(profile);
  return centreIdsOf(profile).filter(c => isManagerOfCentre(profile, c));
}

export function canManageStaffAnywhere(profile) {
  return STAFF_ROLES.has(profile?.role) || staffCentresOf(profile).length > 0;
}

export function canManageStaffAt(profile, centerId) {
  return STAFF_ROLES.has(profile?.role) || isManagerOfCentre(profile, centerId);
}

export function isOwnerTier(profile) {
  return OWNER_TIER.has(profile?.role);
}

const isDirectorTitle = (t) => DIRECTOR_TITLES.has(String(t || '').trim().toLowerCase());

/**
 * Whether this caller may create an account with this title. A director
 * title carries owner-level access, so handing one out stays with the
 * owner tier — otherwise a Manager (or the old Admin role) could mint
 * themselves a director colleague.
 */
export function canCreateTitle(profile, title) {
  return !isDirectorTitle(title) || isOwnerTier(profile);
}

const PRIVILEGE = { instructor: 1, admin: 2, admin_assistant: 2.5, director: 3, owner: 3, super_admin: 4 };

/**
 * Rank for "may A remove B". A Manager ranks with the old Admin role, and
 * a director by title ranks with a director by role — so neither can be
 * removed from below.
 */
export function privilegeOf(profile) {
  let rank = PRIVILEGE[profile?.role || 'instructor'] || 0;
  const titles = [profile?.instructorType, ...Object.values(profile?.centerMemberships || {}).map(m => m?.instructorType)];
  if (titles.some(isDirectorTitle)) rank = Math.max(rank, 3);
  if (rank < 2 && staffCentresOf(profile).length > 0) rank = 2;
  return rank;
}
