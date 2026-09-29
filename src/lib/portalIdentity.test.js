import { describe, it, expect } from 'vitest';
import {
  centreDisplayName, portalSubtitle, STAFF_SUBTITLE, OPERATIONS_SUBTITLE,
} from './portalIdentity';

describe('what the centre is called', () => {
  it('shows a name that is already right, untouched', () => {
    expect(centreDisplayName({ identityName: 'Mathnasium of Langley' }))
      .toBe('Mathnasium of Langley');
  });

  it('adds the missing word to the shape the seed config writes', () => {
    // LANGLEY_DEFAULT_CONFIG.name is literally 'Mathnasium Langley'.
    expect(centreDisplayName({ identityName: 'Mathnasium Langley' }))
      .toBe('Mathnasium of Langley');
  });

  it('brands a bare place name', () => {
    expect(centreDisplayName({ identityName: 'Langley' })).toBe('Mathnasium of Langley');
  });

  it('prefers the identity doc over the config, which defaults to the brand', () => {
    expect(centreDisplayName({
      identityName: 'Mathnasium of Langley', configName: 'Mathnasium', centreId: 'langley',
    })).toBe('Mathnasium of Langley');
  });

  it('never answers with the bare brand when it has anything else', () => {
    // Every rung of the ladder, one at a time: config name, then city,
    // then the centre id — which is how the corner said "Mathnasium".
    expect(centreDisplayName({ identityName: 'Mathnasium', configName: 'Mathnasium Burnaby' }))
      .toBe('Mathnasium of Burnaby');
    expect(centreDisplayName({ configName: 'Mathnasium', city: 'Langley' }))
      .toBe('Mathnasium of Langley');
    expect(centreDisplayName({ centreId: 'langley' })).toBe('Mathnasium of Langley');
    expect(centreDisplayName({ centreId: 'north-vancouver' }))
      .toBe('Mathnasium of North Vancouver');
  });

  it('falls back to the brand only when it knows nothing at all', () => {
    expect(centreDisplayName({})).toBe('Mathnasium');
    expect(centreDisplayName()).toBe('Mathnasium');
  });

  it('tidies whitespace rather than rendering it', () => {
    expect(centreDisplayName({ identityName: '  Mathnasium   Langley  ' }))
      .toBe('Mathnasium of Langley');
  });
});

describe('whose portal this is', () => {
  it('is an operations portal for directors and above', () => {
    for (const flag of ['isOwner', 'isDirector', 'isAdmin', 'isDistrictManager', 'isSuperAdmin']) {
      expect(portalSubtitle({ [flag]: true })).toBe(OPERATIONS_SUBTITLE);
    }
  });

  it('is the staff portal for everyone who works the floor', () => {
    for (const flag of ['isInstructor', 'isLead', 'isHost', 'isTraining', 'isVolunteer']) {
      expect(portalSubtitle({ [flag]: true })).toBe(STAFF_SUBTITLE);
    }
    // A Manager and the admin assistant are leadership in the navigation
    // and are still not above a director. Deliberate — flip it here if
    // the centre decides otherwise, not in the component.
    expect(portalSubtitle({ isManager: true })).toBe(STAFF_SUBTITLE);
    expect(portalSubtitle({ isAdminAssistant: true })).toBe(STAFF_SUBTITLE);
  });

  it('says something sensible with nothing to go on', () => {
    expect(portalSubtitle()).toBe(STAFF_SUBTITLE);
  });
});
