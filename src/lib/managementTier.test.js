import { describe, it, expect } from 'vitest';
import { isCentreManager, inManagementChat } from './managementTier';

const at = (centre, title, extra = {}) => ({
  role: 'instructor', centerId: centre, centerIds: [centre], instructorType: title,
  centerMemberships: { [centre]: { instructorType: title } }, ...extra,
});

describe('isCentreManager', () => {
  it('is true for the Manager of this centre, on either platform role', () => {
    expect(isCentreManager(at('langley', 'Manager'), 'langley')).toBe(true);
    expect(isCentreManager(at('langley', 'Manager', { role: 'admin' }), 'langley')).toBe(true);
  });

  it('is false at a centre they are not a member of, whatever the legacy title says', () => {
    // Mirrors isManagerOfCentre in the rules: the top-level instructorType
    // alone must not make a Burnaby Manager a Manager of Langley.
    expect(isCentreManager(at('burnaby', 'Manager'), 'langley')).toBe(false);
  });

  it('reads the title AT the centre, not the top-level one', () => {
    const u = { ...at('langley', 'Instructor'), centerIds: ['langley', 'burnaby'],
      centerMemberships: { langley: { instructorType: 'Instructor' }, burnaby: { instructorType: 'Manager' } } };
    expect(isCentreManager(u, 'burnaby')).toBe(true);
    expect(isCentreManager(u, 'langley')).toBe(false);
  });

  it('is false for Hosts, Leads, and nobody', () => {
    expect(isCentreManager(at('langley', 'Host'), 'langley')).toBe(false);
    expect(isCentreManager(at('langley', 'Lead'), 'langley')).toBe(false);
    expect(isCentreManager(null, 'langley')).toBe(false);
    expect(isCentreManager(at('langley', 'Manager'), '')).toBe(false);
  });
});

describe('inManagementChat', () => {
  it('includes owner-level staff, the legacy Admin role, and the centre’s Manager', () => {
    for (const role of ['owner', 'admin_assistant', 'director', 'admin']) {
      expect(inManagementChat(at('langley', 'Instructor', { role }), 'langley')).toBe(true);
    }
    expect(inManagementChat(at('langley', 'Manager'), 'langley')).toBe(true);
    expect(inManagementChat(at('langley', 'Dir. of Education'), 'langley')).toBe(true);
  });

  it('includes Enterprise anywhere', () => {
    expect(inManagementChat({ role: 'super_admin', centerIds: [] }, 'langley')).toBe(true);
  });

  it('leaves out Hosts, Leads, Instructors, and other centres’ staff', () => {
    expect(inManagementChat(at('langley', 'Host'), 'langley')).toBe(false);
    expect(inManagementChat(at('langley', 'Lead'), 'langley')).toBe(false);
    expect(inManagementChat(at('langley', 'Instructor'), 'langley')).toBe(false);
    expect(inManagementChat(at('burnaby', 'Manager'), 'langley')).toBe(false);
    expect(inManagementChat(at('burnaby', 'Instructor', { role: 'owner' }), 'langley')).toBe(false);
  });
});
