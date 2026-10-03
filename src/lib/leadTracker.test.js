import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  weekEndingOf, enrolledCell, assessmentCell, notesCell, trackerRow,
  trackerMonths, trackerRows, trackerSummary, trackerCsv, monthLabel,
  lastTouched, TRACKER_COLUMNS,
} from './leadTracker';

const NOW = new Date('2026-10-05T09:00:00');
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

const lead = (over = {}) => ({
  id: 'l1', parentName: 'Rana Alahmad', childName: 'Omar Mustafa',
  status: 'new', createdAt: '2026-08-29T10:00:00', ...over,
});

/**
 * Rows lifted out of the real Lead Tracker, September tab. If this file
 * ever disagrees with these, the copy has stopped being a copy.
 */
const SHEET = [
  { parent: 'Rana Alahmad',  child: 'Omar Mustafa', created: '2026-08-29', week: '2026-08-29',
    assess: '2026-09-01', tour: 'Rahul',   assessor: 'Vin', enrolled: 'Yes', days: 3 },
  { parent: 'Yueli Wang',    child: 'Alicia',       created: '2026-08-30', week: '2026-09-05',
    assess: '2026-09-09', tour: 'Sabrina', assessor: 'Vin', enrolled: 'Yes', days: 10 },
  { parent: 'Jungeun Choi',  child: 'Leah Shin',    created: '2026-08-31', week: '2026-09-05',
    assess: '2026-09-04', tour: 'Sabrina', assessor: 'Vin', enrolled: 'Yes', days: 4 },
  { parent: 'Tomoko Yamamoto', child: 'Ryunosuke',  created: '2026-08-31', week: '2026-09-05',
    assess: '2026-09-03', tour: 'Rahul',   assessor: 'Vin', enrolled: 'Yes', days: 3 },
];

describe('Week Ending — the Saturday on or after', () => {
  it('reproduces the real sheet, row for row', () => {
    for (const row of SHEET) {
      expect(weekEndingOf(row.created)).toBe(row.week);
    }
  });

  it('leaves a Saturday where it is rather than pushing it a week on', () => {
    expect(weekEndingOf('2026-08-29')).toBe('2026-08-29');   // itself a Saturday
    expect(weekEndingOf('2026-10-03')).toBe('2026-10-03');
  });

  it('carries a Sunday to the end of the week it starts', () => {
    expect(weekEndingOf('2026-08-30')).toBe('2026-09-05');   // Sunday
  });

  it('crosses a month boundary without flinching', () => {
    expect(weekEndingOf('2026-06-30')).toBe('2026-07-04');
    expect(weekEndingOf('2026-05-26')).toBe('2026-05-30');
  });

  it('says nothing about a date it cannot read', () => {
    expect(weekEndingOf('')).toBe('');
    expect(weekEndingOf('not a date')).toBe('');
    expect(weekEndingOf(null)).toBe('');
  });
});

describe('Days to Assessment — the wait the family actually had', () => {
  it('counts calendar days, which is what DAYS360 in the sheet does not', () => {
    // The sheet's formula is DAYS360, a 30-day-month accounting count.
    // It reads 29 Aug → 1 Sep as 2 days because it collapses the 30th
    // and 31st. The family waited 3. Copying the column is the point of
    // this module; copying the bug in it is not.
    expect(trackerRow(lead({ createdAt: '2026-08-29T10:00:00', assessmentOn: '2026-09-01' })).days).toBe(3);
    expect(trackerRow(lead({ createdAt: '2026-08-30T10:00:00', assessmentOn: '2026-09-09' })).days).toBe(10);
  });

  it('agrees with the sheet everywhere the sheet is right', () => {
    for (const row of SHEET) {
      const got = trackerRow(lead({ createdAt: `${row.created}T10:00:00`, assessmentOn: row.assess }));
      expect(got.days).toBe(row.days);
    }
  });

  it('is absent, not zero, when there is no assessment to have waited for', () => {
    expect(trackerRow(lead()).days).toBeNull();
  });
});

describe('the Enrolled? column', () => {
  it('speaks the sheet-s vocabulary', () => {
    expect(enrolledCell({ status: 'enrolled' })).toBe('Yes');
    expect(enrolledCell({ status: 'lost' })).toBe('No');
    expect(enrolledCell({ status: 'assessed' })).toBe('Pending');
  });

  it('leaves it blank while nobody knows, exactly as the sheet does', () => {
    expect(enrolledCell({ status: 'new' })).toBe('');
    expect(enrolledCell({ status: 'contacted' })).toBe('');
    expect(enrolledCell({})).toBe('');
    expect(enrolledCell(null)).toBe('');
  });
});

describe('the Assessment Date column', () => {
  it('writes NS and CA, which are values in this column and not missing dates', () => {
    expect(assessmentCell({ assessmentOn: '2026-09-01', assessmentOutcome: 'no-show' })).toBe('NS');
    expect(assessmentCell({ assessmentOn: '2026-09-01', assessmentOutcome: 'cancelled' })).toBe('CA');
  });

  it('writes the date when they came in, or were going to', () => {
    expect(assessmentCell({ assessmentOn: '2026-09-01', assessmentOutcome: 'attended' })).toBe('2026-09-01');
    expect(assessmentCell({ assessmentOn: '2026-09-01' })).toBe('2026-09-01');
  });

  it('is blank when none was ever booked', () => {
    expect(assessmentCell({})).toBe('');
  });
});

describe('the Notes column', () => {
  it('stamps each entry the way the sheet does', () => {
    const got = notesCell({ assessmentNotes: [{ at: '2026-09-01T14:00:00', text: 'Extremely pleasant' }] });
    expect(got).toBe('9/1: Extremely pleasant');
  });

  it('keeps every visit, oldest first, one per line', () => {
    const got = notesCell({ assessmentNotes: [
      { at: '2026-06-30T10:00:00', text: 'NS' },
      { at: '2026-07-09T10:00:00', text: 'Enrolled on the spot' },
    ] });
    expect(got).toBe('6/30: NS\n7/9: Enrolled on the spot');
  });

  it('is blank rather than apologetic when nothing was written', () => {
    expect(notesCell({})).toBe('');
    expect(notesCell({ assessmentNotes: [] })).toBe('');
  });
});

describe('a row of the sheet', () => {
  it('joins the two names the way the column is headed', () => {
    expect(trackerRow(lead()).name).toBe('Rana Alahmad / Omar Mustafa');
  });

  it('copes when only one of the two names is known', () => {
    expect(trackerRow(lead({ childName: '' })).name).toBe('Rana Alahmad');
    expect(trackerRow(lead({ parentName: '' })).name).toBe('Omar Mustafa');
    expect(trackerRow(lead({ parentName: '', childName: '' })).name).toBe('');
  });

  it('fills every column the sheet has', () => {
    const got = trackerRow(lead({
      lastContactOn: '2026-09-01', reason: 'remedial', assessmentOn: '2026-09-01',
      assessmentOutcome: 'attended', tourBy: 'Rahul', assessedBy: 'Vin',
      status: 'enrolled', enrolledAt: '2026-09-01T16:00:00', outcomeReason: 'Enrolled on the spot',
    }));
    expect(got).toMatchObject({
      name: 'Rana Alahmad / Omar Mustafa', created: '2026-08-29', week: '2026-08-29',
      contact: '2026-09-01', reason: 'remedial', assess: '2026-09-01',
      tour: 'Rahul', assessor: 'Vin', enrolled: 'Yes', why: 'Enrolled on the spot', days: 3,
    });
  });

  it('has a value for every declared column', () => {
    const got = trackerRow(lead());
    for (const col of TRACKER_COLUMNS) {
      expect(got).toHaveProperty(col.key);
    }
  });
});

describe('the tabs', () => {
  const leads = [
    lead({ id: 'a', createdAt: '2026-08-29T10:00:00' }),
    lead({ id: 'b', createdAt: '2026-09-02T10:00:00' }),
    lead({ id: 'c', createdAt: '2026-10-01T10:00:00' }),
  ];

  it('lists the months that have leads in them, newest first', () => {
    expect(trackerMonths(leads)).toEqual(['2026-10', '2026-09', '2026-08']);
  });

  it('ignores a lead with no created date rather than inventing a tab', () => {
    expect(trackerMonths([...leads, lead({ id: 'd', createdAt: null })]))
      .toEqual(['2026-10', '2026-09', '2026-08']);
  });

  it('names a tab the way a person says it', () => {
    expect(monthLabel('2026-09')).toMatch(/September/);
    expect(monthLabel('2026-09')).toMatch(/2026/);
    expect(monthLabel('')).toBe('');
  });

  it('shows one month at a time, oldest first inside it', () => {
    const rows = trackerRows([
      lead({ id: 'b', createdAt: '2026-09-04T10:00:00' }),
      lead({ id: 'a', createdAt: '2026-09-02T10:00:00' }),
      lead({ id: 'c', createdAt: '2026-10-01T10:00:00' }),
    ], '2026-09');
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('shows everything when no month is asked for', () => {
    expect(trackerRows(leads, '')).toHaveLength(3);
  });
});

describe('the block under the rows', () => {
  const month = [
    lead({ id: 'a', assessmentOn: '2026-09-01', assessmentOutcome: 'attended', status: 'enrolled', tourBy: 'Rahul', assessedBy: 'Vin' }),
    lead({ id: 'b', assessmentOn: '2026-09-02', assessmentOutcome: 'no-show', tourBy: 'Sabrina' }),
    lead({ id: 'c', assessmentOn: '2026-09-03', assessmentOutcome: 'cancelled', tourBy: 'Sabrina' }),
    lead({ id: 'd' }),
  ];
  const sum = () => trackerSummary(trackerRows(month, ''));

  it('counts the ones nobody booked, out of the month', () => {
    expect(sum()).toMatchObject({ total: 4, noAssessment: 1, noAssessmentRate: 0.25 });
  });

  it('counts cancellations and no-shows together, as the sheet does', () => {
    expect(sum()).toMatchObject({ broken: 2, brokenRate: 0.5 });
  });

  it('credits both names in a shared tour, the way the sheet is written', () => {
    const tours = trackerSummary(trackerRows([
      lead({ id: 'x', tourBy: 'Sabrina / Vin', status: 'enrolled' }),
    ], '')).tours;
    expect(tours.map(t => t.person).sort()).toEqual(['Sabrina', 'Vin']);
    expect(tours.every(t => t.total === 1 && t.enrolled === 1)).toBe(true);
  });

  it('averages only the waits it actually has', () => {
    // Three of the four have an assessment date; the fourth has none and
    // is left out rather than counted as a nought-day wait.
    expect(sum().daysToAssessmentSample).toBe(3);
  });

  it('gives null, not nought per cent, when there is nothing to divide by', () => {
    const empty = trackerSummary([]);
    expect(empty.total).toBe(0);
    expect(empty.noAssessmentRate).toBeNull();
    expect(empty.brokenRate).toBeNull();
    expect(empty.enrolledRate).toBeNull();
    expect(empty.daysToAssessment).toBeNull();
  });
});

describe('getting it back out', () => {
  it('writes the columns in the order the sheet has them', () => {
    const head = trackerCsv([]).split('\n')[0];
    expect(head).toBe(
      'Lead Name/Student Name,Created Date,Week Ending,Last Contact,Trigger/Reason,'
      + 'Assessment Date,Notes,Tour by,Assessor,Enrolled?,Why?,Days to Assessment',
    );
  });

  it('quotes a note that contains a comma or a newline', () => {
    const rows = trackerRows([lead({
      assessmentNotes: [{ at: '2026-09-01T10:00:00', text: 'Keen, but needs to ask dad' }],
    })], '');
    expect(trackerCsv(rows)).toContain('"9/1: Keen, but needs to ask dad"');
  });

  it('leaves an absent day count empty rather than printing null', () => {
    const line = trackerCsv(trackerRows([lead()], '')).split('\n')[1];
    expect(line.endsWith(',')).toBe(true);
    expect(line).not.toContain('null');
  });
});

describe('when the month was last added to', () => {
  it('finds the newest lead in the set', () => {
    expect(lastTouched([
      lead({ createdAt: '2026-09-02T10:00:00' }),
      lead({ createdAt: '2026-09-09T10:00:00' }),
    ])).toBe(new Date('2026-09-09T10:00:00').getTime());
  });

  it('says nothing about an empty month', () => {
    expect(lastTouched([])).toBeNull();
    expect(lastTouched(null)).toBeNull();
  });
});
