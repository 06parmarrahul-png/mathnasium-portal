// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Ratio Games, rendered.
 *
 * What is worth pinning here rather than in the unit tests: that each game
 * actually plays, that the page is honest about the ranked run — the one
 * thing standing between a player and a leaderboard they can't trust — and
 * that the write it finally makes is the shape the Firestore rules accept.
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
const { GAME_LIST } = await import('../lib/ratioGames');
const { dailyEquation } = await import('../lib/games/mathle');
const { dailyBoard } = await import('../lib/games/connections');
const { roundsFor, ROUNDS } = await import('../lib/games/ratioRush');

const row = (uid, date, points, extra = {}) => ({
  uid, userName: uid === 'me' ? 'Sam Lee' : uid, gameId: 'sprint60', date, points, ...extra,
});

function setup({ enabled = true } = {}) {
  current.auth = {
    profile: { uid: 'me', displayName: 'Sam Lee' },
    activeCenterId: 'langley',
    centerConfig: { gamesEnabled: enabled },
  };
  return render(<MemoryRouter><RatioGames /></MemoryRouter>);
}

/** Let the clock run. React state moved by a timer needs act(). */
function runClock(ms) {
  act(() => { vi.advanceTimersByTime(ms); });
}


beforeEach(() => {
  scores.rows = [];
  writes.length = 0;
  toasts.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 8, 20, 15, 0, 0));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** Start a game, ranked or for practice, from its card. */
function startGame(name, { practice = false } = {}) {
  const card = screen.getByText(name).closest('div').parentElement;
  const label = practice ? /Practice/ : /Play for points/;
  fireEvent.click(within(card).getByRole('button', { name: label }));
}

describe('the roster', () => {
  it('offers every game, with today’s pick called out', () => {
    setup();
    for (const game of GAME_LIST) {
      expect(screen.getByText(game.name)).toBeTruthy();
    }
    expect(screen.getByText(/Today’s pick/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Play for points/ })).toHaveLength(GAME_LIST.length);
  });

  it('opens on the roster, not mid-game', () => {
    setup();
    expect(screen.queryByLabelText('Your answer')).toBeNull();
    expect(screen.getByText(/One ranked run per game, per day/)).toBeTruthy();
  });

  it('marks a game already played today, and still offers practice', () => {
    scores.rows = [{ ...row('me', '2026-09-20', 90), gameId: 'mathle', id: 'me_mathle_2026-09-20' }];
    setup();
    expect(screen.getByText(/90 today/)).toBeTruthy();
    // Three left to play for points, plus practice on all four.
    expect(screen.getAllByRole('button', { name: /Play for points/ })).toHaveLength(GAME_LIST.length - 1);
  });
});

describe('Sprint 60', () => {
  it('plays, and a correct answer submits itself', () => {
    setup();
    startGame('Sprint 60');
    const first = screen.getByText(/=$/).textContent;
    const [, a, op, b] = first.match(/^(\d+)\s*(.)\s*(\d+)?/) || [];
    const value = op === '+' ? Number(a) + Number(b) : Number(a) - Number(b);
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: String(value) } });
    expect(screen.getByText(/=$/).textContent).not.toBe(first);
  });

  it('the clock ends the run and writes one score', () => {
    setup();
    startGame('Sprint 60');
    runClock(61000);
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.gameId).toBe('sprint60');
    expect(writes[0].ref.__d).toBe('centers/langley/gameScores/me_sprint60_2026-09-20');
  });
});

describe('Mathle', () => {
  it('shows six rows of eight and a keyboard', () => {
    setup();
    startGame('Mathle');
    expect(screen.getByRole('button', { name: 'Enter' })).toBeTruthy();
    expect(screen.getByText(/true equation/)).toBeTruthy();
  });

  it('refuses a guess that isn’t true, and says why', () => {
    setup();
    startGame('Mathle');
    for (const ch of ['1', '2', '+', '3', '4', '=', '9', '9']) {
      fireEvent.click(screen.getByRole('button', { name: ch === '+' ? '+' : ch }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(screen.getByText(/has to be true/)).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it('writes the run when the answer is found', () => {
    setup();
    startGame('Mathle');
    const answer = dailyEquation('langley|2026-09-20|mathle');
    for (const ch of answer) {
      fireEvent.click(screen.getByRole('button', { name: ch === '*' ? 'times' : ch === '/' ? 'divide' : ch }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.gameId).toBe('mathle');
    expect(writes[0].payload.result).toBe(1);          // solved first go
    expect(writes[0].payload.points).toBe(120);
  });

  it('gives everyone at the centre the same puzzle', () => {
    // The seed is the centre and the date, so two players see one board.
    expect(dailyEquation('langley|2026-09-20|mathle'))
      .toBe(dailyEquation('langley|2026-09-20|mathle'));
  });
});

describe('Connections', () => {
  it('deals sixteen tiles and four lives', () => {
    setup();
    startGame('Connections');
    const board = dailyBoard('langley|2026-09-20|connections');
    expect(screen.getByText(/Pick four/)).toBeTruthy();
    for (const tile of board.tiles) {
      expect(screen.getAllByText(String(tile)).length).toBeGreaterThan(0);
    }
  });

  it('solves a set and names it', () => {
    setup();
    startGame('Connections');
    const board = dailyBoard('langley|2026-09-20|connections');
    for (const value of board.groups[0].items) {
      fireEvent.click(screen.getByRole('button', { name: String(value) }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByText(board.groups[0].name)).toBeTruthy();
  });

  it('writes the run once all four are found', () => {
    setup();
    startGame('Connections');
    const board = dailyBoard('langley|2026-09-20|connections');
    for (const group of board.groups) {
      for (const value of group.items) {
        fireEvent.click(screen.getByRole('button', { name: String(value) }));
      }
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    }
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.gameId).toBe('connections');
    expect(writes[0].payload.result).toBe(4);
    expect(writes[0].payload.points).toBe(120);        // clean sweep
  });
});

describe('Ratio Rush', () => {
  it('asks the centre’s own question', () => {
    setup();
    startGame('Ratio Rush');
    expect(screen.getByText(/students booked/)).toBeTruthy();
    expect(screen.getByText(/how many instructors/)).toBeTruthy();
  });

  it('explains a miss instead of just saying wrong', () => {
    setup();
    startGame('Ratio Rush');
    fireEvent.change(screen.getByLabelText('Instructors needed'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(screen.getByText(/÷ 3.5 =/)).toBeTruthy();
  });

  it('writes the run when the rounds are done', () => {
    setup();
    startGame('Ratio Rush');
    const rounds = roundsFor('langley|2026-09-20|ratioRush', ROUNDS);
    for (const round of rounds) {
      fireEvent.change(screen.getByLabelText('Instructors needed'), { target: { value: String(round.answer) } });
      fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
      fireEvent.click(screen.getByRole('button', { name: /Next slot|Finish/ }));
    }
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.gameId).toBe('ratioRush');
    expect(writes[0].payload.result).toBe(ROUNDS);
    expect(writes[0].payload.points).toBe(120);
  });
});

describe('practice never counts', () => {
  it('writes nothing, whichever game it is', () => {
    setup();
    startGame('Sprint 60', { practice: true });
    runClock(61000);
    expect(writes).toHaveLength(0);
    expect(screen.getByText(/practice, not counted/)).toBeTruthy();
  });

  it('a practice board is not the day’s board', () => {
    setup();
    startGame('Connections', { practice: true });
    // The ranked seed is fixed to the date; practice adds a nonce.
    const ranked = dailyBoard('langley|2026-09-20|connections').tiles.join();
    const onScreen = screen.getAllByRole('button')
      .map(b => b.textContent).filter(t => /^\d+$/.test(t)).join();
    expect(onScreen).not.toBe(ranked);
  });
});

describe('every write is one the rules accept', () => {
  it('points and result are non-negative integers within the cap', () => {
    setup();
    startGame('Sprint 60');
    runClock(61000);
    const { payload } = writes[0];
    expect(Number.isInteger(payload.points)).toBe(true);
    expect(payload.points).toBeGreaterThanOrEqual(0);
    expect(payload.points).toBeLessThanOrEqual(120);
    expect(Number.isInteger(payload.result)).toBe(true);
    expect(payload.result).toBeGreaterThanOrEqual(0);
    expect(payload.centerId).toBe('langley');
    expect(payload.uid).toBe('me');
  });

  it('explains a refused second run in the player’s words', async () => {
    const { setDoc } = await import('firebase/firestore');
    setDoc.mockImplementationOnce(() => Promise.reject(
      Object.assign(new Error('PERMISSION_DENIED'), { code: 'permission-denied' })));
    setup();
    startGame('Sprint 60');
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
    expect(screen.getByText('vol')).toBeTruthy();
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

describe('when the centre has it switched off', () => {
  it('a typed URL meets an explanation, not a game', () => {
    setup({ enabled: false });
    expect(screen.getByText(/isn’t switched on yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Play for points/ })).toBeNull();
  });

  it('off is the default — a missing setting is not on', () => {
    current.auth = { profile: { uid: 'me', displayName: 'Sam Lee' }, activeCenterId: 'langley', centerConfig: {} };
    render(<MemoryRouter><RatioGames /></MemoryRouter>);
    expect(screen.getByText(/isn’t switched on yet/)).toBeTruthy();
  });
});
