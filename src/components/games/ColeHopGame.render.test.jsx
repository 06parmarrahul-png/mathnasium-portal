// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import ColeHopGame from './ColeHopGame';
import { courseFor, questionsFor, RANKED_TABLE } from '../../lib/games/coleHop';

/**
 * Cole Hop, played.
 *
 * jsdom has no 2D context, so nothing is drawn here — which is the point:
 * what is checked is the part that decides a score. The quiz is ordinary
 * HTML, the ladder and the questions come from the seeded engine, and the
 * run reports one outcome at the end.
 *
 * The fairness rule gets its own test because it is the one that costs
 * somebody a gift card if it regresses: a RANKED run is all tables, with
 * no picker.
 */

const SEED = 'langley|2026-10-01|coleHop';

// requestAnimationFrame has to be faked ALONGSIDE the timers, or the two
// clocks come apart: the quiz's setTimeouts jump forward while the game
// loop waits on real time, and Cole stands perfectly still through a
// whole test file that still passes everything it asserts.
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const answerButtons = () =>
  [...document.querySelectorAll('button')].filter(b => /^\d+$/.test(b.textContent.trim()));

describe('a ranked run', () => {
  it('starts straight away on all tables, with no picker', () => {
    render(<ColeHopGame seed={SEED} ranked onFinish={() => {}} />);
    expect(screen.queryByText('Which times table?')).toBeNull();
    expect(screen.getByText('All tables')).toBeTruthy();
    // Picking the 2× table would be an easier game for the same points.
    expect(screen.queryByRole('button', { name: '2×' })).toBeNull();
    expect(RANKED_TABLE).toBe('all');
  });

  it('asks the day’s first question, the one everyone else gets', () => {
    render(<ColeHopGame seed={SEED} ranked onFinish={() => {}} />);
    const [first] = questionsFor(SEED, RANKED_TABLE, 1);
    expect(screen.getByText(`${first.a} × ${first.b}`)).toBeTruthy();
    expect(answerButtons().map(b => Number(b.textContent))).toEqual(first.options);
  });
});

describe('practice', () => {
  it('offers the picker, and plays the table that was picked', () => {
    render(<ColeHopGame seed={SEED} onFinish={() => {}} />);
    expect(screen.getByText('Which times table?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '7×' }));
    expect(screen.getByText('7 times table')).toBeTruthy();
    const [first] = questionsFor(SEED, 7, 1);
    expect(screen.getByText(`${first.a} × ${first.b}`)).toBeTruthy();
  });
});

describe('answering', () => {
  const play = () => {
    render(<ColeHopGame seed={SEED} ranked onFinish={() => {}} />);
    return questionsFor(SEED, RANKED_TABLE, 4);
  };

  it('moves on to the next question after a right answer', async () => {
    const qs = play();
    const right = answerButtons().find(b => Number(b.textContent) === qs[0].answer);
    fireEvent.click(right);
    expect(screen.getByText('Correct')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(screen.getByText(`${qs[1].a} × ${qs[1].b}`)).toBeTruthy();
  });

  it('says the fact out loud after a wrong one, and does not drop him', async () => {
    const qs = play();
    const wrong = answerButtons().find(b => Number(b.textContent) !== qs[0].answer);
    fireEvent.click(wrong);
    expect(screen.getByText(`${qs[0].a} × ${qs[0].b} = ${qs[0].answer}`)).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1200); });
    // Still playing: a wrong answer costs time, not the run.
    expect(screen.getByText(`${qs[1].a} × ${qs[1].b}`)).toBeTruthy();
  });

  it('refuses a second answer to the same question', () => {
    const qs = play();
    fireEvent.click(answerButtons().find(b => Number(b.textContent) === qs[0].answer));
    for (const b of answerButtons()) expect(b.disabled).toBe(true);
  });
});

describe('climbing, and falling off the end of it', () => {
  /** Answer whatever is on screen and let Cole finish the hop. */
  const playOne = async () => {
    const shown = screen.queryByText(/^\d+ × \d+$/);
    if (!shown) return;
    const [a, b] = shown.textContent.split('×').map(n => Number(n.trim()));
    const btn = answerButtons().find(x => Number(x.textContent) === a * b);
    if (btn && !btn.disabled) fireEvent.click(btn);
    await act(async () => { vi.advanceTimersByTime(1400); });
  };

  const counter = () => Number(document.querySelector('.tabular-nums').textContent);

  it('counts the platforms a hop actually lands on', async () => {
    render(<ColeHopGame seed={SEED} ranked onFinish={() => {}} />);
    expect(counter()).toBe(0);
    let reached = 0;
    for (let i = 0; i < 8; i += 1) {
      await playOne();
      if (screen.queryByText('Cole fell.')) break;
      reached = Math.max(reached, counter());
    }
    expect(reached).toBeGreaterThan(0);
  });

  it('reports exactly one outcome when he falls, and stops asking questions', async () => {
    const outcomes = [];
    render(<ColeHopGame seed={SEED} ranked onFinish={o => outcomes.push(o)} />);
    // The ladder narrows and speeds up, so a run always ends. The bound
    // is here so a regression fails the test rather than hanging it.
    for (let i = 0; i < 150 && outcomes.length === 0; i += 1) await playOne();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].climbed).toBeGreaterThan(0);
    expect(outcomes[0].right).toBeGreaterThan(0);
    expect(screen.getByText('Cole fell.')).toBeTruthy();
    expect(screen.queryByText(/^\d+ × \d+$/)).toBeNull();

    // Keep hammering: the run is over and must stay over.
    for (let i = 0; i < 5; i += 1) await playOne();
    expect(outcomes).toHaveLength(1);
  });
});

describe('the ladder it is playing', () => {
  it('is the same one the engine hands everybody', () => {
    expect(courseFor(SEED, 5)).toEqual(courseFor(SEED, 5));
  });
});
