import { describe, it, expect } from 'vitest';
import {
  RATIO_FIELD,
  DEFAULT_IN_RATIO_ROLES,
  NEVER_IN_RATIO_ROLES,
  defaultIncludedInRatio,
  countsInRatio,
  withRatioDefault,
  isRatioOverridden,
  reseedRatioValue,
  ratioHint,
} from './ratioCount';

const shift = (over = {}) => ({ role: 'Instructor', ...over });

describe('defaultIncludedInRatio — floor roles', () => {
  it('counts Instructor', () => {
    expect(defaultIncludedInRatio(shift({ role: 'Instructor' }))).toBe(true);
  });

  it('counts Lead', () => {
    expect(defaultIncludedInRatio(shift({ role: 'Lead' }))).toBe(true);
  });

  // Sabrina runs sessions on the floor every day. Supply & Demand already
  // counted her; the Coverage Grid and Today's Snapshot did not. Counted is
  // the settled answer and this pins it.
  it('counts Manager', () => {
    expect(defaultIncludedInRatio(shift({ role: 'Manager' }))).toBe(true);
  });

  it('counts a shift with no role recorded (legacy documents)', () => {
    expect(defaultIncludedInRatio({ role: '' })).toBe(true);
    expect(defaultIncludedInRatio({})).toBe(true);
    expect(defaultIncludedInRatio({ role: null })).toBe(true);
  });

  it('is tolerant of casing and stray whitespace', () => {
    expect(defaultIncludedInRatio(shift({ role: '  lead ' }))).toBe(true);
    expect(defaultIncludedInRatio(shift({ role: 'INSTRUCTOR' }))).toBe(true);
  });
});

describe('defaultIncludedInRatio — off-ratio roles', () => {
  it.each(['Host', 'Admin', 'Center Director', 'Dir. of Education', 'Online Instructor'])(
    'does not count %s',
    (role) => {
      expect(defaultIncludedInRatio(shift({ role }))).toBe(false);
    },
  );

  it.each(['Training', 'Volunteer'])('never counts %s', (role) => {
    expect(defaultIncludedInRatio(shift({ role }))).toBe(false);
  });

  it('does not count a flex shift, whatever the role says', () => {
    expect(defaultIncludedInRatio(shift({ role: 'Instructor', flexRole: 'STEAM' }))).toBe(false);
    expect(defaultIncludedInRatio(shift({ role: 'Lead', flexRole: 'Summer Camp' }))).toBe(false);
  });

  it('does not count a volunteer identified by centre membership', () => {
    expect(defaultIncludedInRatio(shift({ role: 'Instructor' }), { isVolunteer: true })).toBe(false);
  });

  it('treats an unrecognised role as off-ratio rather than guessing', () => {
    expect(defaultIncludedInRatio(shift({ role: 'Marketing Coordinator' }))).toBe(false);
  });

  it('returns false for a missing shift', () => {
    expect(defaultIncludedInRatio(null)).toBe(false);
    expect(defaultIncludedInRatio(undefined)).toBe(false);
  });
});

describe('countsInRatio — the stored boolean wins', () => {
  it('honours an explicit true on a role that would default to false', () => {
    expect(countsInRatio({ role: 'Host', [RATIO_FIELD]: true })).toBe(true);
    expect(countsInRatio({ role: 'Center Director', [RATIO_FIELD]: true })).toBe(true);
    expect(countsInRatio({ role: 'Training', [RATIO_FIELD]: true })).toBe(true);
  });

  it('honours an explicit false on a role that would default to true', () => {
    expect(countsInRatio({ role: 'Instructor', [RATIO_FIELD]: false })).toBe(false);
    expect(countsInRatio({ role: 'Lead', [RATIO_FIELD]: false })).toBe(false);
  });

  it('an explicit true beats a flex role', () => {
    expect(countsInRatio({ role: 'Instructor', flexRole: 'STEAM', [RATIO_FIELD]: true })).toBe(true);
  });

  it('an explicit true beats the per-centre volunteer flag', () => {
    expect(countsInRatio({ role: 'Instructor', [RATIO_FIELD]: true }, { isVolunteer: true })).toBe(true);
  });

  it('falls back to the default when the field is absent', () => {
    expect(countsInRatio({ role: 'Instructor' })).toBe(true);
    expect(countsInRatio({ role: 'Host' })).toBe(false);
  });

  // A half-written document must not read as "counted" just because the
  // field is truthy-ish. Only a real boolean is treated as a decision.
  it('ignores non-boolean values and falls back to the default', () => {
    expect(countsInRatio({ role: 'Host', [RATIO_FIELD]: 'yes' })).toBe(false);
    expect(countsInRatio({ role: 'Host', [RATIO_FIELD]: 1 })).toBe(false);
    expect(countsInRatio({ role: 'Instructor', [RATIO_FIELD]: null })).toBe(true);
    expect(countsInRatio({ role: 'Instructor', [RATIO_FIELD]: undefined })).toBe(true);
  });

  it('returns false for a missing shift', () => {
    expect(countsInRatio(null)).toBe(false);
  });
});

describe('withRatioDefault', () => {
  it('stamps the derived default onto a payload that has none', () => {
    expect(withRatioDefault({ role: 'Instructor' })[RATIO_FIELD]).toBe(true);
    expect(withRatioDefault({ role: 'Host' })[RATIO_FIELD]).toBe(false);
  });

  it('leaves an explicit choice alone', () => {
    expect(withRatioDefault({ role: 'Host', [RATIO_FIELD]: true })[RATIO_FIELD]).toBe(true);
    expect(withRatioDefault({ role: 'Instructor', [RATIO_FIELD]: false })[RATIO_FIELD]).toBe(false);
  });

  it('does not mutate the payload it was given', () => {
    const payload = { role: 'Instructor' };
    withRatioDefault(payload);
    expect(RATIO_FIELD in payload).toBe(false);
  });

  it('carries every other field through untouched', () => {
    const out = withRatioDefault({ role: 'Lead', userName: 'Bri', date: '2026-09-01' });
    expect(out.userName).toBe('Bri');
    expect(out.date).toBe('2026-09-01');
    expect(out.role).toBe('Lead');
  });

  it('passes the volunteer flag through to the default', () => {
    expect(withRatioDefault({ role: 'Instructor' }, { isVolunteer: true })[RATIO_FIELD]).toBe(false);
  });

  it('is safe on a missing payload', () => {
    expect(withRatioDefault(null)).toBe(null);
  });
});

describe('the exported role sets', () => {
  it('lists exactly the floor roles', () => {
    expect([...DEFAULT_IN_RATIO_ROLES].sort()).toEqual(['Instructor', 'Lead', 'Manager']);
  });

  it('lists exactly the never-counted roles', () => {
    expect([...NEVER_IN_RATIO_ROLES].sort()).toEqual(['Training', 'Volunteer']);
  });

  it('keeps the two sets disjoint', () => {
    for (const r of DEFAULT_IN_RATIO_ROLES) expect(NEVER_IN_RATIO_ROLES.has(r)).toBe(false);
  });
});

describe('ratioHint', () => {
  it('describes both states distinctly', () => {
    expect(ratioHint(true)).not.toBe(ratioHint(false));
    expect(ratioHint(true)).toMatch(/ratio/i);
    expect(ratioHint(false)).toMatch(/not counted/i);
  });
});

// Regression guard: every role the Add/Edit Shift dropdown offers must
// produce a defined, deliberate answer. A new role added to ROLE_OPTIONS
// without a decision here would silently land in the off-ratio bucket, so
// this pins the whole current list.
describe('every role in the shift dropdown has a settled default', () => {
  const EXPECTED = {
    Instructor: true,
    Lead: true,
    Manager: true,
    Host: false,
    Admin: false,
    'Center Director': false,
    'Dir. of Education': false,
    Training: false,
    Volunteer: false,
  };

  it.each(Object.entries(EXPECTED))('%s → %s', (role, expected) => {
    expect(defaultIncludedInRatio({ role })).toBe(expected);
  });

  // 'Owner' is no longer offered anywhere — it isn't a job title, it's what
  // signup stamps on the first account at a new centre. It can still turn
  // up on a real record, so it must keep resolving to a definite answer
  // rather than throwing or reading as counted.
  it('a stray Owner title still resolves, and is out of ratio', () => {
    expect(defaultIncludedInRatio({ role: 'Owner' })).toBe(false);
    expect(countsInRatio({ role: 'Owner' })).toBe(false);
  });
});

describe('isRatioOverridden', () => {
  it('is false for a shift with no stored value', () => {
    expect(isRatioOverridden({ role: 'Instructor' })).toBe(false);
    expect(isRatioOverridden({ role: 'Host' })).toBe(false);
  });

  it('is false when the stored value matches the role default', () => {
    expect(isRatioOverridden({ role: 'Instructor', [RATIO_FIELD]: true })).toBe(false);
    expect(isRatioOverridden({ role: 'Host', [RATIO_FIELD]: false })).toBe(false);
  });

  it('is true when the stored value contradicts the role default', () => {
    expect(isRatioOverridden({ role: 'Host', [RATIO_FIELD]: true })).toBe(true);
    expect(isRatioOverridden({ role: 'Instructor', [RATIO_FIELD]: false })).toBe(true);
  });

  it('is safe on a missing shift', () => {
    expect(isRatioOverridden(null)).toBe(false);
    expect(isRatioOverridden(undefined)).toBe(false);
  });
});

describe('reseedRatioValue', () => {
  it('follows the role while the toggle is untouched', () => {
    expect(reseedRatioValue(false, true, { role: 'Host' })).toBe(false);
    expect(reseedRatioValue(false, false, { role: 'Lead' })).toBe(true);
  });

  // The rule that matters. Marking a shift out of ratio and THEN picking a
  // role must not silently re-count it — nobody would see that happen.
  it('never moves the toggle back once a human has set it', () => {
    expect(reseedRatioValue(true, false, { role: 'Instructor' })).toBe(false);
    expect(reseedRatioValue(true, false, { role: 'Lead' })).toBe(false);
    expect(reseedRatioValue(true, true, { role: 'Host' })).toBe(true);
    expect(reseedRatioValue(true, true, { role: 'Training' })).toBe(true);
  });

  it('re-seeds off a flex role too', () => {
    expect(reseedRatioValue(false, true, { role: 'Instructor', flexRole: 'STEAM' })).toBe(false);
    expect(reseedRatioValue(false, false, { role: 'Instructor', flexRole: '' })).toBe(true);
  });

  // Walks the exact sequence the Add Shift modal produces: open on an
  // Instructor (on), switch to Host (follows, off), switch back (follows,
  // on), user turns it off, then switch role again (must stay off).
  it('models the full Add Shift interaction', () => {
    let touched = false;
    let value = defaultIncludedInRatio({ role: 'Instructor' });
    expect(value).toBe(true);

    value = reseedRatioValue(touched, value, { role: 'Host' });
    expect(value).toBe(false);

    value = reseedRatioValue(touched, value, { role: 'Instructor' });
    expect(value).toBe(true);

    touched = true; value = false;                       // user flips it off
    value = reseedRatioValue(touched, value, { role: 'Lead' });
    expect(value).toBe(false);                           // stays where they put it
  });
});
