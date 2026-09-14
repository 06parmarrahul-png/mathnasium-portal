import { resolveUserForCenter } from './centerMembership';

/**
 * Managers are the admin tier (2026-09-14). The Admin platform role was
 * retired and the Manager job title took over everything it granted — at
 * that centre only. These mirror isManagerOfCentre / the centerLeadership
 * rules in firestore.rules, so a link the app shows is a door the rules
 * open.
 */

const centreIdsOf = (user) => (Array.isArray(user?.centerIds)
  ? user.centerIds
  : (user?.centerId ? [user.centerId] : []));

/**
 * Manager of THIS centre: a member of it, whose title there is Manager.
 * A legacy top-level instructorType of "Manager" doesn't make someone a
 * Manager of a centre they don't belong to.
 */
export function isCentreManager(user, centerId) {
  if (!user || !centerId) return false;
  if (!centreIdsOf(user).includes(centerId)) return false;
  return resolveUserForCenter(user, centerId)?.instructorType === 'Manager';
}

const LEADERSHIP_ROLES = new Set(['owner', 'admin_assistant', 'director', 'admin']);
const DIRECTOR_TITLES = new Set(['center director', 'centre director', 'dir. of education', 'director of education']);

/** Is this person in the centre's Management Chat? */
export function inManagementChat(user, centerId) {
  if (!user) return false;
  if (user.role === 'super_admin') return true;
  if (!centreIdsOf(user).includes(centerId)) return false;
  if (LEADERSHIP_ROLES.has(user.role)) return true;
  const title = String(resolveUserForCenter(user, centerId)?.instructorType || '').trim().toLowerCase();
  return title === 'manager' || DIRECTOR_TITLES.has(title);
}
