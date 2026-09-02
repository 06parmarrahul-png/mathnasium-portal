import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_IDS,
  PLATFORM_ONLY_PERMISSIONS,
  assignablePermissions,
  PLATFORM_ROLES,
  PLATFORM_ROLE_PERMISSIONS,
  permissionGroups,
  permissionLabel,
  roleKey,
  makeRoleId,
  builtInRoles,
  resolveRoles,
  normalizeRole,
  findRole,
  resolvePermissions,
  can,
  roleRatioDefault,
  validateRole,
  canDeleteRole,
  roleHolderCount,
  serializeRoles,
  permissionLookup,
} from './roles';

const ROLES = builtInRoles(() => '#000000');
const perms = (over = {}) => resolvePermissions({ roles: ROLES, ...over });

// ════════════════════════════════════════════════════════════════════════
// THE EQUIVALENCE SUITE
//
// This is the test that matters. The permission model replaces a pile of
// hardcoded role comparisons in AuthContext.jsx and ProtectedRoute.jsx.
// Below are those original formulas, copied verbatim, and every
// (platform role × centre title × volunteer) combination is checked to
// produce the same answer through the new path.
//
// If this suite passes, nobody's access changed.
// ════════════════════════════════════════════════════════════════════════

const DIRECTOR_TITLES = new Set([
  'Center Director', 'Centre Director', 'Dir. of Education', 'Director of Education',
]);

// --- Verbatim from the code being replaced -----------------------------
const legacy = ({ platformRole: role, instructorType: it, isVolunteer }) => {
  const isSuperAdmin     = role === 'super_admin';
  const isOwner          = role === 'owner';
  const isAdminAssistant = role === 'admin_assistant';
  const isAdmin          = role === 'admin';
  // AuthContext's isDirector(): role === 'director' OR a director title.
  const isDirector       = role === 'director' || DIRECTOR_TITLES.has(it);
  const isLead           = it === 'Lead';
  const isManager        = it === 'Manager';
  const isHost           = it === 'Host';
  const isTraining       = it === 'Training';

  const canSeeAdminPanel     = isSuperAdmin || isOwner || isAdminAssistant || isAdmin || isDirector;
  const canSeeCenterSettings = isSuperAdmin || isOwner || isAdminAssistant || isDirector;
  const canRunScheduler      = canSeeAdminPanel || isLead || isManager || isHost;
  const canManageOperations  = canSeeAdminPanel || isManager || isHost;
  const canTakeShifts        = !isVolunteer && !isTraining;

  return {
    canSeeAdminPanel,
    canSeeCenterSettings,
    canRunScheduler,
    canManageOperations,
    canTakeShifts,
    canUseChat:     !isVolunteer,
    canViewAnalytics: canSeeAdminPanel,
    canManageRoles: isSuperAdmin,
  };
};
// -----------------------------------------------------------------------

const modern = (input) => {
  const p = resolvePermissions({ ...input, roles: ROLES });
  return {
    canSeeAdminPanel:     p.has('admin.panel'),
    canSeeCenterSettings: p.has('centre.settings'),
    canRunScheduler:      p.has('scheduler.run'),
    canManageOperations:  p.has('admin.operations'),
    canTakeShifts:        p.has('shifts.take'),
    canUseChat:           p.has('chat.access'),
    canViewAnalytics:     p.has('analytics.view'),
    canManageRoles:       p.has('roles.manage'),
  };
};

const ALL_TITLES = [
  'Instructor', 'Lead', 'Host', 'Admin', 'Manager',
  'Center Director', 'Dir. of Education', 'Training', 'Volunteer', 'Owner',
  '', undefined, 'Some Invented Title',
];

describe('equivalence: the new permission model reproduces the old role checks', () => {
  const cases = [];
  for (const platformRole of PLATFORM_ROLES) {
    for (const instructorType of ALL_TITLES) {
      for (const isVolunteer of [false, true]) {
        cases.push([platformRole, String(instructorType), isVolunteer]);
      }
    }
  }

  it(`covers every combination (${PLATFORM_ROLES.length} roles × ${ALL_TITLES.length} titles × 2)`, () => {
    expect(cases.length).toBe(PLATFORM_ROLES.length * ALL_TITLES.length * 2);
  });

  it.each(cases)('role=%s title=%s volunteer=%s', (platformRole, instructorType, isVolunteer) => {
    const input = { platformRole, instructorType, isVolunteer };
    expect(modern(input)).toEqual(legacy(input));
  });
});

// Every real person at Langley, read from live Firestore, so the suite
// speaks about actual accounts rather than only synthetic combinations.
describe('equivalence on the real Langley roster', () => {
  const ROSTER = [
    ['Ratio',                  'super_admin',     'instructor',        false],
    ['Test Owner',             'owner',           'Instructor',        false],
    ['Andy. Y',                'owner',           'Instructor',        false],
    ['Vin B',                  'director',        'Center Director',   false],
    ['Neeru Gill',             'director',        'Dir. of Education', false],
    ['Rachel Rozelle',         'admin_assistant', 'Admin',             false],
    ['Admin Team',             'admin',           'Instructor',        false],
    ['Sabrina Kedzior',        'admin',           'Manager',           false],
    ['Rahul Parmar',           'instructor',      'Host',              false],
    ['Dev Prasad',             'instructor',      'Lead',              false],
    ['Bri MacDonald',          'instructor',      'Lead',              false],
    ['Krishnaja Tikkisetty',   'instructor',      'Lead',              false],
    ['Georgette Shami',        'instructor',      'Lead',              false],
    ['Anthony Fung',           'instructor',      'Training',          false],
    ['Idan Kanevsky',          'instructor',      'Training',          false],
    ['Mateo Yngreso',          'instructor',      'Volunteer',         true],
    ['Jenna Chiu',             'instructor',      'Volunteer',         true],
  ];

  it.each(ROSTER)('%s keeps exactly the access they have today', (_name, platformRole, instructorType, isVolunteer) => {
    const input = { platformRole, instructorType, isVolunteer };
    expect(modern(input)).toEqual(legacy(input));
  });

  it('Sabrina (admin + Manager) reaches the admin panel and the scheduler', () => {
    const p = perms({ platformRole: 'admin', instructorType: 'Manager' });
    expect(can(p, 'admin.panel')).toBe(true);
    expect(can(p, 'scheduler.run')).toBe(true);
    expect(can(p, 'centre.settings')).toBe(false);
  });

  it('Rahul (instructor + Host) runs the floor without the admin panel', () => {
    const p = perms({ platformRole: 'instructor', instructorType: 'Host' });
    expect(can(p, 'scheduler.run')).toBe(true);
    expect(can(p, 'admin.operations')).toBe(true);
    expect(can(p, 'admin.panel')).toBe(false);
    expect(can(p, 'centre.settings')).toBe(false);
  });

  it('a Lead runs the scheduler but not operations', () => {
    const p = perms({ platformRole: 'instructor', instructorType: 'Lead' });
    expect(can(p, 'scheduler.run')).toBe(true);
    expect(can(p, 'admin.operations')).toBe(false);
  });

  it('a trainee cannot claim shifts but keeps chat', () => {
    const p = perms({ platformRole: 'instructor', instructorType: 'Training' });
    expect(can(p, 'shifts.take')).toBe(false);
    expect(can(p, 'chat.access')).toBe(true);
  });

  it('a volunteer has neither shift claiming nor chat', () => {
    const p = perms({ platformRole: 'instructor', instructorType: 'Volunteer', isVolunteer: true });
    expect(can(p, 'shifts.take')).toBe(false);
    expect(can(p, 'chat.access')).toBe(false);
  });

  it('only Enterprise can manage roles', () => {
    for (const r of PLATFORM_ROLES) {
      expect(can(perms({ platformRole: r }), 'roles.manage')).toBe(r === 'super_admin');
    }
  });
});

describe('resolvePermissions', () => {
  it('treats an unknown platform role as a plain instructor', () => {
    const p = perms({ platformRole: 'not_a_real_role' });
    expect(can(p, 'admin.panel')).toBe(false);
    expect(can(p, 'shifts.take')).toBe(true);
  });

  it('handles no arguments at all without throwing', () => {
    const p = resolvePermissions();
    expect(can(p, 'admin.panel')).toBe(false);
    expect(can(p, 'chat.access')).toBe(true);
  });

  it('admin panel access always implies operations', () => {
    for (const r of PLATFORM_ROLES) {
      const p = perms({ platformRole: r });
      if (p.has('admin.panel')) expect(p.has('admin.operations')).toBe(true);
    }
  });

  it('matches the centre role regardless of casing or punctuation', () => {
    for (const spelling of ['Lead', 'lead', '  LEAD  ', 'Lead.']) {
      expect(can(perms({ platformRole: 'instructor', instructorType: spelling }), 'scheduler.run')).toBe(true);
    }
  });

  it('ignores permission ids that are not in the catalogue', () => {
    const roles = [{ id: 'x', name: 'Weird', permissions: ['admin.panel', 'delete.everything'], builtIn: false }];
    const p = resolvePermissions({ platformRole: 'instructor', instructorType: 'Weird', roles });
    expect(p.has('admin.panel')).toBe(true);
    expect(p.has('delete.everything')).toBe(false);
  });
});

describe('permissions are additive — a centre role can only grant', () => {
  // The core safety property. A custom role with NO permissions must never
  // reduce what the platform role already allows, or a bad edit could lock
  // an owner out of their own centre.
  it('an empty custom role never reduces the platform baseline', () => {
    const roles = [...ROLES, { id: 'nothing', name: 'Nothing', permissions: [], builtIn: false }];
    for (const platformRole of PLATFORM_ROLES) {
      const base = resolvePermissions({ platformRole, roles: ROLES });
      const withRole = resolvePermissions({ platformRole, instructorType: 'Nothing', roles });
      for (const id of base) expect(withRole.has(id)).toBe(true);
    }
  });

  it('deleting every custom role leaves the platform baseline intact', () => {
    for (const platformRole of PLATFORM_ROLES) {
      const base = resolvePermissions({ platformRole, roles: ROLES });
      const orphaned = resolvePermissions({ platformRole, instructorType: 'A Role That No Longer Exists', roles: [] });
      for (const id of base) expect(orphaned.has(id)).toBe(true);
    }
  });

  it('grants a custom role on top of an instructor baseline', () => {
    const roles = [...ROLES, {
      id: 'assistant-lead', name: 'Assistant Lead',
      permissions: ['scheduler.run', 'admin.operations'], builtIn: false,
    }];
    const p = resolvePermissions({ platformRole: 'instructor', instructorType: 'Assistant Lead', roles });
    expect(p.has('scheduler.run')).toBe(true);
    expect(p.has('admin.operations')).toBe(true);
    expect(p.has('admin.panel')).toBe(false);      // not granted, not implied
    expect(p.has('centre.settings')).toBe(false);
  });
});

describe('the registry', () => {
  it('falls back to the built-ins when a centre has never customised', () => {
    expect(resolveRoles(null, () => '#fff').map(r => r.name))
      .toEqual(builtInRoles(() => '#fff').map(r => r.name));
    expect(resolveRoles({}, () => '#fff').length).toBe(ROLES.length);
    expect(resolveRoles({ staffRoles: [] }, () => '#fff').length).toBe(ROLES.length);
  });

  it('merges a stored role over its built-in without losing the others', () => {
    const out = resolveRoles({
      staffRoles: [{ id: 'lead', name: 'Lead', color: '#ff0000', permissions: ['admin.panel'], order: 0 }],
    }, () => '#fff');
    expect(out.length).toBe(ROLES.length);
    const lead = out.find(r => r.name === 'Lead');
    expect(lead.color).toBe('#ff0000');
    expect(lead.permissions).toEqual(['admin.panel']);
    expect(lead.builtIn).toBe(true);              // still undeletable
    expect(out.find(r => r.name === 'Host')).toBeTruthy();
  });

  it('keeps a built-in even if the stored array dropped it', () => {
    const out = resolveRoles({ staffRoles: [{ id: 'lead', name: 'Lead', permissions: [] }] }, () => '#fff');
    expect(out.find(r => r.name === 'Manager')).toBeTruthy();
    expect(out.find(r => r.name === 'Volunteer')).toBeTruthy();
  });

  it('appends genuinely new custom roles', () => {
    const out = resolveRoles({
      staffRoles: [{ id: 'marketing', name: 'Marketing', permissions: ['analytics.view'], order: 50 }],
    }, () => '#fff');
    const m = out.find(r => r.name === 'Marketing');
    expect(m).toBeTruthy();
    expect(m.builtIn).toBe(false);
    expect(canDeleteRole(m)).toBe(true);
  });

  it('never marks a built-in deletable', () => {
    for (const r of ROLES) expect(canDeleteRole(r)).toBe(false);
  });

  // The editor always writes the WHOLE list back through serializeRoles,
  // which renumbers order sequentially — so this exercises the real path
  // rather than a hand-built partial array whose order values would tie
  // with the built-ins that are always merged in.
  it('respects a reordering saved from the editor', () => {
    const reversed = serializeRoles([...ROLES].reverse());
    const out = resolveRoles({ staffRoles: reversed }, () => '#fff');
    expect(out.map(r => r.name)).toEqual([...ROLES].reverse().map(r => r.name));
  });

  it('places a new custom role by its stored order', () => {
    const withNew = serializeRoles([
      { id: 'marketing', name: 'Marketing', color: '#fff', countsInRatio: false, permissions: [], builtIn: false },
      ...ROLES,
    ]);
    const out = resolveRoles({ staffRoles: withNew }, () => '#fff');
    expect(out[0].name).toBe('Marketing');
  });

  it('survives junk in the stored array', () => {
    const out = resolveRoles({
      staffRoles: [null, {}, { name: '   ' }, { name: 'Good', permissions: 'nope' }],
    }, () => '#fff');
    const good = out.find(r => r.name === 'Good');
    expect(good.permissions).toEqual([]);
    expect(out.length).toBe(ROLES.length + 1);
  });
});

describe('normalizeRole', () => {
  it('rejects an entry with no usable name', () => {
    expect(normalizeRole({ name: '' })).toBe(null);
    expect(normalizeRole({})).toBe(null);
    expect(normalizeRole(null)).toBe(null);
  });

  it('drops permissions that are not in the catalogue', () => {
    expect(normalizeRole({ name: 'X', permissions: ['chat.access', 'nope'] }).permissions)
      .toEqual(['chat.access']);
  });

  it('de-duplicates permissions', () => {
    expect(normalizeRole({ name: 'X', permissions: ['chat.access', 'chat.access'] }).permissions)
      .toEqual(['chat.access']);
  });

  it('derives countsInRatio from the name when not stored', () => {
    expect(normalizeRole({ name: 'Lead' }).countsInRatio).toBe(true);
    expect(normalizeRole({ name: 'Host' }).countsInRatio).toBe(false);
    expect(normalizeRole({ name: 'Host', countsInRatio: true }).countsInRatio).toBe(true);
  });
});

describe('validateRole', () => {
  it('requires a name', () => {
    expect(validateRole({ name: '' }, ROLES)).toBeTruthy();
    expect(validateRole({ name: '   ' }, ROLES)).toBeTruthy();
  });

  it('requires at least one letter', () => {
    expect(validateRole({ id: 'n', name: '123' }, ROLES)).toBeTruthy();
  });

  it('caps the length', () => {
    expect(validateRole({ id: 'n', name: 'x'.repeat(41) }, ROLES)).toBeTruthy();
    expect(validateRole({ id: 'n', name: 'x'.repeat(40) }, ROLES)).toBe(null);
  });

  // Two roles whose names fold to the same key would match the same
  // users, so one of them would silently never apply.
  it('rejects a name that collides once folded', () => {
    expect(validateRole({ id: 'new', name: 'lead' }, ROLES)).toMatch(/already uses/);
    expect(validateRole({ id: 'new', name: '  LEAD ' }, ROLES)).toMatch(/already uses/);
  });

  it('lets a role keep its own name', () => {
    const lead = ROLES.find(r => r.name === 'Lead');
    expect(validateRole(lead, ROLES)).toBe(null);
  });

  it('accepts a genuinely new name', () => {
    expect(validateRole({ id: 'new', name: 'Assistant Lead' }, ROLES)).toBe(null);
  });
});

describe('roleRatioDefault — the tie-in to the shift toggle', () => {
  it('uses a custom role\'s own setting', () => {
    const roles = [...ROLES, { id: 'al', name: 'Assistant Lead', permissions: [], countsInRatio: true }];
    expect(roleRatioDefault(roles, { role: 'Assistant Lead' })).toBe(true);
    const off = [...ROLES, { id: 'mk', name: 'Marketing', permissions: [], countsInRatio: false }];
    expect(roleRatioDefault(off, { role: 'Marketing' })).toBe(false);
  });

  it('lets a centre flip a built-in — a Host that does count', () => {
    const roles = resolveRoles({
      staffRoles: [{ id: 'host', name: 'Host', permissions: [], countsInRatio: true }],
    }, () => '#fff');
    expect(roleRatioDefault(roles, { role: 'Host' })).toBe(true);
  });

  it('a flex shift is never counted, whatever the role says', () => {
    const roles = [...ROLES, { id: 'al', name: 'Assistant Lead', permissions: [], countsInRatio: true }];
    expect(roleRatioDefault(roles, { role: 'Assistant Lead', flexRole: 'STEAM' })).toBe(false);
  });

  it('falls through to the built-in default for an unknown role', () => {
    expect(roleRatioDefault(ROLES, { role: 'Instructor' })).toBe(true);
    expect(roleRatioDefault([], { role: 'Instructor' })).toBe(true);
    expect(roleRatioDefault([], { role: 'Host' })).toBe(false);
  });
});

describe('helpers', () => {
  it('roleKey folds casing, spacing and punctuation', () => {
    expect(roleKey('Dir. of Education')).toBe(roleKey('dir of education'));
    expect(roleKey('  Lead  ')).toBe('lead');
    expect(roleKey(null)).toBe('');
  });

  it('makeRoleId produces a slug and avoids collisions', () => {
    expect(makeRoleId('Assistant Lead')).toBe('assistant-lead');
    expect(makeRoleId('Assistant Lead', [{ id: 'assistant-lead' }])).toBe('assistant-lead-2');
    expect(makeRoleId('!!!')).toBe('role');
  });

  it('findRole matches on the folded key', () => {
    expect(findRole(ROLES, 'lead').name).toBe('Lead');
    expect(findRole(ROLES, 'Nope')).toBe(null);
    expect(findRole(ROLES, '')).toBe(null);
  });

  it('can() accepts a Set or an array', () => {
    expect(can(new Set(['a']), 'a')).toBe(true);
    expect(can(['a'], 'a')).toBe(true);
    expect(can(null, 'a')).toBe(false);
  });

  it('roleHolderCount reads the per-centre membership first', () => {
    const users = [
      { centerMemberships: { langley: { instructorType: 'Lead' } }, instructorType: 'Instructor' },
      { instructorType: 'Lead' },
      { centerMemberships: { other: { instructorType: 'Lead' } }, instructorType: 'Host' },
    ];
    expect(roleHolderCount({ name: 'Lead' }, users, 'langley')).toBe(2);
    expect(roleHolderCount({ name: 'Host' }, users, 'langley')).toBe(1);
    expect(roleHolderCount(null, users, 'langley')).toBe(0);
  });

  it('serializeRoles writes a clean, re-orderable array', () => {
    const out = serializeRoles([
      { id: 'a', name: 'A', color: '#111', countsInRatio: true, permissions: ['chat.access', 'bogus'], builtIn: true },
      { id: 'b', name: 'B', color: '#222', countsInRatio: false, permissions: [], builtIn: false },
    ]);
    expect(out[0].order).toBe(0);
    expect(out[1].order).toBe(1);
    expect(out[0].permissions).toEqual(['chat.access']);
    expect(out[0].builtIn).toBe(true);
    expect(out[1].builtIn).toBe(false);
  });

  it('a serialize → resolve round trip is stable', () => {
    const once = serializeRoles(ROLES);
    const back = resolveRoles({ staffRoles: once }, () => '#000000');
    expect(back.map(r => r.name)).toEqual(ROLES.map(r => r.name));
    expect(back.map(r => r.permissions)).toEqual(ROLES.map(r => r.permissions));
  });
});

describe('the permission catalogue', () => {
  it('has unique ids', () => {
    expect(new Set(PERMISSION_IDS).size).toBe(PERMISSION_IDS.length);
  });

  it('gives every permission a label, description and group', () => {
    for (const p of PERMISSIONS) {
      expect(p.label).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.group).toBeTruthy();
    }
  });

  it('groups every assignable permission, and only those', () => {
    const total = permissionGroups().reduce((n, g) => n + g.permissions.length, 0);
    expect(total).toBe(assignablePermissions().length);
    const grouped = permissionGroups().flatMap(g => g.permissions.map(p => p.id));
    for (const id of PLATFORM_ONLY_PERMISSIONS) expect(grouped).not.toContain(id);
  });

  it('labels a known id and passes an unknown one through', () => {
    expect(permissionLabel('admin.panel')).toBe('Open the Admin Panel');
    expect(permissionLabel('nope')).toBe('nope');
  });

  it('every platform role grants only catalogued permissions', () => {
    for (const [, list] of Object.entries(PLATFORM_ROLE_PERMISSIONS)) {
      for (const id of list) expect(PERMISSION_IDS).toContain(id);
    }
  });

  it('every built-in role grants only catalogued permissions', () => {
    for (const r of ROLES) {
      for (const id of r.permissions) expect(PERMISSION_IDS).toContain(id);
    }
  });
});

describe('employment state beats every grant', () => {
  // Regression: these restrictions used to be applied to the baseline,
  // before grants, so a role that granted shifts.take / chat.access handed
  // them straight back. Twelve equivalence combinations failed on it.
  const withGenerousRole = [
    ...ROLES,
    { id: 'generous', name: 'Generous', permissions: ['shifts.take', 'chat.access'], builtIn: false },
  ];

  it('a volunteer cannot be granted shift claiming or chat by a role', () => {
    const p = resolvePermissions({
      platformRole: 'owner', instructorType: 'Generous', isVolunteer: true, roles: withGenerousRole,
    });
    expect(p.has('shifts.take')).toBe(false);
    expect(p.has('chat.access')).toBe(false);
  });

  it('a trainee cannot be granted shift claiming by a role', () => {
    const roles = [...ROLES.filter(r => r.name !== 'Training'), {
      id: 'training', name: 'Training', permissions: ['shifts.take'], builtIn: true,
    }];
    const p = resolvePermissions({ platformRole: 'instructor', instructorType: 'Training', roles });
    expect(p.has('shifts.take')).toBe(false);
  });

  it('a director-titled volunteer still loses both, at every platform role', () => {
    for (const platformRole of PLATFORM_ROLES) {
      const p = resolvePermissions({
        platformRole, instructorType: 'Center Director', isVolunteer: true, roles: ROLES,
      });
      expect(p.has('shifts.take')).toBe(false);
      expect(p.has('chat.access')).toBe(false);
    }
  });
});

// The privilege-escalation boundary. The role editor is open to centre
// directors, not just Enterprise, so a centre role must never be able to
// hand out platform-level power — including to the person editing it.
describe('a centre role cannot grant platform-only permissions', () => {
  it.each([...PLATFORM_ONLY_PERMISSIONS])('ignores a stored grant of %s', (id) => {
    const roles = [{ id: 'sneaky', name: 'Sneaky', permissions: [id], builtIn: false }];
    for (const platformRole of PLATFORM_ROLES) {
      const p = resolvePermissions({ platformRole, instructorType: 'Sneaky', roles });
      // Only the platform role itself can confer it.
      expect(p.has(id)).toBe((PLATFORM_ROLE_PERMISSIONS[platformRole] || []).includes(id));
    }
  });

  it('a director cannot invent a role that makes them Enterprise', () => {
    const roles = [{ id: 'x', name: 'Super', permissions: ['roles.manage'], builtIn: false }];
    const p = resolvePermissions({ platformRole: 'director', instructorType: 'Super', roles });
    expect(p.has('roles.manage')).toBe(false);
  });

  it('strips the grant on save so it never even persists', () => {
    const out = serializeRoles([
      { id: 'x', name: 'X', permissions: ['roles.manage', 'admin.panel'], builtIn: false },
    ]);
    expect(out[0].permissions).toEqual(['admin.panel']);
  });

  it('strips it when normalising a stored entry too', () => {
    expect(normalizeRole({ name: 'X', permissions: ['roles.manage', 'chat.access'] }).permissions)
      .toEqual(['chat.access']);
  });

  it('the editor never offers it', () => {
    const offered = assignablePermissions().map(p => p.id);
    for (const id of PLATFORM_ONLY_PERMISSIONS) expect(offered).not.toContain(id);
    expect(offered.length).toBe(PERMISSIONS.length - PLATFORM_ONLY_PERMISSIONS.size);
  });
});

// The registry is stored twice: the rich array for the editor, and a flat
// map for the Firestore rules, which cannot iterate a list of maps. These
// must agree, or a permission granted in the UI silently does nothing on
// the server.
describe('permissionLookup — the shape the security rules read', () => {
  it('maps role name to its granted permissions', () => {
    expect(permissionLookup([
      { name: 'Ops Lead', permissions: ['admin.operations'] },
      { name: 'Floor Coach', permissions: ['scheduler.run', 'chat.access'] },
    ])).toEqual({
      'Ops Lead': ['admin.operations'],
      'Floor Coach': ['scheduler.run', 'chat.access'],
    });
  });

  it('omits roles that grant nothing, to keep the rules read small', () => {
    expect(permissionLookup([
      { name: 'Instructor', permissions: [] },
      { name: 'Ops Lead', permissions: ['admin.operations'] },
    ])).toEqual({ 'Ops Lead': ['admin.operations'] });
  });

  it('never exposes a platform-only permission to the rules', () => {
    expect(permissionLookup([{ name: 'X', permissions: ['roles.manage'] }])).toEqual({});
    expect(permissionLookup([{ name: 'X', permissions: ['roles.manage', 'chat.access'] }]))
      .toEqual({ X: ['chat.access'] });
  });

  it('drops uncatalogued ids and de-duplicates', () => {
    expect(permissionLookup([{ name: 'X', permissions: ['chat.access', 'chat.access', 'bogus'] }]))
      .toEqual({ X: ['chat.access'] });
  });

  it('survives junk', () => {
    expect(permissionLookup(null)).toEqual({});
    expect(permissionLookup([null, {}, { permissions: ['chat.access'] }])).toEqual({});
  });

  // The property that matters: the map the rules read must carry exactly
  // the role's stored grants, and the client must honour every one of
  // them. If these drift, a permission ticked in the editor works on one
  // side of the wire and not the other — the failure mode this whole
  // two-shape arrangement exists to avoid.
  const CUSTOM = [
    { id: 'ops', name: 'Ops Lead', color: '#fff', countsInRatio: true, permissions: ['admin.operations'], builtIn: false },
    { id: 'coach', name: 'Floor Coach', color: '#fff', countsInRatio: true, permissions: ['scheduler.run'], builtIn: false },
  ];

  it('carries exactly each role\'s stored grants', () => {
    const roles = serializeRoles([...ROLES, ...CUSTOM]);
    const lookup = permissionLookup(roles);
    for (const r of roles) {
      expect((lookup[r.name] || []).slice().sort()).toEqual([...r.permissions].sort());
    }
  });

  it('and the client honours every permission the rules would grant', () => {
    const roles = serializeRoles([...ROLES, ...CUSTOM]);
    const lookup = permissionLookup(roles);
    for (const [name, granted] of Object.entries(lookup)) {
      // A holder with no employment-state restrictions, so nothing is
      // stripped after the grant and the comparison is apples to apples.
      const client = resolvePermissions({ platformRole: 'instructor', instructorType: name, roles });
      for (const id of granted) expect(client.has(id)).toBe(true);
    }
  });
});

describe('Owner is not a centre role', () => {
  // It is what signup stamps on the first account at a new centre, not a
  // job title anyone assigns. Listing it in the editor invited someone to
  // give "Owner" permissions the platform role already grants.
  it('is absent from the registry', () => {
    expect(ROLES.map(r => r.name)).not.toContain('Owner');
    expect(resolveRoles(null, () => '#fff').map(r => r.name)).not.toContain('Owner');
  });

  // An account still carrying the title must be unaffected: it simply has
  // no centre role, so its access comes from its platform role alone.
  it('an account still holding the title keeps exactly its platform access', () => {
    for (const platformRole of PLATFORM_ROLES) {
      const withTitle = resolvePermissions({ platformRole, instructorType: 'Owner', roles: ROLES });
      const without   = resolvePermissions({ platformRole, roles: ROLES });
      expect([...withTitle].sort()).toEqual([...without].sort());
    }
  });
});

describe('the retired flex tag still beats a role default', () => {
  // A centre could create a role called "STEAM" that counts in ratio.
  // A HISTORICAL shift carrying the old flexRole tag must still not
  // count, or past coverage changes under them.
  it('an old flex shift stays out even when its role counts', () => {
    const roles = [...ROLES, { id: 'steam', name: 'STEAM', permissions: [], countsInRatio: true }];
    expect(roleRatioDefault(roles, { role: 'STEAM' })).toBe(true);
    expect(roleRatioDefault(roles, { role: 'STEAM', flexRole: 'STEAM' })).toBe(false);
  });

  // The replacement path the removal assumes: re-create it as a role.
  it('a replacement STEAM role behaves the way the flex tag used to', () => {
    const roles = [...ROLES, { id: 'steam', name: 'STEAM', permissions: [], countsInRatio: false }];
    expect(roleRatioDefault(roles, { role: 'STEAM' })).toBe(false);
    // ...and grants nothing extra, so it is purely a scheduling label.
    const p = resolvePermissions({ platformRole: 'instructor', instructorType: 'STEAM', roles });
    const base = resolvePermissions({ platformRole: 'instructor', roles: [] });
    expect([...p].sort()).toEqual([...base].sort());
  });
});
