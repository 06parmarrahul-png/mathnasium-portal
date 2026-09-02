/**
 * roles.js — Custom centre roles and what they're allowed to do.
 *
 * WHAT THIS IS
 *   A per-centre role registry, editable from Manage Roles → Centre Roles.
 *   A role has a name, a colour, a set of permissions, and whether shifts
 *   worked under it count toward the instructor:student ratio. New roles
 *   can be created, existing ones renamed, recoloured and re-permissioned,
 *   and custom ones deleted.
 *
 * THE THREE THINGS CALLED "ROLE"
 *   Getting these confused is the easiest way to break access, so:
 *
 *   1. `user.role` — the PLATFORM role: super_admin / owner / director /
 *      admin_assistant / admin / instructor. Six fixed values. This is the
 *      security boundary. Firestore rules read it. It is NOT editable here
 *      and there is no way to invent a seventh.
 *
 *   2. `centerMemberships[centreId].instructorType` — the CENTRE role, aka
 *      the job title: Instructor, Lead, Host, Manager, Training, Volunteer,
 *      the directors. THIS is what the registry below describes, and what
 *      Manage Roles lets you extend. Every user already has one, so there
 *      is no migration.
 *
 *   3. `subRoles` — teaching CAPABILITIES (Elementary / Highschool /
 *      Online / Host). Unrelated to permissions. Left alone.
 *
 * PERMISSIONS ARE ADDITIVE. THIS IS DELIBERATE.
 *   A centre role can only ever GRANT access on top of what the platform
 *   role already gives. It cannot take anything away.
 *
 *   The reason is blunt: this registry is editable data. If a role could
 *   revoke, one wrong click — deleting a permission, deleting a role,
 *   renaming it so it stops matching — would lock the owner out of their
 *   own centre with no route back in except a developer with database
 *   access. Grants can be wrong and then corrected. Revocations can be
 *   wrong and then unfixable. So: grants only.
 *
 *   The practical consequence: to give someone LESS, lower their platform
 *   role in Manage Roles → People. To give them MORE, grant it here.
 *
 * TRAINEES AND VOLUNTEERS
 *   Their restrictions — no shift claiming, and volunteers also get no
 *   team chat — are applied LAST, after every grant. Volunteer and trainee
 *   are employment states, not job titles, and the centre relies on them
 *   holding absolutely.
 *
 *   This ordering is not a stylistic choice. Applying them to the baseline
 *   instead let a role's grants hand the permissions straight back: a
 *   volunteer carrying a director title came out able to claim shifts and
 *   use chat, which is not what happens today. The equivalence suite in
 *   roles.test.js caught it across all twelve affected combinations.
 *
 *   Restricting last is also safe, because these two flags come from the
 *   user's own membership record, not from the editable role registry —
 *   so no edit in Manage Roles can trigger them.
 */

import { defaultIncludedInRatio } from './ratioCount';

// ─── The permission catalogue ────────────────────────────────────────────
//
// Every entry here corresponds to a gate that ALREADY EXISTS in the app.
// This is a re-expression of the current rules, not a new set of them —
// which is what lets the built-in grants below reproduce today's access
// exactly, and what the roles.test.js equivalence suite pins.

export const PERMISSIONS = [
  {
    id: 'admin.panel',
    group: 'Administration',
    label: 'Open the Admin Panel',
    description: 'The weekly grid, auto-scheduler, Manage Staff, payroll and time off.',
  },
  {
    id: 'admin.operations',
    group: 'Administration',
    label: 'Run day-to-day operations',
    description: 'Staffing Board, Inventory and the Availability Log. Implied by Admin Panel access.',
  },
  {
    id: 'centre.settings',
    group: 'Administration',
    label: 'Edit centre settings',
    description: 'Operating days, hours, holidays, appearance and the staffing budget.',
  },
  {
    id: 'analytics.view',
    group: 'Insight',
    label: 'View analytics and leads',
    description: 'Supply & Demand, Leads, Case Study and Apptoto. Includes customer contact details.',
  },
  {
    id: 'scheduler.run',
    group: 'Floor',
    label: 'Run the Student Scheduler',
    description: 'Assign instructors to students, check students in, record walk-ins.',
  },
  {
    id: 'shifts.take',
    group: 'Floor',
    label: 'Claim and swap shifts',
    description: 'Pick up open shifts from the Shift Board and trade with other staff.',
  },
  {
    id: 'chat.access',
    group: 'Floor',
    label: 'Use team messaging',
    description: 'The centre chat and direct messages.',
  },
  {
    id: 'roles.manage',
    group: 'Enterprise',
    label: 'Manage roles and permissions',
    description: 'Create and edit centre roles, and change platform roles. Enterprise-level.',
  },
];

export const PERMISSION_IDS = PERMISSIONS.map(p => p.id);
const PERMISSION_ID_SET = new Set(PERMISSION_IDS);

/**
 * Permissions a CENTRE ROLE may never grant, whatever is stored against
 * it. This is the privilege-escalation boundary and it is enforced in
 * resolvePermissions(), not just hidden in the editor UI.
 *
 * Why it has to exist: the role editor is open to anyone holding
 * `centre.settings` — a centre director, not only Enterprise. Without
 * this, that director could invent a role granting `roles.manage`,
 * assign it to themselves, and walk straight into editing platform
 * roles across every centre. `roles.manage` therefore comes from the
 * platform role alone, and a stored grant for it is ignored.
 */
export const PLATFORM_ONLY_PERMISSIONS = new Set(['roles.manage']);

/** The permissions a centre role is allowed to offer in the editor. */
export function assignablePermissions() {
  return PERMISSIONS.filter(p => !PLATFORM_ONLY_PERMISSIONS.has(p.id));
}

/** Catalogue entries grouped for the editor UI, in catalogue order. */
export function permissionGroups() {
  const groups = [];
  for (const p of assignablePermissions()) {
    let g = groups.find(x => x.name === p.group);
    if (!g) { g = { name: p.group, permissions: [] }; groups.push(g); }
    g.permissions.push(p);
  }
  return groups;
}

export function permissionLabel(id) {
  return PERMISSIONS.find(p => p.id === id)?.label || id;
}

// ─── Platform-role baselines ─────────────────────────────────────────────
//
// Exactly what each platform role can do today. Read straight off
// AuthContext.jsx and ProtectedRoute.jsx:
//
//   canSeeAdminPanel    = admin | admin_assistant | director | owner | super_admin
//   canSeeCenterSettings= super_admin | owner | admin_assistant | director   (NOT admin)
//   canManageOperations = canSeeAdminPanel | Manager | Host
//   canRunScheduler     = canSeeAdminPanel | Lead | Manager | Host
//   analytics routes    = canSeeAdminPanel   (requireOwner, no allowOps)
//   /manage-roles       = super_admin only
//
// Change nothing here without changing those, or the equivalence tests
// will (correctly) fail.

const ADMIN_PANEL_BASE = [
  'admin.panel', 'admin.operations', 'analytics.view', 'scheduler.run',
  'shifts.take', 'chat.access',
];

export const PLATFORM_ROLE_PERMISSIONS = {
  super_admin:     [...ADMIN_PANEL_BASE, 'centre.settings', 'roles.manage'],
  owner:           [...ADMIN_PANEL_BASE, 'centre.settings'],
  director:        [...ADMIN_PANEL_BASE, 'centre.settings'],
  admin_assistant: [...ADMIN_PANEL_BASE, 'centre.settings'],
  // A plain Admin gets the panel and the analytics routes, but NOT centre
  // settings. That gap is intentional and predates this file.
  admin:           [...ADMIN_PANEL_BASE],
  instructor:      ['shifts.take', 'chat.access'],
};

/** Platform roles, in descending order of reach. For pickers and labels. */
export const PLATFORM_ROLES = [
  'super_admin', 'owner', 'director', 'admin_assistant', 'admin', 'instructor',
];

// ─── Built-in centre roles ───────────────────────────────────────────────
//
// The seed registry: every value the Manage Staff / shift-role dropdowns
// already offer, with the permissions those titles already carry and the
// ratio default from ratioCount.js. A centre that has never opened the
// role editor behaves exactly as it does today, because this IS today.
//
// `builtIn: true` means the role cannot be deleted — user records and
// shift documents reference these names, and deleting one would orphan
// them. It can still be renamed, recoloured and re-permissioned.

// The two director titles carry owner-equivalent centre access. That is
// not new: AuthContext's isDirector() already matched on instructorType,
// so a director-titled account got the same flags as role:'director'.
// Naming it here makes it visible and editable instead of buried in a
// permissive OR-chain — and it closes a real inconsistency, because
// ProtectedRoute checked only `profile.role` and would have shown that
// same person "Not authorized" on the route its own nav linked to.
// Verified against live data first: both director-titled accounts at
// Langley (Vin, Neeru) ALSO carry role:'director', so nobody's access
// actually moves.
const DIRECTOR_GRANTS = [...ADMIN_PANEL_BASE, 'centre.settings'];

const BUILTIN_ROLE_SEEDS = [
  { name: 'Center Director',   permissions: DIRECTOR_GRANTS },
  { name: 'Dir. of Education', permissions: DIRECTOR_GRANTS },
  { name: 'Manager',           permissions: ['scheduler.run', 'admin.operations'] },
  { name: 'Lead',              permissions: ['scheduler.run'] },
  { name: 'Host',              permissions: ['scheduler.run', 'admin.operations'] },
  { name: 'Admin',             permissions: [] },
  { name: 'Instructor',        permissions: [] },
  { name: 'Training',          permissions: [] },
  { name: 'Volunteer',         permissions: [] },
  // 'Owner' is deliberately NOT here. Signup stamps it as the
  // instructorType of the first account at a new centre
  // (AuthContext.jsx), so it exists on real records — but it is a
  // signup artifact, not a job title anyone assigns, and listing it in
  // the role editor just invited someone to give "Owner" permissions
  // that the platform role already grants. An account still carrying it
  // keeps its title: useRoleOptions() in Admin.jsx appends whatever
  // value a record actually holds, so its dropdown never renders blank.
];

/**
 * Fold a role name to a comparison key. Centre roles are matched to users
 * by their `instructorType` string, and that data is not clean — casing
 * and spacing vary by how old the record is. Matching on a folded key
 * stops a real Lead reading as roleless.
 */
export function roleKey(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
}

/** A stable id for a newly created role, unique within the registry. */
export function makeRoleId(name, existing = []) {
  const base = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    || 'role';
  const taken = new Set(existing.map(r => r.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * The built-in registry. Colours come from the existing per-centre
 * appearance palette via staffTypeColorHex(), so a role's colour here is
 * the same colour it already shows on the weekly grid — one palette, not
 * a second one to keep in sync. The caller passes the resolver in to keep
 * this module free of a centerConfig import cycle.
 */
export function builtInRoles(colorFor) {
  return BUILTIN_ROLE_SEEDS.map((seed, i) => ({
    id: makeRoleId(seed.name),
    name: seed.name,
    color: typeof colorFor === 'function' ? colorFor(seed.name) : '#64748b',
    countsInRatio: defaultIncludedInRatio({ role: seed.name }),
    permissions: [...seed.permissions],
    order: i,
    builtIn: true,
  }));
}

/**
 * Read the registry for a centre, falling back to the built-ins when the
 * centre has never customised it — which is every centre until someone
 * opens the editor.
 *
 * Stored roles are merged OVER the built-ins by name, so a centre that
 * has edited only "Lead" keeps every other built-in intact rather than
 * losing the ones it never touched.
 */
export function resolveRoles(centerConfig, colorFor) {
  const builtins = builtInRoles(colorFor);
  const stored = Array.isArray(centerConfig?.staffRoles) ? centerConfig.staffRoles : null;
  if (!stored || stored.length === 0) return builtins;

  const byKey = new Map(builtins.map(r => [roleKey(r.name), r]));
  for (const raw of stored) {
    const role = normalizeRole(raw, colorFor);
    if (!role) continue;
    const existing = byKey.get(roleKey(role.name));
    byKey.set(roleKey(role.name), existing
      ? { ...existing, ...role, builtIn: existing.builtIn }
      : role);
  }
  // A built-in the centre explicitly removed from the stored array stays
  // present — built-ins are not deletable, and silently dropping one
  // would strip permissions from whoever holds it.
  return [...byKey.values()].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

/** Coerce one stored entry into a well-formed role, or null if unusable. */
export function normalizeRole(raw, colorFor) {
  const name = String(raw?.name ?? '').trim();
  if (!name) return null;
  // Same filter as serializeRoles: a platform-only grant is stripped on
  // the way in as well as on the way out, so a hand-edited Firestore doc
  // can't smuggle one past the editor. resolvePermissions ignores it a
  // third time — this is the boundary that must not leak.
  const permissions = Array.isArray(raw?.permissions)
    ? [...new Set(raw.permissions.filter(
        p => PERMISSION_ID_SET.has(p) && !PLATFORM_ONLY_PERMISSIONS.has(p)))]
    : [];
  return {
    id: raw.id || makeRoleId(name),
    name,
    color: raw.color || (typeof colorFor === 'function' ? colorFor(name) : '#64748b'),
    countsInRatio: typeof raw.countsInRatio === 'boolean'
      ? raw.countsInRatio
      : defaultIncludedInRatio({ role: name }),
    permissions,
    order: Number.isFinite(raw.order) ? raw.order : 99,
    builtIn: !!raw.builtIn,
  };
}

/** Find the centre role a given instructorType refers to. */
export function findRole(roles, instructorType) {
  const key = roleKey(instructorType);
  if (!key) return null;
  return (roles || []).find(r => roleKey(r.name) === key) || null;
}

// ─── Resolution ──────────────────────────────────────────────────────────

/**
 * Everything this person is allowed to do at this centre.
 *
 * baseline (platform role, minus trainee/volunteer restrictions)
 *   ∪ grants from their centre role
 *
 * @param {object} args
 * @param {string} args.platformRole    user.role
 * @param {string} args.instructorType  their per-centre title
 * @param {boolean} args.isVolunteer    per-centre volunteer flag
 * @param {Array}  args.roles           the resolved centre role registry
 * @param {string[]} [args.extraRoleNames] additional role names to draw
 *        grants from. AuthContext passes the title from
 *        `centerConfig.fixedStaff[displayName].role` here, which its
 *        isDirector() check has always honoured as a third way to be a
 *        director. Keeping it as an extra grant source preserves that
 *        exactly instead of quietly dropping a path someone may rely on.
 * @returns {Set<string>} permission ids
 */
export function resolvePermissions({
  platformRole, instructorType, isVolunteer = false, roles = [], extraRoleNames = [],
} = {}) {
  const out = new Set(PLATFORM_ROLE_PERMISSIONS[platformRole] || PLATFORM_ROLE_PERMISSIONS.instructor);

  // Grants from the centre role — and from any extra title the caller
  // supplies — on top of the platform baseline.
  for (const name of [instructorType, ...extraRoleNames]) {
    const role = findRole(roles, name);
    if (!role) continue;
    for (const p of role.permissions) {
      if (!PERMISSION_ID_SET.has(p)) continue;
      if (PLATFORM_ONLY_PERMISSIONS.has(p)) continue;   // escalation boundary
      out.add(p);
    }
  }

  // Admin-panel access always implies the operational routes. Stated once
  // here rather than re-derived at each gate.
  if (out.has('admin.panel')) out.add('admin.operations');

  // Employment-state restrictions, applied LAST so no grant can undo them.
  // See the header note — this ordering is load-bearing.
  const training = roleKey(instructorType) === 'training';
  if (isVolunteer || training) out.delete('shifts.take');
  if (isVolunteer) out.delete('chat.access');

  return out;
}

/** Convenience for call sites that hold a resolved set. */
export function can(permissions, id) {
  if (!permissions) return false;
  return permissions instanceof Set ? permissions.has(id) : (permissions || []).includes(id);
}

/**
 * The ratio default for a shift, honouring a custom role's own setting.
 *
 * This is what ties the two halves together: tick "Counts in ratio" on a
 * role you invented, and shifts created under it default to counted,
 * without anyone editing ratioCount.js. Falls straight through to the
 * built-in default when the role isn't in the registry.
 */
export function roleRatioDefault(roles, shiftLike) {
  const role = findRole(roles, shiftLike?.role);
  // LEGACY: STEAM / Summer Camp were removed and nothing writes flexRole
  // any more. Kept so an old flex shift can never be re-seeded into the
  // ratio if someone opens it in the editor.
  if (shiftLike?.flexRole) return false;
  if (role && typeof role.countsInRatio === 'boolean') return role.countsInRatio;
  return defaultIncludedInRatio(shiftLike);
}

/**
 * Validate a role about to be saved. Returns an error string, or null.
 * Name collisions are checked on the folded key, because two roles whose
 * names differ only in case or punctuation would match the same users.
 */
export function validateRole(role, allRoles) {
  const name = String(role?.name ?? '').trim();
  if (!name) return 'Give the role a name.';
  if (name.length > 40) return 'Role names are limited to 40 characters.';
  const key = roleKey(name);
  if (!key) return 'Role names need at least one letter.';
  const clash = (allRoles || []).find(r => r.id !== role.id && roleKey(r.name) === key);
  if (clash) return `"${clash.name}" already uses that name.`;
  return null;
}

/**
 * Can this role be deleted? Built-ins can't: user records and historical
 * shift documents reference them by name, and removing one would strip
 * permissions from whoever holds it and orphan the shifts.
 */
export function canDeleteRole(role) {
  return !!role && !role.builtIn;
}

/** How many people at this centre currently hold the role. */
export function roleHolderCount(role, users, centerId) {
  if (!role) return 0;
  const key = roleKey(role.name);
  let n = 0;
  for (const u of users || []) {
    const it = u?.centerMemberships?.[centerId]?.instructorType ?? u?.instructorType;
    if (roleKey(it) === key) n += 1;
  }
  return n;
}

/**
 * The flat { roleName: [permission, ...] } map the Firestore rules read.
 *
 * Written to the centre config alongside `staffRoles` on every save. The
 * rules language cannot iterate a list of maps looking for a matching
 * name, so the rich array is unreadable to it; this shape is a plain map
 * lookup, which is both possible and cheap.
 *
 * Roles with no permissions are omitted — there is nothing to grant, and
 * a smaller map is a smaller document read on every rule evaluation.
 */
export function permissionLookup(roles) {
  const out = {};
  for (const r of roles || []) {
    const granted = (r?.permissions || [])
      .filter(p => PERMISSION_ID_SET.has(p) && !PLATFORM_ONLY_PERMISSIONS.has(p));
    if (granted.length > 0 && r?.name) out[r.name] = [...new Set(granted)];
  }
  return out;
}

/** Strip a registry down to what gets stored on the centre config doc. */
export function serializeRoles(roles) {
  return (roles || []).map((r, i) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    countsInRatio: !!r.countsInRatio,
    permissions: [...new Set((r.permissions || [])
      .filter(p => PERMISSION_ID_SET.has(p) && !PLATFORM_ONLY_PERMISSIONS.has(p)))],
    order: i,
    builtIn: !!r.builtIn,
  }));
}
