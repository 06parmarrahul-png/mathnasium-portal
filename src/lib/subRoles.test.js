import { describe, it, expect } from 'vitest';
import { normalizeCapability, hasCapability, requiredCapabilityForShift, SUB_ROLES } from './subRoles';

describe('normalizeCapability', () => {
  it('folds every spelling of Highschool together', () => {
    for (const v of ['Highschool', 'High School', 'high school', 'HIGHSCHOOL', 'High-School', 'HS', 'hs']) {
      expect(normalizeCapability(v)).toBe('highschool');
    }
  });
  it('folds Elementary variants', () => {
    for (const v of ['Elementary', 'elementary', 'ELEM', 'Elem']) {
      expect(normalizeCapability(v)).toBe('elementary');
    }
  });
  it('handles junk without throwing', () => {
    expect(normalizeCapability(null)).toBe('');
    expect(normalizeCapability('')).toBe('');
    expect(normalizeCapability(42)).toBe('');
  });
});

describe('hasCapability', () => {
  // Arham's case: shown as Elementary + Highschool, told he lacked Highschool.
  it('matches Highschool against a shift tagged "High School"', () => {
    expect(hasCapability(['Elementary', 'Highschool'], 'High School')).toBe(true);
  });
  it('matches "High School" on the user against a "Highschool" shift', () => {
    expect(hasCapability(['Elementary', 'High School'], 'Highschool')).toBe(true);
  });
  it('still refuses a capability the user genuinely lacks', () => {
    expect(hasCapability(['Elementary'], 'Highschool')).toBe(false);
    expect(hasCapability(['Elementary', 'Highschool'], 'Online')).toBe(false);
  });
  it('locks out a user with no sub-roles at all', () => {
    expect(hasCapability([], 'Elementary')).toBe(false);
    expect(hasCapability(undefined, 'Elementary')).toBe(false);
  });
  it('lets anyone with a sub-role take an untagged legacy shift', () => {
    expect(hasCapability(['Elementary'], null)).toBe(true);
    expect(hasCapability(['Elementary'], '')).toBe(true);
  });
  it('handles Host as a capability', () => {
    expect(hasCapability(['Elementary', 'Host'], 'Host')).toBe(true);
    expect(hasCapability(['Elementary'], 'Host')).toBe(false);
  });
  it('accepts every canonical sub-role against itself', () => {
    for (const r of SUB_ROLES) expect(hasCapability([r], r)).toBe(true);
  });
});

describe('requiredCapabilityForShift', () => {
  it('a Host shift requires Host regardless of subRole', () => {
    expect(requiredCapabilityForShift({ role: 'Host', subRole: 'Elementary' })).toBe('Host');
  });
  it('a teaching shift requires its subRole', () => {
    expect(requiredCapabilityForShift({ role: 'Instructor', subRole: 'Highschool' })).toBe('Highschool');
  });
  it('an untagged shift requires nothing', () => {
    expect(requiredCapabilityForShift({ role: 'Instructor' })).toBe(null);
    expect(requiredCapabilityForShift(null)).toBe(null);
  });

  it('end to end: Arham can claim the Highschool shift', () => {
    const arham = ['Elementary', 'Highschool'];
    for (const shift of [
      { role: 'Instructor', subRole: 'Highschool' },
      { role: 'Instructor', subRole: 'High School' },
    ]) {
      expect(hasCapability(arham, requiredCapabilityForShift(shift))).toBe(true);
    }
    // and still cannot host
    expect(hasCapability(arham, requiredCapabilityForShift({ role: 'Host' }))).toBe(false);
  });
});
