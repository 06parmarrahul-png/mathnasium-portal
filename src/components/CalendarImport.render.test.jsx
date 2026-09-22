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
  serverTimestamp: () => 'ts',
  writeBatch: () => ({
    set: (ref, data) => writes.push({ col: ref.__col, data }),
    commit: async () => {},
  }),
}));

/** The writes, split by where they went. Leads ride along with intakes. */
const intakeWrites = () => writes.filter(w => w.col === 'centerIntakes');
const entryWrites = () => writes.filter(w => w.col.endsWith('/calendar'));
const leadWrites = () => writes.filter(w => w.col.endsWith('/leads'));

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

    expect(intakeWrites()).toHaveLength(1);
    expect(entryWrites()).toHaveLength(1);
    expect(entryWrites()[0].data.title).toBe('Management team meeting');
  });

  it('writes the intake in the shape the booking grid already reads', async () => {
    const { container } = draw();
    await drop(container);
    await act(async () => { fireEvent.click(importBtn()); });

    // 19:00Z is noon in Langley, and `slot` is the centre's wall clock —
    // the same string api/intakes.js writes and validateSlot parses.
    expect(intakeWrites()[0].data).toMatchObject({
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
    expect(entryWrites()[0].data.holdsBooking).toBe(false);
  });

  it('skips what a previous import already brought in', async () => {
    const { container } = draw({ existingUids: new Set(['a1@google.com']) });
    await drop(container);
    expect(screen.getByText(/skipping .*1 already imported/i)).toBeTruthy();
    await act(async () => { fireEvent.click(importBtn()); });
    expect(intakeWrites()).toHaveLength(0);
    expect(entryWrites()).toHaveLength(1);
  });

  it('leaves out a row that was unticked', async () => {
    const { container } = draw();
    await drop(container);
    fireEvent.click(screen.getByLabelText(/Import Free Math Assessment/i));
    await act(async () => { fireEvent.click(importBtn()); });
    expect(intakeWrites()).toHaveLength(0);
  });

  it('honours a correction typed into the table', async () => {
    const { container } = draw();
    await drop(container);
    fireEvent.change(screen.getByLabelText(/^Guardian for /i), { target: { value: 'A. Sharma-Reid' } });
    await act(async () => { fireEvent.click(importBtn()); });
    expect(intakeWrites()[0].data.guardianName).toBe('A. Sharma-Reid');
  });

  it('lets someone re-route a row the classifier got wrong', async () => {
    // "Assessment" is a word a staff meeting can contain. Being able to
    // say "that one is not an assessment" is what keeps a wrong guess out
    // of the intake list and off the booking page.
    const { container } = draw();
    await drop(container);
    fireEvent.change(screen.getByLabelText(/^Where Free Math Assessment/i), { target: { value: 'entry' } });
    await act(async () => { fireEvent.click(importBtn()); });
    expect(intakeWrites()).toHaveLength(0);
    expect(entryWrites()).toHaveLength(2);
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
    expect(intakeWrites()[0].data.childName).toBe('Sam Lee');
  });
});

/**
 * Narrowing a real export.
 *
 * The first live run brought back about 2,110 events, most of them years
 * old. Nobody checks 2,110 rows, so the range is the difference between a
 * usable panel and an unusable one.
 */
describe('the date range', () => {
  const SPREAD = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:old1
DTSTART;TZID=America/Vancouver:20190304T160000
SUMMARY:Assessment - Ancient History
END:VEVENT
BEGIN:VEVENT
UID:jul
DTSTART;TZID=America/Vancouver:20260715T160000
SUMMARY:Assessment - July Family
END:VEVENT
BEGIN:VEVENT
UID:aug
DTSTART;TZID=America/Vancouver:20260812T160000
SUMMARY:Assessment - August Family
END:VEVENT
BEGIN:VEVENT
UID:sep
DTSTART;TZID=America/Vancouver:20260923T160000
SUMMARY:Assessment - September Family
END:VEVENT
END:VCALENDAR`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0));   // Tue 22 Sep 2026
  });
  afterEach(() => { vi.useRealTimers(); });

  it('opens on the first of last month, not on the whole history', async () => {
    const { container } = draw();
    await drop(container, SPREAD);
    expect(screen.getByLabelText(/import events from/i).value).toBe('2026-08-01');
    expect(screen.getByText(/2 of 4 left out by these dates/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^import 2$/i })).toBeTruthy();
  });

  it('says what the file actually spans, so the range makes sense', async () => {
    const { container } = draw();
    await drop(container, SPREAD);
    expect(screen.getByText(/File covers 2019-03-04 to 2026-09-23/i)).toBeTruthy();
  });

  it('follows the From date being moved', async () => {
    const { container } = draw();
    await drop(container, SPREAD);
    fireEvent.change(screen.getByLabelText(/import events from/i), { target: { value: '2026-09-01' } });
    expect(screen.getByRole('button', { name: /^import 1$/i })).toBeTruthy();
    await act(async () => { fireEvent.click(importBtn()); });
    expect(intakeWrites()).toHaveLength(1);
    expect(intakeWrites()[0].data.childName).toBe('September Family');
  });

  it('follows a To date as well', async () => {
    const { container } = draw();
    await drop(container, SPREAD);
    fireEvent.change(screen.getByLabelText(/import events up to/i), { target: { value: '2026-08-31' } });
    await act(async () => { fireEvent.click(importBtn()); });
    expect(intakeWrites()).toHaveLength(1);
    expect(intakeWrites()[0].data.childName).toBe('August Family');
  });

  it('brings the whole history back if that is really wanted', async () => {
    const { container } = draw();
    await drop(container, SPREAD);
    fireEvent.click(screen.getByRole('button', { name: /^everything$/i }));
    expect(screen.getByText(/all 4 in range/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^import 4$/i })).toBeTruthy();
  });

  it('leaves out-of-range events out of the table entirely', async () => {
    // Not as another skipped row — a skipped row still renders, and 2,110
    // of those is what made this unusable in the first place.
    const { container } = draw();
    await drop(container, SPREAD);
    expect(screen.queryByText(/Ancient History/)).toBeNull();
    expect(screen.getByText(/August Family/)).toBeTruthy();
  });

  it('keeps a correction when the range moves', async () => {
    // Narrowing the dates must not quietly throw away typing.
    const { container } = draw();
    await drop(container, SPREAD);
    const cell = screen.getByLabelText(/^Guardian for Assessment - September Family/i);
    fireEvent.change(cell, { target: { value: 'Dana Reyes' } });
    fireEvent.change(screen.getByLabelText(/import events from/i), { target: { value: '2026-09-01' } });
    expect(screen.getByLabelText(/^Guardian for Assessment - September Family/i).value)
      .toBe('Dana Reyes');
    await act(async () => { fireEvent.click(importBtn()); });
    expect(intakeWrites()[0].data.guardianName).toBe('Dana Reyes');
  });

  it('says plainly when there is more here than anyone will check', async () => {
    const many = ['BEGIN:VCALENDAR'];
    for (let i = 0; i < 420; i += 1) {
      many.push(`BEGIN:VEVENT\nUID:m${i}\nDTSTART;TZID=America/Vancouver:20260915T1${String(i % 10)}0000\nSUMMARY:Assessment - Family ${i}\nEND:VEVENT`);
    }
    many.push('END:VCALENDAR');
    const { container } = draw();
    await drop(container, many.join('\n'));
    expect(screen.getByText(/more than anyone will really check/i)).toBeTruthy();
  });
});

/**
 * Leads.
 *
 * "When it creates the intake assessment it needs to create and assign it
 * a lead" — so the family lands on the Leads board and the assessment can
 * point at it.
 */
describe('the family goes on the Leads board too', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 22, 12, 0, 0));   // Tue 22 Sep 2026
  });
  afterEach(() => { vi.useRealTimers(); });

  it('creates one lead per assessment, and none for a calendar entry', async () => {
    const { container } = draw();
    await drop(container);
    await act(async () => { fireEvent.click(importBtn()); });
    expect(leadWrites()).toHaveLength(1);
    expect(leadWrites()[0].data).toMatchObject({
      parentName: 'Anita Sharma',
      childName: 'Priya Sharma',
      childGrade: '5',
      parentPhone: '604-555-0134',
      source: 'intake-form',
    });
  });

  it('points the lead and the assessment at each other', async () => {
    // The link is what lets an assessment opened on the Calendar say
    // which family it belongs to.
    const { container } = draw();
    await drop(container);
    await act(async () => { fireEvent.click(importBtn()); });
    const lead = leadWrites()[0];
    const intake = intakeWrites()[0];
    expect(intake.data.leadId).toBeTruthy();
    expect(lead.data.intakeId).toBeTruthy();
  });

  it('files an assessment that has already happened as Assessed', async () => {
    // Otherwise a month of history lands at the top of the funnel looking
    // like fresh enquiries nobody has rung yet.
    const { container } = draw();
    await drop(container, `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:past1
DTSTART;TZID=America/Vancouver:20260901T160000
SUMMARY:Assessment - Past Family
END:VEVENT
BEGIN:VEVENT
UID:soon1
DTSTART;TZID=America/Vancouver:20261001T160000
SUMMARY:Assessment - Future Family
END:VEVENT
END:VCALENDAR`);
    await act(async () => { fireEvent.click(importBtn()); });
    const byChild = Object.fromEntries(leadWrites().map(w => [w.data.childName, w.data.status]));
    expect(byChild).toEqual({ 'Past Family': 'assessed', 'Future Family': 'new' });
  });

  it('can be turned off without stopping the import', async () => {
    const { container } = draw();
    await drop(container);
    fireEvent.click(screen.getByLabelText(/add each family to/i));
    await act(async () => { fireEvent.click(importBtn()); });
    expect(leadWrites()).toHaveLength(0);
    expect(intakeWrites()).toHaveLength(1);
    expect(intakeWrites()[0].data.leadId).toBe(null);
  });

  it('carries a correction into the lead as well as the assessment', async () => {
    const { container } = draw();
    await drop(container);
    fireEvent.change(screen.getByLabelText(/^Guardian for /i), { target: { value: 'A. Sharma-Reid' } });
    await act(async () => { fireEvent.click(importBtn()); });
    expect(leadWrites()[0].data.parentName).toBe('A. Sharma-Reid');
  });
});

describe('showing what it was reading', () => {
  // 88 live events produced 71 blank or wrong names. A blank row is only
  // fixable if you can see whether there was anything there to find.
  it('offers the original description next to the row', async () => {
    const { container } = draw();
    await drop(container, `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:d1
DTSTART;TZID=America/Vancouver:20260925T160000
SUMMARY:Assessment [CA] Booked
DESCRIPTION:Parent said they may bring a sibling
END:VEVENT
END:VCALENDAR`);
    expect(screen.getByText(/what it read/i)).toBeTruthy();
    expect(screen.getByText(/may bring a sibling/i)).toBeTruthy();
  });

  it('says plainly when the event carries no description at all', async () => {
    const { container } = draw();
    await drop(container, `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:d2
DTSTART;TZID=America/Vancouver:20260925T160000
SUMMARY:Assessment - Booked
END:VEVENT
END:VCALENDAR`);
    expect(screen.getByText(/no description/i)).toBeTruthy();
    expect(screen.getByLabelText(/^Child for /i).value).toBe('');
  });

  it('stamps the original title on the assessment it writes', async () => {
    const { container } = draw();
    await drop(container, `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:d3
DTSTART;TZID=America/Vancouver:20260925T160000
SUMMARY:Assessment [CA] Booked
END:VEVENT
END:VCALENDAR`);
    fireEvent.change(screen.getByLabelText(/^Child for /i), { target: { value: 'Emma' } });
    await act(async () => { fireEvent.click(importBtn()); });
    expect(intakeWrites()[0].data.sourceSummary).toBe('Assessment [CA] Booked');
    expect(intakeWrites()[0].data.childName).toBe('Emma');
  });
});
