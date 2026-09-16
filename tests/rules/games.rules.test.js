/**
 * Firestore security-rules tests — Ratio Games.
 *
 *   npm run test:rules
 *
 * The maths runs in the browser and api/ is full (12 of 12), so no server
 * can mark a game. These rules are the whole of what is actually
 * enforceable, and the prize makes it worth pinning:
 *
 *   one run per person per game per day · you can only post your own score
 *   · the score is inside the cap · nobody edits history
 *
 * EVERY account plays, including volunteers and trainees — there is no
 * title or permission gate here, and that is deliberate rather than an
 * omission, so it is tested too.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const CENTRE = 'langley';
const OTHER = 'burnaby';
const TODAY = '2026-09-16';

let testEnv;
const as = (uid) => testEnv.authenticatedContext(uid).firestore();

/** What the client writes — buildScoreRow() in src/lib/ratioGames.js. */
const row = (uid, extra = {}) => ({
  uid, userName: uid, centerId: CENTRE, gameId: 'sprint60', date: TODAY,
  result: 9, points: 50, durationMs: 60000, seed: 'langley|2026-09-16',
  createdAt: '2026-09-16T17:00:00.000Z', ...extra,
});
const id = (uid, gameId = 'sprint60', date = TODAY) => `${uid}_${gameId}_${date}`;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-games-rules-test',   // its own project; files run in parallel
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});

afterAll(async () => { await testEnv.cleanup(); });

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const at = (centre, title, extra = {}) => ({
      approved: true, role: 'instructor', centerId: centre, centerIds: [centre],
      instructorType: title, centerMemberships: { [centre]: { instructorType: title } }, ...extra,
    });
    await Promise.all([
      setDoc(doc(db, 'users', 'inst'), at(CENTRE, 'Instructor')),
      setDoc(doc(db, 'users', 'vol'), at(CENTRE, 'Volunteer', { isVolunteer: true })),
      setDoc(doc(db, 'users', 'trainee'), at(CENTRE, 'Training')),
      setDoc(doc(db, 'users', 'mgr'), at(CENTRE, 'Manager')),
      setDoc(doc(db, 'users', 'owner'), at(CENTRE, 'Owner', { role: 'owner' })),
      setDoc(doc(db, 'users', 'outsider'), at(OTHER, 'Instructor')),
    ]);
  });
});

describe('everybody plays', () => {
  it.each(['inst', 'vol', 'trainee', 'mgr', 'owner'])('%s can post their own score', async (uid) => {
    await assertSucceeds(setDoc(doc(as(uid), 'centers', CENTRE, 'gameScores', id(uid)), row(uid)));
  });

  it('volunteers and trainees are in on purpose — they get the barest portal otherwise', async () => {
    // The same two accounts are refused Team Chat and the Job Board. Games
    // are deliberately not gated that way, so this pins the intent.
    for (const uid of ['vol', 'trainee']) {
      await assertSucceeds(setDoc(doc(as(uid), 'centers', CENTRE, 'gameScores', id(uid)), row(uid)));
    }
  });

  it('the whole centre can read the board', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'centers', CENTRE, 'gameScores', id('inst')), row('inst'));
    });
    for (const uid of ['inst', 'vol', 'trainee', 'mgr', 'owner']) {
      await assertSucceeds(getDocs(collection(as(uid), 'centers', CENTRE, 'gameScores')));
    }
  });

  it('but someone from another centre cannot', async () => {
    await assertFails(getDocs(collection(as('outsider'), 'centers', CENTRE, 'gameScores')));
    await assertFails(setDoc(doc(as('outsider'), 'centers', CENTRE, 'gameScores', id('outsider')), row('outsider')));
  });
});

describe('the centre switch', () => {
  // Turning Ratio Games on starts a contest with a prize, so it is the
  // owner's and Enterprise's alone — narrower than the rest of the centre
  // config, which several roles can write.
  const config = (extra = {}) => ({ name: 'Langley', operatingDays: ['Monday'], ...extra });

  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'centers', CENTRE, 'config', 'main'), config({ gamesEnabled: false }));
      await setDoc(doc(ctx.firestore(), 'users', 'aa'), {
        approved: true, role: 'admin_assistant', centerId: CENTRE, centerIds: [CENTRE],
        instructorType: 'Admin', centerMemberships: { [CENTRE]: { instructorType: 'Admin' } },
      });
      await setDoc(doc(ctx.firestore(), 'users', 'ent'), {
        approved: true, role: 'super_admin', centerId: CENTRE, centerIds: [CENTRE],
        instructorType: 'Instructor', centerMemberships: { [CENTRE]: { instructorType: 'Instructor' } },
      });
    });
  });

  it('the owner and Enterprise can switch it on and off', async () => {
    for (const uid of ['owner', 'ent']) {
      await assertSucceeds(setDoc(doc(as(uid), 'centers', CENTRE, 'config', 'main'), { gamesEnabled: true }, { merge: true }));
      await assertSucceeds(setDoc(doc(as(uid), 'centers', CENTRE, 'config', 'main'), { gamesEnabled: false }, { merge: true }));
    }
  });

  it('a Manager or the Admin Assistant cannot', async () => {
    for (const uid of ['mgr', 'aa']) {
      await assertFails(setDoc(doc(as(uid), 'centers', CENTRE, 'config', 'main'), { gamesEnabled: true }, { merge: true }));
    }
  });

  it('but they can still save every other setting', async () => {
    // The Centre Settings tab writes the whole config back on every save,
    // so an unchanged gamesEnabled has to pass or it would lock them out
    // of the page entirely.
    for (const uid of ['mgr', 'aa']) {
      await assertSucceeds(setDoc(
        doc(as(uid), 'centers', CENTRE, 'config', 'main'),
        config({ gamesEnabled: false, defaultMinPerDay: 9 }),
        { merge: true },
      ));
    }
  });

  it('and an instructor still cannot write the config at all', async () => {
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'config', 'main'), { gamesEnabled: true }, { merge: true }));
  });
});

describe('one run a day', () => {
  it('a second run at the same game today is refused', async () => {
    await assertSucceeds(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), row('inst')));
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), row('inst', { result: 18, points: 100 })));
  });

  it('and cannot be filed under a different name to get a second go', async () => {
    // The id has to match the fields inside it, or "one a day" is just a
    // naming convention rather than a rule.
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', 'inst_sprint60_second-go'), row('inst')));
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', 'anything'), row('inst')));
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst', 'sprint60', '2026-09-17')), row('inst')));
  });

  it('tomorrow is a new run', async () => {
    await assertSucceeds(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), row('inst')));
    await assertSucceeds(setDoc(
      doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst', 'sprint60', '2026-09-17')),
      row('inst', { date: '2026-09-17' }),
    ));
  });
});

describe('it has to be your own score', () => {
  it('nobody can post one for somebody else', async () => {
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('vol')), row('vol')));
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), row('inst', { uid: 'vol' })));
  });

  it('not even a Manager or the owner', async () => {
    for (const uid of ['mgr', 'owner']) {
      await assertFails(setDoc(doc(as(uid), 'centers', CENTRE, 'gameScores', id('inst')), row('inst')));
    }
  });

  it('and not onto another centre’s board', async () => {
    await assertFails(setDoc(doc(as('inst'), 'centers', OTHER, 'gameScores', id('inst')), row('inst')));
  });
});

describe('the score has to be plausible', () => {
  it('refuses anything above the cap', async () => {
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), row('inst', { points: 121 })));
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), row('inst', { points: 9000 })));
  });

  it('allows an exceptional but legal run', async () => {
    await assertSucceeds(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), row('inst', { points: 120, result: 40 })));
  });

  it('refuses negatives, non-numbers and missing fields', async () => {
    const bad = [
      { points: -10 }, { result: -1 }, { durationMs: -5 },
      { points: '100' }, { points: 50.5 }, { result: null },
    ];
    for (const patch of bad) {
      await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), row('inst', patch)));
    }
    // eslint-disable-next-line no-unused-vars
    const { points, ...noPoints } = row('inst');
    await assertFails(setDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst')), noPoints));
  });
});

describe('history stands', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'centers', CENTRE, 'gameScores', id('inst')), row('inst'));
    });
  });

  it('nobody can edit a score — not the player, not a Manager, not the owner', async () => {
    for (const uid of ['inst', 'mgr', 'owner']) {
      await assertFails(updateDoc(doc(as(uid), 'centers', CENTRE, 'gameScores', id('inst')), { points: 120 }));
    }
  });

  it('a player cannot delete a bad round and try again', async () => {
    await assertFails(deleteDoc(doc(as('inst'), 'centers', CENTRE, 'gameScores', id('inst'))));
    await assertFails(deleteDoc(doc(as('vol'), 'centers', CENTRE, 'gameScores', id('inst'))));
  });

  it('a Manager or the owner can void a bogus one — the only way a row goes', async () => {
    await assertSucceeds(deleteDoc(doc(as('mgr'), 'centers', CENTRE, 'gameScores', id('inst'))));
    await assertSucceeds(getDoc(doc(as('owner'), 'centers', CENTRE, 'gameScores', id('inst'))));
  });
});
