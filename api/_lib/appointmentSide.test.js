import { describe, it, expect } from 'vitest';
import { sideFromTypeName, isYoungHalfHourBlock } from './appointmentSide.js';

/**
 * Reading a side off an appointment TYPE.
 *
 * Only ever reached when the booking name matched no student — a first
 * session, a booking in a parent's name, a spelling the tracker doesn't
 * hold. A known student's own category wins long before this runs, which
 * is why nothing here tries to be clever about people.
 */
describe('the half-hour in-centre block', () => {
  // Live from 1 October 2026. Named like its siblings, so the length is
  // the only thing that tells them apart.
  const THIRTY = 'Langley In-Centre 30 minute math tutoring';
  const SIXTY  = 'Langley In-Centre 60 minute math tutoring';
  const NINETY = 'Langley In-Centre 90 minute math tutoring';

  it('files the 30 minute block as Elementary', () => {
    // It is young students only — Great Foundations to about grade 2 — so
    // for this one type the name is enough. A new kid's first session
    // lands on the right side of the floor instead of in Unknown.
    expect(sideFromTypeName(THIRTY)).toBe('EM');
  });

  it('LEAVES THE 60 AND 90 MINUTE BLOCKS ALONE', () => {
    // Both sides book these, so their names say nothing about the side and
    // guessing would be worse than admitting it. They still go to the
    // student tracker, exactly as before.
    expect(sideFromTypeName(SIXTY)).toBeNull();
    expect(sideFromTypeName(NINETY)).toBeNull();
  });

  it('reads the length however it is written', () => {
    for (const t of [
      'Langley In-Centre 30 minute math tutoring',
      'Langley In-Centre 30 Minute Math Tutoring',
      'Langley In-Centre 30min math tutoring',
      'Langley In-Centre 30 mins math tutoring',
      '30 Minutes Math Tutoring - Langley',
      'Math Tutoring (30 minute) In-Centre',
    ]) {
      expect(sideFromTypeName(t)).toBe('EM');
    }
  });

  it('will not read a 30 minute ASSESSMENT as a young tutoring block', () => {
    // Different thing entirely, and filing it on the Elementary floor
    // would put a stranger's assessment in the middle of the ratio count.
    expect(sideFromTypeName('Langley In-Centre 30 minute assessment')).toBeNull();
    expect(sideFromTypeName('30 minute consultation')).toBeNull();
    expect(isYoungHalfHourBlock('30 minute assessment')).toBe(false);
  });

  it('does not fire on 130 or 300 minutes', () => {
    expect(isYoungHalfHourBlock('130 minute math tutoring')).toBe(false);
    expect(isYoungHalfHourBlock('300 minute math tutoring')).toBe(false);
  });
});

describe('what the name says outright still wins', () => {
  it('a type that says High School is Highschool, 30 minutes or not', () => {
    // The length is an inference; the words are evidence. If a half-hour
    // block is ever opened on the HS side, this is what keeps it there.
    expect(sideFromTypeName('30 minute math tutoring - High School')).toBe('HS');
    expect(sideFromTypeName('HS 30 min tutoring')).toBe('HS');
  });

  it('a type that says Elementary is Elementary', () => {
    expect(sideFromTypeName('Elementary 60 minute math tutoring')).toBe('EM');
  });

  it('online beats everything — they are not on the floor at all', () => {
    expect(sideFromTypeName('Online 30 minute math tutoring')).toBe('Online');
    expect(sideFromTypeName('@home 30 minute math tutoring')).toBe('Online');
    expect(sideFromTypeName('Virtual 60 minute math tutoring')).toBe('Online');
  });

  it('reads a grade when the type carries one', () => {
    expect(sideFromTypeName('Grade 2 math tutoring')).toBe('EM');
    expect(sideFromTypeName('Grade 11 math tutoring')).toBe('HS');
  });
});

describe('when it should say nothing', () => {
  it('returns null rather than guessing', () => {
    expect(sideFromTypeName('Langley In-Centre 60 minute math tutoring')).toBeNull();
    expect(sideFromTypeName('Math Tutoring')).toBeNull();
    expect(sideFromTypeName('')).toBeNull();
    expect(sideFromTypeName(null)).toBeNull();
    expect(sideFromTypeName(undefined)).toBeNull();
  });

  it('survives a type that is not a string', () => {
    expect(() => sideFromTypeName(42)).not.toThrow();
    expect(() => sideFromTypeName({})).not.toThrow();
  });
});
