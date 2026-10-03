import { describe, it, expect } from 'vitest';
import {
  readDate, schoolYearStart, gradeNow, gradeLabel, stageOf, yearsBetween,
  readStudentRow, reengagement, callBackList, readStudentExport, studentImportId,
  MAX_AWAY_YEARS,
} from './formerStudents';

const TODAY = '2026-10-03';

const row = (over = {}) => ({
  'Student Id': '326183',
  'First Name': 'Brayden',
  'Last Name': 'Longacre',
  'Preferred Name': '',
  'Account': 'Longacre, Nicole',
  'Enrolment Status': 'Inactive',
  'Date of Birth': '02/05/2007',
  'Last Attendance Date': '02/05/2020',
  'Grade': 'College',
  'School': 'Topham Elementary School',
  'Delivery': 'In-Centre',
  ...over,
});

describe('how old they are now', () => {
  it('puts a child into Kindergarten the September of the year they turn five', () => {
    // Born Dec 2021 turns five in Dec 2026, so K in the 2026-27 year.
    expect(gradeNow('25/12/2021', TODAY)).toBe(0);
    expect(gradeNow('01/03/2015', TODAY)).toBe(6);
  });

  it('knows which school year a date is in', () => {
    expect(schoolYearStart('2026-10-03')).toBe(2026);   // after September
    expect(schoolYearStart('2026-06-03')).toBe(2025);   // before it
  });

  it('says nothing once they have left school', () => {
    expect(gradeNow('02/05/2007', TODAY)).toBeNull();   // 19 years old
    expect(gradeNow('', TODAY)).toBeNull();
  });

  it('names the grade the way a parent would', () => {
    expect(gradeLabel(0)).toBe('Kindergarten');
    expect(gradeLabel(7)).toBe('Grade 7');
    expect(gradeLabel(null)).toBe('');
  });

  it('splits elementary from secondary at the BC step, 7 to 8', () => {
    expect(stageOf(7).key).toBe('elementary');
    expect(stageOf(8).key).toBe('secondary');
    expect(stageOf(2).key).toBe('early');
  });
});

describe('the dates, read day-first', () => {
  it('reads the export-s own format', () => {
    expect(readDate('02/05/2020')).toBe('2020-05-02');
    expect(readDate(new Date(2026, 9, 3))).toBe('2026-10-03');
    expect(readDate('2026-01-21 05:38:51')).toBe('2026-01-21');
    expect(readDate('')).toBeNull();
  });

  it('measures a gap in years', () => {
    expect(yearsBetween('2024-10-03', TODAY)).toBeCloseTo(2, 1);
    expect(yearsBetween('', TODAY)).toBeNull();
  });
});

describe('one student row', () => {
  it('computes the grade rather than believing the column', () => {
    // Radius says College for a child born in 2015; it rolls the grade
    // forward with the school year whatever happened to the student.
    const got = readStudentRow(row({ 'Date of Birth': '01/03/2015' }), TODAY).student;
    expect(got.radiusGrade).toBe('College');
    expect(got.grade).toBe(6);
    expect(got.stage).toBe('elementary');
  });

  it('reads the roster word Radius actually uses', () => {
    // "Enrolled", not "Active" — the first pass looked for Active, found
    // none of 1,763, and would have said the centre had no students.
    expect(readStudentRow(row({ 'Enrolment Status': 'Enrolled' }), TODAY).student.enrolled).toBe(true);
    expect(readStudentRow(row(), TODAY).student.enrolled).toBe(false);
  });

  it('turns the household round so it reads as a person', () => {
    expect(readStudentRow(row(), TODAY).student.account).toBe('Nicole Longacre');
  });

  it('skips a row with nobody on it', () => {
    expect(readStudentRow(row({ 'First Name': '', 'Last Name': '' }), TODAY).skip).toBe('no-name');
  });
});

describe('who is worth a call', () => {
  const inactive = (over) => readStudentRow(row(over), TODAY).student;

  it('leads with the child who has changed school stage', () => {
    // Born 2012, last in October 2024 — Grade 7 then, Grade 9 now, so
    // they crossed the BC step out of elementary while they were away.
    const got = reengagement(inactive({
      'Date of Birth': '01/03/2012', 'Last Attendance Date': '01/10/2024',
    }), TODAY);
    expect(got).toMatchObject({ kind: 'moved-up', priority: 0 });
    expect(got.why).toContain('Grade 7');
    expect(got.why).toContain('Grade 9');
    expect(got.why).toContain('secondary');
  });

  it('counts a June visit against the school year that began in September', () => {
    // The off-by-one that would otherwise put every summer leaver a
    // grade ahead of where they actually were.
    const june = reengagement(inactive({
      'Date of Birth': '01/03/2012', 'Last Attendance Date': '01/06/2024',
    }), TODAY);
    const october = reengagement(inactive({
      'Date of Birth': '01/03/2012', 'Last Attendance Date': '01/10/2024',
    }), TODAY);
    expect(june.why).toContain('Grade 6');
    expect(october.why).toContain('Grade 7');
  });

  it('still calls out several grades on inside the same stage', () => {
    // Grade 5 then, Grade 7 now — both elementary, and two years of
    // maths apart.
    const got = reengagement(inactive({
      'Date of Birth': '01/03/2014', 'Last Attendance Date': '01/10/2024',
    }), TODAY);
    expect(got.kind).toBe('grades-on');
  });

  it('mentions a recent leaver by months', () => {
    const got = reengagement(inactive({
      'Date of Birth': '01/03/2014', 'Last Attendance Date': '01/02/2026',
    }), TODAY);
    expect(got).toMatchObject({ kind: 'recent', priority: 2 });
    expect(got.why).toMatch(/months ago/);
  });

  it('never nudges about a current student', () => {
    expect(reengagement(inactive({ 'Enrolment Status': 'Enrolled' }), TODAY)).toBeNull();
  });

  it('never nudges about somebody who has left school', () => {
    // Born 2007 — nineteen. Their maths homework is not the centre-s.
    expect(reengagement(inactive(), TODAY)).toBeNull();
  });

  it('says nothing about a child who was in last month', () => {
    expect(reengagement(inactive({
      'Date of Birth': '01/03/2014', 'Last Attendance Date': '01/09/2026',
    }), TODAY)).toBeNull();
  });

  it('says nothing about somebody who never came in', () => {
    expect(reengagement(inactive({
      'Date of Birth': '01/03/2014', 'Last Attendance Date': '',
    }), TODAY)).toBeNull();
  });

  it('stops calling people who left a decade ago', () => {
    // Uncapped the list came back with 602 names and opened on children
    // who left in Grade 2 and are in Grade 12 now. Every one of them had
    // "something changed"; none was a call worth making first.
    expect(reengagement(inactive({
      'Date of Birth': '01/03/2010', 'Last Attendance Date': '01/06/2016',
    }), TODAY)).toBeNull();
  });

  it('puts the most RECENT leaver first within a reason', () => {
    const list = callBackList([
      inactive({ 'Student Id': '1', 'Date of Birth': '01/03/2012', 'Last Attendance Date': '01/10/2023' }),
      inactive({ 'Student Id': '2', 'Date of Birth': '01/03/2013', 'Last Attendance Date': '01/10/2025' }),
    ], TODAY);
    expect(list[0].student.source_radiusId).toBe('2');
  });

  it('puts the changed-stage children first', () => {
    const list = callBackList([
      inactive({ 'Student Id': '1', 'Date of Birth': '01/03/2014', 'Last Attendance Date': '01/02/2026' }),
      inactive({ 'Student Id': '2', 'Date of Birth': '01/03/2012', 'Last Attendance Date': '01/10/2024' }),
    ], TODAY);
    expect(list.map(x => x.kind)).toEqual(['moved-up', 'recent']);
  });
});

describe('the whole file', () => {
  it('keeps the window at three years', () => {
    expect(MAX_AWAY_YEARS).toBe(3);
  });

  it('counts what it will write and what it will not', () => {
    const got = readStudentExport([
      row({ 'Student Id': '1', 'Enrolment Status': 'Enrolled', 'Date of Birth': '01/03/2015' }),
      row({ 'Student Id': '2', 'Date of Birth': '01/03/2012', 'Last Attendance Date': '01/10/2024' }),
      row({ 'Student Id': '3' }),                                  // left school
      row({ 'Student Id': '4', 'First Name': '', 'Last Name': '' }),
    ], TODAY);
    expect(got).toMatchObject({ total: 4, enrolled: 1, callBacks: 1 });
    expect(got.students).toHaveLength(3);
    expect(got.skipped['no-name']).toBe(1);
  });

  it('writes one stable id per student, so a re-import updates', () => {
    const s = readStudentRow(row(), TODAY).student;
    expect(studentImportId(s)).toBe('radius_s_326183');
  });

  it('survives nothing at all', () => {
    expect(readStudentExport(null, TODAY).students).toEqual([]);
  });
});
