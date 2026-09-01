/**
 * Firestore security-rules tests — custom centre roles.
 *
 * A centre can define its own roles in Manage Roles → Centre Roles, stored
 * as `staffRoles` on centers/{id}/config/main. The rules resolve a user's
 * title at a centre and honour the permissions that role carries, so a
 * role invented in the UI is real on the server too — not just a nav item
 * that opens a page with no data.
 *
 * The two properties worth proving:
 *
 *   1. A granted permission actually works, and is scoped to the centre
 *      that granted it.
 *   2. The grant is ADDITIVE. No configuration of staffRoles — empty,
 *      missing, renamed, deleted, malformed — can take away access that
 *      the platform role already gave. That's what makes the editor safe
 *      to hand to a centre director.
 *
 * Boot with: npm run test:rules
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const CENTRE = 'langley';
const OTHER  = 'burnaby';

let testEnv;

const as = (uid) => testEnv.authenticatedContext(uid).firestore();

const shift = (over = {}) => ({
  centerId:  CENTRE,
  userId:    'someone',
  userName:  'Someone',
  date:      '2026-09-01',
  startTime: '15:00',
  endTime:   '19:00',
  role:      'Instructor',
  subRole:   'Elementary',
  status:    'live',
  ...over,
});

/** Write the centre's role registry past the rules. */
const setRoles = (centerId, staffRoles) => testEnv.withSecurityRulesDisabled(
  (ctx) => setDoc(doc(ctx.firestore(), 'centers', centerId, 'config', 'main'), {
    name: centerId,
    staffRoles,
    // The flat lookup the rules actually read. Derived here the same way
    // permissionLookup() derives it on save, so these tests exercise the
    // shape that really ships.
    staffRolePermissions: Object.fromEntries(
      staffRoles
        .filter(r => r && r.name && Array.isArray(r.permissions) && r.permissions.length)
        .map(r => [r.name, r.permissions]),
    ),
  }),
);

const seed = (path, id, data) => testEnv.withSecurityRulesDisabled(
  (ctx) => setDoc(doc(ctx.firestore(), ...path.split('/'), id), data),
);

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-roles-rules-test',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const u = (id, data) => setDoc(doc(db, 'users', id), {
      approved: true, centerIds: [CENTRE], ...data,
    });
    await Promise.all([
      u('owner1', { role: 'owner' }),
      // Plain instructors carrying an INVENTED title. Nothing about these
      // accounts is special — all their reach has to come from the role.
      u('asstLead', { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Assistant Lead' } } }),
      u('floorCoach', { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Floor Coach' } } }),
      u('opsLead', { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Ops Lead' } } }),
      u('plain', { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Instructor' } } }),
      // Same invented title, but at a different centre.
      u('asstLeadOther', {
        role: 'instructor', centerIds: [OTHER],
        centerMemberships: { [OTHER]: { instructorType: 'Assistant Lead' } },
      }),
      // A legacy account whose title is only on the top-level field.
      u('legacyCoach', { role: 'instructor', instructorType: 'Floor Coach' }),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A granted permission is real
// ─────────────────────────────────────────────────────────────────────────

describe('scheduler.run granted by a custom role', () => {
  beforeEach(() => setRoles(CENTRE, [
    { id: 'floor-coach', name: 'Floor Coach', permissions: ['scheduler.run'] },
  ]));

  it('opens the Student Scheduler data the role was given', async () => {
    await seed('centers/langley/schedulerStudents', 'stu1', { name: 'A Student' });
    await assertSucceeds(getDoc(doc(as('floorCoach'), 'centers', CENTRE, 'schedulerStudents', 'stu1')));
  });

  it('still refuses someone without the role', async () => {
    await seed('centers/langley/schedulerStudents', 'stu1', { name: 'A Student' });
    await assertFails(getDoc(doc(as('plain'), 'centers', CENTRE, 'schedulerStudents', 'stu1')));
  });

  it('does NOT hand over schedule authoring — that is a different permission', async () => {
    await assertFails(setDoc(doc(as('floorCoach'), 'shifts', 's1'), shift()));
  });

  it('works for a legacy account whose title is on the top-level field', async () => {
    await seed('centers/langley/schedulerStudents', 'stu1', { name: 'A Student' });
    await assertSucceeds(getDoc(doc(as('legacyCoach'), 'centers', CENTRE, 'schedulerStudents', 'stu1')));
  });
});

describe('admin.operations granted by a custom role', () => {
  beforeEach(() => setRoles(CENTRE, [
    { id: 'ops-lead', name: 'Ops Lead', permissions: ['admin.operations'] },
  ]));

  it('lets the role author the schedule', async () => {
    await assertSucceeds(setDoc(doc(as('opsLead'), 'shifts', 's1'), shift()));
  });

  it('lets the role post an open shift', async () => {
    await assertSucceeds(setDoc(doc(as('opsLead'), 'openShifts', 'o1'), {
      centerId: CENTRE, date: '2026-09-01', startTime: '15:00', endTime: '19:00',
      subRole: 'Elementary', status: 'open',
    }));
  });

  it('still refuses a plain instructor', async () => {
    await assertFails(setDoc(doc(as('plain'), 'shifts', 's1'), shift()));
  });
});

describe('centre.settings granted by a custom role', () => {
  beforeEach(() => setRoles(CENTRE, [
    { id: 'asst-lead', name: 'Assistant Lead', permissions: ['centre.settings'] },
  ]));

  it('lets the role edit the centre config', async () => {
    await assertSucceeds(updateDoc(
      doc(as('asstLead'), 'centers', CENTRE, 'config', 'main'), { activeStudentCount: 42 },
    ));
  });

  it('still refuses a plain instructor', async () => {
    await assertFails(updateDoc(
      doc(as('plain'), 'centers', CENTRE, 'config', 'main'), { activeStudentCount: 42 },
    ));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scoping
// ─────────────────────────────────────────────────────────────────────────

describe('a role only grants at the centre that defined it', () => {
  beforeEach(async () => {
    await setRoles(CENTRE, [{ id: 'ops-lead', name: 'Ops Lead', permissions: ['admin.operations'] }]);
    // The other centre defines the SAME NAME with no permissions.
    await setRoles(OTHER, [{ id: 'asst-lead', name: 'Assistant Lead', permissions: [] }]);
  });

  it('does not reach into another centre', async () => {
    await assertFails(setDoc(doc(as('asstLeadOther'), 'shifts', 's1'), shift()));
  });

  it('grants at its own centre', async () => {
    await assertSucceeds(setDoc(doc(as('opsLead'), 'shifts', 's1'), shift()));
  });
});

describe('an exact name match is required', () => {
  beforeEach(() => setRoles(CENTRE, [
    { id: 'ops-lead', name: 'Ops Lead ', permissions: ['admin.operations'] },  // stray space
  ]));

  // The rules match exactly where the client folds case and punctuation.
  // That asymmetry is one-directional on purpose: the server is the
  // stricter of the two, so it can only ever deny something the UI
  // allowed — never grant something the UI didn't.
  it('a name that does not match exactly grants nothing', async () => {
    await assertFails(setDoc(doc(as('opsLead'), 'shifts', 's1'), shift()));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The safety property: grants are additive and can never lock anyone out
// ─────────────────────────────────────────────────────────────────────────

describe('nothing in staffRoles can take access away', () => {
  const OWNER_STILL_WORKS = async () => {
    await assertSucceeds(setDoc(doc(as('owner1'), 'shifts', `s-${Date.now()}`), shift()));
    // setDoc rather than updateDoc: one of these cases has no config doc
    // at all, and updateDoc fails on NOT_FOUND before the rules are ever
    // consulted, which would prove nothing about access.
    await assertSucceeds(setDoc(
      doc(as('owner1'), 'centers', CENTRE, 'config', 'main'),
      { activeStudentCount: 1 }, { merge: true },
    ));
  };

  it('when there is no config doc at all', async () => {
    await OWNER_STILL_WORKS();
  });

  it('when staffRoles is missing from the config', async () => {
    await seed('centers/langley/config', 'main', { name: 'Langley' });
    await OWNER_STILL_WORKS();
  });

  it('when staffRoles is empty', async () => {
    await setRoles(CENTRE, []);
    await OWNER_STILL_WORKS();
  });

  it('when every role grants nothing', async () => {
    await setRoles(CENTRE, [
      { id: 'a', name: 'Instructor', permissions: [] },
      { id: 'b', name: 'Manager', permissions: [] },
      { id: 'c', name: 'Host', permissions: [] },
    ]);
    await OWNER_STILL_WORKS();
    // The built-in title checks are untouched by the registry.
    await testEnv.withSecurityRulesDisabled((ctx) => setDoc(
      doc(ctx.firestore(), 'users', 'mgr1'),
      { approved: true, centerIds: [CENTRE], role: 'instructor',
        centerMemberships: { [CENTRE]: { instructorType: 'Manager' } } },
    ));
    await assertSucceeds(setDoc(doc(as('mgr1'), 'shifts', 'sm'), shift()));
  });

  it('when staffRoles is malformed', async () => {
    await setRoles(CENTRE, [
      { name: 'No permissions key' },
      { permissions: ['admin.operations'] },        // no name
      { id: 'x', name: 'Ops Lead', permissions: 'not-a-list' },
    ]);
    await OWNER_STILL_WORKS();
    // And the malformed entry grants nothing.
    await assertFails(setDoc(doc(as('opsLead'), 'shifts', 's1'), shift()));
  });

  it('when the role a user holds was deleted from the registry', async () => {
    await setRoles(CENTRE, [{ id: 'other', name: 'Something Else', permissions: ['admin.operations'] }]);
    await OWNER_STILL_WORKS();
    await assertFails(setDoc(doc(as('opsLead'), 'shifts', 's1'), shift()));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The escalation boundary
// ─────────────────────────────────────────────────────────────────────────

describe('a centre role cannot confer platform power', () => {
  beforeEach(() => setRoles(CENTRE, [
    { id: 'sneaky', name: 'Assistant Lead', permissions: ['roles.manage', 'centre.settings'] },
  ]));

  // roles.manage is on the PLATFORM_ONLY list in src/lib/roles.js and is
  // stripped on read, on write, and again at resolution. The rules never
  // consult it for anything, so even a hand-edited config doc carrying it
  // buys nothing — proven here by the one thing it would be used for.
  it('cannot promote anybody', async () => {
    await seed('users', 'victim', { approved: true, role: 'instructor', centerIds: [CENTRE] });
    await assertFails(updateDoc(doc(as('asstLead'), 'users', 'victim'), { role: 'owner' }));
  });

  it('cannot make itself Enterprise', async () => {
    await assertFails(updateDoc(doc(as('asstLead'), 'users', 'asstLead'), { role: 'super_admin' }));
  });

  it('the centre.settings grant alongside it still works', async () => {
    await assertSucceeds(updateDoc(
      doc(as('asstLead'), 'centers', CENTRE, 'config', 'main'), { activeStudentCount: 7 },
    ));
  });
});
