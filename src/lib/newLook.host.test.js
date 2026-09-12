import { describe, it, expect } from 'vitest';
import { canUseNewLook } from './newLook';
import { resolveRoles, resolvePermissions } from './roles';
import { resolveUserForCenter } from './centerMembership';

/**
 * Rahul's ACTUAL record, copied out of Firestore: platform role
 * 'instructor', job title 'Host' at Langley. Plus Langley's real stored
 * role registry, which grants Host admin.panel — the thing most likely to
 * be mistaken for leadership.
 */
const RAHUL = {
  uid: 'u-rahul', displayName: 'Rahul Parmar', role: 'instructor',
  centerIds: ['langley'],
  centerMemberships: { langley: { instructorType: 'Host', subRoles: ['Elementary', 'Host'] } },
};

const LANGLEY_ROLES = [
  { name: 'Center Director', permissions: ['admin.panel','admin.operations','analytics.view','scheduler.run','shifts.take','chat.access','centre.settings'] },
  { name: 'Dir. of Education', permissions: ['admin.panel','admin.operations','analytics.view','scheduler.run','shifts.take','chat.access','centre.settings'] },
  { name: 'Manager', permissions: ['scheduler.run','admin.operations','chat.access'] },
  { name: 'Lead', permissions: ['scheduler.run'] },
  { name: 'Host', permissions: ['scheduler.run','admin.operations','admin.panel','analytics.view','shifts.take','chat.access'] },
  { name: 'Admin', permissions: [] },
  { name: 'Instructor', permissions: [] },
];

/** The flags AuthContext derives, reproduced from its own formulas. */
function authFor(user) {
  const role = user.role;
  const at = resolveUserForCenter(user, 'langley');
  const roles = resolveRoles({ staffRoles: LANGLEY_ROLES }, () => '#fff');
  const permissions = resolvePermissions({
    platformRole: role, instructorType: at?.instructorType, roles,
  });
  const DIRECTOR_TITLES = ['Center Director', 'Centre Director', 'Dir. of Education', 'Director of Education'];
  const isDirector = role === 'director'
    || DIRECTOR_TITLES.includes(user.instructorType)
    || DIRECTOR_TITLES.includes(at?.instructorType);
  const isOwner = role === 'owner';
  const isAdminAssistant = role === 'admin_assistant';
  const isSuperAdmin = role === 'super_admin';
  const isAdmin = role === 'admin';
  return {
    profile: user, role, isOwner, isAdminAssistant, isSuperAdmin, isAdmin, isDirector,
    isOwnerLike: isOwner || isAdminAssistant || isSuperAdmin || isDirector,
    permissions,
    canSeeAdminPanel: permissions.has('admin.panel'),
  };
}

describe('a Host and the new home', () => {
  it('is eligible — a Host is floor staff, not leadership', () => {
    expect(canUseNewLook(authFor(RAHUL))).toBe(true);
  });

  it('stays eligible even though Langley grants Host the admin panel', () => {
    // The trap: Host carries admin.panel at this centre, so anything
    // reading canSeeAdminPanel as "is leadership" would shut him out of
    // his own home page.
    const auth = authFor(RAHUL);
    expect(auth.canSeeAdminPanel).toBe(true);
    expect(canUseNewLook(auth)).toBe(true);
  });

  it('is eligible for a Manager and a Lead too', () => {
    for (const title of ['Manager', 'Lead', 'Instructor', 'Training']) {
      const u = { ...RAHUL, centerMemberships: { langley: { instructorType: title } } };
      expect(canUseNewLook(authFor(u)), title).toBe(true);
    }
  });

  it('is NOT eligible for the people who run the centre', () => {
    const cases = [
      { ...RAHUL, role: 'owner' },
      { ...RAHUL, role: 'admin' },
      { ...RAHUL, role: 'admin_assistant' },
      { ...RAHUL, role: 'director' },
      { ...RAHUL, role: 'super_admin' },
      { ...RAHUL, centerMemberships: { langley: { instructorType: 'Center Director' } } },
    ];
    for (const u of cases) expect(canUseNewLook(authFor(u))).toBe(false);
  });
});
