// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
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
/** Every write the page makes, so a series can be checked document by document. */
const writes = { added: [], set: [], updated: [], deleted: [] };
let minted = 0;

vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c, where: () => ({}), orderBy: () => ({}), limit: () => ({}),
  // doc(col) mints a new id the way Firestore does; doc(col, id) points at one.
  doc: (...a) => (a.length === 1
    ? { __d: `new-${++minted}`, id: `new-${minted}` }
    : { __d: a[a.length - 1], id: a[a.length - 1] }),
  addDoc: async (c, d) => { writes.added.push(d); return { id: 'x' }; },
  updateDoc: async (r, d) => { writes.updated.push({ id: r.id, data: d }); },
  deleteDoc: async (r) => { writes.deleted.push(r.id); },
  writeBatch: () => ({
    set: (r, d) => writes.set.push({ id: r.id, data: d }),
    update: (r, d) => writes.updated.push({ id: r.id, data: d }),
    delete: (r) => writes.deleted.push(r.id),
    commit: async () => {},
  }),
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
  // centerIntakes is owner-tier in the rules; a director passes it.
  isOwnerLike: true, isSuperAdmin: false,
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
  writes.added = []; writes.set = []; writes.updated = []; writes.deleted = [];
  minted = 0;
  snapshots.calendar = [TRAINING];
  snapshots.events = [{ id: 'ev1', date: '2026-09-24', title: 'Bingo', type: 'fun-day' }];
  snapshots.centerIntakes = [{
    id: 'i1', centerId: 'langley', slot: '2026-09-25T18:00:00', durationMin: 60,
    childName: 'Sofia K.', guardianName: 'A. Kovac', status: 'scheduled',
  }];
  // timeOffRequests is deliberately NOT subscribed any more; rows here
  // would prove nothing except that the listener is gone.
  snapshots.users = [
    { id: 'neeru', displayName: 'Neeru Gill', approved: true },
    { id: 'rahul', displayName: 'Rahul Parmar', approved: true },
    { id: 'rishi', displayName: 'Rishi Mukerji', approved: true },
    { id: 'rushan', displayName: 'Rushan Zavid', approved: true },
    { id: 'sabrina', displayName: 'Sabrina Kedzior', approved: true },
    { id: 'ghost', displayName: 'Not Approved', approved: false },
  ];
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

const draw = () => render(<MemoryRouter><RatioCalendar /></MemoryRouter>);
const openComposer = () => fireEvent.click(screen.getByRole('button', { name: /new entry/i }));

describe('the week everything lands on', () => {
  it('shows the entry, the booking and the fun day together', () => {
    draw();
    expect(screen.getByText('Radius training')).toBeTruthy();
    expect(screen.getByText('Assessment — Sofia K.')).toBeTruthy();
    expect(screen.getByText('Bingo')).toBeTruthy();
  });

  it('has no time-off layer at all — the centre asked for it gone', () => {
    // Not merely empty: the chip is gone and nothing subscribes to
    // timeOffRequests, so an approved day off cannot reach this page.
    snapshots.timeOffRequests = [{
      id: 't1', userName: 'Luke Huang', status: 'approved',
      startDate: '2026-09-24', endDate: '2026-09-24',
    }];
    draw();
    expect(screen.queryByRole('button', { name: /time off/i })).toBeNull();
    expect(screen.queryByText(/Luke Huang/)).toBeNull();
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

  it('opens an assessment in its OWN editor, not the entry composer', () => {
    // An assessment is a centerIntakes document, so it gets the editor
    // that writes there. It used to open nothing at all, which meant an
    // imported booking named "Booked" was wrong forever.
    const { container } = draw();
    fireEvent.click(screen.getByTitle(/Assessment — Sofia K./i));
    const dialog = container.querySelector('.fixed');
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText(/^Assessment$/)).toBeTruthy();
    expect(within(dialog).queryByText(/Edit entry/i)).toBeNull();
    expect(within(dialog).getByLabelText(/child's name/i).value).toBe('Sofia K.');
  });

  it('still will not open a fun day — that is edited on Centre Events', () => {
    const { container } = draw();
    fireEvent.click(screen.getByTitle(/^Bingo$/i));
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

  /* The template is built from however many days are shown, so match on
     `repeat(` rather than a fixed seven. */
  const gridsOf = (container) => [...container.querySelectorAll('div')]
    .filter(el => /grid-template-columns:\s*54px repeat\(/.test(el.getAttribute('style') || ''));

  it('gives every day cell in all three rows a zero minimum width', () => {
    snapshots.calendar = [LONG];
    const { container } = draw();
    const grids = gridsOf(container);
    expect(grids).toHaveLength(3);
    for (const g of grids) {
      // Child 0 is the fixed 54px gutter; the rest are the days.
      const days = [...g.children].slice(1);
      expect(days.length).toBeGreaterThan(0);
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
    const grids = [...container.querySelectorAll('div')]
      .filter(el => /grid-template-columns:\s*repeat\(7, 1fr\)/.test(el.getAttribute('style') || ''));
    expect(grids.length).toBeGreaterThan(0);
    for (const g of grids) {
      for (const cell of g.children) expect(cell.className).toMatch(/\bmin-w-0\b/);
    }
  });
});

/**
 * Recurring entries.
 *
 * The real ask: "I just added our management team meeting 12–1 on
 * Wednesday, I want to make it recurring." Wednesday is 23 September
 * 2026 in this fixture.
 *
 * A series is written as one document per occurrence. That is not a
 * storage preference — api/intakes.js finds holds with a date-range
 * query, so a rule on a single document would hold the first week and
 * then silently stop. These tests read the actual writes.
 */
describe('making it repeat', () => {
  const WED = '2026-09-23';

  const fillMeeting = (dialog, { date = WED } = {}) => {
    fireEvent.change(within(dialog).getByPlaceholderText(/radius training/i), {
      target: { value: 'Management team meeting' },
    });
    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: date } });
    const times = dialog.querySelectorAll('input[type="time"]');
    fireEvent.change(times[0], { target: { value: '12:00' } });
    fireEvent.change(times[1], { target: { value: '13:00' } });
  };
  const pick = (dialog, label) =>
    fireEvent.click(within(dialog).getByRole('button', { name: label }));
  const saveIt = async (dialog) => {
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^save entry$/i }));
    });
  };
  const open = (container) => { openComposer(); return container.querySelector('.fixed'); };

  it('offers the patterns a centre actually runs on', () => {
    const { container } = draw();
    const dialog = open(container);
    for (const label of [/does not repeat/i, /every week/i, /every 2 weeks/i,
      /every 4 weeks/i, /every month/i]) {
      expect(within(dialog).getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('says how many it will make before you press save', () => {
    const { container } = draw();
    const dialog = open(container);
    fillMeeting(dialog);
    pick(dialog, /^every week$/i);
    expect(within(dialog).getByText(/53 entries, every week, through/i)).toBeTruthy();
  });

  it('writes one document per week, every one a Wednesday', async () => {
    const { container } = draw();
    const dialog = open(container);
    fillMeeting(dialog);
    pick(dialog, /^every week$/i);
    // [0] is the entry's own date, [1] is the series "Until".
    fireEvent.change(dialog.querySelectorAll('input[type="date"]')[1], { target: { value: '2026-10-21' } });
    await saveIt(dialog);

    expect(writes.set).toHaveLength(5);
    expect(writes.set.map(w => w.data.date)).toEqual([
      '2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14', '2026-10-21',
    ]);
    for (const w of writes.set) {
      expect(new Date(`${w.data.date}T12:00:00`).getDay()).toBe(3);
      expect(w.data.startTime).toBe('12:00');
      expect(w.data.endTime).toBe('13:00');
      expect(w.data.repeat).toBe('weekly');
    }
  });

  it('ties them together with one seriesId', async () => {
    const { container } = draw();
    const dialog = open(container);
    fillMeeting(dialog);
    pick(dialog, /^every week$/i);
    fireEvent.change(dialog.querySelectorAll('input[type="date"]')[1], { target: { value: '2026-10-07' } });
    await saveIt(dialog);
    const ids = new Set(writes.set.map(w => w.data.seriesId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  it('skips a week the centre is closed', async () => {
    authValue.current = {
      ...DIRECTOR,
      centerConfig: { ...CONFIG, holidays: [{ date: '2026-09-30', name: 'Closure day' }] },
    };
    const { container } = draw();
    const dialog = open(container);
    fillMeeting(dialog);
    pick(dialog, /^every week$/i);
    fireEvent.change(dialog.querySelectorAll('input[type="date"]')[1], { target: { value: '2026-10-07' } });
    expect(within(dialog).getByText(/1 skipped — the centre is closed/i)).toBeTruthy();
    await saveIt(dialog);
    expect(writes.set.map(w => w.data.date)).toEqual(['2026-09-23', '2026-10-07']);
  });

  it('warns that a repeating hold holds every single one', () => {
    const { container } = draw();
    const dialog = open(container);
    fillMeeting(dialog);
    pick(dialog, /^every week$/i);
    fireEvent.click(within(dialog).getByLabelText(/hold the booking page/i));
    expect(within(dialog).getByText(/every one of them holds the booking page/i)).toBeTruthy();
  });

  it('keeps a one-off a one-off', async () => {
    const { container } = draw();
    const dialog = open(container);
    fillMeeting(dialog);
    await saveIt(dialog);
    expect(writes.set).toHaveLength(0);
    expect(writes.added).toHaveLength(1);
    expect(writes.added[0]).toMatchObject({ date: WED, seriesId: null, repeat: null });
  });
});

describe('an entry that is already part of a series', () => {
  const S = (id, date) => ({
    id, title: 'Management team meeting', kind: 'meeting', date,
    startTime: '12:00', endTime: '13:00', allDay: false,
    assignedTo: [], assignedNames: [], holdsBooking: false,
    seriesId: 'ser1', repeat: 'weekly', repeatUntil: '2026-10-14',
  });
  const SERIES = [S('w1', '2026-09-23'), S('w2', '2026-09-30'), S('w3', '2026-10-07'), S('w4', '2026-10-14')];

  const openOccurrence = (container) => {
    fireEvent.click(screen.getAllByTitle(/Management team meeting/i)[0]);
    return container.querySelector('.fixed');
  };

  beforeEach(() => { snapshots.calendar = SERIES; });

  it('says it is part of a series rather than offering the chips again', () => {
    const { container } = draw();
    const dialog = openOccurrence(container);
    expect(within(dialog).getByText(/part of a series/i)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^every 4 weeks$/i })).toBeNull();
  });

  it('asks which occurrences an edit applies to', () => {
    const { container } = draw();
    const dialog = openOccurrence(container);
    expect(within(dialog).getByRole('button', { name: /just this one/i })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /this and all later ones/i })).toBeTruthy();
  });

  it('edits only this one by default', async () => {
    const { container } = draw();
    const dialog = openOccurrence(container);
    fireEvent.change(within(dialog).getByPlaceholderText(/radius training/i), {
      target: { value: 'Management meeting (moved)' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^save changes$/i }));
    });
    expect(writes.updated).toHaveLength(1);
    expect(writes.updated[0].id).toBe('w1');
  });

  it('carries an edit forward to every later one when asked', async () => {
    const { container } = draw();
    const dialog = openOccurrence(container);
    fireEvent.click(within(dialog).getByRole('button', { name: /this and all later ones/i }));
    fireEvent.change(within(dialog).getByPlaceholderText(/radius training/i), {
      target: { value: 'Leadership sync' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^save changes$/i }));
    });
    // The whole series, because the one opened is the first of it.
    expect(writes.updated.map(w => w.id)).toEqual(['w1', 'w2', 'w3', 'w4']);
    for (const w of writes.updated) expect(w.data.title).toBe('Leadership sync');
  });

  it('never rewrites an occurrence-s own date when carrying an edit forward', async () => {
    // The date is the only thing telling two occurrences apart. Pushing
    // one over the others would collapse the series onto a single day.
    const { container } = draw();
    const dialog = openOccurrence(container);
    fireEvent.click(within(dialog).getByRole('button', { name: /this and all later ones/i }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^save changes$/i }));
    });
    for (const w of writes.updated) expect(w.data.date).toBeUndefined();
  });

  it('deletes just this one by default', async () => {
    const { container } = draw();
    const dialog = openOccurrence(container);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /delete/i }));
    });
    expect(writes.deleted).toEqual(['w1']);
  });

  it('deletes this and every later one when asked', async () => {
    const { container } = draw();
    const dialog = openOccurrence(container);
    fireEvent.click(within(dialog).getByRole('button', { name: /this and all later ones/i }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /delete/i }));
    });
    expect(writes.deleted).toEqual(['w1', 'w2', 'w3', 'w4']);
  });
});

describe('turning a meeting that already exists into a recurring one', () => {
  // Exactly the reported case: the Wednesday 12–1 meeting is already
  // saved as a one-off and now needs to repeat.
  const ONE_OFF = {
    id: 'mtg', title: 'Management team meeting', kind: 'meeting',
    date: '2026-09-23', startTime: '12:00', endTime: '13:00', allDay: false,
    assignedTo: [], assignedNames: [], holdsBooking: false,
  };
  beforeEach(() => { snapshots.calendar = [ONE_OFF]; });

  it('keeps the entry that exists and adds the rest around it', async () => {
    const { container } = draw();
    fireEvent.click(screen.getByTitle(/Management team meeting/i));
    const dialog = container.querySelector('.fixed');
    fireEvent.click(within(dialog).getByRole('button', { name: /^every week$/i }));
    fireEvent.change(dialog.querySelectorAll('input[type="date"]')[1], { target: { value: '2026-10-14' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^save changes$/i }));
    });

    // The original document stays put — same id, now the first of the
    // series — so nothing anyone has already looked at moves.
    expect(writes.updated).toHaveLength(1);
    expect(writes.updated[0].id).toBe('mtg');
    expect(writes.updated[0].data.seriesId).toBe('mtg');
    expect(writes.updated[0].data.repeat).toBe('weekly');

    // And the three later Wednesdays are added.
    expect(writes.set.map(w => w.data.date)).toEqual(['2026-09-30', '2026-10-07', '2026-10-14']);
    for (const w of writes.set) expect(w.data.seriesId).toBe('mtg');
  });
});

describe('knowing which day you are on', () => {
  // Reported: red text on the date alone was easy to miss on a
  // seven-column grid — the eye has nothing to follow down the page.
  const todayCells = (container) => [...container.querySelectorAll('*')]
    .filter(el => (el.getAttribute('style') || '').includes('--nl-today'));

  it('tints the header cell and NOTHING below it', () => {
    // A tint running the whole column put a solid stripe behind every
    // entry on the busiest day of the week. The date is where the eye
    // looks for the day, so the mark belongs there and stops there.
    const { container } = draw();
    const cells = todayCells(container);
    expect(cells).toHaveLength(1);
    expect(cells[0].textContent).toContain('22');
  });

  it('marks the date with a filled INK pill, not a fourth red thing', () => {
    // Brand red is identity and actions. It is spent on the now line and
    // on a closure; "selected" is filled ink, the same idiom the Week /
    // Month toggle uses.
    const { container } = draw();
    const pill = [...container.querySelectorAll('div')]
      .find(el => el.textContent === '22' && /--nl-ink/.test(el.getAttribute('style') || ''));
    expect(pill).toBeTruthy();
    expect(pill.getAttribute('style')).not.toMatch(/--nl-brand/);
  });

  it('keeps brand red for the now line alone inside the grid', () => {
    const { container } = draw();
    const grid = container.querySelector('.overflow-x-auto');
    const reds = [...grid.querySelectorAll('*')]
      .filter(el => (el.getAttribute('style') || '').includes('--nl-brand'));
    // The line and its dot — and nothing else. A closure would add its
    // own, which is the other thing red is allowed to mean here.
    expect(reds).toHaveLength(2);
    for (const el of reds) {
      expect(el.closest('[data-now-line]')).toBeTruthy();
    }
  });

  it('draws a fun day in its own colour rather than borrowing the brand', () => {
    // Six pink chips across the all-day band was most of the red on the
    // page, and a fun day is daily texture, not an alert.
    const { container } = draw();
    const bingo = [...container.querySelectorAll('button')].find(b => b.textContent.includes('Bingo'));
    expect(bingo.getAttribute('style')).toMatch(/--nl-info/);
    expect(bingo.getAttribute('style')).not.toMatch(/--nl-brand/);
  });

  it('draws a now line, on today and nowhere else', () => {
    // System time in these tests is 22 Sep at 12:00, inside the 9–8 axis.
    const { container } = draw();
    const lines = container.querySelectorAll('[data-now-line]');
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute('style')).toMatch(/top:\s*27\./);   // 12:00 of 9–20
  });

  it('draws no now line on a week that is not this one', () => {
    // A marker on a week nobody is in says something false.
    const { container } = draw();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(container.querySelectorAll('[data-now-line]')).toHaveLength(0);
    expect(todayCells(container)).toHaveLength(0);
  });

  it('draws no now line outside the hours on screen', () => {
    // Pinned to the top edge at 7am it would report a time that is not
    // on the grid at all.
    vi.setSystemTime(new Date(2026, 8, 22, 7, 0, 0));
    const { container } = draw();
    expect(container.querySelectorAll('[data-now-line]')).toHaveLength(0);
    expect(todayCells(container)).toHaveLength(1);      // header still marked
  });
});

describe('two things at the same time', () => {
  // Reported as "I cannot put multiple things on the same day at the same
  // time". They saved fine — every entry was drawn full width, so the
  // later one covered the earlier one's title, time and click target.
  const at = (id, title, start, end) => ({
    id, title, kind: 'meeting', date: '2026-09-25',
    startTime: start, endTime: end, allDay: false,
    assignedTo: [], assignedNames: [], holdsBooking: false,
  });
  const boxOf = (container, title) => [...container.querySelectorAll('button')]
    .find(b => b.textContent.includes(title))?.getAttribute('style') || '';

  it('gives a lone entry the full column', () => {
    snapshots.calendar = [at('a', 'Alone', '15:00', '16:00')];
    const { container } = draw();
    expect(boxOf(container, 'Alone')).toMatch(/width:\s*calc\(100% - 6px\)/);
  });

  it('halves and offsets two that clash', () => {
    snapshots.calendar = [at('a', 'First', '15:00', '16:00'), at('b', 'Second', '15:30', '16:30')];
    const { container } = draw();
    expect(boxOf(container, 'First')).toMatch(/left:\s*calc\(0% \+ 3px\)/);
    expect(boxOf(container, 'First')).toMatch(/width:\s*calc\(50% - 6px\)/);
    expect(boxOf(container, 'Second')).toMatch(/left:\s*calc\(50% \+ 3px\)/);
  });

  it('leaves both clickable, which is the actual complaint', () => {
    snapshots.calendar = [at('a', 'First', '15:00', '16:00'), at('b', 'Second', '15:30', '16:30')];
    const { container } = draw();
    for (const title of ['First', 'Second']) {
      const btn = [...container.querySelectorAll('button')].find(b => b.textContent.includes(title));
      fireEvent.click(btn);
      const dialog = container.querySelector('.fixed');
      expect(within(dialog).getByPlaceholderText(/radius training/i).value).toBe(title);
      fireEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    }
  });

  it('does not split the width for back-to-back entries', () => {
    // 3–4 and 4–5 sit flush. Halving those would shrink every entry on a
    // normally busy afternoon for nothing.
    snapshots.calendar = [at('a', 'Early', '15:00', '16:00'), at('b', 'Later', '16:00', '17:00')];
    const { container } = draw();
    expect(boxOf(container, 'Early')).toMatch(/width:\s*calc\(100% - 6px\)/);
    expect(boxOf(container, 'Later')).toMatch(/width:\s*calc\(100% - 6px\)/);
  });

  it('drops the second line once three share a column', () => {
    // A third of a column has no room for it, and a clipped half-line is
    // worse than none.
    snapshots.calendar = [
      at('a', 'One', '15:00', '17:00'), at('b', 'Two', '15:00', '17:00'), at('c', 'Three', '15:00', '17:00'),
    ];
    const { container } = draw();
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent.includes('One'));
    expect(btn.textContent).not.toMatch(/3–5/);
    expect(boxOf(container, 'One')).toMatch(/width:\s*calc\(33\./);
  });
});

describe('a day the centre never opens', () => {
  // Langley is shut on Sundays. A dead column that still had to be drawn
  // cut a seventh off the width of the six days that matter.
  const dayHeads = (container) => [...container.querySelectorAll('div')]
    .filter(el => /grid-template-columns:\s*54px repeat\(/.test(el.getAttribute('style') || ''))[0]
    ?.children;

  it('is dropped, and the rest of the week takes the width', () => {
    const { container } = draw();
    const heads = dayHeads(container);
    expect(heads.length - 1).toBe(6);                    // Mon–Sat
    expect([...heads].some(h => h.textContent.includes('Sun'))).toBe(false);
    expect(container.innerHTML).toMatch(/54px repeat\(6, 1fr\)/);
  });

  it('COMES BACK the moment something is on it', () => {
    // The composer takes any date. A hidden column would hide a real
    // entry, and an entry you cannot see is worse than a narrow one.
    snapshots.calendar = [{
      ...TRAINING, id: 'sun', date: '2026-09-20', title: 'Sunday catch-up',
    }];
    const { container } = draw();
    expect(dayHeads(container).length - 1).toBe(7);
    expect(screen.getByText('Sunday catch-up')).toBeTruthy();
  });

  it('follows the centre-s own operating days, not the weekend', () => {
    // A centre that closes on Mondays loses the Monday column instead.
    authValue.current = {
      ...DIRECTOR,
      centerConfig: {
        ...CONFIG,
        operatingDays: ['Sunday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      },
    };
    const { container } = draw();
    const heads = [...dayHeads(container)];
    expect(heads.some(h => h.textContent.includes('Mon'))).toBe(false);
    expect(heads.some(h => h.textContent.includes('Sun'))).toBe(true);
  });

  it('falls back to Mon–Sat for a centre that never set its days', () => {
    // isOperatingDay treats an empty operatingDays as the default week, so
    // "no days open" is unreachable from config — Sunday still goes and
    // the other six stay. The empty-grid guard in weekDays is belt and
    // braces for a future caller, not a state this can reach.
    authValue.current = { ...DIRECTOR, centerConfig: { ...CONFIG, operatingDays: [] } };
    const { container } = draw();
    expect(dayHeads(container).length - 1).toBe(6);
  });
});

describe('the range label matches the grid', () => {
  it('starts on the first day actually shown', () => {
    // "Sep 20 – Sep 26" over a grid that opens on Monday the 21st is a
    // small lie, and it is the line people read to know where they are.
    draw();
    expect(screen.getByText(/21 Sep – 26 Sep 2026|Sep 21 – Sep 26, 2026/)).toBeTruthy();
  });

  it('stretches back to Sunday when Sunday is back', () => {
    snapshots.calendar = [{ ...TRAINING, id: 'sun', date: '2026-09-20', title: 'Sunday catch-up' }];
    draw();
    expect(screen.getByText(/20 Sep – 26 Sep 2026|Sep 20 – Sep 26, 2026/)).toBeTruthy();
  });
});

describe('finding the person to assign', () => {
  // A scroll list of fifty names is a scroll list. Same shape as the
  // Student Scheduler: type, and it narrows.
  const openIt = (container) => { openComposer(); return container.querySelector('.fixed'); };
  const type = (dialog, q) =>
    fireEvent.change(within(dialog).getByLabelText(/search staff by name/i), { target: { value: q } });
  const names = (dialog) => [...dialog.querySelectorAll('label')]
    .map(l => l.textContent.trim())
    .filter(t => /Gill|Parmar|Mukerji|Zavid|Kedzior/.test(t));

  it('shows everybody before anything is typed', () => {
    const { container } = draw();
    const dialog = openIt(container);
    expect(names(dialog)).toHaveLength(5);
  });

  it('narrows to the people whose name contains what was typed', () => {
    // A substring, like the Student Scheduler — "ru" is in Nee-ru as well
    // as Ru-shan, and both are right.
    const { container } = draw();
    const dialog = openIt(container);
    type(dialog, 'ru');
    expect(names(dialog)).toEqual(['Neeru Gill', 'Rushan Zavid']);
    type(dialog, 'rus');
    expect(names(dialog)).toEqual(['Rushan Zavid']);
  });

  it('does not care about case', () => {
    const { container } = draw();
    const dialog = openIt(container);
    type(dialog, 'SABRINA');
    expect(names(dialog)).toEqual(['Sabrina Kedzior']);
  });

  it('matches anywhere in the name, not just the start', () => {
    const { container } = draw();
    const dialog = openIt(container);
    type(dialog, 'gill');
    expect(names(dialog)).toEqual(['Neeru Gill']);
  });

  it('KEEPS somebody already ticked in the list while you search', () => {
    // Tick a person, type a name that does not match them, and watching
    // them disappear reads as "it did not save".
    const { container } = draw();
    const dialog = openIt(container);
    fireEvent.click(within(dialog).getByLabelText('Rahul Parmar'));
    type(dialog, 'sabrina');
    expect(names(dialog)).toEqual(['Rahul Parmar', 'Sabrina Kedzior']);
    expect(within(dialog).getByLabelText('Rahul Parmar').checked).toBe(true);
  });

  it('does not reshuffle the list when somebody is ticked', () => {
    // Floating the selected to the top moves the row out from under the
    // cursor mid-click.
    const { container } = draw();
    const dialog = openIt(container);
    const before = names(dialog);
    fireEvent.click(within(dialog).getByLabelText('Sabrina Kedzior'));
    expect(names(dialog)).toEqual(before);
  });

  it('says so when nothing matches, naming what was typed', () => {
    const { container } = draw();
    const dialog = openIt(container);
    type(dialog, 'zzzz');
    expect(within(dialog).getByText(/nobody matches “zzzz”/i)).toBeTruthy();
  });

  it('still keeps unapproved accounts out of the list entirely', () => {
    const { container } = draw();
    const dialog = openIt(container);
    type(dialog, 'approved');
    expect(within(dialog).queryByLabelText('Not Approved')).toBeNull();
  });

  it('assigns whoever was picked through the search', async () => {
    const { container } = draw();
    const dialog = openIt(container);
    fireEvent.change(within(dialog).getByPlaceholderText(/radius training/i), { target: { value: 'Huddle' } });
    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: '2026-09-25' } });
    const times = dialog.querySelectorAll('input[type="time"]');
    fireEvent.change(times[0], { target: { value: '15:00' } });
    fireEvent.change(times[1], { target: { value: '16:00' } });
    type(dialog, 'mukerji');
    fireEvent.click(within(dialog).getByLabelText('Rishi Mukerji'));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /^save entry$/i }));
    });
    expect(writes.added[0]).toMatchObject({
      title: 'Huddle', assignedTo: ['rishi'], assignedNames: ['Rishi Mukerji'],
    });
  });
});
