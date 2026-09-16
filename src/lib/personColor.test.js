import { describe, it, expect } from 'vitest';
import {
  personColor, hashOf, PERSON_COLORS, YOU_COLOR, UNKNOWN_COLOR,
} from './personColor';

describe('one stable colour per person', () => {
  it('gives the same person the same colour every time', () => {
    expect(personColor('uid-rahul')).toBe(personColor('uid-rahul'));
    expect(personColor('uid-neeru')).toBe(personColor('uid-neeru'));
  });

  it('always answers with a colour from the palette', () => {
    for (const key of ['a', 'uid-1', 'Sabrina Kaur', 'x'.repeat(40)]) {
      expect(PERSON_COLORS).toContain(personColor(key));
    }
  });

  it('never hands out the red that means “this one is yours”', () => {
    expect(PERSON_COLORS).not.toContain(YOU_COLOR);
    const used = new Set(Array.from({ length: 500 }, (_, i) => personColor(`uid-${i}`)));
    expect(used.has(YOU_COLOR)).toBe(false);
  });

  it('falls back rather than throwing on nothing', () => {
    expect(personColor('')).toBe(UNKNOWN_COLOR);
    expect(personColor(null)).toBe(UNKNOWN_COLOR);
    expect(personColor(undefined)).toBe(UNKNOWN_COLOR);
  });

  it('spreads a small team across different colours', () => {
    // The real desk is about ten people. Some collision is acceptable —
    // the chip carries initials and a name too — but most should differ.
    const team = ['rahul', 'neeru', 'vin', 'sabrina', 'rachel', 'aarav', 'kaitlyn', 'jason'];
    const colours = new Set(team.map(n => personColor(`uid-${n}`)));
    expect(colours.size).toBeGreaterThanOrEqual(6);
  });

  it('does not give two people the same colour just for sharing letters', () => {
    // A hash that adds char codes would collide these.
    expect(personColor('AY')).not.toBe(personColor('YA'));
    expect(hashOf('AY')).not.toBe(hashOf('YA'));
  });
});
