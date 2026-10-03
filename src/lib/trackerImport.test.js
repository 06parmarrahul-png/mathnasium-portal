import { describe, it, expect } from 'vitest';
import {
  readTrackerWorkbook, readRow, headerMap, readDate, readContact,
  readAssessment, readNotes, readNames, readReason, readStatus, importId,
} from './trackerImport';

/**
 * The workbook's own shapes, taken off the real tabs rather than invented:
 * September names column D "Last Contact", August calls it "Lead Call
 * Initial/Date", July calls it "Column 4", and August carries a "Why?"
 * column that September dropped — which moves every column after it.
 */
const SEP_HEADER = ['Lead Name/Student Name', 'Created Date', 'Week Ending', 'Last Contact',
  'Trigger/Reason', 'Assessment Date', 'Notes', 'Tour by', 'Assessor',
  'Enrolled? (Yes/Pending/Cold/No)', 'Days to Assessment'];
const AUG_HEADER = ['Lead Name/Student Name', 'Created Date', 'Week Ending', 'Lead Call\nInitial/Date',
  'Trigger/Reason', 'Assessment Date', 'Assessment Notes', 'Tour by', 'Assessor',
  'Enrolled? (Yes/Pending/No)', 'Why?', 'Days to Assessment'];
const JUL_HEADER = [...AUG_HEADER];
JUL_HEADER[3] = 'Column 4';

const d = (ymd) => new Date(`${ymd}T00:00:00`);

describe('the columns are found by name, never by position', () => {
  it('reads September-s header', () => {
    expect(headerMap(SEP_HEADER)).toMatchObject({
      name: 0, created: 1, contact: 3, reason: 4, assess: 5, notes: 6,
      tour: 7, assessor: 8, enrolled: 9,
    });
  });

  it('reads August-s, where Why? shifts everything after it', () => {
    const cols = headerMap(AUG_HEADER);
    expect(cols).toMatchObject({ contact: 3, notes: 6, enrolled: 9, why: 10 });
  });

  it('recognises the column D three tabs each name differently', () => {
    expect(headerMap(SEP_HEADER).contact).toBe(3);   // "Last Contact"
    expect(headerMap(AUG_HEADER).contact).toBe(3);   // "Lead Call\nInitial/Date"
    expect(headerMap(JUL_HEADER).contact).toBe(3);   // "Column 4"
  });

  it('does not let Assessment Notes answer to Assessment Date', () => {
    const cols = headerMap(AUG_HEADER);
    expect(cols.assess).toBe(5);
    expect(cols.notes).toBe(6);
  });
});

describe('reading the cells', () => {
  it('takes a real date, an Excel serial, or an ISO string', () => {
    expect(readDate(d('2026-09-01'))).toBe('2026-09-01');
    expect(readDate('2026-09-01')).toBe('2026-09-01');
    expect(readDate(46266)).toBe('2026-09-01');   // Excel serial
  });

  it('says nothing about a cell that is not a date', () => {
    expect(readDate('NS')).toBe('');
    expect(readDate('')).toBe('');
    expect(readDate(null)).toBe('');
  });

  it('reads NS and CA as outcomes, not as missing dates', () => {
    expect(readAssessment('NS')).toEqual({ on: '', outcome: 'no-show' });
    expect(readAssessment('CA')).toEqual({ on: '', outcome: 'cancelled' });
    expect(readAssessment(d('2026-09-01'))).toEqual({ on: '2026-09-01', outcome: '' });
    expect(readAssessment('N/A')).toEqual({ on: '', outcome: '' });
  });

  it('reads "VB 7/16" as the 16th of July, in the lead-s own year', () => {
    expect(readContact('VB 7/16', 2026)).toMatchObject({ on: '2026-07-16', raw: 'VB 7/16' });
  });

  it('does not turn "Open" or "N/A" into a date', () => {
    // They are somebody saying the call has not happened. A guess here
    // would put a contact on the timeline that nobody ever made.
    expect(readContact('Open', 2026).on).toBe('');
    expect(readContact('N/A', 2026).on).toBe('');
  });

  it('splits the two names the column holds', () => {
    expect(readNames('Rana Alahmad / Omar Musleh'))
      .toEqual({ parentName: 'Rana Alahmad', childName: 'Omar Musleh' });
    expect(readNames('Joey Lau/Janice Lin'))
      .toEqual({ parentName: 'Joey Lau', childName: 'Janice Lin' });
    expect(readNames('A.J./Kemal')).toEqual({ parentName: 'A.J.', childName: 'Kemal' });
  });

  it('copes with one name where the sheet only had one', () => {
    expect(readNames('Miyeon')).toEqual({ parentName: 'Miyeon', childName: '' });
  });

  it('splits a notes cell into one dated entry per visit', () => {
    const got = readNotes('6/30: NS\n7/9: Enrolled on the spot', 2026);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ at: '2026-06-30T12:00:00', text: 'NS' });
    expect(got[1]).toMatchObject({ at: '2026-07-09T12:00:00', text: 'Enrolled on the spot' });
  });

  it('keeps a note somebody typed without a date rather than dropping it', () => {
    const got = readNotes('Was referred to us by another family', 2026);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ at: '', text: 'Was referred to us by another family' });
  });

  it('maps the reason text onto the dropdown without losing the detail', () => {
    expect(readReason('Remedial, ex-Kumon')).toBe('ex-competitor');
    expect(readReason('Enrichment, Pre-IB')).toBe('pre-ib');
    expect(readReason('Remedial, falling behind')).toBe('remedial');
    expect(readReason('Returning student')).toBe('returning');
    expect(readReason('Something nobody has said before')).toBe('other');
    expect(readReason('')).toBe('');
  });

  it('maps the enrolled column onto a status, Cold included', () => {
    const none = { on: '', outcome: '' };
    expect(readStatus('Yes', none, false)).toBe('enrolled');
    expect(readStatus('No', none, false)).toBe('lost');
    // Cold is a family who stopped answering, not one who said no. Both
    // are off the call sheet; the word survives under `tracker`.
    expect(readStatus('Cold', none, false)).toBe('lost');
    expect(readStatus('Pending', none, false)).toBe('assessed');
    expect(readStatus('', none, true)).toBe('assessed');
    expect(readStatus('', none, false)).toBe('new');
  });
});

describe('a row', () => {
  const cols = headerMap(SEP_HEADER);
  const row = (over = []) => {
    const cells = ['Rana Alahmad / Omar Musleh', d('2026-08-29'), d('2026-08-29'), '',
      'Remedial', d('2026-09-01'), '9/1: Extremely pleasant', 'Rahul', 'Vin', 'Yes', 2];
    for (const [i, v] of over) cells[i] = v;
    return readRow(cells, cols);
  };

  it('becomes a lead with the sheet-s own words kept verbatim', () => {
    expect(row()).toMatchObject({
      parentName: 'Rana Alahmad', childName: 'Omar Musleh', status: 'enrolled',
      reason: 'remedial', tourBy: 'Rahul', assessedBy: 'Vin',
      assessmentOn: '2026-09-01', assessmentOutcome: 'attended',
      tracker: { enrolled: 'Yes', reason: 'Remedial' },
    });
  });

  it('is skipped entirely without a created date', () => {
    // Under every tab-s rows sits a summary block with text in the first
    // column — "Tours:", then a name per staff member. A created date is
    // what separates a family from a subtotal.
    expect(readRow(['Tours:', 'Number:', '', '', '', '', '', '', '', '', ''], cols)).toBeNull();
    expect(readRow(['Rahul', 5, 2, 0.4, '', '', '', '', '', '', ''], cols)).toBeNull();
    expect(readRow(['', '', '', 'No assessment booked:', 2, '', '', '', '', '', ''], cols)).toBeNull();
  });

  it('is skipped without a name', () => {
    expect(row([[0, '']])).toBeNull();
  });

  it('reads "N/A" in a who-did-this column as nobody', () => {
    // Splitting it on the slash invented two staff members called N and A
    // and gave them three tours between them.
    expect(row([[7, 'N/A'], [8, 'N/A']])).toMatchObject({ tourBy: '', assessedBy: '' });
  });

  it('calls a dated assessment with nothing beside it a booking, not a visit', () => {
    expect(row([[6, ''], [8, ''], [9, '']])).toMatchObject({ assessmentOutcome: 'booked', assessedAt: null });
  });

  it('keeps the same id across imports, so re-running updates rather than duplicates', () => {
    expect(row().id).toBe(importId('2026-08-29', 'Rana Alahmad Omar Musleh'));
    expect(row().id).toBe(row().id);
  });

  it('gives siblings on the same day different ids', () => {
    const a = row([[0, 'Chen Gu/Lizabeth Liu']]);
    const b = row([[0, 'Chen Gu/Lyvia Liu']]);
    expect(a.id).not.toBe(b.id);
  });
});

describe('the whole workbook', () => {
  const sheet = (name, header, rows) => ({ name, rows: [header, ...rows] });
  const june = sheet('June', AUG_HEADER, [
    // Enquired in May, worked in June — he keeps it on the June tab.
    ['Rachel Singh/Ayana', d('2026-05-26'), d('2026-05-30'), 'VB 5/26', 'Remedial',
      d('2026-06-02'), '6/2: Enjoyed it', 'Sabrina', 'Vin', 'Yes', '', 6],
    ['Ranee NoLast/Ethan', d('2026-06-01'), d('2026-06-06'), 'VB 6/1', '', 'NS',
      '', '', '', '', '', ''],
    // The summary block.
    ['', '', '', 'No assessment booked:', 2, '', '', '', '', '', '', ''],
    ['Tours:', 'Number:', 'Enrolled:', 'Rate:', 48, '', '', '', '', '', '', ''],
    ['Sabrina', 12, 7, 0.58, '', '', '', '', '', '', '', ''],
  ]);
  const july = sheet('July', JUL_HEADER, [
    ['Anand NoLast/Vedaant', d('2026-07-03'), d('2026-07-04'), 'VB 7/3', 'Enrichment',
      d('2026-07-04'), '7/4: Very interested', 'Dev', 'Vin', 'Yes', '', 1],
  ]);

  it('reads every tracker tab and ignores everything else', () => {
    const other = { name: 'KPI Tracking TBD', rows: [['', 'JUNE', 'JULY'], ['TOURS', '', '']] };
    const got = readTrackerWorkbook([june, july, other]);
    expect(got.leads).toHaveLength(3);
    expect(got.bySheet.map(s => s.sheet)).toEqual(['June', 'July']);
  });

  it('leaves the summary block out of the count', () => {
    expect(readTrackerWorkbook([june]).leads).toHaveLength(2);
  });

  it('files a row under the tab it was typed on, not its created date', () => {
    // Rachel enquired on 26 May and is on the June tab. Filing her under
    // May would split his month in two and make the totals under each
    // tab disagree with the ones he reads off the sheet.
    const got = readTrackerWorkbook([june, july]);
    const rachel = got.leads.find(l => l.parentName === 'Rachel Singh');
    expect(rachel.createdAt.slice(0, 10)).toBe('2026-05-26');
    expect(rachel.tracker.month).toBe('2026-06');
    expect(got.months).toEqual(['2026-06', '2026-07']);
  });

  it('keeps everything, and only archives by the month it was worked', () => {
    const got = readTrackerWorkbook([june, july], { liveFrom: '2026-07-01' });
    expect(got.leads).toHaveLength(3);
    expect(got.live).toBe(1);
    expect(got.archived).toBe(2);
  });

  it('skips a tab before the month asked for', () => {
    const got = readTrackerWorkbook([june, july], { from: '2026-07' });
    expect(got.bySheet.map(s => s.sheet)).toEqual(['July']);
    expect(got.leads).toHaveLength(1);
  });

  it('lets the later tab win when a family was chased into the next month', () => {
    const again = sheet('July', JUL_HEADER, [
      ['Rachel Singh/Ayana', d('2026-05-26'), d('2026-05-30'), 'VB 7/2', 'Remedial',
        d('2026-06-02'), '7/2: Rang again', 'Sabrina', 'Vin', 'Pending', '', 6],
    ]);
    const got = readTrackerWorkbook([june, again]);
    expect(got.duplicates).toBe(1);
    const rachel = got.leads.filter(l => l.parentName === 'Rachel Singh');
    expect(rachel).toHaveLength(1);
    expect(rachel[0].tracker.enrolled).toBe('Pending');
  });

  it('returns nothing, rather than throwing, for a workbook that is not the tracker', () => {
    expect(readTrackerWorkbook([{ name: 'Sheet1', rows: [['a', 'b'], [1, 2]] }]).leads).toEqual([]);
    expect(readTrackerWorkbook([]).leads).toEqual([]);
    expect(readTrackerWorkbook(null).leads).toEqual([]);
  });
});
