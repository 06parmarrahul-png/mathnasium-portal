/**
 * Firestore security-rules tests — the fun-day calendar.
 *
 *   npm run test:rules
 *
 * A Host could read the fun-day calendar and not write to it, which made
 * it nobody's job to keep: the people who actually know what is happening
 * on the floor could not enter a single day. Fun days are now open to
 * whoever runs the floor — and nothing else about events moved, which is
 * what most of these tests are for.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const C = 'langley';
let testEnv;
const as = (uid) => testEnv.authenticatedContext(uid).firestore();
const ref = (uid, id) => doc(as(uid), 'centers', C, 'events', id);

const funDay = (over = {}) => ({ title: 'Bingo', date: '2026-09-16', type: 'fun-day', note: '', ...over });
const meeting = (over = {}) => ({ title: 'Staff meeting', date: '2026-09-19', type: 'meeting', ...over });

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-funday-rules-test',
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
      u('vol',    { role: 'instructor', centerMemberships: { [C]: { isVolunteer: true } } }),
      u('other',  { role: 'instructor', centerIds: ['chilliwack'], centerMemberships: { chilliwack: { instructorType: 'Host' } } }),
    ]);
  });
});

const seed = (id, data) => testEnv.withSecurityRulesDisabled(
  (ctx) => setDoc(doc(ctx.firestore(), 'centers', C, 'events', id), data));

describe('who may run the fun-day calendar', () => {
  it('lets the people who run the floor add one', async () => {
    // The designated host is the whole reason this changed.
    for (const uid of ['rahul', 'mgr', 'lead', 'vin', 'owner1']) {
      await assertSucceeds(setDoc(ref(uid, `f-${uid}`), funDay()));
    }
  });

  it('lets them edit and clear one', async () => {
    await seed('f1', funDay());
    await assertSucceeds(updateDoc(ref('rahul', 'f1'), { title: 'Double Bingo!' }));
    await assertSucceeds(deleteDoc(ref('mgr', 'f1')));
  });

  it('still refuses an instructor and a volunteer', async () => {
    await assertFails(setDoc(ref('inst', 'f2'), funDay()));
    await assertFails(setDoc(ref('vol', 'f3'), funDay()));
  });

  it('refuses a Host from another centre', async () => {
    await assertFails(setDoc(ref('other', 'f4'), funDay()));
  });
});

describe('nothing else about events moved', () => {
  it('still refuses a Host a staff meeting', async () => {
    // Meetings are an announcement with a date on them, and stay at the
    // announcements tier.
    await assertFails(setDoc(ref('rahul', 'm1'), meeting()));
    await assertFails(setDoc(ref('mgr', 'm2'), meeting({ type: 'training' })));
  });

  it('stops a meeting being relabelled a fun day to get at it', async () => {
    // The type is checked on BOTH sides of an update for exactly this.
    await seed('m1', meeting());
    await assertFails(updateDoc(ref('rahul', 'm1'), { type: 'fun-day' }));
  });

  it('stops a fun day being turned INTO a meeting by the floor', async () => {
    await seed('f1', funDay());
    await assertFails(updateDoc(ref('rahul', 'f1'), { type: 'meeting' }));
  });

  it('stops a Host deleting a staff meeting', async () => {
    await seed('m1', meeting());
    await assertFails(deleteDoc(ref('rahul', 'm1')));
  });

  it('leaves owners and directors able to do all of it', async () => {
    await assertSucceeds(setDoc(ref('owner1', 'm1'), meeting()));
    await assertSucceeds(setDoc(ref('vin', 'm2'), meeting()));
  });

  it('keeps reading open to every member of the centre', async () => {
    await seed('f1', funDay());
    for (const uid of ['inst', 'vol', 'rahul', 'mgr']) {
      await assertSucceeds(getDoc(ref(uid, 'f1')));
    }
  });
});

describe('the uploaded calendar image', () => {
  const cal = (over = {}) => ({
    month: '2026-09', imageUrl: 'https://example/x.png',
    storagePath: `centers/${C}/fun-days/rahul/2026-09.png`,
    uploadedBy: 'Rahul Parmar', uploadedAt: '2026-09-12T00:00:00.000Z', ...over,
  });
  const calRef = (uid, month = '2026-09') =>
    doc(as(uid), 'centers', C, 'funDayCalendars', month);
  const seedCal = (month, data) => testEnv.withSecurityRulesDisabled(
    (ctx) => setDoc(doc(ctx.firestore(), 'centers', C, 'funDayCalendars', month), data));

  it('lets the floor put the month up, and take it down', async () => {
    await assertSucceeds(setDoc(calRef('rahul'), cal()));
    await assertSucceeds(updateDoc(calRef('rahul'), { imageUrl: 'https://example/y.png' }));
    await assertSucceeds(deleteDoc(calRef('mgr')));
  });

  it('stops an instructor changing what the centre looks at', async () => {
    // Storage lets them upload into their own folder on purpose. THIS is
    // the rule that stops that becoming everybody's problem.
    await seedCal('2026-09', cal());
    await assertFails(updateDoc(calRef('inst'), { imageUrl: 'https://example/mine.png' }));
    await assertFails(setDoc(calRef('inst', '2026-10'), cal({ month: '2026-10' })));
    await assertFails(deleteDoc(calRef('inst')));
  });

  it('stops a volunteer and another centre', async () => {
    await assertFails(setDoc(calRef('vol', '2026-11'), cal()));
    await assertFails(setDoc(calRef('other', '2026-11'), cal()));
  });

  it('lets every member of the centre see it', async () => {
    await seedCal('2026-09', cal());
    for (const uid of ['inst', 'vol', 'rahul', 'mgr']) {
      await assertSucceeds(getDoc(calRef(uid)));
    }
  });
});
