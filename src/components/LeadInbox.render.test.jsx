// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

/**
 * The lead inbox, rendered.
 *
 * What is actually worth pinning here is not that the boxes appear. It is
 * that the queue and the pane agree about who is selected, that logging a
 * call writes the two fields that put a family back on the list at the
 * right time, and that the story draws what the lead really says rather
 * than a tidier version of it.
 */

vi.mock('../firebase', () => ({ db: {}, auth: {}, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}), doc: () => ({}), query: () => ({}), where: () => ({}),
  orderBy: () => ({}), onSnapshot: () => () => {}, getDocs: async () => ({ docs: [] }),
  addDoc: async () => ({ id: 'x' }), updateDoc: async () => {}, setDoc: async () => {},
  deleteDoc: async () => {}, writeBatch: () => ({ set() {}, commit: async () => {} }),
  arrayUnion: (...a) => a, serverTimestamp: () => 'ts', Timestamp: { now: () => 'ts' },
}));

const appendLeadNote = vi.fn(async () => {});
const updateLead = vi.fn(async () => {});
vi.mock('../lib/leads', async (importOriginal) => ({
  ...(await importOriginal()),
  appendLeadNote: (...a) => appendLeadNote(...a),
  updateLead: (...a) => updateLead(...a),
}));
vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  confirmDialog: vi.fn(async () => true),
}));

import LeadInbox from './LeadInbox';

// Frozen clock — these fixtures are fixed dates, and a suite that fails
// because the calendar moved stops being able to say anything.
const NOW = new Date('2026-10-05T09:00:00');
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  appendLeadNote.mockClear();
  updateLead.mockClear();
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

const lead = (over = {}) => ({
  id: 'l1', parentName: 'Priya Raman', childName: 'Aarav', childGrade: '4',
  parentPhone: '604-555-0142', status: 'new', source: 'apptoto',
  assignedTo: 'Vin', createdAt: '2026-10-01T10:00:00', ...over,
});

// One of each thing the call sheet can say, so the groups are all real.
const LEADS = [
  lead({ id: 'today', parentName: 'Priya Raman', assessmentOn: '2026-10-05',
    assessmentOutcome: 'booked', tourBy: 'Sabrina', lastContactOn: '2026-10-02' }),
  lead({ id: 'noshow', parentName: 'Hassan Qureshi', childName: 'Layla',
    assessmentOn: '2026-09-28', assessmentOutcome: 'no-show' }),
  lead({ id: 'never', parentName: 'Robert Lindqvist', childName: 'Nils',
    createdAt: '2026-09-24T10:00:00', assignedTo: '' }),
];

const setup = (leads = LEADS, props = {}) => render(
  <LeadInbox leads={leads} centerId="c1" actor={{ displayName: 'Vin' }} me="Vin"
    studentIndex={new Map()} {...props} />,
);

describe('the queue', () => {
  it('groups by when, not by what kind of problem it is', () => {
    setup();
    expect(screen.getByText('Right now')).toBeTruthy();
    expect(screen.getByText('Overdue')).toBeTruthy();
  });

  it('shows every open lead once and only once', () => {
    setup();
    // Priya appears in the queue AND in the pane she opens by default,
    // so the count that matters is the queue's own badge.
    expect(screen.getAllByText('Hassan Qureshi')).toHaveLength(1);
    expect(screen.getAllByText('Robert Lindqvist')).toHaveLength(1);
  });

  it('says nothing needs chasing rather than drawing an empty list', () => {
    setup([lead({ status: 'enrolled', enrolledAt: '2026-10-02T10:00:00' })]);
    expect(screen.getByText(/Nothing needs chasing/i)).toBeTruthy();
  });

  it('leaves archived history out of the call sheet entirely', () => {
    // Eleven years of imported Radius leads are history, not work.
    setup([...LEADS, lead({ id: 'old', parentName: 'Ancient Family', archived: true,
      createdAt: '2015-03-02T10:00:00' })]);
    expect(screen.queryByText('Ancient Family')).toBeNull();
  });
});

describe('the pane', () => {
  it('opens on the most urgent lead, so arriving is already working', () => {
    setup();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Aarav');
  });

  it('follows the queue when you pick somebody else', () => {
    setup();
    fireEvent.click(screen.getByText('Hassan Qureshi'));
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('Layla');
  });

  it('says why they are on the list in a sentence, not a label', () => {
    // In the queue row AND at the top of the pane: the reason to ring is
    // what you read before dialling, so it does not live one click away.
    setup();
    const pane = screen.getByRole('heading', { level: 2 }).closest('section');
    expect(within(pane).getByText(/Assessment today — Sabrina is touring\./i)).toBeTruthy();
  });

  it('offers the phone as a dialable link', () => {
    setup();
    const call = screen.getByText(/Call Priya/i).closest('a');
    expect(call.getAttribute('href')).toBe('tel:604-555-0142');
  });

  it('does not offer a call it cannot place', () => {
    setup([lead({ id: 'nophone', parentPhone: '', createdAt: '2026-09-24T10:00:00' })]);
    expect(screen.getByText('No number')).toBeTruthy();
  });
});

describe('the story', () => {
  it('draws the five events whether or not they have happened', () => {
    setup();
    const story = screen.getByText('Their story').closest('section');
    for (const label of ['Enquiry in', 'Reached', 'Assessment', 'Assessed', 'Enrolled']) {
      expect(within(story).getByText(label)).toBeTruthy();
    }
  });

  it('names a break instead of the step it broke', () => {
    setup();
    fireEvent.click(screen.getByText('Hassan Qureshi'));
    const story = screen.getByText('Their story').closest('section');
    expect(within(story).getByText('No show')).toBeTruthy();
    expect(within(story).queryByText('Assessment')).toBeNull();
  });

  it('flags an assessment whose outcome nobody recorded', () => {
    setup([lead({ id: 'blank', assessmentOn: '2026-10-01', assessmentOutcome: 'booked' })]);
    expect(screen.getByText(/outcome not recorded/i)).toBeTruthy();
  });

  it('shows the wait against the four-day goal, and says when it is over', () => {
    setup([lead({ id: 'slow', createdAt: '2026-09-25T10:00:00',
      assessmentOn: '2026-10-06', assessmentOutcome: 'booked' })]);
    expect(screen.getByText(/11d from enquiry/)).toBeTruthy();
    expect(screen.getByText(/over the 4-day goal/)).toBeTruthy();
  });

  it('puts the assessment write-up where it is re-read, not in a log', () => {
    setup([lead({ id: 'done', status: 'assessed', assessedAt: '2026-10-01T16:00:00',
      assessmentOn: '2026-10-01', assessmentOutcome: 'attended',
      assessmentNotes: [{ at: '2026-10-01T16:00:00', by: 'Vin',
        text: 'Two grades behind on fractions. Mum was sold; dad needs convincing on price.' }] })]);
    expect(screen.getByText(/dad needs convincing on price/)).toBeTruthy();
  });
});

describe('logging a call', () => {
  it('writes the note and stamps today as the last contact', async () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/Left a voicemail/i),
      { target: { value: 'Left a voicemail' } });
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => expect(appendLeadNote).toHaveBeenCalled());
    expect(appendLeadNote.mock.calls[0][2]).toBe('Left a voicemail');
    expect(updateLead.mock.calls[0][2]).toMatchObject({ lastContactOn: '2026-10-05' });
  });

  it('leaves the follow-up date alone when nobody picked one', async () => {
    // Writing a blank would take the family OFF the list rather than
    // putting them on it.
    setup();
    fireEvent.change(screen.getByPlaceholderText(/Left a voicemail/i),
      { target: { value: 'No answer' } });
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => expect(updateLead).toHaveBeenCalled());
    expect(updateLead.mock.calls[0][2]).not.toHaveProperty('followUpOn');
  });

  it('writes the follow-up date when they did pick one', async () => {
    setup();
    const { container } = { container: document.body };
    fireEvent.change(container.querySelector('input[type="date"]'),
      { target: { value: '2026-10-09' } });
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => expect(updateLead).toHaveBeenCalled());
    expect(updateLead.mock.calls[0][2]).toMatchObject({ followUpOn: '2026-10-09' });
  });

  it('writes nothing at all on an empty box', async () => {
    setup();
    fireEvent.click(screen.getByText('Log it'));
    await waitFor(() => {});
    expect(appendLeadNote).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
  });
});
