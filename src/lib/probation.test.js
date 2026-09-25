import { describe, it, expect } from 'vitest';
import {
  asDay, startDateOf, daysBetween, probationState, paidSickDates,
  PROBATION_DAYS, SICK_DAYS_PER_YEAR,
} from './probation';

describe('reading a start date in whatever shape it was stored', () => {
  it('a plain day', () => {
    expect(asDay('2026-07-01')).toBe('2026-07-01');
  });

  it('AN ISO STRING — which is how every user document actually stores createdAt', () => {
    // This is the whole bug. Both readers required `.toDate`, a Firestore
    // Timestamp method, and a string has not got one — so the fallback
    // never ran and the start date came back null for everybody.
    expect(asDay('2026-07-01T18:22:04.113Z')).toBe('2026-07-01');
  });

  it('a Firestore Timestamp', () => {
    expect(asDay({ toDate: () => new Date('2026-07-01T12:00:00Z') })).toBe('2026-07-01');
  });

  it('the {seconds} shape Firestore hands back over REST', () => {
    expect(asDay({ seconds: Math.floor(Date.parse('2026-07-01T12:00:00Z') / 1000) }))
      .toBe('2026-07-01');
  });

  it('a Date', () => {
    expect(asDay(new Date('2026-07-01T12:00:00Z'))).toBe('2026-07-01');
  });

  it('NEVER GUESSES when there is nothing usable', () => {
    for (const junk of [null, undefined, '', 'soon', 42, {}, { toDate: () => { throw new Error('x'); } }, new Date('nope')]) {
      expect(asDay(junk)).toBeNull();
    }
  });
});

describe('whose date do we actually know', () => {
  it('a typed hire date is the real answer', () => {
    const s = startDateOf({ hireDate: '2026-01-15', createdAt: '2026-07-01T00:00:00Z' });
    expect(s).toEqual({ date: '2026-01-15', assumed: false, known: true });
  });

  it('falls back to when the account was made, and SAYS it is a stand-in', () => {
    // Right for somebody added to Ratio when they started, late for
    // anyone whose account was made long after they were hired. The Sick
    // Days tab highlights these so a real date gets filled in.
    const s = startDateOf({ createdAt: '2026-07-01T00:00:00Z' });
    expect(s.date).toBe('2026-07-01');
    expect(s.assumed).toBe(true);
    expect(s.known).toBe(false);
  });

  it('knows nothing when there is nothing', () => {
    expect(startDateOf({})).toEqual({ date: null, assumed: false, known: false });
    expect(startDateOf(undefined).date).toBeNull();
  });
});

describe('counting the days', () => {
  it('counts them', () => {
    expect(daysBetween('2026-07-01', '2026-09-29')).toBe(90);
    expect(daysBetween('2026-07-01', '2026-07-01')).toBe(0);
  });

  it('returns null rather than a number it cannot stand behind', () => {
    expect(daysBetween(null, '2026-07-01')).toBeNull();
    expect(daysBetween('2026-07-01', null)).toBeNull();
    expect(daysBetween('nope', '2026-07-01')).toBeNull();
  });
});

describe('who is on probation', () => {
  const asOf = '2026-09-25';

  it('day 89 is still probation, day 90 is not', () => {
    const d89 = { hireDate: '2026-06-29' };   // 88 days before 2026-09-25
    expect(probationState({ hireDate: '2026-06-27' }, asOf).daysIn).toBe(90);
    expect(probationState({ hireDate: '2026-06-27' }, asOf).onProbation).toBe(false);
    expect(probationState({ hireDate: '2026-06-28' }, asOf).daysIn).toBe(89);
    expect(probationState({ hireDate: '2026-06-28' }, asOf).onProbation).toBe(true);
    expect(probationState(d89, asOf).onProbation).toBe(true);
  });

  it('NO START DATE MEANS ON PROBATION', () => {
    // Payroll used to say the opposite and pay the day, while the Sick
    // Days tab showed the same person as probationary. Money that has
    // already left is the worse of the two wrong answers.
    const s = probationState({}, asOf);
    expect(s.onProbation).toBe(true);
    expect(s.known).toBe(false);
    expect(s.startDate).toBeNull();
  });

  it('uses the account date when that is all there is', () => {
    const s = probationState({ createdAt: '2026-09-01T09:00:00Z' }, asOf);
    expect(s.onProbation).toBe(true);
    expect(s.assumed).toBe(true);
    expect(s.daysIn).toBe(24);
  });

  it('a long-serving person with a real hire date is eligible', () => {
    expect(probationState({ hireDate: '2024-02-01' }, asOf).onProbation).toBe(false);
  });

  it('the policy is the BC ESA minimum', () => {
    expect(PROBATION_DAYS).toBe(90);
    expect(SICK_DAYS_PER_YEAR).toBe(5);
  });
});

describe('which sick days get paid', () => {
  const veteran = { hireDate: '2024-01-01' };

  it('pays the first five of the year and no more', () => {
    const dates = ['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05'];
    const paid = paidSickDates(dates, veteran);
    expect(paid.size).toBe(5);
    expect(paid.has('2026-06-05')).toBe(false);
  });

  it('spends them in date order, not the order they arrive', () => {
    const paid = paidSickDates(['2026-06-05', '2026-01-05'], veteran);
    expect([...paid].sort()).toEqual(['2026-01-05', '2026-06-05']);
  });

  it('DOES NOT PAY A DAY TAKEN ON PROBATION', () => {
    // Started 1 Sep, off sick on the 25th: 24 days in, not payable.
    const newStarter = { hireDate: '2026-09-01' };
    expect(paidSickDates(['2026-09-25'], newStarter).size).toBe(0);
  });

  it('pays the day once they are through probation, in the same year', () => {
    const newStarter = { hireDate: '2026-09-01' };
    const paid = paidSickDates(['2026-09-25', '2026-12-20'], newStarter);
    expect(paid.has('2026-09-25')).toBe(false);
    expect(paid.has('2026-12-20')).toBe(true);
  });

  it('AND A PROBATIONARY DAY DOES NOT SPEND THE ENTITLEMENT', () => {
    // It was never payable, so it cannot use one of the five up.
    const newStarter = { hireDate: '2026-09-01' };
    const dates = ['2026-09-10', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06'];
    const paid = paidSickDates(dates, newStarter);
    expect(paid.has('2026-09-10')).toBe(false);
    expect(paid.size).toBe(5);
  });

  it('pays nothing at all when nobody knows when they started', () => {
    expect(paidSickDates(['2026-09-25'], {}).size).toBe(0);
  });

  it('survives junk in the date list', () => {
    expect(() => paidSickDates([null, '', '2026-03-05'], veteran)).not.toThrow();
    expect(paidSickDates([null, '', '2026-03-05'], veteran).size).toBe(1);
    expect(paidSickDates(undefined, veteran).size).toBe(0);
  });
});
