/**
 * Firestore security-rules tests — who may hand out a director title.
 *
 *   npm run test:rules
 *
 * A director title ("Center Director", "Dir. of Education" and their
 * spellings) is owner-level access: isDirector() in firestore.rules matches
 * it, and so do the desk, fun-day and client permission checks. The users
 * update rule let a Manager or Host edit anyone non-elevated, locking only
 * role / centerId / centerIds — so either could type "Center Director" onto
 * a colleague in Manage Staff, or onto themselves, and make them an owner.
 * Self-update locked centerMemberships but not the top-level title, which
 * is the one isDirector() reads.
 *
 * Now only the owner tier (isOwnerLike() || isSuperAdmin()) may write one.
 * A title that is already there is not a write: Manage Staff saves other
 * fields on a director's record, and seeds a centre's membership row from a
 * legacy top-level title, and both must keep working.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const CENTRE = 'langley';
const OTHER = 'burnaby';

// The stored spellings, plus variants the client folds to the same role
// (roleKey in src/lib/roles.js ignores case and punctuation).
const DIRECTOR_TITLES = [
  'Center Director', 'Centre Director', 'Dir. of Education', 'Director of Education',
  'center director', 'Director-of-Education',
];
const OTHER_TITLES = ['Instructor', 'Lead', 'Host', 'Admin', 'Manager', 'Training', 'Volunteer', 'Assistant Lead'];

let testEnv;
const as = (uid) => testEnv.authenticatedContext(uid).firestore();

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-director-titles-rules-test',   // its own project; files run in parallel
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});

afterAll(async () => { await testEnv.cleanup(); });

// Five centre rows — every position the rules look at (see writesDirectorTitle).
const fiveCentres = Array.from({ length: 5 }, (_, i) => `c${i}`);

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // Title in both places, as managers.rules.test.js does. The top-level
    // copy matters: isManagerAnywhere / isHostAnywhere only work through it
    // today (their membership branch errors — see writesDirectorTitle in
    // firestore.rules), and a Manager who can't reach the update rule at
    // all would pass the refusals below for the wrong reason.
    const at = (centre, title, extra = {}) => ({
      approved: true, role: 'instructor', centerId: centre, centerIds: [centre], instructorType: title,
      centerMemberships: { [centre]: { instructorType: title, subRoles: [], maxDaysPerWeek: 5 } }, ...extra,
    });
    await Promise.all([
      setDoc(doc(db, 'users', 'mgr'), at(CENTRE, 'Manager')),
      // Today's Manager, still on the Admin platform role.
      setDoc(doc(db, 'users', 'mgrAdmin'), at(CENTRE, 'Manager', { role: 'admin' })),
      setDoc(doc(db, 'users', 'host'), at(CENTRE, 'Host')),
      setDoc(doc(db, 'users', 'multi'), {
        approved: true, role: 'instructor', centerId: 'c0', centerIds: fiveCentres, instructorType: 'Instructor',
        centerMemberships: Object.fromEntries(fiveCentres.map(c => [c, { instructorType: 'Instructor' }])),
      }),
      setDoc(doc(db, 'users', 'owner'), at(CENTRE, 'Owner', { role: 'owner' })),
      setDoc(doc(db, 'users', 'ent'), at(CENTRE, 'Instructor', { role: 'super_admin' })),
      setDoc(doc(db, 'users', 'dirRole'), at(CENTRE, 'Center Director', { role: 'director' })),
      setDoc(doc(db, 'users', 'staff'), at(CENTRE, 'Instructor')),
      // Already a director — their title predates this change.
      setDoc(doc(db, 'users', 'dirTitled'), at(CENTRE, 'Dir. of Education', { instructorType: 'Dir. of Education' })),
      // A legacy record: top-level title only, no membership row yet.
      setDoc(doc(db, 'users', 'legacyDir'), {
        approved: true, role: 'instructor', centerId: CENTRE, centerIds: [CENTRE], instructorType: 'Center Director',
      }),
      setDoc(doc(db, 'users', 'legacyStaff'), {
        approved: false, role: 'instructor', centerId: CENTRE, centerIds: [CENTRE], instructorType: 'Instructor',
      }),
      setDoc(doc(db, 'centers', CENTRE, 'leads', 'l1'), { parentName: 'Sample Parent', phone: '604-555-0100' }),
    ]);
  });
});

// What Manage Staff writes: the per-centre field, by dotted path.
const setTitleAt = (uid, target, centre, title) =>
  updateDoc(doc(as(uid), 'users', target), { [`centerMemberships.${centre}.instructorType`]: title });

describe('a Manager or Host cannot hand out a director title', () => {
  for (const actor of ['mgr', 'mgrAdmin', 'host']) {
    it.each(DIRECTOR_TITLES)(`${actor}: not in someone's centre membership (%s)`, async (title) => {
      await assertFails(setTitleAt(actor, 'staff', CENTRE, title));
    });

    it(`${actor}: not in the top-level title isDirector() reads`, async () => {
      for (const title of DIRECTOR_TITLES) {
        await assertFails(updateDoc(doc(as(actor), 'users', 'staff'), { instructorType: title }));
      }
    });

    it(`${actor}: not by seeding a new centre's membership row with one`, async () => {
      await assertFails(updateDoc(doc(as(actor), 'users', 'staff'), {
        [`centerMemberships.${OTHER}`]: { instructorType: 'Center Director', approved: true },
      }));
      await assertFails(updateDoc(doc(as(actor), 'users', 'legacyStaff'), {
        [`centerMemberships.${CENTRE}`]: { instructorType: 'Centre Director', approved: true },
      }));
    });

    it(`${actor}: not by rewriting the whole document`, async () => {
      const snap = await getDoc(doc(as(actor), 'users', 'staff'));
      const data = snap.data();
      data.centerMemberships[CENTRE].instructorType = 'Dir. of Education';
      await assertFails(setDoc(doc(as(actor), 'users', 'staff'), data));
    });

    it(`${actor}: not on themselves`, async () => {
      await assertFails(setTitleAt(actor, actor, CENTRE, 'Center Director'));
      await assertFails(updateDoc(doc(as(actor), 'users', actor), { instructorType: 'Center Director' }));
    });

    it.each(OTHER_TITLES)(`${actor}: can still set %s`, async (title) => {
      await assertSucceeds(setTitleAt(actor, 'staff', CENTRE, title));
    });
  }

  it('and the person they tried to promote still cannot read leads', async () => {
    await assertFails(setTitleAt('mgr', 'staff', CENTRE, 'Center Director'));
    await assertFails(getDoc(doc(as('staff'), 'centers', CENTRE, 'leads', 'l1')));
  });

  it('whichever of someone’s centre rows the title goes in', async () => {
    for (const actor of ['mgr', 'host']) {
      for (const centre of fiveCentres) {
        await assertFails(setTitleAt(actor, 'multi', centre, 'Center Director'));
        await assertSucceeds(setTitleAt(actor, 'multi', centre, 'Lead'));
      }
    }
  });

  it('even when every row is rewritten at once — and that still fits the rules’ evaluation budget', async () => {
    const rows = (last) => Object.fromEntries(fiveCentres.map((c, i) => [c, {
      instructorType: i === fiveCentres.length - 1 ? last : 'Lead', subRoles: ['Highschool'], maxDaysPerWeek: 4, approved: true,
    }]));
    await assertFails(updateDoc(doc(as('host'), 'users', 'multi'), { centerMemberships: rows('Dir. of Education') }));
    await assertSucceeds(updateDoc(doc(as('host'), 'users', 'multi'), { centerMemberships: rows('Lead') }));
  });

  it('past five centre rows the rules cannot look, so only the owner tier may write them', async () => {
    const sixth = { 'centerMemberships.c5': { instructorType: 'Instructor' } };
    await assertFails(updateDoc(doc(as('mgr'), 'users', 'multi'), sixth));
    await assertSucceeds(updateDoc(doc(as('owner'), 'users', 'multi'), sixth));
  });
});

describe('a title that is already there is not a write', () => {
  it('a Manager can still edit other fields on a director’s record', async () => {
    await assertSucceeds(updateDoc(doc(as('mgr'), 'users', 'dirTitled'), {
      [`centerMemberships.${CENTRE}.maxDaysPerWeek`]: 4,
    }));
    await assertSucceeds(setTitleAt('mgr', 'dirTitled', CENTRE, 'Dir. of Education'));
  });

  it('seeding a membership row from a legacy top-level director title (approve / first edit)', async () => {
    await assertSucceeds(updateDoc(doc(as('mgr'), 'users', 'legacyDir'), {
      [`centerMemberships.${CENTRE}`]: { instructorType: 'Center Director', approved: true, maxDaysPerWeek: 5 },
    }));
  });

  it('a Manager may take a director title away (not an escalation)', async () => {
    await assertSucceeds(setTitleAt('mgr', 'dirTitled', CENTRE, 'Instructor'));
  });
});

describe('the owner tier can', () => {
  for (const actor of ['owner', 'ent', 'dirRole']) {
    it(`${actor}: give a director title, per centre and top-level`, async () => {
      await assertSucceeds(setTitleAt(actor, 'staff', CENTRE, 'Center Director'));
      await assertSucceeds(updateDoc(doc(as(actor), 'users', 'staff'), { instructorType: 'Dir. of Education' }));
    });
  }
});

describe('self-service', () => {
  it('an instructor cannot give themselves a director title at the top level', async () => {
    await assertFails(updateDoc(doc(as('staff'), 'users', 'staff'), { instructorType: 'Center Director' }));
    await assertFails(getDoc(doc(as('staff'), 'centers', CENTRE, 'leads', 'l1')));
  });

  it('nor any other title — the top-level one still makes you a Manager or Host everywhere', async () => {
    await assertFails(updateDoc(doc(as('staff'), 'users', 'staff'), { instructorType: 'Manager' }));
    await assertFails(updateDoc(doc(as('staff'), 'users', 'staff'), { instructorType: 'Host' }));
  });

  it('an instructor can still edit their own profile', async () => {
    await assertSucceeds(updateDoc(doc(as('staff'), 'users', 'staff'), { bio: 'Hi', mascot: 'coach' }));
    await assertSucceeds(updateDoc(doc(as('dirTitled'), 'users', 'dirTitled'), { bio: 'Still here' }));
  });

  it('signup cannot create a profile carrying a director title', async () => {
    const signup = (title) => ({
      uid: 'newbie', role: 'instructor', approved: false, centerId: CENTRE, centerIds: [CENTRE],
      instructorType: 'Instructor',
      centerMemberships: { [CENTRE]: { instructorType: 'Instructor', approved: false } },
      ...title,
    });
    await assertFails(setDoc(doc(as('newbie'), 'users', 'newbie'), signup({ instructorType: 'Center Director' })));
    await assertFails(setDoc(doc(as('newbie'), 'users', 'newbie'), signup({
      centerMemberships: { [CENTRE]: { instructorType: 'Director of Education', approved: false } },
    })));
    await assertSucceeds(setDoc(doc(as('newbie'), 'users', 'newbie'), signup({})));
  });
});
