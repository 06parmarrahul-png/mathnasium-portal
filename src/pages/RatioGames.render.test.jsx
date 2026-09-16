// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Ratio Games, rendered.
 *
 * Two things are worth pinning here rather than in the unit tests: that a
 * run actually plays (a timer, a question, an answer that submits itself),
 * and that the page is honest about the ranked run — it is the one thing
 * standing between a player and a leaderboard they can't trust.
 */

const scores = { rows: [] };
const writes = [];

vi.mock('../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}),
  onSnapshot: (q, next) => {
    if (typeof next === 'function') {
      next({ docs: scores.rows.map(r => ({ id: r.id || r.uid + r.date, data: () => r })) });
    }
    return () => {};
  },
  setDoc: vi.fn(async (ref, payload) => { writes.push({ ref, payload }); }),
}));
const toasts = [];
vi.mock('../lib/notify', () => ({
  toast: { success: (m) => toasts.push(['ok', m]), error: (m) => toasts.push(['err', m]) },
}));
const current = { auth: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth }));

const { default: RatioGames } = await import('./RatioGames');

const row = (uid, date, points, extra = {}) => ({
  uid, userName: uid === 'me' ? 'Sam Lee' : uid, gameId: 'sprint60', date, points, ...extra,
});

function setup() {
  current.auth = {
    profile: { uid: 'me', displayName: 'Sam Lee' },
    activeCenterId: 'langley',
  };
  return render(<MemoryRouter><RatioGames /></MemoryRouter>);
}

/** Let the clock run. React state moved by a timer needs act(). */
function runClock(ms) {
  act(() => { vi.advanceTimersByTime(ms); });
}

/** Answer whatever is on screen, using the question itself. */
function answerCurrent() {
  const q = screen.getByText(/=$/).textContent.replace(/\s*=$/, '');
  const [, a, op, b] = q.match(/^(\d+)\s*(.)\s*(\d+)?/) || [];
  let value;
  if (op === '+') value = Number(a) + Number(b);
  else if (op === '−') value = Number(a) - Number(b);
  else if (op === '²') value = Number(a) * Number(a);
  else value = null;
  if (value === null) return false;
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: String(value) } });
  return true;
}

beforeEach(() => {
  scores.rows = [];
  writes.length = 0;
  toasts.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 8, 16, 15, 0, 0));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('playing', () => {
  it('opens ready to play, not mid-run', () => {
    setup();
    expect(screen.getByRole('button', { name: /Start today’s run/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Practice/ })).toBeTruthy();
    expect(screen.getByText(/One ranked run a day/)).toBeTruthy();
  });

  it('a correct answer submits itself and asks the next one', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Start today’s run/ }));
    const first = screen.getByText(/=$/).textContent;
    expect(answerCurrent()).toBe(true);
    expect(screen.getByText(/=$/).textContent).not.toBe(first);
    // The box clears itself for the next answer.
    expect(screen.getByLabelText('Your answer').value).toBe('');
  });

  it('a wrong answer just sits there', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Start today’s run/ }));
    const first = screen.getByText(/=$/).textContent;
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: '1' } });
    expect(screen.getByText(/=$/).textContent).toBe(first);
    expect(screen.getByLabelText('Your answer').value).toBe('1');
  });

  it('the clock ends the run and writes the score once', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Start today’s run/ }));
    answerCurrent();
    runClock(61000);
    expect(writes).toHaveLength(1);
    const { payload } = writes[0];
    expect(payload.uid).toBe('me');
    expect(payload.gameId).toBe('sprint60');
    expect(payload.date).toBe('2026-09-16');
    expect(payload.result).toBe(1);
    expect(payload.points).toBe(6);        // 1 of par 18
  });

  it('files the score under {uid}_{game}_{date} — the id is what limits it to one', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Start today’s run/ }));
    runClock(61000);
    expect(writes[0].ref.__d).toBe('centers/langley/gameScores/me_sprint60_2026-09-16');
  });
});

describe('practice never counts', () => {
  it('writes nothing at all', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^Practice$/ }));
    answerCurrent();
    runClock(61000);
    expect(writes).toHaveLength(0);
    expect(screen.getByText(/practice, not counted/)).toBeTruthy();
  });

  it('a run that starts as practice cannot become the ranked one at the end', () => {
    // The decision is made at the start and carried through, so a good
    // practice run can't be promoted after the fact.
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^Practice$/ }));
    runClock(61000);
    expect(writes).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Take today’s ranked run/ })).toBeTruthy();
  });
});

describe('once today’s ranked run is in', () => {
  beforeEach(() => {
    scores.rows = [row('me', '2026-09-16', 100, { id: 'me_sprint60_2026-09-16' })];
  });

  it('says so, and still offers practice', () => {
    setup();
    expect(screen.getByRole('button', { name: /Ranked run is in/ })).toBeTruthy();
    expect(screen.getByText(/practice as much as you like/i)).toBeTruthy();
  });

  it('explains the refusal in the player’s words, not Firestore’s', async () => {
    // The rules are what actually stop a second run; the page has to make
    // that readable when it happens.
    const { setDoc } = await import('firebase/firestore');
    setDoc.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('PERMISSION_DENIED'), { code: 'permission-denied' })));
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Ranked run is in/ }));
    runClock(61000);
    await vi.waitFor(() => expect(toasts.length).toBeGreaterThan(0));
    expect(toasts[0][0]).toBe('err');
    expect(toasts[0][1]).toMatch(/already in/i);
  });
});

describe('the board', () => {
  it('shows everyone, with you named as You', () => {
    scores.rows = [
      row('ann', '2026-09-01', 100), row('ann', '2026-09-02', 90),
      row('me', '2026-09-01', 60),
    ];
    setup();
    expect(screen.getByText('ann')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
  });

  it('counts volunteers and trainees like anyone else — every account plays', () => {
    scores.rows = [row('vol', '2026-09-01', 120), row('me', '2026-09-01', 60)];
    setup();
    const names = screen.getAllByText(/vol|You/).map(n => n.textContent);
    expect(names).toContain('vol');
    // The volunteer is top of the board, and nothing on the page argues.
    expect(screen.queryByText(/not eligible/i)).toBeNull();
  });

  it('says so plainly before anyone has played', () => {
    setup();
    expect(screen.getByText(/Nobody has played yet this month/)).toBeTruthy();
  });

  it('shows the caps that let a part-timer win', () => {
    setup();
    expect(screen.getByText(/best 12 days in the month/i)).toBeTruthy();
    expect(screen.getByText(/never part of how anyone’s work is judged/i)).toBeTruthy();
  });
});
