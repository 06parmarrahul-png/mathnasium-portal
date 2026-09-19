import { describe, it, expect } from 'vitest';
import { newLookHomeFor } from './newLook';
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
  // Same per-centre-then-legacy pattern AuthContext uses for the title.
  const isManager = user.instructorType === 'Manager' || at?.instructorType === 'Manager';
  return {
    profile: user, role, isOwner, isAdminAssistant, isSuperAdmin, isAdmin, isDirector, isManager,
    isOwnerLike: isOwner || isAdminAssistant || isSuperAdmin || isDirector,
    permissions,
    canSeeAdminPanel: permissions.has('admin.panel'),
  };
}

describe('a Host and the two homes', () => {
  it('sends a Host to the floor home — a Host is floor staff', () => {
    expect(newLookHomeFor(authFor(RAHUL))).toBe('floor');
  });

  it('still does, though Langley grants Host the admin panel', () => {
    // The trap: Host carries admin.panel at this centre, so anything
    // reading canSeeAdminPanel as "is leadership" would hand him the
    // board instead of his own shifts.
    const auth = authFor(RAHUL);
    expect(auth.canSeeAdminPanel).toBe(true);
    expect(newLookHomeFor(auth)).toBe('floor');
  });

  it('sends a Lead, an Instructor and a Trainee to the floor home too', () => {
    for (const title of ['Lead', 'Instructor', 'Training']) {
      const u = { ...RAHUL, centerMemberships: { langley: { instructorType: title } } };
      expect(newLookHomeFor(authFor(u)), title).toBe('floor');
    }
  });

  it('sends a Manager to the board, on the title alone', () => {
    const u = { ...RAHUL, centerMemberships: { langley: { instructorType: 'Manager' } } };
    expect(newLookHomeFor(authFor(u))).toBe('leadership');
  });

  it('sends everyone who runs the centre to the board', () => {
    const cases = [
      { ...RAHUL, role: 'owner' },
      { ...RAHUL, role: 'admin' },
      { ...RAHUL, role: 'admin_assistant' },
      { ...RAHUL, role: 'director' },
      { ...RAHUL, role: 'super_admin' },
      { ...RAHUL, centerMemberships: { langley: { instructorType: 'Center Director' } } },
    ];
    for (const u of cases) expect(newLookHomeFor(authFor(u))).toBe('leadership');
  });
});
