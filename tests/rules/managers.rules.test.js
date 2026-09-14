/**
 * Firestore security-rules tests — Managers took over the Admin role.
 *
 *   npm run test:rules
 *
 * On 2026-09-14 the Admin platform role was retired in favour of the
 * Manager job title: everything `role: 'admin'` unlocked is unlocked by
 * being Manager AT THAT CENTRE (isAdminOrManagerAt). Two things matter:
 *
 *   1. A Manager can do what the Admin role could — post announcements,
 *      use Management Chat, edit the Student Scheduler's students and
 *      settings, create meetings, see their own staff's contact details —
 *      so switching the Manager's account off the Admin role costs nothing.
 *   2. Only at their own centre. The old isManagerAt() also accepts a
 *      legacy top-level `instructorType: 'Manager'` at ANY centre; the
 *      admin-level checks must not, or a Manager at Burnaby could post
 *      Langley's announcements. Hosts and Leads stay out, as before.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs,
} from 'firebase/firestore';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const CENTRE = 'langley';
const OTHER = 'burnaby';

let testEnv;
const as = (uid) => testEnv.authenticatedContext(uid).firestore();

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-managers-rules-test',   // its own project; files run in parallel
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
      // Today's Manager: still on the Admin role.
      setDoc(doc(db, 'users', 'mgrAdmin'), at(CENTRE, 'Manager', { role: 'admin' })),
      // The same person after the switch: plain staff role, Manager title.
      setDoc(doc(db, 'users', 'mgr'), at(CENTRE, 'Manager')),
      // A Manager somewhere else, whose legacy top-level title also says Manager.
      setDoc(doc(db, 'users', 'mgrOther'), at(OTHER, 'Manager')),
      setDoc(doc(db, 'users', 'host'), at(CENTRE, 'Host')),
      setDoc(doc(db, 'users', 'lead'), at(CENTRE, 'Lead')),
      setDoc(doc(db, 'users', 'inst'), at(CENTRE, 'Instructor')),
      setDoc(doc(db, 'users', 'owner'), at(CENTRE, 'Instructor', { role: 'owner' })),
      // Staff whose private details are being asked for.
      setDoc(doc(db, 'users', 'staffHere'), at(CENTRE, 'Instructor')),
      setDoc(doc(db, 'users', 'staffThere'), at(OTHER, 'Instructor')),
      setDoc(doc(db, 'users', 'staffHere', 'private', 'contact'), { email: 'here@example.com', phone: '604-555-0100' }),
      setDoc(doc(db, 'users', 'staffThere', 'private', 'contact'), { email: 'there@example.com', phone: '604-555-0199' }),
      // Existing documents.
      setDoc(doc(db, 'announcements', 'a1'), { centerId: CENTRE, title: 'Staff meeting', body: 'Saturday 3pm' }),
      setDoc(doc(db, 'centerLeadership', 'm-here'), { centerId: CENTRE, userId: 'owner', text: 'Budget is up' }),
      setDoc(doc(db, 'centerLeadership', 'm-there'), { centerId: OTHER, userId: 'someone', text: 'Burnaby only' }),
      setDoc(doc(db, 'chat', 'swap1'), { centerId: CENTRE, type: 'shift_swap', userId: 'staffHere', swapStatus: 'accepted' }),
      setDoc(doc(db, 'centers', CENTRE, 'demandSnapshots', '2026-09-14'), { peak: 12 }),
      setDoc(doc(db, 'centers', CENTRE, 'connectors', 'apptoto'), { connected: true }),
    ]);
  });
});

describe('announcements', () => {
  const post = (centre) => ({ centerId: centre, title: 'Fun day Friday', body: 'Bingo' });

  it('a Manager posts, edits and removes their own centre’s', async () => {
    await assertSucceeds(setDoc(doc(as('mgr'), 'announcements', 'new'), post(CENTRE)));
    await assertSucceeds(updateDoc(doc(as('mgr'), 'announcements', 'a1'), { body: 'Saturday 2pm' }));
    await assertSucceeds(deleteDoc(doc(as('mgr'), 'announcements', 'a1')));
  });

  it('still works for the account on the Admin role, until it is switched', async () => {
    await assertSucceeds(setDoc(doc(as('mgrAdmin'), 'announcements', 'new'), post(CENTRE)));
  });

  it('a Manager cannot post to another centre, or move one there', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'announcements', 'new'), post(OTHER)));
    await assertFails(updateDoc(doc(as('mgr'), 'announcements', 'a1'), { centerId: OTHER }));
  });

  it('a Manager from another centre cannot touch this one’s', async () => {
    await assertFails(setDoc(doc(as('mgrOther'), 'announcements', 'new'), post(CENTRE)));
    await assertFails(deleteDoc(doc(as('mgrOther'), 'announcements', 'a1')));
  });

  it('Hosts, Leads and Instructors still cannot post', async () => {
    for (const uid of ['host', 'lead', 'inst']) {
      await assertFails(setDoc(doc(as(uid), 'announcements', `n-${uid}`), post(CENTRE)));
    }
  });
});

describe('Management Chat', () => {
  it('a Manager reads and writes their centre’s', async () => {
    await assertSucceeds(getDoc(doc(as('mgr'), 'centerLeadership', 'm-here')));
    await assertSucceeds(getDocs(query(collection(as('mgr'), 'centerLeadership'), where('centerId', '==', CENTRE))));
    await assertSucceeds(setDoc(doc(as('mgr'), 'centerLeadership', 'm-new'), { centerId: CENTRE, userId: 'mgr', text: 'On it' }));
  });

  it('but not another centre’s', async () => {
    await assertFails(getDoc(doc(as('mgr'), 'centerLeadership', 'm-there')));
    await assertFails(getDocs(query(collection(as('mgr'), 'centerLeadership'), where('centerId', '==', OTHER))));
    await assertFails(getDoc(doc(as('mgrOther'), 'centerLeadership', 'm-here')));
  });

  it('a Manager cannot post as somebody else', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'centerLeadership', 'm-fake'), { centerId: CENTRE, userId: 'owner', text: 'Hi' }));
  });

  it('stays closed to Hosts and Leads', async () => {
    await assertFails(getDoc(doc(as('host'), 'centerLeadership', 'm-here')));
    await assertFails(getDoc(doc(as('lead'), 'centerLeadership', 'm-here')));
  });
});

describe('centre data the Admin role could write', () => {
  const cases = [
    ['Student Scheduler students', ['centers', CENTRE, 'schedulerStudents', 's1'], { name: 'Sample Student' }],
    ['Student Scheduler name matches', ['centers', CENTRE, 'schedulerAliases', 'x1'], { alias: 'Sam', canonical: 'Sample Student' }],
    ['Student Scheduler settings', ['centers', CENTRE, 'schedulerSettings', 'main'], { highlightLegend: {} }],
    ['a staff meeting', ['centers', CENTRE, 'events', 'e1'], { type: 'meeting', title: 'Staff meeting', date: '2026-09-19' }],
    ['centre config', ['centers', CENTRE, 'config', 'main'], { staffingBudget: {} }],
    ['connectors', ['centers', CENTRE, 'connectors', 'apptoto'], { connected: false }],
  ];

  it.each(cases)('a Manager can write %s', async (_, path, data) => {
    await assertSucceeds(setDoc(doc(as('mgr'), ...path), data));
  });

  it.each(cases)('a Manager from another centre cannot write %s', async (_, path, data) => {
    await assertFails(setDoc(doc(as('mgrOther'), ...path), data));
  });

  it('Hosts and Leads still cannot write the students list or a meeting', async () => {
    for (const uid of ['host', 'lead']) {
      await assertFails(setDoc(doc(as(uid), 'centers', CENTRE, 'schedulerStudents', 's1'), { name: 'X' }));
      await assertFails(setDoc(doc(as(uid), 'centers', CENTRE, 'events', 'e1'), { type: 'meeting', title: 'X' }));
    }
  });

  it('a Manager reads demand snapshots; a Lead does not', async () => {
    await assertSucceeds(getDoc(doc(as('mgr'), 'centers', CENTRE, 'demandSnapshots', '2026-09-14')));
    await assertFails(getDoc(doc(as('lead'), 'centers', CENTRE, 'demandSnapshots', '2026-09-14')));
  });
});

describe('staff contact details', () => {
  it('a Manager sees the contact details of staff at their centre', async () => {
    await assertSucceeds(getDoc(doc(as('mgr'), 'users', 'staffHere', 'private', 'contact')));
  });

  it('but not staff elsewhere — narrower than the Admin role was', async () => {
    await assertFails(getDoc(doc(as('mgr'), 'users', 'staffThere', 'private', 'contact')));
    await assertFails(getDoc(doc(as('mgrOther'), 'users', 'staffHere', 'private', 'contact')));
  });

  it('Hosts and Instructors still do not', async () => {
    await assertFails(getDoc(doc(as('host'), 'users', 'staffHere', 'private', 'contact')));
    await assertFails(getDoc(doc(as('inst'), 'users', 'staffHere', 'private', 'contact')));
  });
});

describe('clearing swap posts off the board', () => {
  it('a Manager can remove one at their centre', async () => {
    await assertSucceeds(deleteDoc(doc(as('mgr'), 'chat', 'swap1')));
  });

  it('a Manager elsewhere and a Host cannot', async () => {
    await assertFails(deleteDoc(doc(as('mgrOther'), 'chat', 'swap1')));
    await assertFails(deleteDoc(doc(as('host'), 'chat', 'swap1')));
  });
});
