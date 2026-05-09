/**
 * Multi-tenant (multi-center) helpers.
 *
 * The data model:
 *   - `centers/{centerId}` — one doc per Mathnasium location ('langley', 'burnaby', ...)
 *   - Every other doc carries a `centerId` field that ties it to one center
 *   - User docs additionally carry `centerIds: string[]` (an array) because
 *     some staff work at multiple Mathnasium locations
 *
 * The "active" center for a user is whichever center they're currently
 * looking at. For users with one center it's just that one. For multi-
 * center staff, we store the choice in localStorage and they can switch
 * via a sidebar dropdown (Phase 7 — not yet built).
 *
 * Until we add a 2nd center, every user defaults to Langley. The fallback
 * is intentional so legacy code that doesn't yet know about centers
 * continues to work.
 */

export const DEFAULT_CENTER_ID = 'langley';

const ACTIVE_CENTER_KEY = 'mathnasium.activeCenterId';

/**
 * Return the array of center IDs this user belongs to.
 * Always returns at least one entry (DEFAULT_CENTER_ID as fallback).
 */
export function getUserCenters(profile) {
  if (!profile) return [DEFAULT_CENTER_ID];
  if (Array.isArray(profile.centerIds) && profile.centerIds.length > 0) {
    return profile.centerIds;
  }
  if (profile.centerId) return [profile.centerId];
  return [DEFAULT_CENTER_ID];
}

/**
 * Return the user's currently-active center ID. If they have multiple
 * centers and have previously picked one (stored in localStorage), use
 * that — otherwise default to the first in their list.
 */
export function getActiveCenterId(profile) {
  const userCenters = getUserCenters(profile);
  try {
    const stored = localStorage.getItem(ACTIVE_CENTER_KEY);
    if (stored && userCenters.includes(stored)) return stored;
  } catch { /* ignore SSR / privacy modes */ }
  return userCenters[0];
}

/**
 * Persist the user's center choice. Used by the (future) sidebar
 * center-switcher for staff who work at multiple Mathnasium locations.
 */
export function setActiveCenterId(centerId) {
  try {
    localStorage.setItem(ACTIVE_CENTER_KEY, centerId);
  } catch { /* ignore */ }
}

/**
 * Whether this user is allowed to switch between centers in the UI.
 * True if they belong to more than one, or are a super-admin.
 */
export function canSwitchCenters(profile) {
  if (profile?.role === 'super_admin') return true;
  return getUserCenters(profile).length > 1;
}
