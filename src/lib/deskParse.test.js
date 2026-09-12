import { describe, it, expect } from 'vitest';
import {
  parseNote, initialsOf, nearestStudent, canSend, addressLabel, firstNameOf,
} from './deskParse';

/**
 * The grammar under test is the centre's own, measured against 1,750 real
 * notes: initials mean a colleague, a full name means a family. The cases
 * that matter most are the ones where a wrong read would be silent — a
 * volunteer credited with a director's notes, or a sentence mistaken for
 * an address.
 */

// Desk members only. Mateo is deliberately ABSENT: he is a volunteer, and
// a student, and his initials are MY.
const STAFF = [
  { uid: 'u-andy',    displayName: 'Andy. Y' },          // AY
  { uid: 'u-neeru',   displayName: 'Neeru Gill' },       // NG
  { uid: 'u-vin',     displayName: 'Vin B' },            // VB
  { uid: 'u-rahul',   displayName: 'Rahul Parmar' },     // RP
  { uid: 'u-rachel',  displayName: 'Rachel Rozelle' },   // RR
  { uid: 'u-sabrina', displayName: 'Sabrina Kedzior' },  // SK
];
const STUDENTS = ['Lexie Liu', 'Theo Marchetti', 'Priya Okonkwo', 'Wren Kowalski', 'Mateo Yngreso'];
const P = (t) => parseNote(t, { staff: STAFF, students: STUDENTS });

describe('initialsOf', () => {
  it('takes first and last', () => {
    expect(initialsOf('Rahul Parmar')).toBe('RP');
    expect(initialsOf('Neeru Gill')).toBe('NG');
    expect(initialsOf('Vin B')).toBe('VB');
  });

  it('skips a bracketed preferred name', () => {
    expect(initialsOf('Jieun (Joanne) Lee')).toBe('JL');
    expect(initialsOf('Darshveer (Diya) Brar')).toBe('DB');
  });

  it('copes with one name, and with none', () => {
    expect(initialsOf('Rahul')).toBe('R');
    expect(initialsOf('')).toBe('');
    expect(initialsOf(null)).toBe('');
  });

  it('firstNameOf handles a trailing full stop', () => {
    expect(firstNameOf('Andy. Y')).toBe('Andy');
  });
});

describe('who it is for', () => {
  it('reads a single code with a comma, the way you would text it', () => {
    const p = P('NG, can you please complete a care call for Lexie Liu');
    expect(p.toUids).toEqual(['u-neeru']);
    expect(p.body).toBe('can you please complete a care call for Lexie Liu');
  });

  it('reads two people the way the sheet writes it', () => {
    expect(P('VB/NG Priya Okonkwo — card declined').toUids)
      .toEqual(['u-vin', 'u-neeru']);
    expect(P('RR, SK please check this').toUids)
      .toEqual(['u-rachel', 'u-sabrina']);
  });

  it('reads an @name', () => {
    expect(P('@Neeru can you look at this').toUids).toEqual(['u-neeru']);
  });

  it('strips a greeting before the address', () => {
    // 172 notes open with "Hi".
    expect(P('Hi NG, can you call the family').toUids).toEqual(['u-neeru']);
  });

  it('never lists the same person twice', () => {
    expect(P('NG/NG please look').toUids).toEqual(['u-neeru']);
  });
});

describe('addressed to everyone', () => {
  it('reads every form the centre uses', () => {
    // 82 notes are addressed to ALL.
    for (const t of [
      'Everyone can you please remind staff of our meeting?',
      'ALL — fun day this Saturday, wear red',
      'All, please check your DWPs before Friday',
      'Team, staff meeting moved to 6:30',
      'all: fun day Saturday',
    ]) {
      expect(P(t).toAll, t).toBe(true);
    }
  });

  it('does NOT mistake a sentence beginning "All the…" for an address', () => {
    // The whole reason lower-case "all" needs punctuation.
    const p = P('All the gift cards arrived today');
    expect(p.toAll).toBe(false);
    expect(canSend(p)).toBe(false);
  });

  it('still reads "Everyone" as an address when it is the subject', () => {
    // "Everyone needs to check their DWPs" IS for everyone, so reading it
    // that way is right either way.
    expect(P('Everyone needs to check their DWPs').toAll).toBe(true);
  });
});

describe('a code with no Ratio account', () => {
  it('keeps the code rather than dropping the note', () => {
    const p = P('MY, new AFU family enrolled — Wren Kowalski');
    expect(p.unknownCodes).toEqual(['MY']);
    expect(p.toUids).toEqual([]);
    expect(canSend(p)).toBe(true);
    expect(addressLabel(p)).toBe('MY');
  });

  it('NEVER resolves MY to the volunteer who shares those initials', () => {
    // Mateo Yngreso is a volunteer AND a student. Built from all 53 staff
    // he would have been credited with the busiest code in the whole
    // spreadsheet. The staff roster passed in is desk members only.
    const p = P('MY please look at this');
    expect(p.toNames).toEqual([]);
    expect(p.unknownCodes).toEqual(['MY']);
  });

  it('resolves it the moment that person has an account', () => {
    // Nothing to configure — initials are derived from the display name.
    const withMyro = parseNote('MY please look at this', {
      staff: [...STAFF, { uid: 'u-myro', displayName: 'Myro Yngreso' }],
      students: STUDENTS,
    });
    expect(withMyro.toUids).toEqual(['u-myro']);
    expect(withMyro.unknownCodes).toEqual([]);
  });

  it('handles one known and one unknown together', () => {
    const p = P('NG/MY can you both look');
    expect(p.toUids).toEqual(['u-neeru']);
    expect(p.unknownCodes).toEqual(['MY']);
  });
});

describe('who it is about', () => {
  it('finds a student and leaves the sentence intact', () => {
    const p = P('NG, can you please complete a care call for Lexie Liu');
    expect(p.about).toBe('Lexie Liu');
    // Lifting the name out left "a care call for" — worse than not tidying.
    expect(p.body).toContain('for Lexie Liu');
  });

  it('matches a student who is also a volunteer, as a STUDENT', () => {
    // The other side of the same overlap: on "about", the student roster
    // is the right one to read.
    const p = P('NG, Mateo Yngreso missed his session');
    expect(p.about).toBe('Mateo Yngreso');
    expect(p.toUids).toEqual(['u-neeru']);
  });

  it('marks it as family when a parent is being discussed', () => {
    // 225 notes say "mom", 139 "parent".
    const p = P('VB Priya Okonkwo — mom is coming in with cash Friday');
    expect(p.about).toBe('Priya Okonkwo');
    expect(p.family).toBe(true);
  });

  it('is not family when only the child is discussed', () => {
    expect(P('NG Lexie Liu missed her session').family).toBe(false);
  });

  it('offers a correction rather than silently applying one', () => {
    const p = P('SK Lexi Lu needs a progress check');
    expect(p.about).toBeNull();
    expect(p.nearMiss).toEqual({ typed: 'Lexi Lu', suggestion: 'Lexie Liu' });
  });

  it('says nothing when a name is nowhere near the roster', () => {
    expect(P('NG Zebediah Quatermain called').nearMiss).toBeNull();
  });

  it('prefers the longer match', () => {
    expect(parseNote('NG about Lexie Liu', {
      staff: STAFF, students: ['Lexie', 'Lexie Liu'],
    }).about).toBe('Lexie Liu');
  });
});

describe('labels, read from the centre’s own words', () => {
  it('files a DWP as a workout plan, not an assessment', () => {
    // Vin's correction. 54 notes were in the wrong drawer.
    const p = P('SK Theo Marchetti needs his DWPs finalised before his online session');
    expect(p.topic).toBe('Workout plan');
    expect(p.labels).toContain('Workout plan · digital');
    expect(p.labels).toContain('Online');
  });

  it('files an ECT with applicants, which it had no category for at all', () => {
    const p = P('RP Sayan cannot make his ECT tomorrow');
    expect(p.topic).toBe('Applicant');
    expect(p.labels).toContain('Competency test');
  });

  it('reads AFU as autism funding', () => {
    const p = P('NG new AFU family enrolled, account set up on Radius');
    expect(p.topic).toBe('Funding');
    expect(p.labels).toEqual(expect.arrayContaining(['Autism funding', 'Radius']));
  });

  it('reads the paper workout plan too', () => {
    expect(P('VB please note it on her paper WOP').labels)
      .toContain('Workout plan · paper');
  });

  it('reads GC as a gift card, which is how the centre writes it', () => {
    expect(P('RR Theo Marchetti — $15 Roblox GC, prepaid').topic).toBe('Gift card');
  });

  it('files a declined card as billing', () => {
    expect(P('VB Priya Okonkwo card was declined this month').topic).toBe('Billing');
  });
});

describe('canSend', () => {
  const ok = P('NG, please call the family');
  it('needs an address and a body', () => {
    expect(canSend(ok)).toBe(true);
    expect(canSend(P('NG,'))).toBe(false);          // nothing said
    expect(canSend(P('please call the family'))).toBe(false);  // nobody named
    expect(canSend(null)).toBe(false);
  });
});

describe('addressLabel', () => {
  it('names one, several, everyone, and an unknown code', () => {
    expect(addressLabel(P('NG please look'))).toBe('Neeru');
    expect(addressLabel(P('VB/NG please look'))).toBe('Vin & Neeru');
    expect(addressLabel(P('Everyone please look'))).toBe('Everyone');
    expect(addressLabel(P('MY please look'))).toBe('MY');
  });
});

describe('nearestStudent', () => {
  it('refuses to guess from something too short', () => {
    expect(nearestStudent('Al B', STUDENTS)).toBeNull();
  });

  it('refuses a name that is nothing like any student', () => {
    expect(nearestStudent('Quentin Blackwood', STUDENTS)).toBeNull();
  });
});
