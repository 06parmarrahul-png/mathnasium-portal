import { describe, it, expect } from 'vitest';
import { linkAbout, stripPrefix, looksLikeName, suggestStudents } from './deskLink';

/**
 * Fixtures are real subject lines out of the 1,750. The archive's shape,
 * measured: 15.5% name a student Ratio holds, 32.2% are person-shaped but
 * in no roster it has (parents, almost all of them), 51.1% are not a
 * person at all.
 */
const STUDENTS = [
  'Ranbir Randhawa', 'Ananya Bodupally', 'Noyan Pehlivan', 'Lexie Liu',
  'Samar Rana', 'Aashay Rana', 'Harshad Patel',
];

describe('stripPrefix', () => {
  it('removes the sheet’s own prefixes', () => {
    expect(stripPrefix('Account: Manjeet Kaur')).toBe('Manjeet Kaur');
    expect(stripPrefix('Student: Ranbir R.')).toBe('Ranbir R.');
    expect(stripPrefix('Applicant: Aislin')).toBe('Aislin');
  });

  it('leaves a subject with no prefix alone', () => {
    expect(stripPrefix('Blog Post Reminder')).toBe('Blog Post Reminder');
  });
});

describe('looksLikeName', () => {
  it('knows a person from a topic', () => {
    expect(looksLikeName('Manjeet Kaur')).toBe(true);
    expect(looksLikeName('Ranbir R.')).toBe(true);
    // Same SHAPE as a name — two or three capitalised words — so shape
    // alone cannot separate them. The centre's own vocabulary does.
    expect(looksLikeName('Blog Post Reminder')).toBe(false);
    expect(looksLikeName('WinWin Wednesday')).toBe(false);
    expect(looksLikeName('Claw Machine')).toBe(false);
    expect(looksLikeName('Luke offer letter')).toBe(false);
    expect(looksLikeName('DWPs')).toBe(false);
    // ...and it must not swallow real people.
    expect(looksLikeName('Ravinder Raju')).toBe(true);
    expect(looksLikeName('Aiden Aby Thomas')).toBe(true);
  });
});

describe('linkAbout — linking to a real student', () => {
  it('links an exact name', () => {
    expect(linkAbout('Student: Ranbir Randhawa', '', STUDENTS))
      .toEqual({ about: 'Ranbir Randhawa', linked: true, how: 'exact' });
  });

  it('links the abbreviated form the sheet uses 48 times', () => {
    expect(linkAbout('Student: Ranbir R.', '', STUDENTS))
      .toEqual({ about: 'Ranbir Randhawa', linked: true, how: 'abbreviated' });
  });

  it('links a name embedded in a topic subject', () => {
    // "$15 Starbucks for Ananya B" is a real subject line.
    const out = linkAbout('$15 Starbucks for Ananya Bodupally', '', STUDENTS);
    expect(out.about).toBe('Ananya Bodupally');
    expect(out.linked).toBe(true);
  });

  it('falls back to the body when the subject is a topic', () => {
    const out = linkAbout('DWPs', 'Only had to finalise three. New student: Lexie Liu.', STUDENTS);
    expect(out).toEqual({ about: 'Lexie Liu', linked: true, how: 'in-body' });
  });

  it('links a bare first name only when one student has it', () => {
    expect(linkAbout('Lexie', '', STUDENTS).about).toBe('Lexie Liu');
    expect(linkAbout('Lexie', '', STUDENTS).linked).toBe(true);
  });
});

describe('linkAbout — refusing to guess', () => {
  it('will not choose between two students sharing a surname initial', () => {
    // "Samar R." could be Samar Rana; "Aashay R." could be Aashay Rana —
    // but a shared first name would be the real trap, so check the
    // surname-initial collision directly.
    const out = linkAbout('Student: A. R.', '', STUDENTS);
    expect(out.linked).toBe(false);
  });

  it('will not choose between two students with the same first name', () => {
    const twins = ['Sofia Delacroix', 'Sofia Manlosa'];
    const out = linkAbout('Sofia', '', twins);
    expect(out.linked).toBe(false);
    expect(out.how).toBe('ambiguous');
    // The name is still kept, so the note does not go blank.
    expect(out.about).toBe('Sofia');
  });
});

describe('linkAbout — the parents Ratio does not hold', () => {
  it('KEEPS an unmatched person name rather than dropping it', () => {
    // A third of the archive is this: a parent, on no roster. The note
    // still has to say who it is about, and her name is searchable.
    const out = linkAbout('Account: Manjeet Kaur', 'Card was declined', STUDENTS);
    expect(out.about).toBe('Manjeet Kaur');
    expect(out.linked).toBe(false);
    expect(out.how).toBe('unmatched-name');
  });

  it('does not pretend a topic is a person', () => {
    expect(linkAbout('Blog Post Reminder', 'Create questions for Myro', STUDENTS))
      .toEqual({ about: null, linked: false, how: 'none' });
    expect(linkAbout('DWPs', 'Only had to finalise three.', STUDENTS).about).toBeNull();
  });

  it('copes with an empty subject and no students', () => {
    expect(linkAbout('', '', STUDENTS).about).toBeNull();
    expect(linkAbout('Ranbir Randhawa', '', []).linked).toBe(false);
    expect(linkAbout(null, null, null).about).toBeNull();
  });
});

describe('suggestStudents', () => {
  it('puts names that START with what you typed first', () => {
    // "ran" is inside "Rana" too, so the ordering is the useful part.
    expect(suggestStudents('ran', STUDENTS)[0]).toBe('Ranbir Randhawa');
  });

  it('falls back to a match anywhere in the name', () => {
    expect(suggestStudents('rana', STUDENTS)).toEqual(['Samar Rana', 'Aashay Rana']);
  });

  it('says nothing until there is something to go on', () => {
    expect(suggestStudents('r', STUDENTS)).toEqual([]);
    expect(suggestStudents('', STUDENTS)).toEqual([]);
  });
});
