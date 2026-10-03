import { describe, it, expect } from 'vitest';
import {
  mapStatus, isDoNotContact, isCollege, gradeNumber, readDate, mapSource,
  readRow, readExport, importId,
} from './radiusLeads';
import { LEAD_STATUSES } from './leads';

/** A row shaped exactly like the export's columns. */
const row = (over = {}) => ({
  'Lead Id': '367687',
  'Lead Name': 'Dietmar Dorrer',
  'Created Date': '27/01/2016',
  'Mobile Phone': '(778) 386-5498',
  'Email': 'DietmarDoerrer@gmail.com',
  'Lead Status': 'Visited',
  'Student Name': 'Annabelle Dorrer',
  'Student Gender': 'Female',
  'Grade': '6',
  'Rating': 'Warm',
  'Lead Source': 'Location/Visibility - Walk By Centre Front',
  'Last Contacted': '',
  'Centre': 'LangleyBC',
  ...over,
});

describe('the date, which is the one that fails silently', () => {
  it('reads day first, because the export is Canadian', () => {
    // Read the American way this is 10 March and nothing throws.
    expect(readDate('03/10/2026')).toBe('2026-10-03');
    expect(readDate('27/01/2016')).toBe('2016-01-27');
  });

  it('takes a real Date and an ISO string too', () => {
    expect(readDate(new Date(2026, 9, 3))).toBe('2026-10-03');
    expect(readDate('2026-10-03T11:16:00')).toBe('2026-10-03');
  });

  it('says nothing rather than guessing', () => {
    expect(readDate('')).toBeNull();
    expect(readDate('next Tuesday')).toBeNull();
  });
});

describe('what Radius called it, and what Ratio calls it', () => {
  it('lands every status the file holds on one of Ratio-s five', () => {
    const seen = ['Open', 'Active', 'Visited', 'Contacted', 'Hold',
      'Assessment Pending', 'Assessed', 'Assessed - Declined Enrolment',
      'Inactive', 'Do Not Contact', 'Mail Only', ''];
    for (const s of seen) expect(LEAD_STATUSES).toContain(mapStatus(s));
  });

  it('reads an assessment that has not happened as contacted, not assessed', () => {
    expect(mapStatus('Assessment Pending')).toBe('contacted');
    expect(mapStatus('Assessed')).toBe('assessed');
  });

  it('closes the three that are closed, and keeps them apart in words', () => {
    expect(mapStatus('Assessed - Declined Enrolment')).toBe('lost');
    expect(mapStatus('Inactive')).toBe('lost');
    expect(mapStatus('Do Not Contact')).toBe('lost');
    // The verbatim status rides along, because "came in and said no" and
    // "asked never to be rung again" are not the same fact.
    expect(readRow(row({ 'Lead Status': 'Do Not Contact' })).lead.outcomeReason)
      .toBe('Do Not Contact');
  });

  it('flags do-not-contact on its own, since it is a promise', () => {
    expect(isDoNotContact('Do Not Contact')).toBe(true);
    expect(isDoNotContact('Inactive')).toBe(false);
    expect(readRow(row({ 'Lead Status': 'Do Not Contact' })).lead.doNotContact).toBe(true);
  });

  it('falls back to new rather than inventing a stage', () => {
    expect(mapStatus('Something Radius Added Later')).toBe('new');
    expect(mapStatus('')).toBe('new');
  });
});

describe('the grade, which is what makes a nudge possible', () => {
  it('knows College is not a school grade', () => {
    expect(isCollege('College')).toBe(true);
    expect(isCollege('University')).toBe(true);
    expect(isCollege('11')).toBe(false);
  });

  it('reads the two that are not numbers', () => {
    expect(gradeNumber('Kindergarten')).toBe(0);
    expect(gradeNumber('JK (Junior Kindergarten)')).toBe(-1);
    expect(gradeNumber('6')).toBe(6);
  });

  it('refuses anything outside K–12', () => {
    expect(gradeNumber('College')).toBeNull();
    expect(gradeNumber('')).toBeNull();
    expect(gradeNumber('13')).toBeNull();
  });

  it('stamps WHEN the grade was true, or one year on is meaningless', () => {
    const got = readRow(row()).lead;
    expect(got.importedGrade).toBe(6);
    expect(got.importedGradeOn).toBe('2016-01-27');
  });
});

describe('where they came from', () => {
  it('reads the multi-valued free text down to one source', () => {
    expect(mapSource('Internet - Search Engine Marketing (PPC and Organic), Other - Apptoto')).toBe('apptoto');
    expect(mapSource('Internet, Referral')).toBe('referral');
    expect(mapSource('Location/Visibility - Walk By Centre Front')).toBe('walk-in');
    expect(mapSource('Internet - Social Media/Facebook')).toBe('social');
    expect(mapSource('Internet')).toBe('website');
    expect(mapSource('Not Specified')).toBe('other');
  });

  it('keeps the whole string, because the reduction loses most of it', () => {
    const got = readRow(row({ 'Lead Source': 'Internet, Other - Apptoto' })).lead;
    expect(got.source).toBe('apptoto');
    expect(got.sourceDetail).toBe('Internet, Other - Apptoto');
  });
});

describe('one row', () => {
  it('carries the family across, email lowercased', () => {
    expect(readRow(row()).lead).toMatchObject({
      parentName: 'Dietmar Dorrer',
      parentEmail: 'dietmardoerrer@gmail.com',
      parentPhone: '(778) 386-5498',
      childName: 'Annabelle Dorrer',
      status: 'contacted',
      rating: 'warm',
      createdOn: '2016-01-27',
    });
  });

  it('skips College, and says that is why', () => {
    expect(readRow(row({ Grade: 'College' }))).toEqual({ skip: 'college', name: 'Dietmar Dorrer' });
  });

  it('skips a row with nobody named on it', () => {
    expect(readRow(row({ 'Lead Name': '', 'Student Name': '' })).skip).toBe('no-name');
  });

  it('keeps a row that has only the child', () => {
    expect(readRow(row({ 'Lead Name': '' })).lead.childName).toBe('Annabelle Dorrer');
  });
});

describe('only what is still the pipeline', () => {
  it('leaves everything before the cut-off out of the file entirely', () => {
    const got = readExport([
      row({ 'Lead Id': '1', 'Created Date': '27/01/2016' }),
      row({ 'Lead Id': '2', 'Created Date': '15/09/2026' }),
    ], { since: '2026-07-01' });
    expect(got.leads).toHaveLength(1);
    expect(got.leads[0].source_radiusId).toBe('2');
    expect(got.skipped['before-cutoff']).toBe(1);
  });

  it('drops a row with no readable date, since a recent one would have one', () => {
    const got = readExport([row({ 'Created Date': '' })], { since: '2026-07-01' });
    expect(got.leads).toHaveLength(0);
    expect(got.skipped['before-cutoff']).toBe(1);
  });

  it('takes the lot when no cut-off is given', () => {
    expect(readExport([row({ 'Created Date': '27/01/2016' })]).leads).toHaveLength(1);
  });

  it('arrives live, because inside the cut-off IS the pipeline', () => {
    expect(readRow(row()).lead.archived).toBe(false);
  });

  it('knows an assessment happened even with no date column to prove it', () => {
    // Radius has a status and no assessment date. Without this, 28 of
    // the 57 read as "nobody has booked them in" — families already sat
    // down with Vin.
    expect(readRow(row({ 'Lead Status': 'Assessed' })).lead.assessmentOutcome).toBe('attended');
    expect(readRow(row({ 'Lead Status': 'Assessed - Declined Enrolment' })).lead.assessmentOutcome).toBe('attended');
    expect(readRow(row({ 'Lead Status': 'Open' })).lead.assessmentOutcome).toBe('');
  });

  it('keeps every field, so nothing is lost by archiving it', () => {
    const got = readRow(row()).lead;
    expect(got.parentPhone).toBeTruthy();
    expect(got.outcomeReason).toBeTruthy();
    expect(got.importedGrade).toBe(6);
  });
});

describe('re-running the import', () => {
  it('writes the same id for the same Radius lead, so it rewrites not duplicates', () => {
    const a = readRow(row()).lead;
    expect(importId(a)).toBe('radius_367687');
    expect(importId(a)).toBe(importId(readRow(row()).lead));
  });

  it('still has a stable id when Radius gave no id', () => {
    const a = readRow(row({ 'Lead Id': '' })).lead;
    expect(importId(a)).toBe(importId(readRow(row({ 'Lead Id': '' })).lead));
    expect(importId(a).startsWith('radius_x_')).toBe(true);
  });
});

describe('the whole file, counted before anything is written', () => {
  const rows = [
    row({ 'Lead Id': '1', Grade: '6', 'Lead Status': 'Assessed' }),
    row({ 'Lead Id': '2', Grade: 'College' }),
    row({ 'Lead Id': '3', Grade: 'College' }),
    row({ 'Lead Id': '4', Grade: '', 'Lead Status': 'Do Not Contact', 'Mobile Phone': '', Email: '' }),
    row({ 'Lead Id': '5', 'Lead Name': '', 'Student Name': '' }),
  ];

  it('reports what it will write and what it will not', () => {
    const got = readExport(rows);
    expect(got.total).toBe(5);
    expect(got.leads).toHaveLength(2);
    expect(got.skipped).toMatchObject({ college: 2, 'no-name': 1 });
  });

  it('counts the things somebody would want to know first', () => {
    const got = readExport(rows);
    expect(got.byStatus).toEqual({ assessed: 1, lost: 1 });
    expect(got.withPhone).toBe(1);
    expect(got.withEmail).toBe(1);
    expect(got.withGrade).toBe(1);
    expect(got.doNotContact).toBe(1);
    expect(got.from).toBe('2016-01-27');
  });

  it('survives an empty file', () => {
    expect(readExport([]).leads).toEqual([]);
    expect(readExport(null).total).toBe(0);
  });
});
