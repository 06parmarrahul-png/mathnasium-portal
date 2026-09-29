/**
 * centreStaff.js — who actually works at a centre.
 *
 * Some accounts belong to a centre without being employed by it. They
 * carry `centerIds`, because that is how the app scopes what a person can
 * see, but they are not on the rota, not in payroll, not in the staffing
 * maths, and not in the roster an owner manages.
 *
 *   super_admin       the platform operator. Already excluded, in five
 *                     separate places, each with its own inline
 *                     `role !== 'super_admin'` — this is those, gathered.
 *
 *   district_manager  answers for several centres and is employed by
 *                     none of them. `centerIds` is how their district is
 *                     defined, so they match every per-centre user query
 *                     there is — and would otherwise be counted as a
 *                     member of staff at every centre in the province,
 *                     including on their own roll-up.
 *
 * Kept as a set rather than a string test so the next such role is one
 * line here instead of a hunt through five files.
 *
 * NOT THE SAME QUESTION AS "does this person show on the schedule".
 * An owner is staff — they draw pay and can be rostered — but is hidden
 * from the roster by default unless listed in fixedStaff. That nuance
 * lives with the schedule, in Admin.jsx. This file answers the blunter
 * question: is this an employee of the centre at all.
 *
 * PURE MODULE — no React, no Firebase.
 */

export const NON_STAFF_PLATFORM_ROLES = new Set(['super_admin', 'district_manager']);

/** Is this account employed by the centre whose roster is being built? */
export function isCentreStaff(user) {
  if (!user) return false;
  return !NON_STAFF_PLATFORM_ROLES.has(String(user.role || ''));
}

/** The staff among them. Order preserved; anything falsy dropped. */
export function onlyCentreStaff(users) {
  return (users || []).filter(isCentreStaff);
}
