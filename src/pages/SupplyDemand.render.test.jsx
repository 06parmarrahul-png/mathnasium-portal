// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

/**
 * Supply & Demand, rendered.
 *
 * The point of the rebuild: two charts, one per side, with supply read
 * from the Student Scheduler's own side assignments. So the tests worth
 * having are that the numbers on screen are the ones Neeru typed, that
 * each side is counted against its own students, and that a day with no
 * sides set says so instead of showing an empty floor.
 */

const docs = {};          // path -> data for doc() reads
const collections = {};   // path -> array of docs

vi.mock('../firebase', () => ({ db: {}, auth: { currentUser: { uid: 'owner1' } }, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __path: a.slice(1).join('/') }),
  doc: (...a) => ({ __path: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}),
  onSnapshot: (ref, next) => {
    if (typeof next !== 'function') return () => {};
    const path = ref.__path;
    if (path in docs) next({ exists: () => docs[path] != null, data: () => docs[path] });
    else {
      const rows = collections[path] || [];
      next({ docs: rows.map((r, i) => ({ id: r.id || `d${i}`, data: () => r })), forEach(f) { this.docs.forEach(f); } });
    }
    return () => {};
  },
}));
vi.mock('../lib/demand-snapshots', () => ({
  getSnapshot: async () => null,
  saveSnapshot: vi.fn(),
  computeTypicalDemand: async () => ({}),
}));
vi.mock('../lib/schedulerFeed', () => ({
  watchFeedDay: (centerId, date, cb) => { cb({ grouped: globalThis.__feed, refreshedAt: null, loading: false, error: null }); return () => {}; },
  requestFeedRefresh: vi.fn(),
  describeAge: () => 'just now',
}));
vi.mock('../lib/notify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The Student Scheduler's own watchers — the page reads check-ins and
// walk-ins through these, so the test hands them the document shapes the
// scheduler really writes.
vi.mock('../lib/scheduler-data', () => ({
  watchCheckIns: (c, d, cb) => { cb(globalThis.__checkIns || {}); return () => {}; },
  watchWalkIns: (c, d, cb) => { cb(globalThis.__addOns || {}); return () => {}; },
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authValue.current, useOptionalAuth: () => authValue.current }));

const { default: SupplyDemand } = await import('./SupplyDemand');

const TODAY = new Date().toISOString().slice(0, 10);
const CENTRE = 'langley';

// Instructional hours give the chart its half hours: 3:00–5:00pm = 4 slots.
const CONFIG = {
  instructionalHours: Object.fromEntries(
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      .map(d => [d, { start: '15:00', end: '17:00' }]),
  ),
};

const student = (name, slot) => ({ id: `${name}-${slot}`, name, duration: 30 });

beforeEach(() => {
  for (const k of Object.keys(docs)) delete docs[k];
  for (const k of Object.keys(collections)) delete collections[k];
  authValue.current = { activeCenterId: CENTRE, centerConfig: CONFIG, canSeeCenterSettings: true };
  // Four high schoolers and two elementary students at 3:00.
  globalThis.__feed = {
    slots: [{
      slot: '15:00',
      students: {
        EM: { onHour: [student('Sample EM One', '15:00'), student('Sample EM Two', '15:00')], halfHour: [] },
        HS: { onHour: [student('Sample HS One', '15:00'), student('Sample HS Two', '15:00'),
          student('Sample HS Three', '15:00'), student('Sample HS Four', '15:00')], halfHour: [] },
      },
    }],
  };
  collections[`shifts`] = [];
  globalThis.__checkIns = {};
  globalThis.__addOns = {};
  collections['users'] = [
    { id: 'u1', uid: 'u1', displayName: 'Ann Park', centerMemberships: { [CENTRE]: { instructorType: 'Instructor' } } },
    { id: 'u2', uid: 'u2', displayName: 'Trainee Tom', centerMemberships: { [CENTRE]: { instructorType: 'Training' } } },
  ];
  docs[`centers/${CENTRE}/schedulerInstructorAssignments/${TODAY}`] = {
    'EM|15:00': ['Ann Park', 'Bo Ng'],
    'HS|15:00': ['Cy Diaz', 'Trainee Tom'],
  };
});
afterEach(() => { cleanup(); delete globalThis.__feed; delete globalThis.__checkIns; delete globalThis.__addOns; });

const cardFor = (title) => screen.getByRole('heading', { name: new RegExp(title) }).closest('div.rounded-2xl');

describe('one chart per side', () => {
  it('renders Elementary / Middle and High School, not one combined chart', () => {
    render(<SupplyDemand />);
    expect(screen.getByRole('heading', { name: /Elementary \/ Middle — Supply vs\. Demand/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /High School — Supply vs\. Demand/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Centre — Supply vs\. Demand/ })).toBeNull();
  });

  it('counts each side against its own students', () => {
    render(<SupplyDemand />);
    // 2 elementary students, 4 high schoolers.
    expect(within(cardFor('Elementary / Middle')).getAllByDisplayValue('2').length).toBeGreaterThan(0);
    expect(within(cardFor('High School')).getAllByDisplayValue('4').length).toBeGreaterThan(0);
  });

  it('takes supply from the Student Scheduler and says so', () => {
    render(<SupplyDemand />);
    const em = within(cardFor('Elementary / Middle'));
    expect(em.getByText(/Supply from the/)).toBeTruthy();
    expect(em.getByText('Student Scheduler')).toBeTruthy();
  });

  it('leaves a trainee out of the count, and names them', () => {
    render(<SupplyDemand />);
    const hs = within(cardFor('High School'));
    // Cy Diaz counts, Trainee Tom does not.
    expect(hs.getByText(/Not counted: Trainee Tom \(trainee\)/)).toBeTruthy();
  });

  it('counts the people on each side — two on Elementary, one on High School', () => {
    render(<SupplyDemand />);
    // Ann Park + Bo Ng on Elementary; Cy Diaz on High School (Tom is a trainee).
    expect(within(cardFor('Elementary / Middle')).getByText('2 instructors')).toBeTruthy();
    expect(within(cardFor('High School')).getByText('1 instructor')).toBeTruthy();
  });
});

describe('a day with no sides set', () => {
  beforeEach(() => {
    docs[`centers/${CENTRE}/schedulerInstructorAssignments/${TODAY}`] = {};
    collections['shifts'] = [
      { userName: 'Ann Park', subRole: 'Elementary', startTime: '15:00', endTime: '17:00', includedInRatio: true, centerId: CENTRE, date: TODAY },
    ];
  });

  it('falls back to the posted shifts and warns that the sides are not set', () => {
    render(<SupplyDemand />);
    const em = within(cardFor('Elementary / Middle'));
    expect(em.getByText(/Sides aren’t set for this day yet/)).toBeTruthy();
    expect(em.getByText('on shift')).toBeTruthy();
  });
});

describe('the sources the Student Scheduler writes', () => {
  it('counts a walk-in nobody booked on Acuity', () => {
    // 16 Sept 2026: Kabir Cheema walked in at 3:00 and never reached the
    // chart, because the page read a collection that doesn't exist.
    globalThis.__addOns = { 'EM|15:00': [{ id: 'wi_k', name: 'Kabir Cheema', duration: 60 }] };
    render(<SupplyDemand />);
    // Two booked + one walk-in.
    expect(within(cardFor('Elementary / Middle')).getAllByDisplayValue('3').length).toBeGreaterThan(0);
  });

  it('takes a no-show off the count', () => {
    globalThis.__checkIns = { 'Sample EM One-15:00': { status: 'noshow' } };
    render(<SupplyDemand />);
    expect(within(cardFor('Elementary / Middle')).getAllByDisplayValue('1').length).toBeGreaterThan(0);
  });
});
