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
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authValue.current }));

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

const draw = () => render(<MemoryRouter><ShiftBoard /></MemoryRouter>);

beforeEach(() => {
  authValue.current = { ...BASE_AUTH };
  confirmAnswer.current = true;
  deleted.length = 0;
  for (const k of ['openShifts', 'chat']) snapshots[k] = [];
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
