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
/** Collections the rules refuse — the listener gets its error callback. */
const denied = new Set();
/** Which collections the page actually subscribed to, this render. */
const asked = [];
const rowsFor = (q) => {
  const key = String(q?.__c || '').split('/').pop();
  asked.push(key);
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
  onSnapshot: (ref, next, onError) => {
    if (typeof next === 'function' && !ref?.__d) {
      const key = String(ref?.__c || '').split('/').pop();
      if (denied.has(key)) {
        asked.push(key);
        if (typeof onError === 'function') onError(new Error('permission-denied'));
        return () => {};
      }
      const rows = rowsFor(ref);
      next({ docs: rows.map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));

const authValue = { current: {} };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authValue.current, useOptionalAuth: () => authValue.current }));

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
  asked.length = 0;
  denied.clear();
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

describe('the errands that are no longer on the page', () => {
  /**
   * The centre-settings shortcut and the availability-chasing card used to
   * be here, gated on role. Both went: they answer "where do I click", not
   * "what is waiting on me", and the sidebar reaches both. Nobody gets
   * them now — which is the point, so it is asserted for every role rather
   * than just the one that used to be refused.
   */
  for (const [name, auth] of [['a director', DIRECTOR], ['a manager', MANAGER], ['an owner', OWNER]]) {
    it(`shows ${name} no centre-settings shortcut`, () => {
      snapshots.users = [{ id: 'a', uid: 'a', displayName: 'A', approved: true }];
      draw(auth);
      expect(screen.queryByText(/Hours, roles and appearance/)).toBeNull();
    });

    it(`shows ${name} no availability card`, () => {
      snapshots.users = [
        { id: 'a', uid: 'a', displayName: 'Has days', approved: true },
        { id: 'b', uid: 'b', displayName: 'Has not', approved: true },
      ];
      snapshots.availability = [{ userId: 'a', date: TODAY }];
      draw(auth);
      expect(screen.queryByText(/have days in/)).toBeNull();
    });
  }

  it('no longer subscribes to the availability collection at all', () => {
    // The card went; so should the read that fed it. A page that keeps
    // the listener is still paying for a card nobody can see.
    snapshots.availability = [{ userId: 'a', date: TODAY }];
    draw(DIRECTOR);
    expect(asked).not.toContain('availability');
    // and the ones it still needs are all there
    expect(asked).toEqual(expect.arrayContaining([
      'shifts', 'openShifts', 'users', 'timeOffRequests', 'centerIntakes', 'leads', 'events',
    ]));
  });
});

describe('the order leadership read it in', () => {
  /**
   * Snapshot, then the desk, then the queue. The desk is what they come
   * here for once they know the floor is covered, so it sits above the
   * things that can wait.
   */
  // DeskHomeCard asks canUseDesk(), which reads profile.role — without it
  // the card never renders and an order assertion would pass on absence.
  const DESK_DIRECTOR = { ...DIRECTOR, profile: { ...DIRECTOR.profile, role: 'director' } };

  const orderOf = (...labels) => {
    const html = document.body.innerHTML;
    return labels.map(l => html.indexOf(l));
  };

  it('puts the desk above what needs a decision', () => {
    snapshots.timeOffRequests = [{ id: 't1', userName: 'Sam', from: TODAY, status: 'pending' }];
    draw(DESK_DIRECTOR);
    // The new-look variant heads the card "On your desk".
    const [desk, needs] = orderOf('On your desk', 'Needs you');
    expect(desk).toBeGreaterThan(-1);
    expect(needs).toBeGreaterThan(-1);
    expect(desk).toBeLessThan(needs);
  });

  it('answers a person before it chases a shift', () => {
    snapshots.timeOffRequests = [{ id: 't1', userName: 'Sam', from: TODAY, status: 'pending' }];
    snapshots.openShifts = [{ id: 'o1', status: 'open', date: TODAY, startTime: '15:00' }];
    draw(DESK_DIRECTOR);
    const [timeOff, unclaimed] = orderOf('time-off request', 'nobody has taken');
    expect(timeOff).toBeGreaterThan(-1);
    expect(unclaimed).toBeGreaterThan(-1);
    expect(timeOff).toBeLessThan(unclaimed);
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

/**
 * Assessments today.
 *
 * It used to be a time and a bare grade — "Today 3:00 PM … 2" — which
 * answered when but never who. And it reported "None booked this week" to
 * a Manager who simply may not read `centerIntakes`, which is the
 * confidently-wrong figure this whole page exists to avoid.
 *
 * It is TODAY only now, at the centre's request: a week of them pushed the
 * rest of the page down to answer a question nobody opens this home to ask.
 */
describe('assessments today', () => {
  const booking = (over = {}) => ({
    id: 'i1', centerId: 'langley', slot: `${TODAY}T15:00:00`, durationMin: 60,
    childName: 'Catherine Moon', childGrade: '2', guardianName: 'Francis Moon',
    status: 'scheduled', notes: '', ...over,
  });

  it('leads with the child, not the clock', () => {
    snapshots.centerIntakes = [booking()];
    draw();
    expect(screen.getByText('Catherine Moon')).toBeTruthy();
    expect(screen.getByText(/Francis Moon/)).toBeTruthy();
  });

  it('gives a bare grade its word', () => {
    // "2" beside a time, in a column headed by nothing, reads as a count.
    snapshots.centerIntakes = [booking()];
    draw();
    expect(screen.getByText('Grade 2')).toBeTruthy();
  });

  it('leaves PreK and K exactly as the family typed them', () => {
    snapshots.centerIntakes = [booking({ childGrade: 'PreK' })];
    draw();
    expect(screen.getByText('PreK')).toBeTruthy();
  });

  it('shows a note when there is one', () => {
    snapshots.centerIntakes = [booking({ notes: 'may bring a sibling' })];
    draw();
    expect(screen.getByText('may bring a sibling')).toBeTruthy();
  });

  it('says a name is missing rather than rendering a blank row', () => {
    snapshots.centerIntakes = [booking({ childName: '' })];
    draw();
    expect(screen.getByText(/name not recorded/i)).toBeTruthy();
  });

  it('shows only today — tomorrow is not this card-s question', () => {
    const tomorrow = todayStr(new Date(Date.now() + 24 * 3600 * 1000));
    snapshots.centerIntakes = [
      booking(),
      booking({ id: 'i2', slot: `${tomorrow}T15:00:00`, childName: 'Tomorrow Child' }),
    ];
    draw();
    expect(screen.getByText('Catherine Moon')).toBeTruthy();
    expect(screen.queryByText('Tomorrow Child')).toBeNull();
  });

  it('drops the day prefix, because every row is today', () => {
    // The time and the guardian sit in separate elements, so match on the
    // row's own text rather than a single node.
    snapshots.centerIntakes = [booking()];
    const { container } = draw();
    const row = [...container.querySelectorAll('div')]
      .find(el => el.textContent === '3:00 PM · Francis Moon');
    expect(row).toBeTruthy();
    expect(screen.queryByText(/\bToday\b/)).toBeNull();
  });

  it('never says "none booked" to somebody who may not read them', () => {
    // centerIntakes is owner-tier; Managers reach this home. Reporting an
    // empty week to them is a figure that is confidently wrong.
    denied.add('centerIntakes');
    snapshots.centerIntakes = [booking()];
    draw();
    expect(screen.queryByText(/none booked today/i)).toBeNull();
    expect(screen.getByText(/not shown to you/i)).toBeTruthy();
    expect(screen.getByText(/families’ contact details/i)).toBeTruthy();
  });

  it('still says "none booked" when the read worked and the day is empty', () => {
    snapshots.centerIntakes = [];
    draw();
    expect(screen.getByText(/none booked today/i)).toBeTruthy();
  });
});
