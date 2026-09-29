import { describe, it, expect } from 'vitest';
import { isCentreStaff, onlyCentreStaff, NON_STAFF_PLATFORM_ROLES } from './centreStaff';

describe('who counts as staff at a centre', () => {
  it('counts the people who work there', () => {
    for (const role of ['instructor', 'admin', 'owner', 'director', 'admin_assistant']) {
      expect(isCentreStaff({ role }), role).toBe(true);
    }
  });

  it('leaves out the platform operator, as it always has', () => {
    expect(isCentreStaff({ role: 'super_admin' })).toBe(false);
  });

  it('leaves out a district manager, who is employed by no centre', () => {
    // They carry centerIds for every centre in their district, so without
    // this they would be counted as a member of staff at each one — on
    // their own roll-up, among other places.
    expect(isCentreStaff({ role: 'district_manager' })).toBe(false);
  });

  it('treats a missing role as ordinary staff', () => {
    // Legacy docs predate the role field; they are instructors.
    expect(isCentreStaff({})).toBe(true);
    expect(isCentreStaff({ role: null })).toBe(true);
  });

  it('is false for nothing at all', () => {
    expect(isCentreStaff(null)).toBe(false);
    expect(isCentreStaff(undefined)).toBe(false);
  });

  it('filters a list without reordering it', () => {
    const list = [
      { uid: 'a', role: 'instructor' },
      { uid: 'b', role: 'district_manager' },
      { uid: 'c', role: 'super_admin' },
      { uid: 'd', role: 'owner' },
    ];
    expect(onlyCentreStaff(list).map(u => u.uid)).toEqual(['a', 'd']);
    expect(onlyCentreStaff(null)).toEqual([]);
  });

  it('names both non-staff roles in one place', () => {
    expect([...NON_STAFF_PLATFORM_ROLES].sort()).toEqual(['district_manager', 'super_admin']);
  });
});
