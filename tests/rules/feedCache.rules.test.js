/**
 * Firestore security-rules tests — the Acuity day cache.
 *
 *   npm run test:rules
 *
 * `schedulerDays` is what the Student Scheduler and Supply & Demand actually
 * render from, and clients SUBSCRIBE to it. Two things have to hold:
 *
 *   - everyone who runs the floor can read it, or the pages show an empty day
 *     and look broken;
 *   - nobody can write it, because a write would put wrong students on every
 *     screen at once. It is written only by the Admin SDK, which bypasses
 *     rules entirely.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const C = 'langley';
const DATE = '2026-09-15';
let testEnv;
const as = (uid) => testEnv.authenticatedContext(uid).firestore();
const dayRef = (uid, d = DATE) => doc(as(uid), 'centers', C, 'schedulerDays', d);
const metaRef = (uid) => doc(as(uid), 'centers', C, 'schedulerCache', 'meta');

const dayDoc = {
  day: DATE,
  slots: [],
  totals: { HS: 39, EM: 72, Online: 7, Unknown: 1, all: 119 },
  unknownList: [],
  refreshedAt: '2026-09-16T04:18:08.522Z',
};

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-feedcache-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
afterAll(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const u = (id, d) => setDoc(doc(db, 'users', id), { approved: true, centerIds: [C], ...d });
    await Promise.all([
      u('owner1', { role: 'owner' }),
      u('vin',    { role: 'director', centerMemberships: { [C]: { instructorType: 'Center Director' } } }),
      u('rahul',  { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Host' } } }),
      u('mgr',    { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Manager' } } }),
      u('lead',   { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Lead' } } }),
      u('inst',   { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Instructor' } } }),
      u('other',  { role: 'instructor', centerIds: ['chilliwack'], centerMemberships: { chilliwack: { instructorType: 'Manager' } } }),
      // Rahul's REAL document, field for field. A thin fixture passed while
      // the live account was refused, so the shape matters: rules run out of
      // budget on big documents and a denial looks identical to "no data".
      u('rahulReal', {
        role: 'instructor', approved: true, centerIds: [C],
        instructorType: 'Host', guaranteed: true, priority: 1,
        displayName: 'Rahul Parmar', firstName: 'Rahul', lastName: 'Parmar',
        subRoles: ['Elementary', 'Host'],
        bio: 'x'.repeat(200), calendarToken: 'y'.repeat(64), careerPlan: { goal: 'z'.repeat(200) },
        centerId: C, centersChangedAt: '2026-01-01', centersChangedBy: 'owner1',
        hireDate: '2024-01-01', mascot: 'classic',
        photoPath: 'p'.repeat(120), photoURL: 'https://example.com/' + 'q'.repeat(120),
        profileUpdatedAt: '2026-09-01', uid: 'rahulReal',
        centerMemberships: { [C]: {
          priority: 1, maxDaysPerWeek: 5, guaranteed: true, approved: true,
          isVolunteer: false, subRoles: ['Elementary', 'Host'], instructorType: 'Host',
        } },
      }),
    ]);
    await setDoc(doc(db, 'centers', C, 'schedulerDays', DATE), dayDoc);
    await setDoc(doc(db, 'centers', C, 'schedulerCache', 'meta'),
      { refreshedAt: dayDoc.refreshedAt, hashes: { [DATE]: 'abc' } });
  });
});

describe('reading the day cache', () => {
  it('lets everyone who runs the floor read a day', async () => {
    // If any of these are refused the page renders an empty day, which reads
    // as "no bookings" rather than "you were denied" — the exact failure this
    // suite exists to catch.
    for (const uid of ['owner1', 'vin', 'rahul', 'mgr', 'lead']) {
      await assertSucceeds(getDoc(dayRef(uid)));
    }
  });

  it('lets the REAL host document read a day', async () => {
    // The owner account worked and the host account did not. An owner exits
    // canRunFloor on its first clause; a host falls through every one of
    // them, which is the expensive path and the one that breaks.
    await assertSucceeds(getDoc(dayRef('rahulReal')));
  });

  it('lets them read the refresh bookkeeping too', async () => {
    await assertSucceeds(getDoc(metaRef('owner1')));
    await assertSucceeds(getDoc(metaRef('mgr')));
  });

  it("refuses another centre's manager", async () => {
    await assertFails(getDoc(dayRef('other')));
  });
});

describe('writing the day cache', () => {
  it('refuses every client, including the owner', async () => {
    // Written only by the Admin SDK. A client write would put wrong students
    // on every subscribed screen at once.
    for (const uid of ['owner1', 'vin', 'mgr', 'rahul', 'inst']) {
      await assertFails(setDoc(dayRef(uid, '2026-09-20'), dayDoc));
    }
  });

  it('refuses edits and deletes of an existing day', async () => {
    await assertFails(updateDoc(dayRef('owner1'), { totals: { all: 0 } }));
    await assertFails(deleteDoc(dayRef('owner1')));
  });

  it('refuses writes to the refresh bookkeeping', async () => {
    await assertFails(setDoc(metaRef('owner1'), { refreshedAt: 'tampered' }));
    await assertFails(updateDoc(metaRef('mgr'), { hashes: {} }));
  });
});
