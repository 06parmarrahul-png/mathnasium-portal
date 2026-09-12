/**
 * Firestore security-rules tests — taking back a swap request.
 *
 * Run against the real rules file in the emulator:
 *   npm run test:rules
 *
 * Before this, a swap request could only be removed by an owner or an
 * admin. The Shift Board's 15-minute grace period carried a comment saying
 * "only the poster can delete during this window (delete permission already
 * checks userId)" — which was simply not true of the deployed rules. The
 * poster had no way to take anything back at all.
 *
 * The negative cases are the ones that matter. This rule widens DELETE on a
 * collection that also holds the team chat, so the tests exist to prove it
 * did not widen one inch further than a person's own open swap request.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const CENTRE = 'langley';

let testEnv;
const as = (uid) => testEnv.authenticatedContext(uid).firestore();

const swap = (over = {}) => ({
  text: 'Is anyone able to swap or take my shift?',
  type: 'shift_swap',
  userId: 'inst1',
  userName: 'Inst One',
  centerId: CENTRE,
  shiftId: 's1',
  shiftDate: '2026-09-20',
  shiftStartTime: '15:00',
  shiftEndTime: '19:00',
  swapStatus: 'open',
  acceptedBy: null,
  ...over,
});

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    // Its OWN project. These files run in parallel against one emulator,
    // and clearFirestore() wipes a whole project — sharing an id with
    // shifts.rules.test.js had each file deleting the other's seeded users
    // mid-run.
    projectId: 'ratio-swaps-rules-test',
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
      u('admin1', { role: 'admin' }),
      u('inst1',  { role: 'instructor', instructorType: 'Instructor' }),
      u('inst2',  { role: 'instructor', instructorType: 'Instructor' }),
    ]);
  });
});

const seed = (id, data) => testEnv.withSecurityRulesDisabled(
  (ctx) => setDoc(doc(ctx.firestore(), 'chat', id), data),
);

describe('taking back your own swap request', () => {
  it('lets the poster take their own open request down', async () => {
    await seed('c1', swap());
    await assertSucceeds(deleteDoc(doc(as('inst1'), 'chat', 'c1')));
  });

  it('still lets an owner and an admin cancel one', async () => {
    await seed('c1', swap());
    await seed('c2', swap());
    await assertSucceeds(deleteDoc(doc(as('owner1'), 'chat', 'c1')));
    await assertSucceeds(deleteDoc(doc(as('admin1'), 'chat', 'c2')));
  });
});

describe('what it must NOT have widened', () => {
  it("stops an instructor deleting somebody else's swap request", async () => {
    await seed('c1', swap({ userId: 'inst1' }));
    await assertFails(deleteDoc(doc(as('inst2'), 'chat', 'c1')));
  });

  it('stops the poster erasing a swap somebody has already taken', async () => {
    // The shift changed hands when it was accepted. Deleting the request
    // now would leave the taker holding a shift with no record of why.
    await seed('c1', swap({ swapStatus: 'accepted', acceptedBy: 'inst2' }));
    await assertFails(deleteDoc(doc(as('inst1'), 'chat', 'c1')));
  });

  it('stops anyone deleting an ordinary chat message of their own', async () => {
    // The point of the type check: chat stays an audit-able log, and this
    // rule is not a back door into deleting from it.
    await seed('m1', { text: 'see you tomorrow', type: 'text', userId: 'inst1', centerId: CENTRE });
    await assertFails(deleteDoc(doc(as('inst1'), 'chat', 'm1')));
  });

  it('stops an instructor deleting a system confirmation naming them', async () => {
    await seed('m1', {
      text: 'Inst One took a shift', type: 'shift_confirmation',
      userId: 'inst1', centerId: CENTRE,
    });
    await assertFails(deleteDoc(doc(as('inst1'), 'chat', 'm1')));
  });

  it('denies rather than errors on a swap doc missing its fields', async () => {
    // A legacy row with no swapStatus must fall through to a denial, not
    // blow the evaluation up — which is why the rule reads with defaults.
    await seed('c1', { type: 'shift_swap', userId: 'inst1', centerId: CENTRE });
    await assertFails(deleteDoc(doc(as('inst1'), 'chat', 'c1')));
  });

  it('stops a signed-out visitor deleting anything', async () => {
    await seed('c1', swap());
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(deleteDoc(doc(anon, 'chat', 'c1')));
  });
});
