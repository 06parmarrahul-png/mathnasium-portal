/**
 * Firestore security-rules tests — what a signup may create.
 *
 *   npm run test:rules
 *
 * THE HOLE THESE CLOSE. `/users/{uid}` create used to be "is this your own
 * uid", nothing more. Anyone who could reach the signup page could write
 * themselves `role: 'owner'` and read centers/{id}/leads — parent names,
 * emails and phone numbers. It was open because signup auto-promoted the
 * first account at a centre to owner, and rules cannot run the "is there an
 * owner yet" query that decision needed.
 *
 * A new account is now a plain, pending instructor and nothing else. The
 * first owner of a new centre is promoted by a person in Manage Roles.
 *
 * The first test here is the exploit, written the way an attacker would:
 * create the account, then go for the leads.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const CENTRE = 'langley';

let testEnv;
const as = (uid) => testEnv.authenticatedContext(uid).firestore();

/** Exactly what AuthContext.signup() writes. */
const signup = (uid, extra = {}) => ({
  uid,
  email: `${uid}@example.com`,
  displayName: 'New Person',
  role: 'instructor',
  approved: false,
  instructorType: 'Instructor',
  maxDaysPerWeek: 5,
  phone: '',
  mascot: 'classic',
  centerId: CENTRE,
  centerIds: [CENTRE],
  centerMemberships: {
    [CENTRE]: { instructorType: 'Instructor', maxDaysPerWeek: 5, subRoles: [], guaranteed: false, approved: false },
  },
  createdAt: '2026-09-16T12:00:00.000Z',
  ...extra,
});

const withMembership = (uid, title) => signup(uid, {
  centerMemberships: { [CENTRE]: { instructorType: title, approved: false } },
});

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-signup-rules-test',   // its own project; files run in parallel
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});

afterAll(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'centers', CENTRE, 'leads', 'l1'), {
      parentName: 'Sample Parent', email: 'parent@example.com', phone: '604-555-0100',
    });
    await setDoc(doc(db, 'users', 'owner'), {
      approved: true, role: 'owner', centerId: CENTRE, centerIds: [CENTRE],
      instructorType: 'Owner', centerMemberships: { [CENTRE]: { instructorType: 'Owner' } },
    });
  });
});

describe('the exploit', () => {
  it('a new signup cannot make itself the owner and read the leads', async () => {
    const db = as('attacker');
    await assertFails(setDoc(doc(db, 'users', 'attacker'), signup('attacker', { role: 'owner', approved: true })));
    // And with no profile written, there is nothing to read the leads with.
    await assertFails(getDoc(doc(db, 'centers', CENTRE, 'leads', 'l1')));
  });

  it('nor any other role that carries reach', async () => {
    for (const role of ['owner', 'super_admin', 'director', 'admin_assistant', 'admin']) {
      await assertFails(setDoc(doc(as('attacker'), 'users', 'attacker'), signup('attacker', { role })));
    }
  });

  it('nor a title that grants — Manager, Host, Lead, Admin, the directors', async () => {
    for (const title of ['Manager', 'Host', 'Lead', 'Admin', 'Center Director', 'Dir. of Education', 'centre director']) {
      await assertFails(setDoc(doc(as('attacker'), 'users', 'attacker'), signup('attacker', { instructorType: title })));
      await assertFails(setDoc(doc(as('attacker'), 'users', 'attacker'), withMembership('attacker', title)));
    }
  });

  it('nor approve itself', async () => {
    await assertFails(setDoc(doc(as('attacker'), 'users', 'attacker'), signup('attacker', { approved: true })));
  });

  it('nor hide a title behind a pile of centre rows', async () => {
    // The positional walk checks the first five rows and refuses anything
    // longer, so a sixth row can't smuggle one past.
    const many = {};
    for (let i = 0; i < 5; i += 1) many[`c${i}`] = { instructorType: i === 4 ? 'Manager' : 'Instructor' };
    await assertFails(setDoc(doc(as('attacker'), 'users', 'attacker'), signup('attacker', { centerMemberships: many })));

    const tooMany = {};
    for (let i = 0; i < 6; i += 1) tooMany[`c${i}`] = { instructorType: 'Instructor' };
    await assertFails(setDoc(doc(as('attacker'), 'users', 'attacker'), signup('attacker', { centerMemberships: tooMany })));
  });

  it('nor create somebody else’s account', async () => {
    await assertFails(setDoc(doc(as('attacker'), 'users', 'someone-else'), signup('someone-else')));
  });
});

describe('a real signup still works', () => {
  it('lands as a pending instructor', async () => {
    await assertSucceeds(setDoc(doc(as('newbie'), 'users', 'newbie'), signup('newbie')));
  });

  it('including the shapes signup actually writes', async () => {
    // A volunteer or trainee account created by hand carries these titles,
    // and neither grants anything, so neither is worth refusing.
    await assertSucceeds(setDoc(doc(as('v'), 'users', 'v'), signup('v', { instructorType: 'Volunteer' })));
    await assertSucceeds(setDoc(doc(as('t'), 'users', 't'), withMembership('t', 'Training')));
  });

  it('and cannot read the leads until somebody promotes them', async () => {
    await assertSucceeds(setDoc(doc(as('newbie'), 'users', 'newbie'), signup('newbie')));
    await assertFails(getDoc(doc(as('newbie'), 'centers', CENTRE, 'leads', 'l1')));
  });

  it('the owner can then approve and promote them — the path that replaced auto-promotion', async () => {
    await assertSucceeds(setDoc(doc(as('newbie'), 'users', 'newbie'), signup('newbie')));
    await assertSucceeds(setDoc(
      doc(as('owner'), 'users', 'newbie'),
      signup('newbie', { role: 'owner', approved: true }),
    ));
  });
});
