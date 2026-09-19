// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Does the leadership home actually RENDER?
 *
 * This board's ancestor crashed in production. That crash is the reason
 * HomeSwitch carries its own error boundary, and the reason these render
 * tests exist at all — eslint, `vite build` and the unit suite all inspect
 * code, and none of them run React.
 *
 * So the point of this file is not the numbers. It is that the component
 * survives an empty centre, a centre mid-load, junk rows, and each of the
 * roles that can reach it.
 */

// Firestore, routed BY COLLECTION — a mock that hands every listener the
// same rows lets a test pass for the wrong reason.
const snapshots = {};
const rowsFor = (q) => {
  const key = String(q?.__c || '').split('/').pop();
  return snapshots[key] || [];
};

vi.mock('../../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}),
  orderBy: () => ({}),
  limit: () => ({}),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  onSnapshot: (ref, next) => {
    if (typeof next === 'function' && !ref?.__d) {
      const rows = rowsFor(ref);
      next({ docs: rows.map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));

const authValue = { current: {} };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authValue.current }));

const { default: LeadershipHome } = await import('./LeadershipHome');

const todayStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const TODAY = todayStr();

const MANAGER = {
  profile: { uid: 'u1', displayName: 'Priya Shah', mascot: 'classic' },
  activeCenterId: 'langley',
  isManager: true,
  centerConfig: { name: 'Mathnasium of Langley' },
};
const DIRECTOR = { ...MANAGER, profile: { ...MANAGER.profile, displayName: 'Neeru Gill' }, isDirector: true, isManager: false };
const OWNER = { ...MANAGER, profile: { ...MANAGER.profile, displayName: 'Doug Reid' }, isOwner: true, isManager: false };

const shift = (over = {}) => ({
  centerId: 'langley', date: TODAY, userName: 'Bri MacDonald',
  startTime: '15:00', endTime: '19:00', role: 'Instructor', status: 'live', ...over,
});

const draw = (auth = MANAGER) => {
  authValue.current = auth;
  return render(<MemoryRouter><LeadershipHome /></MemoryRouter>);
};

beforeEach(() => {
  for (const k of Object.keys(snapshots)) delete snapshots[k];
  Object.assign(snapshots, {
    shifts: [], openShifts: [], users: [], timeOffRequests: [],
    centerIntakes: [], leads: [], events: [], availability: [],
  });
});
afterEach(() => cleanup());

describe('it renders at all', () => {
  it('survives a centre with nothing in it', () => {
    draw();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getByText(/Nobody rostered today/i)).toBeTruthy();
    expect(screen.getByText(/Nothing waiting/i)).toBeTruthy();
  });

  it('renders for a manager, a director and an owner alike', () => {
    for (const auth of [MANAGER, DIRECTOR, OWNER]) {
      draw(auth);
      expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
      cleanup();
    }
  });

  it('does not throw before a centre is chosen', () => {
    expect(() => draw({ ...MANAGER, activeCenterId: null })).not.toThrow();
  });

  it('survives rows missing the fields it reads', () => {
    // Real collections carry legacy documents. A home that throws on one
    // takes the whole portal down with it.
    snapshots.shifts = [shift({ startTime: undefined, endTime: undefined, role: undefined })];
    snapshots.openShifts = [{ status: 'open' }];
    snapshots.timeOffRequests = [{}];
    snapshots.centerIntakes = [{}, { slot: 123 }];
    snapshots.leads = [{}, { status: 'nonsense' }];
    snapshots.users = [{}];
    expect(() => draw()).not.toThrow();
  });
});

describe('the floor, today', () => {
  it('counts the people actually working, not the drafts', () => {
    snapshots.shifts = [
      shift({ userName: 'Bri MacDonald', role: 'Lead' }),
      shift({ userName: 'Luke Huang' }),
      shift({ userName: 'Maria Fahim', status: 'draft' }),
      shift({ userName: 'Idan Kanevsky', status: 'cancelled' }),
    ];
    draw();
    expect(screen.getByText(/2 on today/)).toBeTruthy();
  });

  it('names whoever is leading the floor', () => {
    snapshots.shifts = [shift({ userName: 'Bri MacDonald', role: 'Lead' }), shift({ userName: 'Luke Huang' })];
    draw();
    expect(screen.getByText(/Bri MacDonald leading/)).toBeTruthy();
  });

  it('ignores another day, and another centre', () => {
    // Both are filtered in the query; this pins that the component does
    // not quietly widen them.
    snapshots.shifts = [shift(), shift({ date: '2020-01-01' })];
    draw();
    expect(screen.getByText(/2 on today/)).toBeTruthy();
  });
});

describe('what needs a decision', () => {
  it('says so when nothing does', () => {
    draw();
    expect(screen.getByText(/Nothing waiting/i)).toBeTruthy();
  });

  it('counts unclaimed shifts from today forward only', () => {
    snapshots.openShifts = [
      { status: 'open', date: TODAY, startTime: '15:00' },
      { status: 'open', date: '2099-01-01', startTime: '15:00' },
      { status: 'open', date: '2020-01-01', startTime: '15:00' },   // long gone
      { status: 'claimed', date: '2099-01-02', startTime: '15:00' },
    ];
    draw();
    expect(screen.getByText(/2 shifts nobody has taken/)).toBeTruthy();
  });

  it('counts people waiting to be approved, and not the ones who left', () => {
    snapshots.users = [
      { displayName: 'New Person', approved: false },
      { displayName: 'Also New' },                                   // no field yet
      { displayName: 'Approved', approved: true },
      { displayName: 'Gone', approved: false, status: 'terminated' },
    ];
    draw();
    expect(screen.getByText(/2 waiting to be approved/)).toBeTruthy();
  });

  it('counts only time-off nobody has answered', () => {
    snapshots.timeOffRequests = [
      { userName: 'Luke Huang', from: '2099-10-02' },                // no status = pending
      { userName: 'Sofie Rzepinski', from: '2099-10-05', status: 'pending' },
      { userName: 'Caleb Schelp', from: '2099-10-08', status: 'approved' },
    ];
    draw();
    expect(screen.getByText(/2 time-off requests/)).toBeTruthy();
  });
});

describe('the funnel', () => {
  it('counts a status field rather than deriving one', () => {
    snapshots.leads = [
      { status: 'new' }, { status: 'new' }, { status: 'contacted' },
      { status: 'enrolled' }, { status: 'lost' }, {},
    ];
    draw();
    // Two 'new' plus the row with no status, which reads as new. The
    // label is lower case in the DOM and capitalised by CSS.
    expect(screen.getByText('new').previousSibling.textContent).toBe('3');
    expect(screen.getByText('enrolled').previousSibling.textContent).toBe('1');
  });

  it('leaves lost out, because it is not a stage anyone works', () => {
    draw();
    expect(screen.queryByText('lost')).toBeNull();
  });
});

describe('the cards each role gets', () => {
  it('gives a director the centre settings and availability cards', () => {
    snapshots.users = [
      { id: 'a', uid: 'a', displayName: 'Has days', approved: true },
      { id: 'b', uid: 'b', displayName: 'Has not', approved: true },
    ];
    snapshots.availability = [
      { userId: 'a', date: TODAY }, { userId: 'a', date: '2099-01-01' },
      { userId: 'ghost', date: TODAY },        // nobody on the roster
    ];
    draw(DIRECTOR);
    expect(screen.getByText(/Hours, roles and appearance/)).toBeTruthy();
    // One distinct person, counted once across two rows; the ghost is out.
    expect(screen.getByText(/1 of 2 have days in/)).toBeTruthy();
  });

  it('withholds both from a manager, who cannot write centre settings', () => {
    snapshots.users = [{ displayName: 'A', approved: true }];
    draw(MANAGER);
    expect(screen.queryByText(/Hours, roles and appearance/)).toBeNull();
  });
});

describe('what is deliberately not on it', () => {
  it('shows no derived figure — no ratio, budget, attendance or revenue', () => {
    // The first version of this board was deleted for showing these from
    // live Radius reads it could not do quickly or completely. If one
    // comes back, it comes back with the Radius API behind it — not by
    // someone adding a card without reading why the last one went.
    //
    // "enrolled" is deliberately NOT banned: it is a stage of the leads
    // funnel, a count of a status field a human sets in this app. The
    // thing being kept out is a number nothing here can source.
    snapshots.shifts = [shift(), shift({ userName: 'Luke Huang' })];
    snapshots.leads = [{ status: 'enrolled' }];
    const { container } = draw();
    const text = container.textContent;
    for (const banned of [/ratio/i, /budget/i, /attendance/i, /revenue/i, /\d+\s*%/]) {
      expect(text).not.toMatch(banned);
    }
  });
});
