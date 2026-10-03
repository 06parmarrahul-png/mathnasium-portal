// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

/**
 * The tracker, rendered.
 *
 * The claim this file exists to hold is that the screen is a COPY. So the
 * headers are asserted word for word against the real spreadsheet, and
 * the cells in the shorthand the sheet uses — NS, CA, Yes/Pending/No —
 * rather than in Ratio's own vocabulary. If somebody renames a column to
 * something tidier, this fails, which is the point.
 */

vi.mock('../firebase', () => ({ db: {}, auth: {}, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}), doc: () => ({}), query: () => ({}), where: () => ({}),
  orderBy: () => ({}), onSnapshot: () => () => {}, getDocs: async () => ({ docs: [] }),
  addDoc: async () => ({ id: 'x' }), updateDoc: async () => {}, setDoc: async () => {},
  deleteDoc: async () => {}, writeBatch: () => ({ set() {}, commit: async () => {} }),
  arrayUnion: (...a) => a, serverTimestamp: () => 'ts', Timestamp: { now: () => 'ts' },
}));
vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  confirmDialog: vi.fn(async () => true),
}));

import LeadTracker from './LeadTracker';

const NOW = new Date('2026-10-05T09:00:00');
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); cleanup(); });

const lead = (over = {}) => ({
  id: 'l1', parentName: 'Rana Alahmad', childName: 'Omar Mustafa',
  status: 'new', createdAt: '2026-10-01T10:00:00', ...over,
});

// Rows shaped like the real September tab.
const LEADS = [
  lead({ id: 'a', parentName: 'Rana Alahmad', childName: 'Omar Mustafa',
    createdAt: '2026-10-01T10:00:00', assessmentOn: '2026-10-04',
    assessmentOutcome: 'attended', tourBy: 'Rahul', assessedBy: 'Vin',
    status: 'enrolled', enrolledAt: '2026-10-04T16:00:00', reason: 'remedial',
    outcomeReason: 'Enrolled on the spot' }),
  lead({ id: 'b', parentName: 'Ally Power', childName: 'Leon Gibbons',
    createdAt: '2026-10-02T10:00:00', assessmentOn: '2026-10-03',
    assessmentOutcome: 'no-show', tourBy: 'Sabrina' }),
  lead({ id: 'c', parentName: 'A.J.', childName: 'Kemal',
    createdAt: '2026-10-02T10:00:00', assessmentOn: '2026-10-03',
    assessmentOutcome: 'cancelled' }),
  lead({ id: 'd', parentName: 'Tina Vuong', childName: 'Kai',
    createdAt: '2026-10-02T10:00:00' }),
  // A different month, so the tabs have something to separate.
  lead({ id: 'e', parentName: 'Yueli Wang', childName: 'Alicia',
    createdAt: '2026-09-02T10:00:00' }),
];

const setup = (leads = LEADS, props = {}) => render(<LeadTracker leads={leads} {...props} />);

describe('it is a copy of the sheet', () => {
  it('uses the spreadsheet-s own column headings, word for word', () => {
    setup();
    for (const label of [
      'Lead Name/Student Name', 'Created Date', 'Week Ending', 'Last Contact',
      'Trigger/Reason', 'Assessment Date', 'Notes', 'Tour by', 'Assessor',
      'Enrolled?', 'Why?', 'Days to Assessment',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('joins the two names the way that column is headed', () => {
    setup();
    expect(screen.getByText('Rana Alahmad / Omar Mustafa')).toBeTruthy();
  });

  it('writes NS and CA, which are values in that column and not missing dates', () => {
    setup();
    expect(screen.getByText('NS')).toBeTruthy();
    expect(screen.getByText('CA')).toBeTruthy();
  });

  it('speaks the sheet-s vocabulary in the enrolled column', () => {
    setup();
    expect(screen.getByText('Yes')).toBeTruthy();
  });

  it('leaves a cell empty rather than filling it with something invented', () => {
    setup();
    const row = screen.getByText('Tina Vuong / Kai').closest('tr');
    // Nothing booked, nobody toured, no outcome: the sheet leaves all of
    // that blank and so does this.
    expect(within(row).getAllByText('—').length).toBeGreaterThan(4);
  });
});

describe('one month at a time', () => {
  it('puts a tab up for each month that has leads in it', () => {
    setup();
    expect(screen.getByText(/October 2026/)).toBeTruthy();
    expect(screen.getByText(/September 2026/)).toBeTruthy();
  });

  it('opens on the month being worked, not the oldest one', () => {
    setup();
    expect(screen.getByText('Rana Alahmad / Omar Mustafa')).toBeTruthy();
    expect(screen.queryByText('Yueli Wang / Alicia')).toBeNull();
  });

  it('switches when a tab is clicked', () => {
    setup();
    fireEvent.click(screen.getByText(/September 2026/));
    expect(screen.getByText('Yueli Wang / Alicia')).toBeTruthy();
    expect(screen.queryByText('Rana Alahmad / Omar Mustafa')).toBeNull();
  });
});

describe('the block under the rows', () => {
  it('prints the counts the way the sheet prints them', () => {
    setup();
    expect(screen.getByText('No assessment booked')).toBeTruthy();
    expect(screen.getByText('Cancellations / no shows')).toBeTruthy();
    expect(screen.getAllByText(/out of 4/).length).toBeGreaterThan(0);
  });

  it('credits both names in a shared tour, as the sheet is written', () => {
    setup([lead({ id: 'x', tourBy: 'Sabrina / Vin', status: 'enrolled',
      enrolledAt: '2026-10-02T10:00:00' })]);
    const tours = screen.getByText('Tours').closest('div');
    expect(within(tours).getByText('Sabrina')).toBeTruthy();
    expect(within(tours).getByText('Vin')).toBeTruthy();
  });

  it('says how many leads a mean was taken over', () => {
    // A mean over three rows and a mean over thirty are different facts.
    setup();
    expect(screen.getByText(/^of \d+$/)).toBeTruthy();
  });

  it('shows an em dash, not nought, when nothing can be averaged', () => {
    setup([lead({ id: 'none' })]);
    const box = screen.getByText('Days to assessment').parentElement;
    expect(within(box).getByText('—')).toBeTruthy();
  });

  it('draws no summary at all for an empty month', () => {
    setup([]);
    expect(screen.queryByText('No assessment booked')).toBeNull();
    expect(screen.getByText('No leads yet.')).toBeTruthy();
  });
});

describe('getting back out of it', () => {
  it('offers an export, because the sheet is not going away on day one', () => {
    setup();
    expect(screen.getByText('Export')).toBeTruthy();
  });
});

describe('a row is a way into the lead', () => {
  it('opens the family it belongs to', () => {
    const onOpen = vi.fn();
    setup(LEADS, { onOpen });
    fireEvent.click(screen.getByText('Rana Alahmad / Omar Mustafa'));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });
});
