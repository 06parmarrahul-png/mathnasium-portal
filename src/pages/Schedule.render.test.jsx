// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The day modal's swap controls.
 *
 * Sarah Ghazi got the same shift onto the Shift Board twice. Nothing in the
 * code stopped her: the page never read the chat collection, so it could
 * not know a request already existed, and posting closed the modal without
 * leaving a trace — reopening the day showed a fresh "Post for Swap" button
 * exactly as though the first press had never happened.
 *
 * These render the real page and drive the real buttons, because that is
 * the only way to catch the version of this bug where the guard exists in
 * a helper but was never wired to the thing a person actually presses.
 */

const snapshots = {};
const added = [];
const deleted = [];
const getDocsRows = { current: [] };
const rowsFor = (q) => snapshots[String(q?.__c || '').split('/').pop()] || [];

vi.mock('../firebase', () => ({ db: {}, auth: {}, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}), orderBy: () => ({}), limit: () => ({}),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  addDoc: async (ref, data) => { added.push({ path: ref.__c, data }); return { id: 'new' }; },
  updateDoc: async () => {},
  setDoc: async () => {},
  deleteDoc: async (ref) => { deleted.push(ref.__d); },
  writeBatch: () => ({ set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} }),
  runTransaction: async () => {},
  getDocs: async () => ({
    docs: getDocsRows.current.map((r, i) => ({ id: r.id || `g${i}`, data: () => r })),
  }),
  onSnapshot: (q, next) => {
    if (typeof next === 'function') {
      next({ docs: rowsFor(q).map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));

const confirmAnswer = { current: true };
const toasts = { success: [], error: [] };
vi.mock('../lib/notify', () => ({
  toast: {
    success: (m) => toasts.success.push(m),
    error: (m) => toasts.error.push(m),
  },
  confirmDialog: async () => confirmAnswer.current,
}));
vi.mock('../lib/emailService', () => ({ notifyShiftClaimed: async () => {} }));
vi.mock('../lib/availabilityLog', () => ({
  logAvailabilityChange: () => {}, logAvailabilityBatch: () => {},
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authValue.current }));

const { default: Schedule } = await import('./Schedule');

const DAY = '2026-09-21';           // a Monday — the centre is closed Sundays

const BASE_AUTH = {
  profile: { uid: 'sarah', displayName: 'Sarah Ghazi', role: 'instructor' },
  mySubRoles: ['Elementary'],
  activeCenterId: 'langley',
  canTakeShifts: true,
  canSeeAdminPanel: false,
  centerConfig: { name: 'Mathnasium Langley', holidays: [] },
};

const shift = (over = {}) => ({
  id: 's1', centerId: 'langley', userId: 'sarah', userName: 'Sarah Ghazi',
  date: DAY, startTime: '15:00', endTime: '19:00',
  role: 'Instructor', subRole: 'Elementary', status: 'live', ...over,
});

const swap = (over = {}) => ({
  id: 'c1', centerId: 'langley', type: 'shift_swap', swapStatus: 'open',
  userId: 'sarah', userName: 'Sarah Ghazi',
  shiftId: 's1', shiftDate: DAY, shiftStartTime: '15:00', shiftEndTime: '19:00',
  createdAt: { toMillis: () => Date.now() }, ...over,
});

const draw = () => render(<MemoryRouter><Schedule /></MemoryRouter>);

/** Open the day modal for DAY. */
const openDay = (container) => {
  const cell = container.querySelector(`[data-day="${DAY}"]`);
  expect(cell).toBeTruthy();
  fireEvent.click(cell);
};

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => {
  // Fixed clock: the calendar opens on the current month, and DAY has to
  // be in it and still in the future.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));
  authValue.current = { ...BASE_AUTH };
  confirmAnswer.current = true;
  added.length = 0; deleted.length = 0;
  getDocsRows.current = [];
  toasts.success.length = 0; toasts.error.length = 0;
  for (const k of ['availability', 'shifts', 'openShifts', 'timeOffRequests', 'chat']) {
    snapshots[k] = [];
  }
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('it renders', () => {
  it('with no data at all', () => {
    expect(() => draw()).not.toThrow();
  });

  it('with a shift, and opens the day', () => {
    snapshots.shifts = [shift()];
    const { container } = draw();
    openDay(container);
    expect(screen.getByText('Post for Swap')).toBeTruthy();
  });
});

describe('posting the same shift twice — the reported bug', () => {
  it('shows the posted state instead of the button once it is up', () => {
    // The heart of it. The day used to look identical before and after
    // posting, so a person with no feedback pressed again.
    snapshots.shifts = [shift()];
    snapshots.chat = [swap()];
    const { container } = draw();
    openDay(container);
    expect(screen.getByText('Posted for swap')).toBeTruthy();
    expect(screen.queryByText('Post for Swap')).toBeNull();
  });

  it('refuses a second post when one already exists on the server', async () => {
    // The page's own view of chat is a recent-messages window, so the
    // authoritative check asks the server for this shift specifically.
    snapshots.shifts = [shift()];
    getDocsRows.current = [swap()];
    const { container } = draw();
    openDay(container);
    fireEvent.click(screen.getByText('Post for Swap'));
    await settle();
    expect(added).toEqual([]);
    expect(toasts.error.join(' ')).toMatch(/already posted this shift/i);
  });

  it('posts exactly one request on a double-tap', async () => {
    // A phone delivers two clicks before the first write lands.
    //
    // Two separate guards hold this line — the button disables itself the
    // moment it is pressed, and the handler refuses to re-enter while a
    // write is in flight. Removing either one alone leaves this green,
    // which is the point of having both; removing both gives two requests.
    snapshots.shifts = [shift()];
    const { container } = draw();
    openDay(container);
    const btn = screen.getByText('Post for Swap');
    fireEvent.click(btn);
    fireEvent.click(btn);
    await settle();
    expect(added.filter(a => a.data?.type === 'shift_swap').length).toBe(1);
  });

  it('posts one when nothing is up yet', async () => {
    snapshots.shifts = [shift()];
    const { container } = draw();
    openDay(container);
    fireEvent.click(screen.getByText('Post for Swap'));
    await settle();
    const posts = added.filter(a => a.data?.type === 'shift_swap');
    expect(posts.length).toBe(1);
    expect(posts[0].data.shiftId).toBe('s1');
    expect(posts[0].data.swapStatus).toBe('open');
  });

  it("names the other person when somebody else posted this shift", async () => {
    snapshots.shifts = [shift()];
    getDocsRows.current = [swap({ userId: 'jason', userName: 'Jason Soo' })];
    const { container } = draw();
    openDay(container);
    fireEvent.click(screen.getByText('Post for Swap'));
    await settle();
    expect(added).toEqual([]);
    expect(toasts.error.join(' ')).toMatch(/Jason Soo/);
  });

  it('ignores a request that has already been taken', async () => {
    // An accepted request must not block posting again — the shift could
    // legitimately have come back.
    snapshots.shifts = [shift()];
    getDocsRows.current = [swap({ swapStatus: 'accepted' })];
    const { container } = draw();
    openDay(container);
    fireEvent.click(screen.getByText('Post for Swap'));
    await settle();
    expect(added.filter(a => a.data?.type === 'shift_swap').length).toBe(1);
  });
});

describe('taking it back from the day modal', () => {
  it('removes the request when they confirm', async () => {
    snapshots.shifts = [shift()];
    snapshots.chat = [swap()];
    const { container } = draw();
    openDay(container);
    fireEvent.click(screen.getByText('Take it back'));
    await settle();
    expect(deleted).toEqual(['chat/c1']);
  });

  it('leaves it posted when they change their mind at the prompt', async () => {
    confirmAnswer.current = false;
    snapshots.shifts = [shift()];
    snapshots.chat = [swap()];
    const { container } = draw();
    openDay(container);
    fireEvent.click(screen.getByText('Take it back'));
    await settle();
    expect(deleted).toEqual([]);
  });

  it("never offers to take back somebody else's request", () => {
    snapshots.shifts = [shift()];
    snapshots.chat = [swap({ userId: 'jason', userName: 'Jason Soo' })];
    const { container } = draw();
    openDay(container);
    expect(screen.queryByText('Take it back')).toBeNull();
    expect(screen.getByText('Post for Swap')).toBeTruthy();
  });

  it('ties the request to the right shift, not merely the right person', () => {
    // A swap posted for a DIFFERENT shift must not make this day look
    // posted.
    snapshots.shifts = [shift()];
    snapshots.chat = [swap({ shiftId: 'other-shift' })];
    const { container } = draw();
    openDay(container);
    expect(screen.getByText('Post for Swap')).toBeTruthy();
  });
});

describe('who may post at all', () => {
  it('offers nothing to a volunteer or trainee', () => {
    authValue.current = { ...BASE_AUTH, canTakeShifts: false };
    snapshots.shifts = [shift()];
    const { container } = draw();
    openDay(container);
    expect(screen.queryByText('Post for Swap')).toBeNull();
  });
});
