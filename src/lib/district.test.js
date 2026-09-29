import { describe, it, expect } from 'vitest';
import {
  readVitals, ageInDays, freshnessOf, asOfLabel, rollUp, staffAt,
  millisOf, toFigure, VITAL_KEYS, FRESH_DAYS, STALE_DAYS,
} from './district';

/**
 * The one thing this file exists to stop: a district total that reads as
 * fact when half the centres never answered.
 */

const DAY = 86400000;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (n) => NOW - n * DAY;

const config = (over = {}) => ({
  name: 'Mathnasium of Langley',
  vitals: {
    activeStudents: 120, inactiveStudents: 30, onHoldStudents: 8,
    monthlyRevenue: 48000, updatedAt: daysAgo(3), updatedByName: 'Neeru Gill',
  },
  ...over,
});

describe('reading what a centre typed in', () => {
  it('reads all four figures and who last touched them', () => {
    const v = readVitals(config());
    expect(v.activeStudents).toBe(120);
    expect(v.inactiveStudents).toBe(30);
    expect(v.onHoldStudents).toBe(8);
    expect(v.monthlyRevenue).toBe(48000);
    expect(v.updatedByName).toBe('Neeru Gill');
    expect(v.reported).toBe(true);
  });

  it('gives null, not zero, for a centre that has never answered', () => {
    // The distinction the whole page rests on.
    const v = readVitals({ name: 'New centre' });
    for (const k of VITAL_KEYS) expect(v[k], k).toBeNull();
    expect(v.reported).toBe(false);
  });

  it('keeps a real zero as a real zero', () => {
    const v = readVitals(config({ vitals: { onHoldStudents: 0, updatedAt: daysAgo(1) } }));
    expect(v.onHoldStudents).toBe(0);
    expect(v.reported).toBe(true);
    expect(v.activeStudents).toBeNull();   // that one genuinely wasn't given
  });

  it('picks up the single manual count that predates this page', () => {
    const v = readVitals({ activeStudentCount: 96, studentCountUpdatedAt: daysAgo(5) });
    expect(v.activeStudents).toBe(96);
    expect(v.reported).toBe(true);
    expect(ageInDays(v, NOW)).toBe(5);
  });

  it('ignores the legacy field when nobody ever stamped it', () => {
    // It defaults to 0 on every centre, so an unstamped 0 is not a report.
    const v = readVitals({ activeStudentCount: 0 });
    expect(v.activeStudents).toBeNull();
    expect(v.reported).toBe(false);
  });

  it('refuses junk rather than passing it on as a figure', () => {
    const v = readVitals(config({ vitals: { activeStudents: 'lots', monthlyRevenue: -5 } }));
    expect(v.activeStudents).toBeNull();
    expect(v.monthlyRevenue).toBe(0);      // clamped, not negative
  });
});

describe('how old the number is', () => {
  it('counts whole days', () => {
    expect(ageInDays(readVitals(config()), NOW)).toBe(3);
  });

  it('is null when nobody ever entered anything', () => {
    expect(ageInDays(readVitals({}), NOW)).toBeNull();
  });

  it('grades it the way the page colours it', () => {
    expect(freshnessOf(null)).toBe('never');
    expect(freshnessOf(0)).toBe('fresh');
    expect(freshnessOf(FRESH_DAYS)).toBe('fresh');
    expect(freshnessOf(FRESH_DAYS + 1)).toBe('ageing');
    expect(freshnessOf(STALE_DAYS)).toBe('ageing');
    expect(freshnessOf(STALE_DAYS + 1)).toBe('stale');
  });

  it('says so in words', () => {
    expect(asOfLabel(null)).toBe('never entered');
    expect(asOfLabel(0)).toBe('as of today');
    expect(asOfLabel(1)).toBe('as of yesterday');
    expect(asOfLabel(9)).toBe('as of 9 days ago');
    expect(asOfLabel(60)).toBe('as of 2 months ago');
  });

  it('reads a Firestore timestamp, a Date and millis alike', () => {
    expect(millisOf({ toMillis: () => 42 })).toBe(42);
    expect(millisOf({ seconds: 2 })).toBe(2000);
    expect(millisOf(new Date(1234))).toBe(1234);
    expect(millisOf(1234)).toBe(1234);
    expect(millisOf(null)).toBeNull();
    expect(millisOf('not a date')).toBeNull();
  });
});

describe('adding the district up', () => {
  const row = (centreId, vitals) => ({ centreId, vitals: readVitals(vitals) });

  it('sums the centres that answered', () => {
    const out = rollUp([
      row('langley', config()),
      row('burnaby', config({ vitals: { activeStudents: 80, monthlyRevenue: 31000, updatedAt: daysAgo(2) } })),
    ], NOW);
    expect(out.activeStudents).toBe(200);
    expect(out.monthlyRevenue).toBe(79000);
    expect(out.reporting).toBe(2);
    expect(out.total).toBe(2);
    expect(out.complete).toBe(true);
  });

  it('never counts a silent centre as a zero', () => {
    const out = rollUp([
      row('langley', config()),
      row('abbotsford', {}),            // never entered anything
    ], NOW);
    expect(out.activeStudents).toBe(120);   // not 120 + 0 dressed up as whole
    expect(out.reporting).toBe(2 - 1);
    expect(out.total).toBe(2);
    expect(out.missing).toEqual(['abbotsford']);
    expect(out.complete).toBe(false);
  });

  it('names the centres whose numbers have gone stale', () => {
    const out = rollUp([
      row('langley', config()),
      row('surrey', config({ vitals: { activeStudents: 60, updatedAt: daysAgo(90) } })),
    ], NOW);
    expect(out.stale).toEqual(['surrey']);
    expect(out.reporting).toBe(2);
    // Still counted — stale is a warning, not a reason to drop a centre.
    expect(out.activeStudents).toBe(180);
  });

  it('gives null rather than zero for a figure nobody anywhere reported', () => {
    const out = rollUp([row('langley', { vitals: { activeStudents: 10, updatedAt: daysAgo(1) } })], NOW);
    expect(out.activeStudents).toBe(10);
    expect(out.monthlyRevenue).toBeNull();
  });

  it('is honest about an empty district', () => {
    const out = rollUp([], NOW);
    expect(out.total).toBe(0);
    expect(out.reporting).toBe(0);
    expect(out.complete).toBe(false);
    expect(out.activeStudents).toBeNull();
  });
});

describe('who works there', () => {
  const user = (over = {}) => ({
    uid: 'u1', centerIds: ['langley'], approved: true, instructorType: 'Instructor', ...over,
  });

  it('counts the approved staff at one centre, by role', () => {
    const out = staffAt([
      user(),
      user({ uid: 'u2', instructorType: 'Lead' }),
      user({ uid: 'u3', instructorType: 'Instructor' }),
      user({ uid: 'u4', centerIds: ['burnaby'] }),
    ], 'langley');
    expect(out.count).toBe(3);
    expect(out.byRole).toEqual({ Instructor: 2, Lead: 1 });
  });

  it('leaves out anyone unapproved or gone', () => {
    const out = staffAt([
      user(),
      user({ uid: 'u2', approved: false }),
      user({ uid: 'u3', status: 'terminated' }),
    ], 'langley');
    expect(out.count).toBe(1);
  });

  it('counts somebody who works at two centres at both', () => {
    const both = [user({ centerIds: ['langley', 'burnaby'] })];
    expect(staffAt(both, 'langley').count).toBe(1);
    expect(staffAt(both, 'burnaby').count).toBe(1);
  });
});

describe('what a typed box becomes, and survives a round trip', () => {
  it('keeps an empty box apart from a typed nought', () => {
    expect(toFigure('')).toBeNull();
    expect(toFigure(null)).toBeNull();
    expect(toFigure(undefined)).toBeNull();
    expect(toFigure('0')).toBe(0);
    expect(toFigure(0)).toBe(0);
  });

  it('reads back exactly what was saved, blanks included', () => {
    // The contract the page rests on, checked end to end rather than on
    // either half: save what the boxes held, read it, get the same answer.
    const typed = { activeStudents: '120', inactiveStudents: '', onHoldStudents: '0', monthlyRevenue: '48000' };
    const saved = {
      activeStudents:   toFigure(typed.activeStudents),
      inactiveStudents: toFigure(typed.inactiveStudents),
      onHoldStudents:   toFigure(typed.onHoldStudents),
      monthlyRevenue:   toFigure(typed.monthlyRevenue),
      updatedAt: NOW,
    };
    const back = readVitals({ vitals: saved });
    expect(back.activeStudents).toBe(120);
    expect(back.inactiveStudents).toBeNull();   // left blank, stays blank
    expect(back.onHoldStudents).toBe(0);        // typed zero, stays zero
    expect(back.monthlyRevenue).toBe(48000);
    expect(back.reported).toBe(true);
  });

  it('refuses junk and never goes negative', () => {
    expect(toFigure('abc')).toBeNull();
    expect(toFigure(-12)).toBe(0);
    expect(toFigure('12.6')).toBe(13);
  });
});

describe('a district manager is not staff anywhere', () => {
  // They carry every centre in the district on centerIds, which is how
  // the district is defined — so without this they would appear as a
  // member of staff at each one, on the page they are reading.
  const michelle = {
    uid: 'michelle', role: 'district_manager', approved: true,
    centerIds: ['langley', 'burnaby', 'abbotsford'],
  };
  const instructor = (uid, centreId) => ({
    uid, role: 'instructor', approved: true, centerIds: [centreId],
    instructorType: 'Instructor',
  });

  it('is left out of every centre he oversees', () => {
    for (const centre of michelle.centerIds) {
      const out = staffAt([michelle, instructor('a', centre)], centre);
      expect(out.count, centre).toBe(1);
      expect(out.byRole.district_manager).toBeUndefined();
    }
  });

  it('does not change the count for everyone else', () => {
    const out = staffAt([instructor('a', 'langley'), instructor('b', 'langley')], 'langley');
    expect(out.count).toBe(2);
  });

  it('leaves the platform operator out too, as it always did', () => {
    const enterprise = { uid: 'e', role: 'super_admin', approved: true, centerIds: ['langley'] };
    expect(staffAt([enterprise, instructor('a', 'langley')], 'langley').count).toBe(1);
  });
});
