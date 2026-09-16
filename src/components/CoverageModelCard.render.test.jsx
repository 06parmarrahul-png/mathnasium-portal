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
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth }));

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

/** The verdict line under a day ("2 short", "+1 spare", "none on file"). */
const verdictFor = (day) =>
  screen.getByRole('button', { name: new RegExp(`^${day}$`) })
    .parentElement.querySelectorAll('p')[1].textContent.trim();

const targetInput = (day) => screen.getByLabelText(`Instructors wanted on ${day}`);

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
    // Ann, Bea, Cal — three people across the afternoon, not twelve
    // slot-appearances. Hugo the host is not supply.
    expect(screen.getByTitle(/3 available on Monday/)).toBeTruthy();
    expect(verdictFor('Mon')).toBe('+0 spare');
  });

  it('says how short a day is against its own target', () => {
    setup({ Monday: { day: 5 }, Saturday: { day: 3 } });
    expect(verdictFor('Mon')).toBe('2 short');
    expect(verdictFor('Sat')).toBe('2 short');   // only Ann has Saturday on file
  });

  it('leaves a day with no target unjudged', () => {
    // Saturday HAS availability on file (Ann), so the missing piece is the
    // target — "none on file" would be the wrong complaint.
    setup({ Monday: { day: 3 } });
    expect(verdictFor('Sat')).toBe('no target');
  });

  it('shows a day nobody has filled in as blank, not as zero available', () => {
    // Tuesday has no availability rows at all — the common live case.
    setup({ Tuesday: { day: 4 } });
    expect(verdictFor('Tue')).toBe('none on file');
    expect(screen.getByTitle(/No availability on file for Tuesday/)).toBeTruthy();
  });

  it('totals only the days it can actually speak about', () => {
    setup({ Monday: { day: 5 }, Tuesday: { day: 4 }, Saturday: { day: 3 } });
    // Monday 2 short + Saturday 2 short. Tuesday has nothing on file, so it
    // is not counted as 4 short.
    expect(screen.getByText('Instructors short').parentElement.textContent).toContain('4');
    expect(screen.getByText('Days at target').parentElement.textContent).toContain('of 2');
  });
});

describe('opening a day', () => {
  it('expands into that weekday’s instructional half hours', () => {
    setup({ Monday: { day: 3 } });
    fireEvent.click(screen.getByRole('button', { name: /^Mon$/ }));
    // Langley Monday is 3–7pm → eight half hours, and the window is stated.
    expect(screen.getByText(/instructional hours 3pm–7pm/)).toBeTruthy();
    expect(screen.getAllByLabelText(/Wanted at .* on Monday/)).toHaveLength(8);
  });

  it('reads each weekday’s own hours, not Monday’s', () => {
    // Saturday is a morning shift in the default config, and shorter.
    setup({ Saturday: { day: 2 } }, {
      config: { instructionalHours: { ...DEFAULT_CENTER_CONFIG.instructionalHours, Saturday: { start: '10:00', end: '15:00' } } },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Sat$/ }));
    expect(screen.getByText(/instructional hours 10am–3pm/)).toBeTruthy();
    expect(screen.getAllByLabelText(/Wanted at .* on Saturday/)).toHaveLength(10);
  });

  it('shows the half-hour detail: available climbs when Cal arrives at 4', () => {
    setup({ Monday: { day: 3 } });
    fireEvent.click(screen.getByRole('button', { name: /^Mon$/ }));
    const availRow = screen.getByText('Available').closest('tr');
    const cells = [...availRow.querySelectorAll('td')].slice(1).map(td => td.textContent.trim());
    expect(cells).toEqual(['2', '2', '3', '3', '3', '3', '3', '3']);
  });

  it('counts the rota separately from availability', () => {
    setup({ Monday: { day: 3 } });
    fireEvent.click(screen.getByRole('button', { name: /^Mon$/ }));
    const row = screen.getByText('Scheduled').closest('tr');
    const cells = [...row.querySelectorAll('td')].slice(1).map(td => td.textContent.trim());
    // Ann is rostered; Hugo's host shift is not teaching cover.
    expect(cells.every(c => c === '1')).toBe(true);
  });

  it('every half hour inherits the day’s number until one is overridden', () => {
    setup({ Monday: { day: 3, '16:30': 5 } });
    fireEvent.click(screen.getByRole('button', { name: /^Mon$/ }));
    const inputs = screen.getAllByLabelText(/Wanted at .* on Monday/);
    // Inherited slots show the day's number as a placeholder, not a value.
    expect(inputs[0].value).toBe('');
    expect(inputs[0].placeholder).toBe('3');
    // The overridden one carries its own.
    expect(screen.getByLabelText('Wanted at 16:30 on Monday').value).toBe('5');
  });

  it('closes again when the same day is clicked', () => {
    setup({ Monday: { day: 3 } });
    fireEvent.click(screen.getByRole('button', { name: /^Mon$/ }));
    expect(screen.queryByText(/instructional hours/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Mon$/ }));
    expect(screen.queryByText(/instructional hours/)).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: /^Mon$/ }));
    expect(screen.getByLabelText('Wanted at 16:30 on Monday').value).toBe('5');
  });

  it('sets every operating day at once', () => {
    setup(undefined);
    fireEvent.change(screen.getByLabelText('Target for every operating day'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Set every day to this/ }));
    expect(targetInput('Monday').value).toBe('12');
    expect(targetInput('Saturday').value).toBe('12');
  });

  it('a Host gets the numbers read-only — the rules refuse their write', () => {
    setup({ Monday: { day: 3 } }, { canEdit: false });
    expect(targetInput('Monday').disabled).toBe(true);
    expect(screen.getByText(/Read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Set every day to this/ })).toBeNull();
  });
});
