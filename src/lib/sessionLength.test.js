import { describe, it, expect } from 'vitest';
import { shortSessionLabel, sessionEndMinutes, STANDARD_MINUTES } from './sessionLength';

describe('marking a session that ends early', () => {
  it('marks the half-hour block', () => {
    // The whole reason this exists: from 1 Oct a Great Foundations student
    // sits in the same on-the-hour column as everybody else and gets up
    // thirty minutes sooner.
    expect(shortSessionLabel(30)).toBe('30 min');
  });

  it('SAYS NOTHING ABOUT AN ORDINARY HOUR', () => {
    // Every student on the sheet is one. A badge on all of them is a badge
    // on none of them.
    expect(shortSessionLabel(60)).toBeNull();
    expect(shortSessionLabel(STANDARD_MINUTES)).toBeNull();
  });

  it('says nothing about a LONGER session either', () => {
    // Deliberate asymmetry: the Highschool side already pulls anything
    // that isn't an hour into its own 1.5 hr column, so the column heading
    // says it. A chip repeating that is clutter on a printed sheet. A
    // shorter session has nowhere else to go, which is why it needs this.
    expect(shortSessionLabel(90)).toBeNull();
    expect(shortSessionLabel(120)).toBeNull();
  });

  it('marks any other short length, should one ever appear', () => {
    expect(shortSessionLabel(45)).toBe('45 min');
    expect(shortSessionLabel(15)).toBe('15 min');
  });

  it('stays quiet rather than inventing a badge from nothing', () => {
    for (const bad of [undefined, null, 0, -30, NaN, '', 'abc', {}]) {
      expect(shortSessionLabel(bad)).toBeNull();
    }
  });

  it('reads a numeric string, because that is what a feed sends', () => {
    expect(shortSessionLabel('30')).toBe('30 min');
  });
});

describe('when they actually get up', () => {
  it('adds the length to the slot', () => {
    expect(sessionEndMinutes('15:00', 30)).toBe(15 * 60 + 30);
    expect(sessionEndMinutes('16:00', 30)).toBe(16 * 60 + 30);
  });

  it('works on the Saturday hours too', () => {
    expect(sessionEndMinutes('10:00', 30)).toBe(10 * 60 + 30);
    expect(sessionEndMinutes('12:00', 30)).toBe(12 * 60 + 30);
    expect(sessionEndMinutes('13:00', 30)).toBe(13 * 60 + 30);
  });

  it('crosses the hour', () => {
    expect(sessionEndMinutes('15:30', 30)).toBe(16 * 60);
    expect(sessionEndMinutes('11:30', 30)).toBe(12 * 60);
  });

  it('WORKS OFF THE SLOT KEY, so there is no timezone to get wrong', () => {
    // The key is already centre-local. Deriving this from the booking's
    // UTC timestamp is the trap that makes a 3:00 session read as 8:00.
    expect(sessionEndMinutes('15:00', 60)).toBe(16 * 60);
  });

  it('RETURNS MINUTES, not a clock face', () => {
    // Which face the reader sees is their own setting, and only the
    // component knows it — see the scan test that stops a thirteenth
    // hand-rolled AM/PM appearing.
    expect(typeof sessionEndMinutes('15:00', 30)).toBe('number');
  });

  it('returns nothing rather than a wrong time', () => {
    expect(sessionEndMinutes('', 30)).toBeNull();
    expect(sessionEndMinutes('15:00', undefined)).toBeNull();
    expect(sessionEndMinutes('not a slot', 30)).toBeNull();
    expect(sessionEndMinutes(null, null)).toBeNull();
  });
});
