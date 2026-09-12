/**
 * Firestore security-rules tests — the Management Desk.
 *
 *   npm run test:rules
 *
 * These five collections hold parent account questions, card details on
 * receipts, and notes about individual students' funding and family
 * circumstances. So the negative cases are the point: an instructor, a
 * Lead, a volunteer and somebody from another centre must all be shut
 * out, and the app's own "settle, don't delete" rule has to be real
 * rather than merely a missing button.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const CENTRE = 'langley';
const OTHER  = 'chilliwack';

let testEnv;
const as = (uid) => testEnv.authenticatedContext(uid).firestore();

const note = (over = {}) => ({
  toUids: ['vin'], toLabel: 'VB', toAll: false,
  fromUid: 'rachel', fromName: 'Rachel R', fromInitials: 'RR',
  subject: 'Account: Manjeet Kaur',
  body: 'Card was declined for this month.',
  loggedAt: '2026-09-01', createdAt: '2026-09-01T17:00:00.000Z',
  status: 'open', replies: [],
  ...over,
});

const COLLECTIONS = ['notes', 'giftCards', 'receipts', 'referrals', 'studentOfMonth'];

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-desk-rules-test',      // its own project; these run in parallel
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
      u('owner1',   { role: 'owner' }),
      u('super1',   { role: 'super_admin' }),
      u('rachel',   { role: 'admin_assistant' }),          // Admin Assistant
      u('admin1',   { role: 'admin' }),                    // Admin
      u('vin',      { role: 'director', centerMemberships: { [CENTRE]: { instructorType: 'Center Director' } } }),
      u('neeru',    { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Dir. of Education' } } }),
      u('mgr1',     { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Manager' } } }),
      u('host1',    { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Host' } } }),
      // Everybody who must NOT get in.
      u('lead1',    { role: 'instructor', centerMemberships: { [CENTRE]: { instructorType: 'Lead' } } }),
      u('inst1',    { role: 'instructor', instructorType: 'Instructor' }),
      u('vol1',     { role: 'instructor', centerMemberships: { [CENTRE]: { isVolunteer: true } } }),
      u('mgrOther', { role: 'instructor', centerIds: [OTHER], centerMemberships: { [OTHER]: { instructorType: 'Manager' } } }),
    ]);
  });
});

const seed = (coll, id, data) => testEnv.withSecurityRulesDisabled(
  (ctx) => setDoc(doc(ctx.firestore(), 'centers', CENTRE, coll, id), data),
);

const ref = (uid, coll, id) => doc(as(uid), 'centers', CENTRE, coll, id);

// The seven titles the centre named.
const ALLOWED = ['owner1', 'super1', 'rachel', 'admin1', 'vin', 'neeru', 'mgr1', 'host1'];
const REFUSED = ['lead1', 'inst1', 'vol1', 'mgrOther'];

describe('who may open the desk', () => {
  it('lets every management title read a note', async () => {
    await seed('notes', 'n1', note());
    for (const uid of ALLOWED) {
      await assertSucceeds(getDoc(ref(uid, 'notes', 'n1')));
    }
  });

  it('lets every management title write one', async () => {
    for (const uid of ALLOWED) {
      await assertSucceeds(setDoc(ref(uid, 'notes', `n-${uid}`), note({ fromUid: uid })));
    }
  });

  it('lets them settle one', async () => {
    await seed('notes', 'n1', note());
    await assertSucceeds(updateDoc(ref('mgr1', 'notes', 'n1'), { status: 'closed' }));
  });
});

describe('who may not', () => {
  it('shuts out Leads, instructors, volunteers and other centres — reads', async () => {
    // These notes carry parent account details and students' family
    // circumstances. Unlike centre events, there is no widened read.
    await seed('notes', 'n1', note());
    for (const uid of REFUSED) {
      await assertFails(getDoc(ref(uid, 'notes', 'n1')));
    }
  });

  it('shuts them out of writing too', async () => {
    for (const uid of REFUSED) {
      await assertFails(setDoc(ref(uid, 'notes', `n-${uid}`), note({ fromUid: uid })));
    }
  });

  it('shuts out a signed-out visitor', async () => {
    await seed('notes', 'n1', note());
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'centers', CENTRE, 'notes', 'n1')));
  });

  it('stops a Manager at another centre reaching into this one', async () => {
    // The permission is per-centre, not a global badge.
    await seed('notes', 'n1', note());
    await assertFails(getDoc(ref('mgrOther', 'notes', 'n1')));
    await assertFails(setDoc(ref('mgrOther', 'notes', 'n2'), note()));
  });
});

describe('the same gate guards all five collections', () => {
  it('admits a Manager to every one of them', async () => {
    for (const coll of COLLECTIONS) {
      await assertSucceeds(setDoc(ref('mgr1', coll, 'x1'), { note: 'row' }));
    }
  });

  it('refuses an instructor on every one of them', async () => {
    // Easy to add a collection and forget its rule; this is the check
    // that a new tab cannot quietly ship wide open.
    for (const coll of COLLECTIONS) {
      await assertFails(setDoc(ref('inst1', coll, 'x1'), { note: 'row' }));
    }
  });
});

describe('settle, do not erase', () => {
  it('stops a Manager or an Admin deleting a note', async () => {
    // 1,853 rows of history came over from the spreadsheet, and its value
    // is being able to look up what was decided. Settling is the verb;
    // deleting is not offered, and here is why it also is not permitted.
    await seed('notes', 'n1', note());
    await assertFails(deleteDoc(ref('mgr1', 'notes', 'n1')));
    await assertFails(deleteDoc(ref('admin1', 'notes', 'n1')));
    await assertFails(deleteDoc(ref('host1', 'notes', 'n1')));
  });

  it('leaves an owner able to remove a genuine mistake', async () => {
    await seed('notes', 'n1', note());
    await assertSucceeds(deleteDoc(ref('owner1', 'notes', 'n1')));
  });

  it('applies the same deletion rule to every tracker', async () => {
    for (const coll of COLLECTIONS) {
      await seed(coll, 'x1', { note: 'row' });
      await assertFails(deleteDoc(ref('mgr1', coll, 'x1')));
      await assertSucceeds(deleteDoc(ref('owner1', coll, 'x1')));
    }
  });
});

describe('a centre role granted notes.access in Manage Roles', () => {
  it('gets in without a code change', async () => {
    // The escape hatch: a centre that wants its Leads on the desk grants
    // the permission rather than waiting for a deploy.
    await testEnv.withSecurityRulesDisabled(ctx => setDoc(
      doc(ctx.firestore(), 'centers', CENTRE, 'config', 'main'),
      { staffRolePermissions: { Lead: ['notes.access'] } },
    ));
    await seed('notes', 'n1', note());
    await assertSucceeds(getDoc(ref('lead1', 'notes', 'n1')));
  });
});
