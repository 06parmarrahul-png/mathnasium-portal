import { describe, it, expect } from 'vitest';
import {
  evaluate, checkGuess, markGuess, keyboardMarks, dailyEquation, LENGTH,
} from './mathle';

describe('working out what an expression comes to', () => {
  it('does times and divide before plus and minus', () => {
    expect(evaluate('2+3*4')).toBe(14);
    expect(evaluate('12/4+1')).toBe(4);
    expect(evaluate('9-2*3')).toBe(3);
  });

  it('reads a plain number', () => {
    expect(evaluate('46')).toBe(46);
  });

  it('refuses what isn’t an expression, rather than guessing', () => {
    expect(evaluate('12+')).toBeNull();
    expect(evaluate('+12')).toBeNull();
    expect(evaluate('12++3')).toBeNull();
    expect(evaluate('12+*3')).toBeNull();
    expect(evaluate('')).toBeNull();
    expect(evaluate('1/0')).toBeNull();
  });

  it('never runs the player’s text as code', () => {
    // A string that would be valid JavaScript but is not arithmetic.
    expect(evaluate('alert(1)')).toBeNull();
    expect(evaluate('1;2')).toBeNull();
  });
});

describe('a guess has to be a true equation', () => {
  it('accepts one that is', () => {
    expect(checkGuess('12+34=46')).toBeNull();
    expect(checkGuess('72-35=37')).toBeNull();
    expect(checkGuess('9*7-18=45')).not.toBeNull();   // nine characters
  });

  it('says what is wrong, in words a player can act on', () => {
    expect(checkGuess('12+34')).toMatch(/Eight characters/);
    expect(checkGuess('12+34=99')).toMatch(/isn't/);
    expect(checkGuess('123456789')).toMatch(/Eight characters/);
    expect(checkGuess('1234=abc')).toMatch(/Digits and/);
    expect(checkGuess('12345678')).toMatch(/equals sign/);
    expect(checkGuess('1+2=3=6x')).toMatch(/Digits and/);
  });

  it('refuses two equals signs', () => {
    expect(checkGuess('1+1=2=2')).toMatch(/Eight characters|equals sign/);
  });
});

describe('marking a guess', () => {
  it('greens the right character in the right place', () => {
    expect(markGuess('12+34=46', '12+34=46')).toEqual(new Array(LENGTH).fill('exact'));
  });

  it('ambers a character that is in the answer elsewhere', () => {
    const marks = markGuess('21+34=46', '12+34=46');
    expect(marks[0]).toBe('present');
    expect(marks[1]).toBe('present');
    expect(marks[2]).toBe('exact');
  });

  it('does not amber more copies than the answer holds', () => {
    // The answer has one 1; the guess opens with two.
    const marks = markGuess('11+35=46', '12+34=46');
    expect(marks[0]).toBe('exact');
    expect(marks[1]).toBe('absent');
  });

  it('greys what is not there at all', () => {
    // markGuess does no validation — that is checkGuess's job — so this
    // can use a string with nothing in common with the answer at all.
    expect(markGuess('99999999', '12+34=46').every(m => m === 'absent')).toBe(true);
  });

  it('greens an equals sign that lines up, because it does line up', () => {
    const marks = markGuess('99*99=99', '12+34=46');
    expect(marks[5]).toBe('exact');
  });
});

describe('the keyboard remembers', () => {
  it('keeps the best mark a key has earned', () => {
    const marks = keyboardMarks([
      { guess: '21+34=46', answer: '12+34=46' },   // 1 and 2 present
      { guess: '12+34=46', answer: '12+34=46' },   // then exact
    ]);
    expect(marks['1']).toBe('exact');
    expect(marks['2']).toBe('exact');
    expect(marks['9']).toBeUndefined();
  });
});

describe('the day’s equation', () => {
  it('is the same for everyone at the centre, all day', () => {
    expect(dailyEquation('langley|2026-09-20')).toBe(dailyEquation('langley|2026-09-20'));
  });

  it('differs by day and by centre', () => {
    const today = dailyEquation('langley|2026-09-20');
    expect(dailyEquation('langley|2026-09-21')).not.toBe(today);
    expect(dailyEquation('burnaby|2026-09-20')).not.toBe(today);
  });

  it('is always eight characters and always true', () => {
    // Every day for four years — the generator must not ever hand out a
    // puzzle that its own rules would reject.
    for (let i = 0; i < 1500; i += 1) {
      const eq = dailyEquation(`langley|seed-${i}`);
      expect(eq).toHaveLength(LENGTH);
      expect(checkGuess(eq)).toBeNull();
    }
  });

  it('never needs a negative number or a fraction to be true', () => {
    for (let i = 0; i < 400; i += 1) {
      const eq = dailyEquation(`langley|seed-${i}`);
      expect(eq).not.toContain('-0');
      const [left, right] = eq.split('=');
      expect(Number.isInteger(evaluate(left))).toBe(true);
      expect(evaluate(right)).toBeGreaterThanOrEqual(0);
    }
  });
});
