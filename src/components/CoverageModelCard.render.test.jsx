// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * The coverage card, rendered.
 *
 * The numbers here are the whole point of the card, so they're asserted
 * off the real DOM rather than from the pure module alone: a row that
 * reads its columns in the wrong order, or an average divided by the
 * wrong number of weeks, looks fine in coverageModel.test.js and wrong on
 * the screen.
 */

// Four Mondays from the frozen clock: 21 Sep, 28 Sep, 5 Oct, 12 Oct 2026.
const MONDAYS = ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'];

const availability = MONDAYS.flatMap(date => ([
  { userId: 'a', date, startTime: '15:00', endTime: '19:00' },
  { userId: 'b', date, startTime: '15:00', endTime: '19:00' },
  { userId: 'c', date, startTime: '16:00', endTime: '19:00' },
  // A host — present, but never ratio supply.
  { userId: 'h', date, startTime: '15:00', endTime: '19:00' },
]));

const shifts = MONDAYS.flatMap(date => ([
  { id: `s1-${date}`, date, userName: 'Ann',  startTime: '15:00', endTime: '19:00', role: 'Instructor' },
  { id: `s2-${date}`, date, userName: 'Bea',  startTime: '16:00', endTime: '19:00', role: 'Instructor' },
  { id: `s3-${date}`, date, userName: 'Hugo', startTime: '15:00', endTime: '19:00', role: 'Host' },
]));

const users = [
  { uid: 'a', id: 'a', displayName: 'Ann',  instructorType: 'Instructor' },
  { uid: 'b', id: 'b', displayName: 'Bea',  instructorType: 'Instructor' },
  { uid: 'c', id: 'c', displayName: 'Cal',  instructorType: 'Lead' },
  { uid: 'h', id: 'h', displayName: 'Hugo', instructorType: 'Host' },
];

const snapshots = { availability, timeOffRequests: [] };

vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c,
  where: () => ({}),
  orderBy: () => ({}),
  onSnapshot: (q, next) => {
    const rows = snapshots[q?.__c] || [];
    if (typeof next === 'function') next({ docs: rows.map(r => ({ id: r.id || r.userId + r.date, data: () => r })) });
    return () => {};
  },
}));

const current = { auth: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth }));

const { default: CoverageModelCard } = await import('./CoverageModelCard');
const { builtInRoles } = await import('../lib/roles');
const { DEFAULT_CENTER_CONFIG } = await import('../lib/centerConfig');

function setup(coverageModel, overrides = {}) {
  current.auth = {
    activeCenterId: 'langley',
    centreRoles: builtInRoles(() => '#000'),
    centerConfig: {
      ...DEFAULT_CENTER_CONFIG,
      instructionalHours: { ...DEFAULT_CENTER_CONFIG.instructionalHours, Monday: { start: '15:00', end: '17:00' } },
      coverageModel,
      ...overrides,
    },
  };
  return render(<CoverageModelCard users={users} shifts={shifts} />);
}

/** The cells of the row whose label starts with `label`. */
function rowCells(label) {
  const cell = screen.getByText((t, node) => node?.tagName === 'TD' && node.textContent.startsWith(label));
  return [...cell.parentElement.querySelectorAll('td')].slice(1).map(td => td.textContent.trim());
}

beforeEach(() => {
  snapshots.availability = availability;   // tests below mutate it
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 8, 21, 9, 0, 0));   // Monday 21 Sep 2026, local
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('coverage vs target', () => {
  it('shows a column per half hour of the teaching window', () => {
    setup({ Monday: { '15:00': 4, '15:30': 4, '16:00': 4, '16:30': 4 } });
    for (const label of ['3', '3:30', '4', '4:30']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('counts only staff who fill a ratio slot, on both lines', () => {
    setup({ Monday: { '15:00': 4, '15:30': 4, '16:00': 4, '16:30': 4 } });
    // Available: Ann + Bea from 3pm, Cal joins at 4pm. Hugo the host never
    // counts, though he is available and rostered all afternoon.
    expect(rowCells('Available')).toEqual(['2', '2', '3', '3']);
    // Scheduled: Ann from 3, Bea from 4. Hugo's host shift is not cover.
    expect(rowCells('Scheduled')).toEqual(['1', '1', '2', '2']);
  });

  it('separates a rota gap from a gap no rota can fix', () => {
    setup({ Monday: { '15:00': 2, '15:30': 4, '16:00': 3, '16:30': 3 } });
    const statuses = rowCells('Status');
    // 3:00 wants 2, 2 free, 1 rostered → fixable on the board.
    expect(statuses[0]).toBe('-1');
    // 3:30 wants 4 and only 2 people are free → can't be staffed at all.
    expect(statuses[1]).toBe('-2');
    // 4:00 wants 3, 3 free, 2 rostered → still a rota gap.
    expect(statuses[2]).toBe('-1');
    expect(screen.getByText(/can.t be staffed/i)).toBeTruthy();
    expect(screen.getByText(/short on the rota but have/i)).toBeTruthy();
  });

  it('says OK when the rota meets the target', () => {
    setup({ Monday: { '16:00': 2, '16:30': 2 } });
    const statuses = rowCells('Status');
    expect(statuses[2]).toBe('OK');
    expect(statuses[3]).toBe('OK');
    // Slots with no target stay blank rather than reading as zero wanted.
    expect(statuses[0]).toBe('—');
    expect(rowCells('Staff wanted')[0]).toBe('—');
  });

  it('points at the Staffing Board when a weekday has no targets', () => {
    setup({ Tuesday: { '15:00': 3 } });
    expect(screen.getByText(/No targets set for Monday yet/i)).toBeTruthy();
  });

  it('switches weekday without losing the table', () => {
    setup({ Monday: { '15:00': 4 }, Tuesday: { '15:00': 3 } });
    fireEvent.click(screen.getByRole('button', { name: 'Tue' }));
    expect(screen.queryByText(/No targets set for Tuesday/i)).toBeNull();
    expect(rowCells('Staff wanted')[0]).toBe('3');
  });

  it('skips a closed day rather than averaging it in as nobody working', () => {
    setup(
      { Monday: { '15:00': 2 } },
      { holidays: [{ date: '2026-09-21', name: 'Closed' }] },
    );
    expect(screen.getByText(/1 closed day skipped/i)).toBeTruthy();
    // The three remaining Mondays still have both instructors free.
    expect(rowCells('Available')[0]).toBe('2');
  });

  it('renders the header even with nothing configured at all', () => {
    setup(undefined);
    expect(within(screen.getByRole('heading', { name: /Coverage vs target/i })).toString).toBeTruthy();
  });
});

describe('when availability is thin — the normal state of this centre', () => {
  it('leaves Available blank rather than reporting nobody is free', () => {
    // Most days at Langley have no availability on file at all. Reading
    // that as "nobody can work" would paint every slot red.
    snapshots.availability = [];
    setup({ Monday: { '15:00': 4, '15:30': 4, '16:00': 4, '16:30': 4 } });
    expect(rowCells('Available')).toEqual(['—', '—', '—', '—']);
    expect(screen.getByText(/Nobody has submitted availability for Monday yet/i)).toBeTruthy();
    // Still says the rota is short, because the rota IS known.
    expect(rowCells('Status')[0]).toBe('-3');
    // But never claims it can't be staffed.
    expect(screen.queryByText(/can.t be staffed/i)).toBeNull();
  });

  it('averages availability only over the weeks people filled in', () => {
    // Only the first Monday has been submitted. Averaging four weeks would
    // report 0.5 people free and cry wolf; the answer is 2.
    snapshots.availability = availability.filter(a => a.date === MONDAYS[0]);
    setup({ Monday: { '15:00': 2, '15:30': 2, '16:00': 2, '16:30': 2 } });
    expect(rowCells('Available')[0]).toBe('2');
    expect(screen.getByText(/availability from the 1 with any on file/i)).toBeTruthy();
    // The rota line still reads all four Mondays.
    expect(rowCells('Scheduled')[0]).toBe('1');
  });

  it('a submitted day with nobody free is still a real zero', () => {
    snapshots.availability = MONDAYS.map(date => (
      { userId: 'h', date, startTime: '15:00', endTime: '19:00' }   // host only
    ));
    setup({ Monday: { '15:00': 2 } });
    expect(rowCells('Available')[0]).toBe('0');
    expect(screen.getByText(/can.t be staffed/i)).toBeTruthy();
  });
});
