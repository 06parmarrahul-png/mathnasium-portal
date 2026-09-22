// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Calendar, rendered.
 *
 * The page pulls five collections together and the only thing with teeth
 * — the booking hold — is decided in a preview line someone reads BEFORE
 * they save. That line is arithmetic over the centre's own hours, so it
 * can be asserted, and it is the one thing here worth being sure about:
 * getting it wrong means a director closes Friday without being told.
 */
const snapshots = {};

vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {}, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c, where: () => ({}), orderBy: () => ({}), limit: () => ({}),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  addDoc: async () => ({ id: 'x' }), updateDoc: async () => {}, deleteDoc: async () => {},
  onSnapshot: (ref, next) => {
    if (typeof next === 'function') {
      const rows = snapshots[String(ref?.__c || '').split('/').pop()] || [];
      next({ docs: rows.map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));
vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn() }, confirmDialog: async () => true,
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authValue.current, useOptionalAuth: () => authValue.current,
}));

const { default: RatioCalendar } = await import('./RatioCalendar');

/** Langley: teaches 3–7pm on weekdays, 60-minute assessments every 30. */
const HOURS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
  .reduce((acc, d) => ({ ...acc, [d]: { start: '15:00', end: '19:00' } }), {});

const CONFIG = {
  name: 'Langley',
  instructionalHours: HOURS,
  intakeSettings: { slotDurationMin: 60, slotIntervalMin: 30 },
  holidays: [{ date: '2026-09-07', name: 'Labour Day' }],
};

const DIRECTOR = {
  activeCenterId: 'langley',
  profile: { uid: 'neeru', displayName: 'Neeru Gill' },
  centerConfig: CONFIG,
};

const TRAINING = {
  id: 'e1', title: 'Radius training', kind: 'training', date: '2026-09-25',
  startTime: '15:00', endTime: '17:00', allDay: false,
  assignedTo: ['neeru'], assignedNames: ['Neeru Gill'], holdsBooking: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  // Tuesday 22 September 2026, so the week grid runs Sun 20 – Sat 26.
  vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0));
  authValue.current = DIRECTOR;
  snapshots.calendar = [TRAINING];
  snapshots.events = [{ id: 'ev1', date: '2026-09-24', title: 'Bingo', type: 'fun-day' }];
  snapshots.centerIntakes = [{
    id: 'i1', centerId: 'langley', slot: '2026-09-25T18:00:00', durationMin: 60,
    childName: 'Sofia K.', guardianName: 'A. Kovac', status: 'scheduled',
  }];
  snapshots.timeOffRequests = [{
    id: 't1', userName: 'Luke Huang', status: 'approved',
    startDate: '2026-09-24', endDate: '2026-09-24',
  }];
  snapshots.users = [
    { id: 'neeru', displayName: 'Neeru Gill', approved: true },
    { id: 'rahul', displayName: 'Rahul Parmar', approved: true },
    { id: 'ghost', displayName: 'Not Approved', approved: false },
  ];
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

const draw = () => render(<MemoryRouter><RatioCalendar /></MemoryRouter>);
const openComposer = () => fireEvent.click(screen.getByRole('button', { name: /new entry/i }));

describe('the week everything lands on', () => {
  it('shows the entry, the booking, the fun day and the time off together', () => {
    draw();
    expect(screen.getByText('Radius training')).toBeTruthy();
    expect(screen.getByText('Assessment — Sofia K.')).toBeTruthy();
    expect(screen.getByText('Bingo')).toBeTruthy();
    expect(screen.getByText('Luke Huang — time off')).toBeTruthy();
  });

  it('counts what is holding the booking page', () => {
    draw();
    expect(screen.getByText(/1 entry holds the booking page/i)).toBeTruthy();
  });

  it('says "entries hold" once there is more than one', () => {
    snapshots.calendar = [TRAINING, { ...TRAINING, id: 'e2', date: '2026-09-23' }];
    draw();
    expect(screen.getByText(/2 entries hold the booking page/i)).toBeTruthy();
  });

  it('leaves the count alone for an entry that does not hold', () => {
    snapshots.calendar = [{ ...TRAINING, holdsBooking: false }];
    draw();
    expect(screen.queryByText(/holds the booking page/i)).toBeNull();
  });

  it('switches a layer off without touching the others', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /assessments/i }));
    expect(screen.queryByText('Assessment — Sofia K.')).toBeNull();
    expect(screen.getByText('Radius training')).toBeTruthy();
  });
});

describe('the month, where the closures live', () => {
  it('names a statutory closure on its own day', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /^month$/i }));
    expect(screen.getByText('Labour Day')).toBeTruthy();
    expect(screen.getByText('Statutory — centre closed')).toBeTruthy();
  });

  it('shows a centre closure as a closure rather than a holiday', () => {
    authValue.current = {
      ...DIRECTOR,
      centerConfig: { ...CONFIG, holidays: [{ date: '2026-09-18', name: 'Staff training day', stat: false }] },
    };
    draw();
    fireEvent.click(screen.getByRole('button', { name: /^month$/i }));
    expect(screen.getByText('Centre closed')).toBeTruthy();
  });

  it('keeps everything else off a closed day — the centre is shut', () => {
    authValue.current = {
      ...DIRECTOR,
      centerConfig: { ...CONFIG, holidays: [{ date: '2026-09-25', name: 'Labour Day' }] },
    };
    draw();
    fireEvent.click(screen.getByRole('button', { name: /^month$/i }));
    expect(screen.getByText('Labour Day')).toBeTruthy();
    expect(screen.queryByText('Radius training')).toBeNull();
  });
});

describe('what the composer tells you before you close a day', () => {
  /** Fill the composer in for a 3–5pm Friday hold. */
  const composeFridayTraining = (container, { hold = true } = {}) => {
    openComposer();
    const dialog = container.querySelector('.fixed');
    fireEvent.change(within(dialog).getByPlaceholderText(/radius training/i), {
      target: { value: 'Radius training' },
    });
    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2026-09-25' } });
    const times = dialog.querySelectorAll('input[type="time"]');
    fireEvent.change(times[0], { target: { value: '15:00' } });
    fireEvent.change(times[1], { target: { value: '17:00' } });
    if (hold) fireEvent.click(within(dialog).getByLabelText(/hold the booking page/i));
    return dialog;
  };

  it('names every time a family loses', () => {
    // The centre offers 3:00, 3:30, 4:00, 4:30, 5:00, 5:30 and 6:00.
    // A 3–5 hold takes the first four: an assessment starting at 4:30
    // runs to 5:30 and overlaps the tail of it. 5:00 survives, because
    // it sits flush against the end.
    const { container } = draw();
    const dialog = composeFridayTraining(container);
    expect(within(dialog).getByText('3pm, 3:30pm, 4pm, 4:30pm')).toBeTruthy();
  });

  it('says how little is left, counting the booking already on that day', () => {
    // 5:00, 5:30 and 6:00 survive the hold, and Sofia already has 6:00.
    const { container } = draw();
    const dialog = composeFridayTraining(container);
    expect(within(dialog).getByText(/2 bookable times left/i)).toBeTruthy();
  });

  it('warns plainly when the day closes completely', () => {
    const { container } = draw();
    openComposer();
    const dialog = container.querySelector('.fixed');
    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2026-09-25' } });
    fireEvent.click(within(dialog).getByLabelText(/all day/i));
    fireEvent.click(within(dialog).getByLabelText(/hold the booking page/i));
    expect(within(dialog).getByText(/no bookable times left/i)).toBeTruthy();
  });

  it('is honest that a hold does not spend the day-s assessment limit', () => {
    const { container } = draw();
    const dialog = composeFridayTraining(container);
    expect(within(dialog).getByText(/only real assessments count against that/i)).toBeTruthy();
  });

  it('says nothing at all until the hold is ticked', () => {
    const { container } = draw();
    const dialog = composeFridayTraining(container, { hold: false });
    expect(within(dialog).queryByText(/bookable times left/i)).toBeNull();
  });

  it('does not pretend to hold a day the centre is already closed on', () => {
    const { container } = draw();
    openComposer();
    const dialog = container.querySelector('.fixed');
    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2026-09-07' } });
    fireEvent.click(within(dialog).getByLabelText(/hold the booking page/i));
    expect(within(dialog).getByText(/already closed that day \(Labour Day\)/i)).toBeTruthy();
  });

  it('does not pretend to hold a day with no booking hours', () => {
    const { container } = draw();
    openComposer();
    const dialog = container.querySelector('.fixed');
    // Sunday — the centre does not teach.
    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2026-09-20' } });
    const times = dialog.querySelectorAll('input[type="time"]');
    fireEvent.change(times[0], { target: { value: '15:00' } });
    fireEvent.change(times[1], { target: { value: '17:00' } });
    fireEvent.click(within(dialog).getByLabelText(/hold the booking page/i));
    expect(within(dialog).getByText(/isn’t taking assessments then/i)).toBeTruthy();
  });
});

describe('the composer', () => {
  it('refuses an entry with no name rather than saving a blank row', () => {
    const { container } = draw();
    openComposer();
    const dialog = container.querySelector('.fixed');
    fireEvent.click(within(dialog).getByRole('button', { name: /save entry/i }));
    expect(within(dialog).getByText(/give it a name/i)).toBeTruthy();
  });

  it('offers only approved staff to assign', () => {
    const { container } = draw();
    openComposer();
    const dialog = container.querySelector('.fixed');
    expect(within(dialog).getByLabelText('Neeru Gill')).toBeTruthy();
    expect(within(dialog).getByLabelText('Rahul Parmar')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Not Approved')).toBeNull();
  });

  it('opens an existing entry for editing, with a way to delete it', () => {
    const { container } = draw();
    fireEvent.click(screen.getByTitle(/Radius training/i));
    const dialog = container.querySelector('.fixed');
    expect(within(dialog).getByText('Edit entry')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /delete/i })).toBeTruthy();
  });

  it('will not open a row the calendar does not own', () => {
    // An assessment is edited where it was booked, a fun day on Centre
    // Events. Opening them here would offer an edit that goes nowhere.
    const { container } = draw();
    fireEvent.click(screen.getByTitle(/Assessment — Sofia K./i));
    expect(container.querySelector('.fixed')).toBeNull();
  });
});

describe('the three week rows keep one set of columns', () => {
  /**
   * Reported: the all-day band did not line up with the dates above it.
   *
   * The header, the all-day band and the hour grid are three SIBLING
   * grids sharing `54px repeat(7, 1fr)`. `1fr` is minmax(auto, 1fr), and
   * a grid item's automatic minimum is its min-content — which `truncate`
   * (white-space: nowrap) makes the entire string. So a long all-day
   * title widened its own column and squeezed the rest, in that row only:
   * the header holds three characters and the hour columns hold nothing
   * but absolutely-positioned children, so both stayed even.
   *
   * jsdom does not lay out, so geometry cannot be measured here. What can
   * be pinned is the thing whose removal causes it.
   */
  const LONG = { ...TRAINING, id: 'long', allDay: true, startTime: null, endTime: null,
    title: 'Rock Paper Scissors Tournament and then some more words' };

  const cellsOf = (container, sel) => [...container.querySelectorAll(sel)];

  it('gives every day cell in all three rows a zero minimum width', () => {
    snapshots.calendar = [LONG];
    const { container } = draw();
    const grids = cellsOf(container, '[style*="repeat(7, 1fr)"]');
    expect(grids).toHaveLength(3);
    for (const g of grids) {
      // Child 0 is the fixed 54px gutter; the seven after it are the days.
      const days = [...g.children].slice(1);
      expect(days).toHaveLength(7);
      for (const d of days) expect(d.className).toMatch(/\bmin-w-0\b/);
    }
  });

  it('still truncates the long title rather than letting it set the width', () => {
    snapshots.calendar = [LONG];
    const { container } = draw();
    const chip = [...container.querySelectorAll('button')]
      .find(b => b.textContent.includes('Rock Paper Scissors'));
    expect(chip.className).toMatch(/\btruncate\b/);
  });

  it('gives the month grid the same treatment — same shape, same chips', () => {
    snapshots.calendar = [LONG];
    const { container } = draw();
    fireEvent.click([...container.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'month'));
    const grids = cellsOf(container, '[style*="repeat(7, 1fr)"]');
    for (const g of grids) {
      for (const cell of g.children) expect(cell.className).toMatch(/\bmin-w-0\b/);
    }
  });
});
