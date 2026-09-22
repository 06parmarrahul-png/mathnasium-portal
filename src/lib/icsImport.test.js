import { describe, it, expect } from 'vitest';
import {
  unfold, unescapeIcal, parseIcsDate, toCentreLocal, zonedToUtc, parseIcs,
  classify, nameFromSummary, normaliseGrade, extractDetails,
  buildRows, importSummary, SKIP_REASONS,
  inDateRange, eventDateSpan, defaultImportFrom, looksLikeAName,
  labelledFields, looksLikeABooking,
} from './icsImport';

const TZ = 'America/Vancouver';

/**
 * A Google Calendar export, in the three shapes one actually contains: a
 * UTC instant, a wall clock with a TZID, and an all-day event. The
 * assessment carries labelled details the way a booking tool writes them;
 * the second one carries nothing but a title, which is the harder and more
 * common case.
 */
const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VEVENT
UID:evt-assess-1@google.com
DTSTART:20260923T190000Z
DTEND:20260923T200000Z
SUMMARY:Free Math Assessment - Priya Sharma (Grade 5)
DESCRIPTION:Parent: Anita Sharma\\nStudent: Priya Sharma\\nGrade: 5\\nSchool:
  Willoughby Elementary\\nPhone: 604-555-0134\\nEmail: anita.sharma@example.com
LOCATION:Mathnasium Langley
STATUS:CONFIRMED
BEGIN:VALARM
TRIGGER:-PT30M
DESCRIPTION:Reminder
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:evt-assess-2@google.com
DTSTART;TZID=America/Vancouver:20260924T160000
DTEND;TZID=America/Vancouver:20260924T170000
SUMMARY:Assessment — Marcus Lee
END:VEVENT
BEGIN:VEVENT
UID:evt-meeting-1@google.com
DTSTART;TZID=America/Vancouver:20260925T120000
DTEND;TZID=America/Vancouver:20260925T130000
SUMMARY:Management team meeting
END:VEVENT
BEGIN:VEVENT
UID:evt-cancelled@google.com
DTSTART:20260926T180000Z
DTEND:20260926T190000Z
SUMMARY:Assessment - Cancelled Family
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
UID:evt-allday@google.com
DTSTART;VALUE=DATE:20260928
DTEND;VALUE=DATE:20260929
SUMMARY:Pro-D day
END:VEVENT
BEGIN:VEVENT
UID:evt-weekly@google.com
DTSTART;TZID=America/Vancouver:20260930T090000
DTEND;TZID=America/Vancouver:20260930T093000
RRULE:FREQ=WEEKLY;BYDAY=WE
SUMMARY:Morning huddle
END:VEVENT
END:VCALENDAR`;

const parse = () => parseIcs(ICS, { timeZone: TZ });
const byUid = (u) => parse().find(e => e.uid === u);

describe('reading the file', () => {
  it('puts folded lines back together', () => {
    // RFC 5545 strips the single leading space, so the halves join with
    // nothing between them — "one" + "two", not "one two".
    expect(unfold('DESCRIPTION:one\n two\nSUMMARY:x')).toEqual(['DESCRIPTION:onetwo', 'SUMMARY:x']);
  });

  it('un-escapes what iCalendar escaped', () => {
    expect(unescapeIcal('a\\nb\\, c\\; d')).toBe('a\nb, c; d');
  });

  it('finds every event and nothing else', () => {
    expect(parse()).toHaveLength(6);
  });

  it('does not let a reminder steal the event-s description', () => {
    // A VALARM carries its own DESCRIPTION ("Reminder"). Taking it would
    // overwrite the parent and child details this import exists for.
    expect(byUid('evt-assess-1@google.com').description).toMatch(/Parent: Anita Sharma/);
    expect(byUid('evt-assess-1@google.com').description).not.toMatch(/Reminder/);
  });

  it('survives a file with nothing in it', () => {
    expect(parseIcs('')).toEqual([]);
    expect(parseIcs('not a calendar at all')).toEqual([]);
  });
});

describe('a Google time becomes the centre-s own wall clock', () => {
  it('converts a UTC instant, which is the whole point', () => {
    // 19:00Z on 23 Sep is noon in Langley. Storing "19:00" would put a
    // midday assessment at seven in the evening.
    const e = byUid('evt-assess-1@google.com');
    expect(e.date).toBe('2026-09-23');
    expect(e.startTime).toBe('12:00');
    expect(e.endTime).toBe('13:00');
  });

  it('takes a TZID wall clock at its word when the zone matches', () => {
    const e = byUid('evt-assess-2@google.com');
    expect(e.date).toBe('2026-09-24');
    expect(e.startTime).toBe('16:00');
  });

  it('converts a TZID from somewhere else', () => {
    const [e] = parseIcs(
      'BEGIN:VEVENT\nUID:x\nDTSTART;TZID=America/Toronto:20260924T150000\nSUMMARY:Call\nEND:VEVENT',
      { timeZone: TZ },
    );
    expect(e.startTime).toBe('12:00');    // 3pm Toronto is noon here
  });

  it('gets DST right on both sides of the change', () => {
    // Vancouver is UTC-7 in September and UTC-8 in December.
    expect(toCentreLocal(new Date('2026-09-23T19:00:00Z'), TZ).time).toBe('12:00');
    expect(toCentreLocal(new Date('2026-12-23T19:00:00Z'), TZ).time).toBe('11:00');
  });

  it('round-trips a wall clock through UTC and back', () => {
    for (const [d, t] of [['2026-03-08', '02:30'], ['2026-07-01', '15:00'], ['2026-11-20', '09:45']]) {
      const [y, mo, dd] = d.split('-').map(Number);
      const [h, mi] = t.split(':').map(Number);
      const back = toCentreLocal(zonedToUtc(y, mo, dd, h, mi, TZ), TZ);
      expect(back.date).toBe(d);
    }
  });

  it('reads an all-day event as a date with no time', () => {
    const e = byUid('evt-allday@google.com');
    expect(e.allDay).toBe(true);
    expect(e.date).toBe('2026-09-28');
    expect(e.startTime).toBe(null);
  });

  it('gives nothing for a date it cannot read, rather than a plausible one', () => {
    expect(parseIcsDate('later')).toBe(null);
    expect(parseIcsDate('')).toBe(null);
  });

  it('falls back to the centre-s zone for a TZID that does not exist', () => {
    // An unknown zone throws inside Intl; losing the whole file over one
    // bad event would be worse than placing it in the centre's own zone.
    const [e] = parseIcs(
      'BEGIN:VEVENT\nUID:x\nDTSTART;TZID=Mars/Olympus:20260924T160000\nSUMMARY:Call\nEND:VEVENT',
      { timeZone: TZ },
    );
    expect(e.startTime).toBe('16:00');
  });
});

describe('working out what each event is', () => {
  it('knows an assessment by any of the words a centre uses for one', () => {
    for (const s of ['Free Math Assessment', 'Initial consultation', 'Intake — Lee',
      'Skills check', 'New student evaluation']) {
      expect(classify({ summary: s })).toBe('assessment');
    }
  });

  it('tells the rest apart', () => {
    expect(classify({ summary: 'Management team meeting' })).toBe('meeting');
    expect(classify({ summary: 'Interview — A. Nguyen' })).toBe('interview');
    expect(classify({ summary: 'Radius training' })).toBe('training');
    expect(classify({ summary: 'Follow-up with the Chens' })).toBe('call');
  });

  it('falls back to a task rather than guessing assessment', () => {
    // Everything unknown routed to "assessment" would put junk in the
    // intake list and on the booking page.
    expect(classify({ summary: 'Order whiteboard markers' })).toBe('task');
    expect(classify({})).toBe('task');
  });
});

describe('pulling a family out of the prose', () => {
  it('believes labelled lines over anything else', () => {
    const d = extractDetails(byUid('evt-assess-1@google.com'));
    expect(d).toMatchObject({
      guardianName: 'Anita Sharma',
      childName: 'Priya Sharma',
      childGrade: '5',
      childSchool: 'Willoughby Elementary',
      phone: '604-555-0134',
      email: 'anita.sharma@example.com',
    });
  });

  it('falls back to the title for a child-s name', () => {
    const d = extractDetails(byUid('evt-assess-2@google.com'));
    expect(d.childName).toBe('Marcus Lee');
  });

  it('strips the words that describe the appointment, not the person', () => {
    expect(nameFromSummary('Free Math Assessment - Priya Sharma (Grade 5)')).toBe('Priya Sharma');
    expect(nameFromSummary('Assessment — Marcus Lee')).toBe('Marcus Lee');
    expect(nameFromSummary('In-Centre Assessment: Sofia Kovac')).toBe('Sofia Kovac');
    expect(nameFromSummary('Mathnasium Langley Assessment')).toBe('');
  });

  it('NEVER guesses a guardian from the title', () => {
    // The name in a title is the child's far more often than not, and a
    // child's name in the parent field is worse than a blank somebody
    // fills in.
    expect(extractDetails({ summary: 'Assessment - Marcus Lee' }).guardianName).toBe('');
  });

  it('reads a grade however it was written', () => {
    expect(normaliseGrade('5th')).toBe('5');
    expect(normaliseGrade('Grade 7')).toBe('7');
    expect(normaliseGrade('K')).toBe('K');
    expect(normaliseGrade('kindergarten')).toBe('K');
    expect(normaliseGrade('')).toBe('');
    expect(extractDetails({ summary: 'Assessment - Jo (3rd grade)' }).childGrade).toBe('3');
    expect(extractDetails({ summary: 'Assessment', description: 'Gr. 9 student' }).childGrade).toBe('9');
  });

  it('finds an email and a phone wherever they are', () => {
    const d = extractDetails({ summary: 'Assessment', description: 'reach mum on (604) 555-9876 or mum@x.co' });
    expect(d.phone).toBe('(604) 555-9876');
    expect(d.email).toBe('mum@x.co');
  });

  it('leaves a field blank rather than inventing one', () => {
    const d = extractDetails({ summary: 'Assessment', description: '' });
    expect(d.guardianName).toBe('');
    expect(d.childSchool).toBe('');
    expect(d.email).toBe('');
  });
});

describe('the rows someone confirms', () => {
  const rows = () => buildRows(parse());

  it('routes an assessment to the intake list and the rest to the calendar', () => {
    // The distinction with teeth: only centerIntakes occupies a booking
    // slot, so an assessment filed as a calendar entry would let the
    // public page sell the same hour twice.
    const r = rows();
    expect(r.find(x => x.uid === 'evt-assess-1@google.com').target).toBe('intake');
    expect(r.find(x => x.uid === 'evt-assess-2@google.com').target).toBe('intake');
    expect(r.find(x => x.uid === 'evt-meeting-1@google.com').target).toBe('entry');
    expect(r.find(x => x.uid === 'evt-allday@google.com').target).toBe('entry');
  });

  it('keeps a cancelled event in the list, marked, instead of dropping it', () => {
    const r = rows().find(x => x.uid === 'evt-cancelled@google.com');
    expect(r.skip).toBe('cancelled');
    expect(r.include).toBe(false);
    expect(SKIP_REASONS[r.skip]).toBeTruthy();
  });

  it('refuses to half-import a repeating event', () => {
    // Importing the master alone brings in one occurrence and silently
    // loses every later one. Ratio has its own recurrence for this.
    const r = rows().find(x => x.uid === 'evt-weekly@google.com');
    expect(r.skip).toBe('recurring');
  });

  it('skips what is already here, so a second run changes nothing', () => {
    const again = buildRows(parse(), { existingUids: new Set(['evt-assess-1@google.com']) });
    expect(again.find(x => x.uid === 'evt-assess-1@google.com').skip).toBe('duplicate');
    expect(again.find(x => x.uid === 'evt-assess-2@google.com').skip).toBe(null);
  });

  it('catches the same event twice inside one file', () => {
    // The four importable ones repeat as duplicates; the cancelled and
    // the recurring keep their own, more specific reason.
    const twice = buildRows([...parse(), ...parse()]);
    expect(twice.filter(x => x.skip === 'duplicate')).toHaveLength(4);
    expect(importSummary(twice).importing).toBe(4);   // never twice over
  });

  it('gives an event with no end time a sensible one rather than none', () => {
    const [r] = buildRows(parseIcs(
      'BEGIN:VEVENT\nUID:x\nDTSTART;TZID=America/Vancouver:20260924T160000\nSUMMARY:Assessment - Jo\nEND:VEVENT',
      { timeZone: TZ },
    ));
    expect(r.startTime).toBe('16:00');
    expect(r.endTime).toBe('17:00');
  });

  it('counts what the confirm button is about to do', () => {
    const s = importSummary(rows());
    expect(s.total).toBe(6);
    expect(s.assessments).toBe(2);
    expect(s.entries).toBe(2);
    expect(s.importing).toBe(4);
    expect(s.skipped).toEqual({ cancelled: 1, recurring: 1 });
  });

  it('counts an assessment nobody-s name could be read off', () => {
    const s = importSummary(buildRows(parseIcs(
      'BEGIN:VEVENT\nUID:x\nDTSTART:20260924T230000Z\nSUMMARY:Mathnasium Assessment\nEND:VEVENT',
      { timeZone: TZ },
    )));
    expect(s.assessments).toBe(1);
    expect(s.missingNames).toBe(1);
  });

  it('follows what someone unticked in the review table', () => {
    const r = rows().map(x => ({ ...x, include: false }));
    expect(importSummary(r).importing).toBe(0);
  });
});

/**
 * Narrowing a real export down.
 *
 * Langley's first run came back with ~2,110 events, most of them years
 * old. Nobody can check 2,110 rows, and nobody wants a calendar's whole
 * history written into a live centre.
 */
describe('only the part of the file anyone wants', () => {
  const OLD = `BEGIN:VCALENDAR
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
  const evs = () => parseIcs(OLD, { timeZone: TZ });

  it('keeps everything when no range is asked for', () => {
    expect(buildRows(evs())).toHaveLength(4);
  });

  it('drops what is before the start date', () => {
    const r = buildRows(evs(), { from: '2026-08-01' });
    expect(r.map(x => x.uid)).toEqual(['aug', 'sep']);
  });

  it('drops what is after the end date', () => {
    expect(buildRows(evs(), { from: '2026-08-01', to: '2026-08-31' }).map(x => x.uid))
      .toEqual(['aug']);
  });

  it('DROPS out-of-range rows rather than skipping them', () => {
    // A skipped row still renders. 2,110 of those is exactly what made
    // the table unusable, so the range is applied before the rows exist.
    const r = buildRows(evs(), { from: '2026-08-01' });
    expect(r.some(x => x.uid === 'old1')).toBe(false);
    expect(r.every(x => x.skip === null)).toBe(true);
  });

  it('includes an event on the boundary itself', () => {
    expect(buildRows(evs(), { from: '2026-08-12', to: '2026-08-12' }).map(x => x.uid))
      .toEqual(['aug']);
  });

  it('never hides an event whose date could not be read', () => {
    // It has no date to judge, and silently dropping it is how a real
    // appointment disappears without anyone being told.
    expect(inDateRange({ date: null }, { from: '2026-08-01' })).toBe(true);
  });

  it('reports the span the file covers', () => {
    expect(eventDateSpan(evs())).toEqual({ first: '2019-03-04', last: '2026-09-23' });
    expect(eventDateSpan([])).toBe(null);
  });

  it('defaults to the first of last month', () => {
    // Recent history plus everything ahead — last week's assessments are
    // still worth having in the Intakes list.
    expect(defaultImportFrom('2026-09-22')).toBe('2026-08-01');
    expect(defaultImportFrom('2026-01-15')).toBe('2025-12-01');
    expect(defaultImportFrom('garbage')).toBe('');
  });

  it('still counts and dedupes within the range', () => {
    const r = buildRows(evs(), { from: '2026-08-01', existingUids: new Set(['aug']) });
    expect(r.find(x => x.uid === 'aug').skip).toBe('duplicate');
    expect(importSummary(r).importing).toBe(1);
  });
});

describe('a booking state is not a child', () => {
  // Reported from the first live import: every assessment came back
  // titled "Assessment — Booked", because "Booked" was the longest thing
  // left in the summary once the appointment words were stripped.
  it('never reads a status word as somebody-s name', () => {
    for (const s of ['Assessment - Booked', 'Assessment Booked', 'BOOKED - Assessment',
      'Assessment — Confirmed', '[NOT COMING] Appointment', 'Assessment (Cancelled)',
      'Open slot', 'Assessment - TBD']) {
      expect(nameFromSummary(s)).toBe('');
    }
  });

  it('still finds a real name sitting next to a status word', () => {
    expect(nameFromSummary('Assessment - Priya Sharma - Booked')).toBe('Priya Sharma');
    expect(nameFromSummary('[BOOKED] Assessment — Marcus Lee')).toBe('Marcus Lee');
  });

  it('flags the nameless ones instead of importing "Booked" as a child', () => {
    const rows = buildRows(parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:b1\nDTSTART:20260924T230000Z\nSUMMARY:Assessment - Booked\nEND:VEVENT\nEND:VCALENDAR',
      { timeZone: TZ },
    ));
    expect(rows[0].childName).toBe('');
    expect(importSummary(rows).missingNames).toBe(1);
  });
});

describe('a note in a title is not a child', () => {
  // Straight from the live import: 88 events produced these as names.
  it('rejects the sentences the real calendar produced', () => {
    for (const s of ['Book Your Skills Today!', 'might have 2nd student',
      'Assessment - might have 2nd student', 'RESCHEDULED', '[CA] Booked']) {
      expect(nameFromSummary(s)).toBe('');
    }
  });

  it('keeps names up to three words', () => {
    expect(nameFromSummary('Assessment - Alicia Aby Thomas')).toBe('Alicia Aby Thomas');
    expect(nameFromSummary('Assessment - Caleb')).toBe('Caleb');
    expect(nameFromSummary("Assessment - Siobhán O'Brien")).toBe("Siobhán O'Brien");
  });

  it('knows a name from a note', () => {
    expect(looksLikeAName('Priya Sharma')).toBe(true);
    expect(looksLikeAName('Caleb')).toBe(true);
    expect(looksLikeAName('might have 2nd student')).toBe(false);
    expect(looksLikeAName('Book Your Skills Today!')).toBe(false);
    expect(looksLikeAName('Room 3')).toBe(false);
    expect(looksLikeAName('')).toBe(false);
  });

  it('keeps the original text so a blank row can be understood', () => {
    const [r] = buildRows(parseIcs(
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:r1\nDTSTART:20260924T230000Z\nSUMMARY:[CA] Booked\nDESCRIPTION:no details here\nEND:VEVENT\nEND:VCALENDAR',
      { timeZone: TZ },
    ));
    expect(r.childName).toBe('');
    expect(r.rawSummary).toBe('[CA] Booked');
    expect(r.rawDescription).toBe('no details here');
  });
});

/**
 * Langley's REAL format, copied out of the Google Calendar event.
 *
 * Every booking is titled "Appointment Booked:" — which contains no word
 * meaning assessment — and the details are snake_case lines in the body.
 * The first version matched `guardian\s*name\s*:` and an underscore is not
 * whitespace, so it read none of it: 88 assessments arrived with no
 * guardian, no grade, and every child called "Booked".
 */
const REAL_DESC = [
  'Name: ',
  'Phone: 6047167699',
  'Email: moonf83@gmail.com',
  '',
  'Created: Wednesday September 16, 2026 8:22 PM',
  '',
  'Client Timezone: America/Vancouver',
  'Start Time: Saturday September 26, 2026 1:30 PM PDT',
  'Duration: 60.0 minutes',
  'Appointment Type: ',
  '',
  'guardian_name: Francis Moon',
  'child_name: Catherine Moon',
  'child_grade_dropdown: 2',
  'utm_source: google',
  'utm_medium: cpc',
  'utm_campaign: Google_Search_Brand-Core_CA_Natl_Exact_Tinuiti',
  'radid: langleybc',
  'dlmode: postmessage',
].join('\n');

const REAL_ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:real-1@google.com
DTSTART;TZID=America/Vancouver:20260922T163000
DTEND;TZID=America/Vancouver:20260922T173000
SUMMARY:Appointment Booked:
DESCRIPTION:${REAL_DESC.replace(/\n/g, '\\n')}
LOCATION:Mathnasium of Langley
END:VEVENT
END:VCALENDAR`;

describe('the real Langley booking', () => {
  const ev = () => parseIcs(REAL_ICS, { timeZone: TZ })[0];

  it('reads snake_case keys — the bug that broke 88 imports', () => {
    expect(labelledFields(REAL_DESC)).toMatchObject({
      'guardian name': 'Francis Moon',
      'child name': 'Catherine Moon',
      'child grade dropdown': '2',
      phone: '6047167699',
      email: 'moonf83@gmail.com',
    });
  });

  it('pulls the whole family off it', () => {
    expect(extractDetails(ev())).toMatchObject({
      guardianName: 'Francis Moon',
      childName: 'Catherine Moon',
      childGrade: '2',
      phone: '6047167699',
      email: 'moonf83@gmail.com',
    });
  });

  it('knows it is an assessment although the title never says so', () => {
    // "Appointment Booked:" contains no word meaning assessment. The
    // child_name line in the body is the real evidence.
    expect(ev().summary).toBe('Appointment Booked:');
    expect(classify(ev())).toBe('assessment');
    expect(looksLikeABooking(ev())).toBe(true);
    expect(buildRows([ev()])[0].target).toBe('intake');
  });

  it('does not let the empty "Name:" line win over child_name', () => {
    expect(extractDetails(ev()).childName).toBe('Catherine Moon');
  });

  it('IGNORES the Start Time in the body and believes the event', () => {
    // That text says Saturday the 26th at 1:30pm on an event that runs
    // Tuesday the 22nd at 4:30pm. It is a snapshot from booking time and
    // can be stale; DTSTART is what the calendar actually shows.
    const r = buildRows([ev()])[0];
    expect(r.date).toBe('2026-09-22');
    expect(r.startTime).toBe('16:30');
    expect(r.endTime).toBe('17:30');
  });

  it('never mistakes a utm tag or a radid for a person', () => {
    const d = extractDetails(ev());
    expect(JSON.stringify(d)).not.toMatch(/google_search|langleybc|postmessage|cpc/i);
  });

  it('reads a booking with no guardian recorded without inventing one', () => {
    const bare = { summary: 'Appointment Booked:', description: 'child_name: Emma\nPhone: 6040000000' };
    expect(extractDetails(bare)).toMatchObject({ childName: 'Emma', guardianName: '', childGrade: '' });
    expect(classify(bare)).toBe('assessment');
  });

  it('handles the same keys written any other way', () => {
    for (const desc of ['Guardian Name: Francis Moon\nChild Name: Catherine Moon',
      'guardian-name: Francis Moon\nchild-name: Catherine Moon',
      'GUARDIAN_NAME: Francis Moon\nCHILD_NAME: Catherine Moon']) {
      expect(extractDetails({ description: desc })).toMatchObject({
        guardianName: 'Francis Moon', childName: 'Catherine Moon',
      });
    }
  });
});

describe('a family who is not coming', () => {
  // "[NOT COMING] Appointment…" is a real title on Langley's calendar.
  const row = (summary) => buildRows(parseIcs(
    `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:nc1\nDTSTART;TZID=America/Vancouver:20260924T173000\nSUMMARY:${summary}\nDESCRIPTION:child_name: Emma\nEND:VEVENT\nEND:VCALENDAR`,
    { timeZone: TZ },
  ))[0];

  it('comes in cancelled, so the hour goes back on the booking page', () => {
    // Skipping it would lose the record; importing it as scheduled would
    // hold an hour for somebody who already said they are not attending.
    expect(row('[NOT COMING] Appointment Booked:').status).toBe('cancelled');
    expect(row('[NOT COMING] Appointment Booked:').skip).toBe(null);
    expect(row('[NOT COMING] Appointment Booked:').childName).toBe('Emma');
  });

  it('recognises the other ways staff write it', () => {
    for (const s of ['NO SHOW - Appointment Booked:', '[Cancelled] Appointment Booked:',
      'Appointment Booked: no-show']) {
      expect(row(s).status).toBe('cancelled');
    }
  });

  it('leaves an ordinary booking scheduled', () => {
    expect(row('Appointment Booked:').status).toBe('scheduled');
  });
});
