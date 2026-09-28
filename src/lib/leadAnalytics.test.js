import { describe, it, expect } from 'vitest';
import {
  whenOf, gapInDays, timingStats, goneCold, byAge, monthlyTrend,
  centreFunnel, rollUpLeads, asPercent, asDays, CHASE_AFTER_DAYS,
} from './leadAnalytics';

const DAY = 86400000;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const lead = (over = {}) => ({
  id: 'l1', status: 'new', source: 'website', createdAt: ago(10), ...over,
});

describe('reading whatever shape a timestamp arrived in', () => {
  it('takes Firestore, ISO, Date and millis', () => {
    expect(whenOf({ toMillis: () => 5 })).toBe(5);
    expect(whenOf({ seconds: 2 })).toBe(2000);
    expect(whenOf(new Date(7))).toBe(7);
    expect(whenOf(7)).toBe(7);
    expect(whenOf('2026-10-01T00:00:00Z')).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });

  it('is null for nothing, and for nonsense', () => {
    expect(whenOf(null)).toBeNull();
    expect(whenOf('whenever')).toBeNull();
  });

  it('measures a gap, and refuses one that runs backwards', () => {
    expect(gapInDays(ago(10), ago(8))).toBe(2);
    expect(gapInDays(ago(8), ago(10))).toBeNull();   // enrolled before created
    expect(gapInDays(ago(10), null)).toBeNull();
  });
});

describe('how long the funnel takes', () => {
  it('reports the median, and how many leads it could measure', () => {
    const stats = timingStats([
      lead({ createdAt: ago(10), contactedAt: ago(9) }),    // 1 day
      lead({ createdAt: ago(10), contactedAt: ago(7) }),    // 3 days
      lead({ createdAt: ago(10), contactedAt: ago(5) }),    // 5 days
      lead({ createdAt: ago(10) }),                          // never contacted
    ]);
    expect(stats.daysToContact).toBe(3);
    expect(stats.daysToContactFrom).toBe(3);   // not 4 — one had nothing to measure
    expect(stats.total).toBe(4);
  });

  it('prefers the median so one forgotten lead cannot set the tone', () => {
    const stats = timingStats([
      lead({ createdAt: ago(400), contactedAt: ago(1) }),   // 399 days, ignored it
      lead({ createdAt: ago(10), contactedAt: ago(9) }),
      lead({ createdAt: ago(10), contactedAt: ago(9) }),
    ]);
    expect(stats.daysToContact).toBe(1);       // a mean would say 133
  });

  it('says nothing rather than zero when no lead can be measured', () => {
    const stats = timingStats([lead(), lead()]);
    expect(stats.daysToContact).toBeNull();
    expect(stats.daysToContactFrom).toBe(0);
  });

  it('measures time to enrol separately from time to contact', () => {
    const stats = timingStats([lead({ createdAt: ago(30), enrolledAt: ago(10) })]);
    expect(stats.daysToEnrol).toBe(20);
    expect(stats.daysToContact).toBeNull();
  });
});

describe('the leads going cold', () => {
  it('finds new leads nobody has touched', () => {
    const cold = goneCold([
      lead({ id: 'a', createdAt: ago(5) }),
      lead({ id: 'b', createdAt: ago(1) }),                       // still fresh
      lead({ id: 'c', createdAt: ago(9), status: 'contacted' }),  // already worked
    ], NOW);
    expect(cold.map(l => l.id)).toEqual(['a']);
  });

  it('uses the chase threshold on its boundary', () => {
    expect(goneCold([lead({ createdAt: ago(CHASE_AFTER_DAYS) })], NOW)).toHaveLength(1);
    expect(goneCold([lead({ createdAt: ago(CHASE_AFTER_DAYS - 0.5) })], NOW)).toHaveLength(0);
  });

  it('leaves out a lead with no creation date rather than guessing', () => {
    expect(goneCold([lead({ createdAt: null })], NOW)).toHaveLength(0);
  });

  it('names the longest-waiting first', () => {
    const sorted = byAge([
      lead({ id: 'a', createdAt: ago(2) }),
      lead({ id: 'b', createdAt: ago(30) }),
    ], NOW);
    expect(sorted[0].lead.id).toBe('b');
    expect(sorted[0].ageDays).toBe(30);
  });
});

describe('which way it is going', () => {
  it('buckets leads by the month they arrived and the month they enrolled', () => {
    const trend = monthlyTrend([
      lead({ createdAt: '2026-08-14T00:00:00Z' }),
      lead({ createdAt: '2026-09-02T00:00:00Z' }),
      lead({ createdAt: '2026-09-20T00:00:00Z', enrolledAt: '2026-10-01T00:00:00Z' }),
    ], 3, NOW);
    expect(trend.map(t => t.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(trend[0].created).toBe(1);
    expect(trend[1].created).toBe(2);
    expect(trend[2].enrolled).toBe(1);     // counted in the month it was WON
  });

  it('drops anything outside the window rather than piling it on the edge', () => {
    const trend = monthlyTrend([lead({ createdAt: '2020-01-01T00:00:00Z' })], 3, NOW);
    expect(trend.reduce((n, t) => n + t.created, 0)).toBe(0);
  });
});

describe('one centre, then the district', () => {
  const langley = [
    lead({ id: 'a', status: 'enrolled', createdAt: ago(40), enrolledAt: ago(20) }),
    lead({ id: 'b', status: 'lost' }),
    lead({ id: 'c', status: 'new', createdAt: ago(8) }),
  ];
  const burnaby = [lead({ id: 'd', status: 'enrolled' })];

  it('reads one centre', () => {
    const f = centreFunnel('langley', langley, NOW);
    expect(f.total).toBe(3);
    expect(f.counts.enrolled).toBe(1);
    expect(f.conversion).toBe(0.5);        // 1 enrolled of 2 closed
    expect(f.cold).toBe(1);
    expect(f.open).toBe(1);                // the 'new' one
  });

  it('adds the district up and keeps the centres visible inside it', () => {
    const out = rollUpLeads({ langley, burnaby }, NOW);
    expect(out.total).toBe(4);
    expect(out.counts.enrolled).toBe(2);
    expect(out.centres.map(c => c.centreId)).toEqual(['langley', 'burnaby']);  // biggest first
    expect(out.cold).toHaveLength(1);
  });

  it('keeps a centre with no leads as a row, because empty is a finding', () => {
    const out = rollUpLeads({ langley, abbotsford: [] }, NOW);
    expect(out.centres.find(c => c.centreId === 'abbotsford').total).toBe(0);
    expect(out.centres).toHaveLength(2);
  });

  it('survives a district with nothing in it', () => {
    const out = rollUpLeads({}, NOW);
    expect(out.total).toBe(0);
    expect(out.conversion).toBeNull();
    expect(out.centres).toEqual([]);
  });
});

describe('the words on the page', () => {
  it('shows a dash rather than nought per cent when nothing has closed', () => {
    // A centre with five live leads and no decisions has no rate yet.
    expect(asPercent(null)).toBe('—');
    expect(asPercent(0)).toBe('0%');
    expect(asPercent(0.625)).toBe('63%');
  });

  it('reads days the way a person would say them', () => {
    expect(asDays(null)).toBe('—');
    expect(asDays(0.2)).toBe('same day');
    expect(asDays(1)).toBe('1 day');
    expect(asDays(3.42)).toBe('3.4 days');
    expect(asDays(45)).toBe('45 days');
  });
});
