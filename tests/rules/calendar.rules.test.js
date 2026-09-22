/**
 * Firestore security-rules tests — the Ratio Calendar.
 *
 *   npm run test:rules
 *
 * An entry here is not an announcement with a date on it. It names the
 * people it is assigned to, its title can carry a candidate's or a
 * parent's name, and with `holdsBooking` it takes real time off the
 * PUBLIC booking page — api/intakes.js reads these rows and hands them to
 * the slot engine. So unlike `events` next door, read is not widened to
 * the whole centre, and the write tier is management rather than whoever
 * runs the floor.
 *
 * The list has to match calendar.access in src/lib/roles.js. These tests
 * are what says so out loud.
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
const ref = (uid, id) => doc(as(uid), 'centers', C, 'calendar', id);

const entry = (over = {}) => ({
  title: 'Radius training', kind: 'training', date: '2026-09-25',
  startTime: '15:00', endTime: '17:00', allDay: false,
  assignedTo: ['neeru'], assignedNames: ['Neeru Gill'],
  holdsBooking: true, note: '', ...over,
});

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ratio-calendar-rules-test',
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
      u('neeru',  { role: 'director', centerMemberships: { [C]: { instructorType: 'Dir. of Education' } } }),
      u('rachel', { role: 'admin_assistant', centerMemberships: { [C]: { instructorType: 'Admin' } } }),
      u('mgr',    { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Manager' } } }),
      u('rahul',  { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Host' } } }),
      u('lead',   { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Lead' } } }),
      u('inst',   { role: 'instructor', centerMemberships: { [C]: { instructorType: 'Instructor' } } }),
      u('trainee',{ role: 'instructor', centerMemberships: { [C]: { instructorType: 'Training' } } }),
      u('vol',    { role: 'instructor', centerMemberships: { [C]: { isVolunteer: true } } }),
      // A Host at another centre. Their title must not reach in here.
      u('other',  { role: 'instructor', centerIds: ['chilliwack'],
                    centerMemberships: { chilliwack: { instructorType: 'Host' } } }),
    ]);
  });
});

const seed = (id, data) => testEnv.withSecurityRulesDisabled(
  (ctx) => setDoc(doc(ctx.firestore(), 'centers', C, 'calendar', id), data));

/** Everyone Rahul named: owners, both directors, managers, AA, hosts. */
const ALLOWED = ['owner1', 'vin', 'neeru', 'rachel', 'mgr', 'rahul'];
const REFUSED = ['lead', 'inst', 'trainee', 'vol', 'other'];

describe('who may open the Calendar', () => {
  it.each(ALLOWED)('%s can read an entry', async (uid) => {
    await seed('e1', entry());
    await assertSucceeds(getDoc(ref(uid, 'e1')));
  });

  it.each(REFUSED)('%s cannot read an entry', async (uid) => {
    await seed('e1', entry());
    await assertFails(getDoc(ref(uid, 'e1')));
  });

  it('a signed-out visitor cannot read one', async () => {
    await seed('e1', entry());
    await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), 'centers', C, 'calendar', 'e1')));
  });
});

describe('writing an entry', () => {
  it.each(ALLOWED)('%s can create one', async (uid) => {
    await assertSucceeds(setDoc(ref(uid, `c-${uid}`), entry()));
  });

  it.each(REFUSED)('%s cannot create one', async (uid) => {
    await assertFails(setDoc(ref(uid, `c-${uid}`), entry()));
  });

  it.each(ALLOWED)('%s can update and delete one', async (uid) => {
    await seed('e1', entry());
    await assertSucceeds(updateDoc(ref(uid, 'e1'), { title: 'Moved' }));
    await assertSucceeds(deleteDoc(ref(uid, 'e1')));
  });

  it.each(REFUSED)('%s cannot update or delete one', async (uid) => {
    await seed('e1', entry());
    await assertFails(updateDoc(ref(uid, 'e1'), { title: 'Moved' }));
    await assertFails(deleteDoc(ref(uid, 'e1')));
  });
});

describe('the hold is the part with teeth', () => {
  it('a Lead cannot close Friday afternoon to bookings', async () => {
    // The specific thing this tier exists for. A Lead runs the floor for
    // a shift; taking assessment slots off the public page is not that
    // job, and it is the one write here that reaches outside the app.
    await assertFails(setDoc(ref('lead', 'hold'), entry({ holdsBooking: true })));
  });

  it('a Lead cannot add a harmless-looking entry either', async () => {
    // holdsBooking is a field on an ordinary-looking document, so a rule
    // that allowed "entries but not holds" would be one updateDoc away
    // from being no rule at all.
    await assertFails(setDoc(ref('lead', 'soft'), entry({ holdsBooking: false })));
  });

  it('a Lead cannot release a hold somebody else set', async () => {
    await seed('e1', entry({ holdsBooking: true }));
    await assertFails(updateDoc(ref('lead', 'e1'), { holdsBooking: false }));
  });

  it('a Host, who is on the list, can set one', async () => {
    // Hosts book the interviews and the parent calls. Leaving them out
    // would mean asking somebody else to enter their own work.
    await assertSucceeds(setDoc(ref('rahul', 'h1'), entry({ holdsBooking: true })));
  });
});

describe('it is not the fun-day calendar', () => {
  it('a Lead who may write a fun day still cannot write here', async () => {
    // Fun days were deliberately opened to whoever runs the floor. This
    // collection was deliberately not.
    await assertSucceeds(setDoc(
      doc(as('lead'), 'centers', C, 'events', 'f1'),
      { title: 'Bingo', date: '2026-09-16', type: 'fun-day', note: '' },
    ));
    await assertFails(setDoc(ref('lead', 'f1'), entry({ kind: 'task' })));
  });

  it('an instructor can read the fun day and not the calendar', async () => {
    await testEnv.withSecurityRulesDisabled((ctx) => setDoc(
      doc(ctx.firestore(), 'centers', C, 'events', 'f1'),
      { title: 'Bingo', date: '2026-09-16', type: 'fun-day' },
    ));
    await seed('e1', entry());
    await assertSucceeds(getDoc(doc(as('inst'), 'centers', C, 'events', 'f1')));
    await assertFails(getDoc(ref('inst', 'e1')));
  });
});

describe('a centre can widen it in Manage Roles', () => {
  const grantLead = (perms) => testEnv.withSecurityRulesDisabled(
    (ctx) => setDoc(doc(ctx.firestore(), 'centers', C, 'config', 'main'),
      { staffRolePermissions: { Lead: perms } }, { merge: true }),
  );

  it('a Lead granted calendar.access gets in', async () => {
    await grantLead(['scheduler.run', 'calendar.access']);
    await assertSucceeds(setDoc(ref('lead', 'g1'), entry()));
  });

  it('a Lead granted something else does not', async () => {
    await grantLead(['scheduler.run', 'notes.access']);
    await assertFails(setDoc(ref('lead', 'g2'), entry()));
  });

  it('granting it at this centre does not let another centre-s staff in', async () => {
    await grantLead(['scheduler.run', 'calendar.access']);
    await assertFails(setDoc(ref('other', 'g3'), entry()));
  });
});
