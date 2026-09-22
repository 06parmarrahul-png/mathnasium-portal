// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

/**
 * The import panel.
 *
 * Two things here are worth being sure about, and neither is cosmetic.
 *
 * 1. AN ASSESSMENT MUST LAND IN `centerIntakes`. That collection alone
 *    feeds `bookedSlots` in api/intakes.js, so an assessment written as a
 *    calendar entry would leave its hour on sale and the public page would
 *    take a second family for it.
 * 2. NOTHING IS WRITTEN BEFORE SOMEBODY LOOKS. These rows carry parents'
 *    and children's names pulled out of prose by guesswork.
 */
const writes = [];
vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  doc: (col) => ({ __col: col.__c, id: `id-${writes.length}` }),
  writeBatch: () => ({
    set: (ref, data) => writes.push({ col: ref.__col, data }),
    commit: async () => {},
  }),
}));

const { default: CalendarImport } = await import('./CalendarImport');

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:a1@google.com
DTSTART:20260923T190000Z
DTEND:20260923T200000Z
SUMMARY:Free Math Assessment - Priya Sharma (Grade 5)
DESCRIPTION:Parent: Anita Sharma\\nStudent: Priya Sharma\\nGrade: 5\\nPhone: 604-555-0134
END:VEVENT
BEGIN:VEVENT
UID:m1@google.com
DTSTART;TZID=America/Vancouver:20260925T120000
DTEND;TZID=America/Vancouver:20260925T130000
SUMMARY:Management team meeting
END:VEVENT
BEGIN:VEVENT
UID:c1@google.com
DTSTART:20260926T180000Z
SUMMARY:Assessment - Gone Away
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`;

const draw = (props = {}) => render(
  <CalendarImport centerId="langley" timeZone="America/Vancouver"
    profile={{ displayName: 'Neeru Gill' }} onClose={() => {}} {...props} />,
);

/** jsdom gives File no .text(), and the component reads the file that way. */
const drop = async (container, text = ICS, name = 'langley.ics') => {
  const input = container.querySelector('input[type="file"]');
  const file = { name, text: async () => text };
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
};

const importBtn = () => screen.getByRole('button', { name: /^import \d+$/i });

beforeEach(() => { writes.length = 0; });
afterEach(cleanup);

describe('before a file is chosen', () => {
  it('says where the file comes from', () => {
    draw();
    expect(screen.getByText(/Import & export/i)).toBeTruthy();
  });

  it('promises nothing is saved yet, and offers no import button', () => {
    draw();
    expect(screen.getByText(/nothing is saved until you have looked/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^import \d+$/i })).toBeNull();
  });

  it('says so plainly when the file has no events in it', async () => {
    const { container } = draw();
    await drop(container, 'just some text');
    expect(screen.getByText(/no events in that file/i)).toBeTruthy();
  });
});

describe('the review table', () => {
  it('counts what it is about to do, split by where it goes', async () => {
    const { container } = draw();
    await drop(container);
    expect(screen.getByText(/1 as an assessment/i)).toBeTruthy();
    expect(screen.getByText(/1 as calendar entry/i)).toBeTruthy();
  });

  it('shows a cancelled event, marked, rather than hiding it', async () => {
    const { container } = draw();
    await drop(container);
    // Twice on purpose: once as the row's reason, once in the tally.
    expect(screen.getAllByText(/cancelled in google/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/skipping 1 cancelled/i)).toBeTruthy();
  });

  it('fills in what it could read off the event', async () => {
    const { container } = draw();
    await drop(container);
    expect(screen.getByLabelText(/^Child for /i).value).toBe('Priya Sharma');
    expect(screen.getByLabelText(/^Guardian for /i).value).toBe('Anita Sharma');
    expect(screen.getByLabelText(/^Grade for /i).value).toBe('5');
  });

  it('routes each row by what it is, not by what the first option says', () => {
    // A <select>'s value is a DOM property React sets, so a static render
    // of this table shows every dropdown reading "Assessment". Asserting
    // the value is the only way to know the routing is actually right.
    return (async () => {
      const { container } = draw();
      await drop(container);
      expect(screen.getByLabelText(/^Where Free Math Assessment/i).value).toBe('intake');
      expect(screen.getByLabelText(/^Where Management team meeting/i).value).toBe('entry');
    })();
  });

  it('explains why an assessment is not a calendar entry', async () => {
    const { container } = draw();
    await drop(container);
    expect(screen.getByText(/takes its slot off the public booking page/i)).toBeTruthy();
  });
});

describe('what actually gets written', () => {
  it('puts an assessment in centerIntakes and the meeting on the calendar', async () => {
    const { container } = draw();
    await drop(container);
    await act(async () => { fireEvent.click(importBtn()); });

    const intake = writes.find(w => w.col === 'centerIntakes');
    const entry = writes.find(w => w.col === 'centers/langley/calendar');
    expect(writes).toHaveLength(2);
    expect(intake).toBeTruthy();
    expect(entry).toBeTruthy();
    expect(entry.data.title).toBe('Management team meeting');
  });

  it('writes the intake in the shape the booking grid already reads', async () => {
    const { container } = draw();
    await drop(container);
    await act(async () => { fireEvent.click(importBtn()); });

    // 19:00Z is noon in Langley, and `slot` is the centre's wall clock —
    // the same string api/intakes.js writes and validateSlot parses.
    expect(writes.find(w => w.col === 'centerIntakes').data).toMatchObject({
      centerId: 'langley',
      slot: '2026-09-23T12:00:00',
      durationMin: 60,
      childName: 'Priya Sharma',
      guardianName: 'Anita Sharma',
      childGrade: '5',
      status: 'scheduled',
      source: 'google-import',
      sourceUid: 'a1@google.com',
    });
  });

  it('never imports a cancelled event', async () => {
    const { container } = draw();
    await drop(container);
    await act(async () => { fireEvent.click(importBtn()); });
    expect(writes.some(w => JSON.stringify(w.data).includes('Gone Away'))).toBe(false);
  });

  it('never holds the booking page on somebody-s behalf', async () => {
    // Closing assessment slots is a decision with a cost, and the entry
    // composer is where that cost is spelled out. An import must not make
    // it silently, forty rows at a time.
    const { container } = draw();
    await drop(container);
    await act(async () => { fireEvent.click(importBtn()); });
    expect(writes.find(w => w.col.endsWith('/calendar')).data.holdsBooking).toBe(false);
  });

  it('skips what a previous import already brought in', async () => {
    const { container } = draw({ existingUids: new Set(['a1@google.com']) });
    await drop(container);
    expect(screen.getByText(/skipping .*1 already imported/i)).toBeTruthy();
    await act(async () => { fireEvent.click(importBtn()); });
    expect(writes).toHaveLength(1);
    expect(writes[0].col).toBe('centers/langley/calendar');
  });

  it('leaves out a row that was unticked', async () => {
    const { container } = draw();
    await drop(container);
    fireEvent.click(screen.getByLabelText(/Import Free Math Assessment/i));
    await act(async () => { fireEvent.click(importBtn()); });
    expect(writes.every(w => w.col !== 'centerIntakes')).toBe(true);
  });

  it('honours a correction typed into the table', async () => {
    const { container } = draw();
    await drop(container);
    fireEvent.change(screen.getByLabelText(/^Guardian for /i), { target: { value: 'A. Sharma-Reid' } });
    await act(async () => { fireEvent.click(importBtn()); });
    expect(writes.find(w => w.col === 'centerIntakes').data.guardianName).toBe('A. Sharma-Reid');
  });

  it('lets someone re-route a row the classifier got wrong', async () => {
    // "Assessment" is a word a staff meeting can contain. Being able to
    // say "that one is not an assessment" is what keeps a wrong guess out
    // of the intake list and off the booking page.
    const { container } = draw();
    await drop(container);
    fireEvent.change(screen.getByLabelText(/^Where Free Math Assessment/i), { target: { value: 'entry' } });
    await act(async () => { fireEvent.click(importBtn()); });
    expect(writes.every(w => w.col !== 'centerIntakes')).toBe(true);
    expect(writes).toHaveLength(2);
  });

  it('reports what landed where when it is finished', async () => {
    const { container } = draw();
    await drop(container);
    await act(async () => { fireEvent.click(importBtn()); });
    expect(screen.getByText(/Imported 2\./i)).toBeTruthy();
    expect(screen.getByText(/occupy their slot on the booking page/i)).toBeTruthy();
  });

  it('warns about an assessment with no name rather than writing a blank row', async () => {
    const { container } = draw();
    await drop(container, `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:n1@google.com
DTSTART:20260924T230000Z
SUMMARY:Mathnasium Assessment
END:VEVENT
END:VCALENDAR`);
    expect(screen.getByText(/1 assessment has no child’s name/i)).toBeTruthy();
    const cell = screen.getByLabelText(/^Child for /i);
    expect(cell.value).toBe('');
    fireEvent.change(cell, { target: { value: 'Sam Lee' } });
    await act(async () => { fireEvent.click(importBtn()); });
    expect(writes[0].data.childName).toBe('Sam Lee');
  });
});
