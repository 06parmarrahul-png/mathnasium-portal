import { describe, it, expect } from 'vitest';
import {
  grantablePermissions, resolveGrants, grantsFor, toggleGrant,
  permissionLabel, peopleWithGrants, isRedundant,
} from './individualGrants';
import { resolvePermissions, resolveRoles, can } from './roles';

const user = (over = {}) => ({ uid: 'u1', displayName: 'Ainsley Grant', ...over });
const withGrants = (centerId, grants, over = {}) =>
  user({ centerMemberships: { [centerId]: { instructorType: 'Instructor', extraPermissions: grants } }, ...over });

describe('what may be granted to one person', () => {
  it('is exactly what a centre role may grant', () => {
    const ids = grantablePermissions().map(p => p.id);
    expect(ids).toContain('scheduler.run');
    expect(ids.length).toBeGreaterThan(3);
  });

  it('never reaches the platform-only ones', () => {
    // Same escalation boundary a role has. Otherwise the Individuals tab
    // would be a way around the thing roles.js exists to prevent.
    const ids = grantablePermissions().map(p => p.id);
    expect(ids).not.toContain('roles.manage');
    expect(ids).not.toContain('district.view');
    expect(resolveGrants(['roles.manage', 'district.view'])).toEqual([]);
    expect(toggleGrant([], 'roles.manage')).toEqual([]);
  });
});

describe('reading what somebody has been given', () => {
  it('reads the grant on their membership at that centre', () => {
    expect(grantsFor(withGrants('langley', ['scheduler.run']), 'langley')).toEqual(['scheduler.run']);
  });

  it('does not follow them to another centre', () => {
    // Trusted with the scheduler at Langley is not trusted with it at
    // Burnaby, and the second centre's owner never agreed to it.
    expect(grantsFor(withGrants('langley', ['scheduler.run']), 'burnaby')).toEqual([]);
  });

  it('drops an id the registry no longer knows', () => {
    expect(grantsFor(withGrants('langley', ['scheduler.run', 'wishful.thinking']), 'langley'))
      .toEqual(['scheduler.run']);
  });

  it('copes with a person who has none, or no memberships at all', () => {
    expect(grantsFor(user(), 'langley')).toEqual([]);
    expect(grantsFor(null, 'langley')).toEqual([]);
    expect(resolveGrants('scheduler.run')).toEqual([]);
    expect(resolveGrants([null, 7])).toEqual([]);
  });
});

describe('adding and removing one', () => {
  it('toggles', () => {
    expect(toggleGrant([], 'scheduler.run')).toEqual(['scheduler.run']);
    expect(toggleGrant(['scheduler.run'], 'scheduler.run')).toEqual([]);
  });

  it('never lists the same one twice', () => {
    expect(toggleGrant(['scheduler.run', 'scheduler.run'], 'chat.access'))
      .toEqual(['scheduler.run', 'chat.access']);
  });
});

describe('what the screen says', () => {
  it('names a permission the way the role editor names it', () => {
    expect(permissionLabel('scheduler.run')).not.toBe('scheduler.run');
    expect(permissionLabel('nonsense')).toBe('nonsense');
  });

  it('lists everyone carrying a grant, by name', () => {
    const rows = peopleWithGrants([
      withGrants('langley', ['scheduler.run'], { displayName: 'Kaitlyn MacDonald' }),
      user({ displayName: 'Nobody Special' }),
      withGrants('langley', ['scheduler.run'], { displayName: 'Ainsley Grant' }),
    ], 'langley');
    expect(rows.map(r => r.user.displayName)).toEqual(['Ainsley Grant', 'Kaitlyn MacDonald']);
  });

  it('spots a grant the title already covers', () => {
    // Not wrong, but it looks like the reason they have the access when
    // it isn't — removing it would change nothing.
    expect(isRedundant('scheduler.run', new Set(['scheduler.run']))).toBe(true);
    expect(isRedundant('scheduler.run', new Set(['chat.access']))).toBe(false);
    expect(isRedundant('scheduler.run', null)).toBe(false);
  });
});

describe('what a grant actually does to somebody', () => {
  const ROLES = resolveRoles({}, () => '#999');
  const resolve = (extraPermissions, over = {}) => resolvePermissions({
    platformRole: 'instructor', instructorType: 'Instructor', roles: ROLES, extraPermissions, ...over,
  });

  it('gives an instructor the Student Scheduler without touching the role', () => {
    expect(can(resolve([]), 'scheduler.run')).toBe(false);
    expect(can(resolve(['scheduler.run']), 'scheduler.run')).toBe(true);
    // Everyone else with that title is unchanged — the grant is on the
    // person, and this is the same registry.
    expect(can(resolve([]), 'scheduler.run')).toBe(false);
  });

  it('adds only, never takes away', () => {
    const base = resolve([]);
    const granted = resolve(['scheduler.run']);
    for (const p of base) expect(granted.has(p)).toBe(true);
  });

  it('cannot hand over a platform-only permission', () => {
    expect(can(resolve(['roles.manage']), 'roles.manage')).toBe(false);
    expect(can(resolve(['district.view']), 'district.view')).toBe(false);
  });

  it('loses to the employment-state rules, which still run last', () => {
    // A volunteer cannot be granted onto a shift. Those rules are applied
    // after every grant for exactly this reason.
    const volunteer = resolve(['shifts.take'], { isVolunteer: true });
    expect(can(volunteer, 'shifts.take')).toBe(false);
    const trainee = resolve(['shifts.take'], { instructorType: 'Training' });
    expect(can(trainee, 'shifts.take')).toBe(false);
  });

  it('still pulls admin.operations along with admin.panel', () => {
    expect(can(resolve(['admin.panel']), 'admin.operations')).toBe(true);
  });
});
