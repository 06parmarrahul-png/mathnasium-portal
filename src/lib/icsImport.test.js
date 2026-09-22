import { describe, it, expect } from 'vitest';
import {
  unfold, unescapeIcal, parseIcsDate, toCentreLocal, zonedToUtc, parseIcs,
  classify, nameFromSummary, normaliseGrade, extractDetails,
  buildRows, importSummary, SKIP_REASONS,
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
