// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The desk card on a home page.
 *
 * The thing worth pinning hardest is who does NOT see it: notes carry
 * parent account questions and notes about individual students' funding,
 * and this card puts a line of one on a home page.
 */

const notes = { rows: [] };
const queries = [];

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c, ...rest) => ({ ...c, __w: rest }),
  where: (field, op, value) => ({ field, op, value }),
  onSnapshot: (q, next) => {
    queries.push(q);
    if (typeof next === 'function') next({ docs: notes.rows.map(r => ({ id: r.id, data: () => r })) });
    return () => {};
  },
}));
const current = { auth: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth }));

const { default: DeskHomeCard } = await import('./DeskHomeCard');

const note = (id, extra = {}) => ({
  id, status: 'open', toUids: ['me'], fromName: 'Aarav Yadav', fromInitials: 'AY',
  subject: 'Hold Mickey’s October spot', body: 'Mum asked to hold the spot.',
  loggedAt: '2026-09-05', ...extra,
});

function setup({ variant = 'nl', title = 'Manager', role = 'instructor' } = {}) {
  current.auth = {
    profile: { uid: 'me', displayName: 'Sam Lee', role },
    activeCenterId: 'langley',
    myInstructorType: title,
    permissions: new Set(),
  };
  return render(<MemoryRouter><DeskHomeCard variant={variant} /></MemoryRouter>);
}

beforeEach(() => {
  notes.rows = [];
  queries.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 8, 16, 9, 0, 0));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('who sees it', () => {
  it('an instructor sees nothing at all', () => {
    notes.rows = [note('a')];
    const { container } = setup({ title: 'Instructor' });
    expect(container.textContent).toBe('');
  });

  it('a volunteer sees nothing at all', () => {
    notes.rows = [note('a')];
    const { container } = setup({ title: 'Volunteer' });
    expect(container.textContent).toBe('');
  });

  it('and nothing is even queried for them', () => {
    // The rules would refuse the read anyway; not asking is cheaper and
    // keeps a permission-denied out of their console.
    setup({ title: 'Instructor' });
    expect(queries).toHaveLength(0);
  });

  it('Managers, Hosts and the owner see it', () => {
    notes.rows = [note('a')];
    for (const who of [{ title: 'Manager' }, { title: 'Host' }, { title: 'Instructor', role: 'owner' }]) {
      const { container } = setup(who);
      expect(container.textContent).toContain('On your desk');
      cleanup();
    }
  });
});

describe('what it says', () => {
  it('asks for live notes, not just the ones marked open', () => {
    // In progress and Waiting are still waiting on somebody.
    setup();
    const clause = queries[0].__w.find(w => w.field === 'status');
    expect(clause.op).toBe('in');
    expect(clause.value).toEqual(['open', 'in_progress', 'waiting']);
  });

  it('counts what is on you, and calls out what is late', () => {
    notes.rows = [
      note('late', { dueDate: '2026-09-14' }),
      note('today', { dueDate: '2026-09-16' }),
      note('undated'),
      note('theirs', { toUids: ['someone-else'], dueDate: '2026-09-01' }),
    ];
    setup();
    expect(screen.getByText(/3 waiting on you/)).toBeTruthy();
    expect(screen.getByText(/1 overdue/)).toBeTruthy();
    expect(screen.getByText('Overdue by 2 days')).toBeTruthy();
    expect(screen.getByText('Due today')).toBeTruthy();
    expect(screen.getByText(/\+ 1 more with no due date/)).toBeTruthy();
  });

  it('leads with the latest thing, not the newest', () => {
    notes.rows = [note('today', { dueDate: '2026-09-16' }), note('late', { dueDate: '2026-09-10' })];
    setup();
    const lines = screen.getAllByText(/Hold Mickey/);
    expect(lines).toHaveLength(2);
    // The overdue one is first in the DOM.
    expect(screen.getByText('Overdue by 6 days').compareDocumentPosition(screen.getByText('Due today')))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('says you are clear when you are', () => {
    notes.rows = [note('theirs', { toUids: ['someone-else'] })];
    setup();
    expect(screen.getByText(/Nothing waiting on you/)).toBeTruthy();
    expect(screen.queryByText(/Open the desk/)).toBeNull();
  });

  it('a settled note is not waiting on anybody', () => {
    notes.rows = [note('done', { status: 'closed', dueDate: '2026-09-01' })];
    setup();
    expect(screen.getByText(/Nothing waiting on you/)).toBeTruthy();
  });

  it('the classic skin says the same thing in one line', () => {
    notes.rows = [note('late', { dueDate: '2026-09-14' }), note('b')];
    setup({ variant: 'classic' });
    expect(screen.getByText(/2 on you/)).toBeTruthy();
    expect(screen.getByText(/1 overdue/)).toBeTruthy();
    expect(screen.getByText(/oldest is 11 days/)).toBeTruthy();
  });
});
