// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Shift Board, rendered.
 *
 * Written because adding the "Take it back" button introduced a use of
 * RotateCcw that was never imported — a blank-page crash that eslint, the
 * build and 850 unit tests all passed straight over, because none of them
 * render React. The same class of bug has reached production twice before.
 *
 * The behaviour under test is narrow and worth being strict about: a swap
 * request is a shift changing hands, so who may take one down matters.
 */

const snapshots = {};
const deleted = [];
const rowsFor = (q) => snapshots[String(q?.__c || '').split('/').pop()] || [];

vi.mock('../firebase', () => ({ db: {}, auth: {}, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}), orderBy: () => ({}), limit: () => ({}),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  addDoc: async () => ({ id: 'new' }),
  updateDoc: async () => {},
  deleteDoc: async (ref) => { deleted.push(ref.__d); },
  getDocs: async () => ({ docs: [] }),
  runTransaction: async () => {},
  onSnapshot: (q, next) => {
    if (typeof next === 'function') {
      next({ docs: rowsFor(q).map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));

const confirmAnswer = { current: true };
vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  confirmDialog: async () => confirmAnswer.current,
}));
vi.mock('../lib/emailService', () => ({ notifyShiftClaimed: async () => {} }));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authValue.current, useOptionalAuth: () => authValue.current }));

const { default: ShiftBoard } = await import('./ShiftBoard');

const BASE_AUTH = {
  profile: { uid: 'sarah', displayName: 'Sarah Ghazi' },
  mySubRoles: ['Elementary'],
  activeCenterId: 'langley',
  canSeeAdminPanel: false,
  canTakeShifts: true,
  centerConfig: { name: 'Mathnasium Langley' },
};

// Far enough in the past that the 15-minute grace window has elapsed.
const anHourAgo = { toMillis: () => Date.now() - 60 * 60 * 1000 };

const swap = (over = {}) => ({
  id: 'c1', centerId: 'langley', type: 'shift_swap', swapStatus: 'open',
  userId: 'sarah', userName: 'Sarah Ghazi',
  shiftId: 's1', shiftDate: '2099-09-20',
  shiftStartTime: '15:00', shiftEndTime: '19:00',
  shiftSubRole: 'Elementary', createdAt: anHourAgo,
  ...over,
});

const openShift = (over = {}) => ({
  id: 'o1', centerId: 'langley', status: 'open',
  date: '2099-09-20', startTime: '15:00', endTime: '19:00',
  subRole: 'Elementary', role: 'Instructor', ...over,
});

const myShift = (over = {}) => ({
  id: 'm1', centerId: 'langley', userId: 'sarah', userName: 'Sarah Ghazi',
  date: '2099-09-20', startTime: '15:00', endTime: '19:00',
  status: 'published', ...over,
});

const draw = () => render(<MemoryRouter><ShiftBoard /></MemoryRouter>);

beforeEach(() => {
  authValue.current = { ...BASE_AUTH };
  confirmAnswer.current = true;
  deleted.length = 0;
  for (const k of ['openShifts', 'chat', 'shifts']) snapshots[k] = [];
});
afterEach(() => { cleanup(); });

describe('it renders', () => {
  it('with nothing on the board', () => {
    expect(() => draw()).not.toThrow();
    expect(screen.getByText(/No active swap requests/)).toBeTruthy();
  });

  it('with a swap request', () => {
    snapshots.chat = [swap({ userId: 'jason', userName: 'Jason Soo' })];
    expect(() => draw()).not.toThrow();
    expect(screen.getByText(/Jason Soo/)).toBeTruthy();
  });

  it('with a profile that has not loaded', () => {
    authValue.current = { ...BASE_AUTH, profile: null, activeCenterId: null };
    expect(() => draw()).not.toThrow();
  });
});

describe('taking your own request back', () => {
  it('offers the poster a way out of their own request', () => {
    snapshots.chat = [swap()];
    draw();
    expect(screen.getByText('Take it back')).toBeTruthy();
    expect(screen.getByText(/Waiting for someone to take this shift/)).toBeTruthy();
  });

  it('removes the request when they confirm', async () => {
    snapshots.chat = [swap()];
    draw();
    fireEvent.click(screen.getByText('Take it back'));
    await Promise.resolve();
    await Promise.resolve();
    expect(deleted).toEqual(['chat/c1']);
  });

  it('leaves it alone when they change their mind at the prompt', async () => {
    confirmAnswer.current = false;
    snapshots.chat = [swap()];
    draw();
    fireEvent.click(screen.getByText('Take it back'));
    await Promise.resolve();
    await Promise.resolve();
    expect(deleted).toEqual([]);
  });

  it("never offers it on somebody else's request", () => {
    // The rules refuse it too, but a button that always fails is its own
    // kind of broken.
    snapshots.chat = [swap({ userId: 'jason', userName: 'Jason Soo' })];
    draw();
    expect(screen.queryByText('Take it back')).toBeNull();
  });

  it('gives an ordinary instructor no admin delete control', () => {
    snapshots.chat = [swap({ userId: 'jason', userName: 'Jason Soo' })];
    draw();
    expect(screen.queryByTitle('Cancel this swap request')).toBeNull();
  });

  it('still gives an admin the cancel control on anyone', () => {
    authValue.current = { ...BASE_AUTH, canSeeAdminPanel: true };
    snapshots.chat = [swap({ userId: 'jason', userName: 'Jason Soo' })];
    draw();
    expect(screen.getByTitle('Cancel this swap request')).toBeTruthy();
  });

  it('shows nothing for a request somebody has already taken', () => {
    // Accepted requests drop off the board entirely — there is nothing
    // left to take back.
    snapshots.chat = [swap({ swapStatus: 'accepted', acceptedBy: 'jason' })];
    draw();
    expect(screen.queryByText('Take it back')).toBeNull();
    expect(screen.getByText(/No active swap requests/)).toBeTruthy();
  });
});

describe('one shift a day', () => {
  it('offers the claim when the day is free', () => {
    snapshots.openShifts = [openShift()];
    snapshots.shifts = [myShift({ date: '2099-09-21' })];
    draw();
    expect(screen.getByText('Claim Shift')).toBeTruthy();
  });

  it('locks the claim on a day they already work, and says which shift', () => {
    snapshots.openShifts = [openShift()];
    snapshots.shifts = [myShift()];
    draw();
    expect(screen.queryByText('Claim Shift')).toBeNull();
    expect(screen.getByText('Already on 3:00 PM – 7:00 PM')).toBeTruthy();
  });

  it('locks it even when the hours do not collide', () => {
    // Same day is the rule, not same clock — a 9–12 and a 3–7 is still two
    // shifts in one day for one person.
    snapshots.openShifts = [openShift()];
    snapshots.shifts = [myShift({ startTime: '09:00', endTime: '12:00' })];
    draw();
    expect(screen.queryByText('Claim Shift')).toBeNull();
    expect(screen.getByText('Already on 9:00 AM – 12:00 PM')).toBeTruthy();
  });

  it('locks taking a swap on that day too', () => {
    snapshots.chat = [swap({ userId: 'jason', userName: 'Jason Soo' })];
    snapshots.shifts = [myShift()];
    draw();
    expect(screen.queryByText('Take This Shift')).toBeNull();
    expect(screen.getByText('Already on 3:00 PM – 7:00 PM')).toBeTruthy();
  });

  it('is not tripped by somebody else working that day', () => {
    snapshots.openShifts = [openShift()];
    snapshots.shifts = [myShift({ userId: 'jason' })];
    draw();
    expect(screen.getByText('Claim Shift')).toBeTruthy();
  });

  it('is not tripped by a draft they cannot even see', () => {
    snapshots.openShifts = [openShift()];
    snapshots.shifts = [myShift({ status: 'draft' })];
    draw();
    expect(screen.getByText('Claim Shift')).toBeTruthy();
  });

  it('is not tripped by a shift that was cancelled', () => {
    snapshots.openShifts = [openShift()];
    snapshots.shifts = [myShift({ status: 'cancelled' })];
    draw();
    expect(screen.getByText('Claim Shift')).toBeTruthy();
  });

  it('hides the clash entirely under "hide ones I can\'t take"', () => {
    snapshots.openShifts = [openShift()];
    snapshots.shifts = [myShift()];
    draw();
    fireEvent.click(screen.getByLabelText(/Hide ones I can/));
    expect(screen.queryByText('Already on 3:00 PM – 7:00 PM')).toBeNull();
    expect(screen.getByText(/1 hidden/)).toBeTruthy();
  });
});
