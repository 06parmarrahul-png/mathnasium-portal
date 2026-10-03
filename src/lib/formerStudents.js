/**
 * formerStudents.js — the families who already know you.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE ASK: "tell them to reach out to so-and-so, it's a new year and
 * they're in middle school now — they used to be in elementary."
 *
 * That needs three facts Ratio did not hold: that the child was once a
 * student, when they were last in the centre, and how old they are now.
 * The Radius student export has all three for 1,763 children, going back
 * to 2016 — and the third one properly, as a date of birth, which is the
 * only field that stays true while a child gets older.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHAT THE EXPORT ACTUALLY SAYS, measured on the real file:
 *
 *   1,763 students, Centre always LangleyBC
 *   Enrolment Status   Inactive 1,371 · Enrolled 332 · New 44 · On Hold 16
 *   Date of Birth      1,552 of 1,763, spanning 1998 → 2021
 *   Last Attendance    1,706 of 1,763, spanning 2016-03 → today
 *   769 inactive students are STILL SCHOOL AGE. That is the list.
 *
 * DO NOT TRUST THE GRADE COLUMN. 641 students read "College", including
 * children born in 2015. Radius rolls the grade forward with the school
 * year, so anybody who stopped coming long enough ago eventually ages
 * into College whatever grade they actually reached. The date of birth
 * does not drift, so the grade is COMPUTED from it here.
 *
 * THE TWO EXPORTS DO NOT JOIN. Both files carry a "Lead Id" in the same
 * numeric range and the intersection of 1,357 student ids with 1,303 lead
 * ids is EXACTLY ZERO — they are separate id spaces, whatever the column
 * is called. Nothing in here pretends otherwise; a former student is its
 * own record, matched to a lead by name only where a person asks for it.
 *
 * PURE MODULE — no React, no Firebase, no file reading.
 */

/** BC: Kindergarten the year a child turns five, elementary K–7, then 8–12. */
export const STAGES = [
  { key: 'early',      label: 'Early years', from: -1, to: 3 },
  { key: 'elementary', label: 'Elementary',  from: 4,  to: 7 },
  { key: 'secondary',  label: 'Secondary',   from: 8,  to: 12 },
];

const clean = (v) => String(v ?? '').trim();

/** 'dd/mm/yyyy', a Date, or an ISO string → 'YYYY-MM-DD'. Day first. */
export function readDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = clean(value);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${String(Number(dmy[2])).padStart(2, '0')}-${String(Number(dmy[1])).padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return iso ? iso[0] : null;
}

/** The September a school year began, for a date inside it. */
export function schoolYearStart(onYmd) {
  const m = /^(\d{4})-(\d{2})/.exec(clean(onYmd));
  if (!m) return null;
  const [y, mo] = [Number(m[1]), Number(m[2])];
  return mo >= 9 ? y : y - 1;
}

/**
 * What grade this child is in TODAY, from their birthday.
 *
 * BC puts a child into Kindergarten in the September of the calendar year
 * they turn five, so the arithmetic is the school year's September minus
 * the birth year minus five. Kindergarten is 0 and anything past 12 is
 * null — they have left school, and a nudge about their maths homework
 * would be addressed to an adult.
 */
export function gradeNow(dobYmd, onYmd) {
  const dob = readDate(dobYmd);
  const start = schoolYearStart(onYmd);
  if (!dob || start === null) return null;
  const grade = start - Number(dob.slice(0, 4)) - 5;
  return grade >= 0 && grade <= 12 ? grade : null;
}

/** 'Kindergarten' / 'Grade 7'. */
export function gradeLabel(grade) {
  if (grade === null || grade === undefined) return '';
  return grade === 0 ? 'Kindergarten' : `Grade ${grade}`;
}

export function stageOf(grade) {
  if (grade === null || grade === undefined) return null;
  return STAGES.find(s => grade >= s.from && grade <= s.to) || null;
}

/** Whole years between two 'YYYY-MM-DD' days. */
export function yearsBetween(fromYmd, toYmd) {
  const a = readDate(fromYmd); const b = readDate(toYmd);
  if (!a || !b) return null;
  return (new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / (365.25 * 86400000);
}

/**
 * One export row → the record Ratio keeps, or why it was skipped.
 *
 * `Enrolment Status` is Radius's word and it is kept verbatim: "Enrolled"
 * is the current roster, and it is NOT the word this file uses elsewhere
 * — a first pass looked for "Active", found none of 1,763, and would have
 * reported the centre as having no students at all.
 */
export function readStudentRow(row, today) {
  const first = clean(row['First Name']);
  const last = clean(row['Last Name']);
  const name = [first, last].filter(Boolean).join(' ');
  if (!name) return { skip: 'no-name' };

  const status = clean(row['Enrolment Status']);
  const dob = readDate(row['Date of Birth']);
  const lastSeen = readDate(row['Last Attendance Date']);
  const grade = gradeNow(dob, today);

  return {
    student: {
      name,
      preferredName: clean(row['Preferred Name']),
      // The household, which is how a parent is reached. "Longacre,
      // Nicole" in the export; turned round so it reads as a person.
      account: clean(row['Account']).split(',').map(s => s.trim()).filter(Boolean).reverse().join(' '),
      status,
      enrolled: /^enrolled$/i.test(status),
      dob,
      lastSeen,
      school: clean(row['School']),
      // Radius's own grade, kept only so a person can see what it said.
      // It rolls forward with the school year, so it is not evidence.
      radiusGrade: clean(row['Grade']),
      grade,
      stage: stageOf(grade)?.key || null,
      source_radiusId: clean(row['Student Id']),
      delivery: clean(row['Delivery']),
    },
  };
}

/**
 * How long away is too long to ring.
 *
 * MEASURED, NOT PICKED. Without a ceiling the list came back with 602
 * names and opened on children who left in Grade 2 and are in Grade 12
 * now — ten years of a different phone number, a different school and a
 * parent who will not place the centre. Every one of them satisfies
 * "something changed"; none of them is a call anybody should make first.
 * Three years keeps the families who still remember you.
 */
export const MAX_AWAY_YEARS = 3;

/**
 * Is this former student worth a call, and what is the reason to give?
 *
 * EVERY REASON NAMES SOMETHING THAT CHANGED. "They have been away a
 * while" is not a reason anybody can open a conversation with; "they were
 * in Grade 6 when they left and they are in Grade 9 now" is. Where
 * nothing has changed, this returns null rather than padding the list —
 * a call list people stop believing is worse than a short one.
 */
export function reengagement(student, today) {
  if (!student || student.enrolled) return null;
  if (student.grade === null) return null;          // left school
  if (!student.lastSeen) return null;               // never came in

  const away = yearsBetween(student.lastSeen, today);
  if (away === null || away < 0.5) return null;     // still basically current
  if (away > MAX_AWAY_YEARS) return null;           // history, not a call

  const gradeThen = gradeNow(student.dob, student.lastSeen);
  const stageThen = stageOf(gradeThen);
  const stageNow = stageOf(student.grade);
  const who = student.preferredName || student.name.split(' ')[0];

  // Moved school stage — the one that genuinely changes the maths and
  // the conversation. In BC that is the Grade 7 → 8 step.
  if (stageThen && stageNow && stageThen.key !== stageNow.key) {
    return {
      kind: 'moved-up',
      priority: 0,
      why: `${who} was in ${gradeLabel(gradeThen)} when they last came in. They are in ${gradeLabel(student.grade)} now — ${stageNow.label.toLowerCase()}.`,
      awayYears: away,
    };
  }

  // Several grades on, same stage. Still a different child mathematically.
  if (gradeThen !== null && student.grade - gradeThen >= 2) {
    return {
      kind: 'grades-on',
      priority: 1,
      why: `${who} has gone from ${gradeLabel(gradeThen)} to ${gradeLabel(student.grade)} since they were last in.`,
      awayYears: away,
    };
  }

  // Left recently enough that the centre is still fresh in mind.
  if (away < 1.5) {
    return {
      kind: 'recent',
      priority: 2,
      why: `${who} stopped coming ${Math.round(away * 12)} months ago, in ${gradeLabel(student.grade)}.`,
      awayYears: away,
    };
  }
  return null;
}

/** The call-back list, best reason first, then longest away. */
export function callBackList(students, today) {
  const out = [];
  for (const student of students || []) {
    const r = reengagement(student, today);
    if (r) out.push({ student, ...r });
  }
  // Best reason first, then the MOST RECENT leaver — they are the ones
  // who still remember the centre, and the call that is most likely to
  // be a conversation rather than a cold introduction.
  return out.sort((a, b) => a.priority - b.priority || a.awayYears - b.awayYears
    || a.student.name.localeCompare(b.student.name));
}

/** Read the whole export, with the counts somebody sees before writing. */
export function readStudentExport(rows, today) {
  const students = [];
  const skipped = { 'no-name': 0 };
  const byStatus = {};
  for (const row of rows || []) {
    const got = readStudentRow(row, today);
    if (got.skip) { skipped[got.skip] = (skipped[got.skip] || 0) + 1; continue; }
    students.push(got.student);
    byStatus[got.student.status || '(blank)'] = (byStatus[got.student.status || '(blank)'] || 0) + 1;
  }
  return {
    students,
    skipped,
    total: (rows || []).length,
    byStatus,
    enrolled: students.filter(s => s.enrolled).length,
    schoolAge: students.filter(s => !s.enrolled && s.grade !== null).length,
    withDob: students.filter(s => s.dob).length,
    callBacks: callBackList(students, today).length,
  };
}

export const studentImportId = (student) => `radius_s_${clean(student.source_radiusId)}`;
