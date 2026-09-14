import { describe, it, expect } from 'vitest';
import {
  titleAt, isManagerOfCentre, staffCentresOf, canManageStaffAnywhere, canManageStaffAt,
  isOwnerTier, canCreateTitle, privilegeOf,
} from './staffAccess.js';

const at = (centre, title, extra = {}) => ({
  role: 'instructor', centerId: centre, centerIds: [centre], instructorType: title,
  centerMemberships: { [centre]: { instructorType: title } }, ...extra,
});

describe('who manages staff', () => {
  it('the owner tier, the old Admin role, and the centre’s Manager', () => {
    for (const role of ['super_admin', 'owner', 'director', 'admin_assistant', 'admin']) {
      expect(canManageStaffAnywhere(at('langley', 'Instructor', { role }))).toBe(true);
    }
    expect(canManageStaffAnywhere(at('langley', 'Manager'))).toBe(true);
  });

  it('not Hosts, Leads or Instructors', () => {
    for (const t of ['Host', 'Lead', 'Instructor', 'Training']) {
      expect(canManageStaffAnywhere(at('langley', t))).toBe(false);
    }
  });

  it('a Manager only at the centre they manage', () => {
    const mgr = at('langley', 'Manager');
    expect(canManageStaffAt(mgr, 'langley')).toBe(true);
    expect(canManageStaffAt(mgr, 'burnaby')).toBe(false);
    expect(staffCentresOf(mgr)).toEqual(['langley']);
  });

  it('a legacy top-level "Manager" does not reach a centre they are not in', () => {
    expect(isManagerOfCentre(at('burnaby', 'Manager'), 'langley')).toBe(false);
  });

  it('reads the title at the centre before the top-level one', () => {
    const u = { ...at('langley', 'Instructor'), centerIds: ['langley', 'burnaby'],
      centerMemberships: { langley: { instructorType: 'Instructor' }, burnaby: { instructorType: 'Manager' } } };
    expect(titleAt(u, 'burnaby')).toBe('Manager');
    expect(staffCentresOf(u)).toEqual(['burnaby']);
  });
});

describe('director accounts', () => {
  it('only the owner tier may create one', () => {
    for (const title of ['Center Director', 'Dir. of Education', 'Centre Director', 'director of education']) {
      expect(canCreateTitle(at('langley', 'Manager'), title)).toBe(false);
      expect(canCreateTitle(at('langley', 'Instructor', { role: 'admin' }), title)).toBe(false);
      expect(canCreateTitle(at('langley', 'Instructor', { role: 'owner' }), title)).toBe(true);
      expect(canCreateTitle(at('langley', 'Instructor', { role: 'director' }), title)).toBe(true);
    }
  });

  it('anyone who manages staff may create the other titles', () => {
    for (const title of ['Instructor', 'Lead', 'Host', 'Manager', 'Volunteer']) {
      expect(canCreateTitle(at('langley', 'Manager'), title)).toBe(true);
    }
    expect(isOwnerTier(at('langley', 'Manager'))).toBe(false);
  });
});

describe('privilegeOf — who can remove whom', () => {
  it('ranks a Manager with the old Admin role', () => {
    expect(privilegeOf(at('langley', 'Manager'))).toBe(2);
    expect(privilegeOf(at('langley', 'Manager', { role: 'admin' }))).toBe(2);
    expect(privilegeOf(at('langley', 'Instructor'))).toBe(1);
  });

  it('so a Manager can remove an Instructor but not another Manager or an owner', () => {
    const mgr = privilegeOf(at('langley', 'Manager'));
    expect(privilegeOf(at('langley', 'Instructor'))).toBeLessThan(mgr);
    expect(privilegeOf(at('langley', 'Manager'))).not.toBeLessThan(mgr);
    expect(privilegeOf(at('langley', 'Instructor', { role: 'owner' }))).not.toBeLessThan(mgr);
  });

  it('ranks a director by title with a director by role', () => {
    expect(privilegeOf(at('langley', 'Dir. of Education'))).toBe(3);
  });
});
