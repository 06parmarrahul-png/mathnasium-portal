// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * The coverage card, rendered.
 *
 * The numbers are the whole point, so they're asserted off the real DOM: a
 * day bar that adds slots up instead of counting people, or an expansion
 * that reads the wrong weekday's instructional hours, looks fine in
 * coverageModel.test.js and wrong on the screen.
 *
 * Clock is frozen to Monday 21 Sep 2026, so "the next Monday" is that day
 * and "the next Saturday" is the 26th.
 */

const MON = '2026-09-21';
const SAT = '2026-09-26';

const users = [
  { uid: 'a', id: 'a', displayName: 'Ann',  instructorType: 'Instructor', centerIds: ['langley'] },
  { uid: 'b', id: 'b', displayName: 'Bea',  instructorType: 'Instructor', centerIds: ['langley'] },
  { uid: 'c', id: 'c', displayName: 'Cal',  instructorType: 'Lead',       centerIds: ['langley'] },
  { uid: 'h', id: 'h', displayName: 'Hugo', instructorType: 'Host',       centerIds: ['langley'] },
];

// Monday: Ann + Bea all afternoon, Cal from 4. Hugo is a host — never supply.
// Saturday: Ann only.
const availability = [
  { id: 'r1', userId: 'a', date: MON, startTime: '15:00', endTime: '19:00' },
  { id: 'r2', userId: 'b', date: MON, startTime: '15:00', endTime: '19:00' },
  { id: 'r3', userId: 'c', date: MON, startTime: '16:00', endTime: '19:00' },
  { id: 'r4', userId: 'h', date: MON, startTime: '15:00', endTime: '19:00' },
  { id: 'r5', userId: 'a', date: SAT, startTime: '10:00', endTime: '14:00' },
];

const shifts = [
  { id: 's1', date: MON, userName: 'Ann',  startTime: '15:00', endTime: '19:00', role: 'Instructor' },
  { id: 's2', date: MON, userName: 'Hugo', startTime: '15:00', endTime: '19:00', role: 'Host' },
];

const snapshots = { users, availability, shifts, timeOffRequests: [] };
const writes = [];

vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}),
  orderBy: () => ({}),
  onSnapshot: (q, next) => {
    const rows = snapshots[q?.__c] || [];
    if (typeof next === 'function') next({ docs: rows.map(r => ({ id: r.id, data: () => r })) });
    return () => {};
  },
  updateDoc: async (ref, payload) => { writes.push(payload); },
  setDoc: async (ref, payload) => { writes.push(payload); },
}));
vi.mock('../lib/notify', () => ({ toast: { success: () => {}, error: () => {} } }));

const current = { auth: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth, useOptionalAuth: () => current.auth }));

const { default: CoverageModelCard } = await import('./CoverageModelCard');
const { builtInRoles } = await import('../lib/roles');
const { DEFAULT_CENTER_CONFIG } = await import('../lib/centerConfig');

function setup(coverageModel, { canEdit = true, config = {} } = {}) {
  current.auth = {
    activeCenterId: 'langley',
    centreRoles: builtInRoles(() => '#000'),
    profile: { uid: 'me', role: 'owner' },
    isAdmin: false,
    can: () => canEdit,
    centerConfig: { ...DEFAULT_CENTER_CONFIG, coverageModel, ...config },
  };
  return render(<CoverageModelCard />);
}

/** The value printed above each bar, left to right. */
const barValues = () =>
  [...document.querySelectorAll('svg text[font-weight="600"]')].map(t => t.textContent.trim());

/** The cells of the row whose header starts with `label`. */
const rowCells = (label) => {
  const th = [...document.querySelectorAll('th')].find(x => x.textContent.startsWith(label));
  return [...th.parentElement.querySelectorAll('td')].map(td => td.textContent.trim());
};

/** The "2 Short" / "Matched" / "1 Spare" pills, left to right. */
const verdicts = () => rowCells('Ratio status');

const targetInput = (day) => screen.getByLabelText(`Instructors wanted on ${day}`);
const openDay = (day) => fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${day}$`) }));

beforeEach(() => {
  snapshots.availability = availability;
  writes.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 8, 21, 9, 0, 0));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the day bars', () => {
  it('counts people once, not once per half hour', () => {
    setup({ Monday: { day: 3 } });
    // Ann, Bea and Cal — three people across the afternoon, not twelve
    // slot-appearances. Hugo the host is never supply.
    expect(barValues()[0]).toBe('3');
    expect(verdicts()[0]).toBe('Matched');
  });

  it('says how short a day is against its own target', () => {
    setup({ Monday: { day: 5 }, Saturday: { day: 3 } });
    expect(verdicts()[0]).toBe('2 Short');
    expect(verdicts()[5]).toBe('2 Short');   // only Ann has Saturday on file
  });

  it('says when a day has more free than it asked for', () => {
    setup({ Monday: { day: 2 } });
    expect(verdicts()[0]).toBe('1 Spare');
  });

  it('leaves a day with no target unjudged', () => {
    // Saturday HAS availability on file (Ann), so the missing piece is the
    // target — "No data" would be the wrong complaint.
    setup({ Monday: { day: 3 } });
    expect(verdicts()[5]).toBe('—');
  });

  it('shows a day nobody has filled in as no data, not as zero available', () => {
    setup({ Tuesday: { day: 4 } });
    expect(verdicts()[1]).toBe('No data');
    expect(screen.getByText(/nobody has submitted availability yet/i)).toBeTruthy();
  });

  it('counts the instructors still to find, and only where it can tell', () => {
    setup({ Monday: { day: 5 }, Tuesday: { day: 4 }, Saturday: { day: 3 } });
    expect(rowCells('Impact')).toEqual(['2', '—', '—', '—', '—', '2']);
    // Monday 2 + Saturday 2. Tuesday has nothing on file, so it is not
    // counted as 4 short.
    expect(screen.getByText('Instructors short').parentElement.textContent).toContain('4');
    expect(screen.getByText('Days at target').parentElement.textContent).toContain('of 2');
  });
});

describe('opening a day', () => {
  it('redraws the same chart for that weekday’s instructional half hours', () => {
    setup({ Monday: { day: 3 } });
    openDay('Mon');
    expect(screen.getByText(/Monday — Supply vs\. Target/)).toBeTruthy();
    // Langley Monday is 3–7pm → eight half hours, and the window is stated.
    expect(screen.getByText(/instructional hours 3pm–7pm/)).toBeTruthy();
    expect(screen.getAllByLabelText(/Wanted at .* on Monday/)).toHaveLength(8);
  });

  it('reads each weekday’s own hours, not Monday’s', () => {
    setup({ Saturday: { day: 2 } }, {
      config: { instructionalHours: { ...DEFAULT_CENTER_CONFIG.instructionalHours, Saturday: { start: '10:00', end: '15:00' } } },
    });
    openDay('Sat');
    expect(screen.getByText(/instructional hours 10am–3pm/)).toBeTruthy();
    expect(screen.getAllByLabelText(/Wanted at .* on Saturday/)).toHaveLength(10);
  });

  it('bars show availability per half hour — it climbs when Cal arrives at 4', () => {
    setup({ Monday: { day: 3 } });
    openDay('Mon');
    expect(barValues()).toEqual(['2', '2', '3', '3', '3', '3', '3', '3']);
  });

  it('counts the rota separately from availability', () => {
    setup({ Monday: { day: 3 } });
    openDay('Mon');
    // Ann is rostered; Hugo's host shift is not teaching cover.
    expect(rowCells('On the rota')).toEqual(['1', '1', '1', '1', '1', '1', '1', '1']);
  });

  it('every half hour inherits the day’s number until one is overridden', () => {
    setup({ Monday: { day: 3, '16:30': 5 } });
    openDay('Mon');
    const inputs = screen.getAllByLabelText(/Wanted at .* on Monday/);
    // Inherited slots show the day's number as a placeholder, not a value.
    expect(inputs[0].value).toBe('');
    expect(inputs[0].placeholder).toBe('3');
    expect(screen.getByLabelText('Wanted at 16:30 on Monday').value).toBe('5');
  });

  it('a matched slot has nobody to find, however short the rota is', () => {
    // Monday wants 3 and 3 are free, but only one is rostered. The pill
    // says Matched and Impact stays blank — the rota gap is its own row,
    // and mixing them read "Matched" with an impact of seven.
    setup({ Monday: { day: 3 } });
    openDay('Mon');
    const status = rowCells('Ratio status');
    const impact = rowCells('Impact');
    const rota = rowCells('On the rota');
    expect(status[2]).toBe('Matched');
    expect(impact[2]).toBe('—');
    expect(rota[2]).toBe('1');
  });

  it('counts only what availability cannot cover as “to find”', () => {
    setup({ Monday: { day: 4 } });
    openDay('Mon');
    // 3:00 has two free against a want of four.
    expect(rowCells('Ratio status')[0]).toBe('2 Short');
    expect(rowCells('Impact')[0]).toBe('2');
  });

  it('goes back to the week', () => {
    setup({ Monday: { day: 3 } });
    openDay('Mon');
    fireEvent.click(screen.getByRole('button', { name: /Back to the week/ }));
    expect(screen.getByText(/Centre — Supply vs\. Target/)).toBeTruthy();
  });
});

describe('editing targets', () => {
  it('typing a day target offers a save, and writes the whole field', async () => {
    setup({ Monday: { day: 3 } });
    fireEvent.change(targetInput('Tuesday'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /Save targets/ }));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].coverageModel.Tuesday.day).toBe(6);
    expect(writes[0].coverageModel.Monday.day).toBe(3);
  });

  it('keeps a half-hour override when the day’s number changes', () => {
    setup({ Monday: { day: 3, '16:30': 5 } });
    fireEvent.change(targetInput('Monday'), { target: { value: '4' } });
    openDay('Mon');
    expect(screen.getByLabelText('Wanted at 16:30 on Monday').value).toBe('5');
  });

  it('sets every operating day at once', () => {
    setup(undefined);
    fireEvent.change(screen.getByLabelText('Target for every operating day'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply to all/ }));
    expect(targetInput('Monday').value).toBe('12');
    expect(targetInput('Saturday').value).toBe('12');
  });

  it('a Host gets the numbers read-only — the rules refuse their write', () => {
    setup({ Monday: { day: 3 } }, { canEdit: false });
    expect(targetInput('Monday').disabled).toBe(true);
    expect(screen.getByText(/Read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Apply to all/ })).toBeNull();
  });
});
