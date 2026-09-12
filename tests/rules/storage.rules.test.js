/**
 * Firebase Storage rules — the fun-day calendar image.
 *
 *   npm run test:rules
 *
 * The centre already makes a fun-day sheet every month, so the useful
 * thing is to upload THAT rather than retype it. Which makes this a
 * user-uploaded surface that everybody sees, so the gate matters: without
 * one, any signed-in instructor could overwrite the month on display, or
 * delete it.
 *
 * The rule resolves against the same titles as canRunFunDaysAt() in
 * firestore.rules, by reading the user's profile across from Firestore.
 * These tests exist mostly to prove that cross-service lookup works at
 * all — it is the part most likely to be silently wrong.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const C = 'langley';
let testEnv;

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const meta = { contentType: 'image/png' };
/** Your own folder. `owner` lets a test aim at somebody else's. */
const at = (uid, name = '2026-09.png', owner = uid) =>
  ref(testEnv.authenticatedContext(uid).storage(), `centers/${C}/fun-days/${owner}/${name}`);

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-storage-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
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
      u('rahul',  { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Host' } } }),
      u('mgr',    { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Manager' } } }),
      u('inst',   { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Instructor' } } }),
      u('vol',    { role: 'instructor', centerMemberships: { [C]: { isVolunteer: true } } }),
      // A Host at a DIFFERENT centre — the title is per centre.
      u('other',  { role: 'instructor', centerIds: ['chilliwack'],
        centerMemberships: { chilliwack: { instructorType: 'Host' } } }),
    ]);
  });
});

describe('uploading the month', () => {
  it('lets anybody signed in put a file in their OWN folder', async () => {
    for (const uid of ['rahul', 'mgr', 'owner1', 'inst']) {
      await assertSucceeds(uploadBytes(at(uid), png(), meta));
    }
  });

  it('stops anybody writing into somebody else\u2019s folder', async () => {
    // The property that matters here: nobody can overwrite or replace a
    // file that is not theirs. WHICH file the centre sees is decided in
    // Firestore, by canRunFunDaysAt, and tested there.
    await assertFails(uploadBytes(at('inst', '2026-09.png', 'rahul'), png(), meta));
    await assertFails(uploadBytes(at('rahul', '2026-09.png', 'owner1'), png(), meta));
  });

  it('refuses a signed-out visitor', async () => {
    const anon = ref(testEnv.unauthenticatedContext().storage(), `centers/${C}/fun-days/rahul/x.png`);
    await assertFails(uploadBytes(anon, png(), meta));
  });

  it('refuses anything that is not an image', async () => {
    await assertFails(uploadBytes(at('rahul', 'notes.txt'), png(), { contentType: 'text/plain' }));
  });
});

describe('seeing it', () => {
  it('is readable by every signed-in member of staff \u2014 it is a poster', async () => {
    await uploadBytes(at('rahul'), png(), meta);
    for (const uid of ['inst', 'vol', 'mgr']) {
      await assertSucceeds(getBytes(at(uid, '2026-09.png', 'rahul')));
    }
  });

  it('is not readable signed out', async () => {
    await uploadBytes(at('rahul'), png(), meta);
    const anon = ref(testEnv.unauthenticatedContext().storage(), `centers/${C}/fun-days/rahul/2026-09.png`);
    await assertFails(getBytes(anon));
  });
});

describe('taking it down', () => {
  it('lets you remove your own', async () => {
    await uploadBytes(at('rahul'), png(), meta);
    await assertSucceeds(deleteObject(at('rahul')));
  });

  it('stops anybody deleting somebody else\u2019s', async () => {
    await uploadBytes(at('rahul'), png(), meta);
    await assertFails(deleteObject(at('inst', '2026-09.png', 'rahul')));
  });
});

describe('nothing else in the bucket moved', () => {
  it('still blocks an unrelated path', async () => {
    const stray = ref(testEnv.authenticatedContext('owner1').storage(), 'random/thing.png');
    await assertFails(uploadBytes(stray, png(), meta));
  });

  it('still lets somebody write their own profile picture and not another\u2019s', async () => {
    const mine = ref(testEnv.authenticatedContext('rahul').storage(), 'profile-pictures/rahul/a.png');
    const theirs = ref(testEnv.authenticatedContext('rahul').storage(), 'profile-pictures/inst/a.png');
    await assertSucceeds(uploadBytes(mine, png(), meta));
    await assertFails(uploadBytes(theirs, png(), meta));
  });
});
