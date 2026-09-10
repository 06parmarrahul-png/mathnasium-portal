import { describe, it, expect } from 'vitest';
import {
  eventTypeLabel, asDate, toISO, isUsableEvent, minutesOf,
  eventsBetween, weekAhead, monthAhead, monthWindow, weekWindow, validateEvent,
} from './centreEvents';

const ev = (over = {}) => ({
  id: 'e1', title: 'Staff meeting', date: '2026-09-17',
  startTime: '18:30', endTime: '19:30', type: 'meeting', note: '', ...over,
});
const shift = (over = {}) => ({
  id: 's1', date: '2026-09-15', startTime: '15:00', endTime: '19:00',
  status: 'published', subRole: 'Elementary', ...over,
});

describe('dates never slip a day', () => {
  it('parses at local noon, not UTC midnight', () => {
    // `new Date('2026-09-17')` is 5pm on the 16th in Vancouver. This must not.
    expect(asDate('2026-09-17').getDate()).toBe(17);
    expect(toISO(asDate('2026-09-17'))).toBe('2026-09-17');
  });
  it('refuses a date it cannot read', () => {
    for (const bad of ['', null, 'next Tuesday', '2026-13-40x']) {
      expect(asDate(bad)).toBeNull();
    }
  });
});

describe('isUsableEvent', () => {
  it('needs a name and a real date', () => {
    expect(isUsableEvent(ev())).toBe(true);
    expect(isUsableEvent(ev({ title: '   ' }))).toBe(false);
    expect(isUsableEvent(ev({ date: 'soon' }))).toBe(false);
    expect(isUsableEvent(null)).toBe(false);
  });
});

describe('minutesOf', () => {
  it('reads a 24-hour time', () => {
    expect(minutesOf('18:30')).toBe(1110);
    expect(minutesOf('09:00')).toBe(540);
  });
  it('is null for anything else, including an absent time', () => {
    for (const bad of ['', null, 'evening', '25:00', '10:99']) {
      expect(minutesOf(bad)).toBeNull();
    }
  });
});

describe('eventsBetween', () => {
  const list = [
    ev({ id: 'a', date: '2026-09-20' }),
    ev({ id: 'b', date: '2026-09-10' }),
    ev({ id: 'c', date: '2026-10-05' }),
    ev({ id: 'junk', title: '' }),
  ];
  it('keeps only usable events inside the window, in date order', () => {
    expect(eventsBetween(list, '2026-09-01', '2026-09-30').map(e => e.id))
      .toEqual(['b', 'a']);
  });
  it('puts an all-day event before a timed one on the same day', () => {
    const same = [
      ev({ id: 'timed', date: '2026-09-12', startTime: '18:00' }),
      ev({ id: 'allday', date: '2026-09-12', startTime: null }),
    ];
    expect(eventsBetween(same, '2026-09-01', '2026-09-30').map(e => e.id))
      .toEqual(['allday', 'timed']);
  });
  it('is empty rather than broken with no input', () => {
    expect(eventsBetween(null, '2026-09-01', '2026-09-30')).toEqual([]);
  });
});

describe('weekAhead — one merged list, not two', () => {
  const from = '2026-09-14';
  const to = '2026-09-20';

  it('interleaves shifts and events by date', () => {
    const rows = weekAhead({
      shifts: [shift({ id: 's1', date: '2026-09-15' }), shift({ id: 's2', date: '2026-09-19' })],
      events: [ev({ id: 'e1', date: '2026-09-17' })],
      from, to,
    });
    expect(rows.map(r => r.id)).toEqual(['s1', 'e1', 's2']);
    expect(rows.map(r => r.kind)).toEqual(['shift', 'event', 'shift']);
  });

  it('orders by time within a day', () => {
    const rows = weekAhead({
      shifts: [shift({ id: 'late', date: '2026-09-15', startTime: '17:00' })],
      events: [ev({ id: 'early', date: '2026-09-15', startTime: '09:00' })],
      from, to,
    });
    expect(rows.map(r => r.id)).toEqual(['early', 'late']);
  });

  it('excludes drafts and cancellations — a plan is not a commitment', () => {
    const rows = weekAhead({
      shifts: [
        shift({ id: 'd', date: '2026-09-15', status: 'draft' }),
        shift({ id: 'c', date: '2026-09-16', status: 'cancelled' }),
        shift({ id: 'ok', date: '2026-09-17' }),
      ],
      events: [], from, to,
    });
    expect(rows.map(r => r.id)).toEqual(['ok']);
  });

  it('drops anything outside the window', () => {
    const rows = weekAhead({
      shifts: [shift({ id: 'before', date: '2026-09-01' }), shift({ id: 'after', date: '2026-10-01' })],
      events: [ev({ id: 'far', date: '2026-12-01' })],
      from, to,
    });
    expect(rows).toEqual([]);
  });

  it('copes with nothing at all', () => {
    expect(weekAhead({ from, to })).toEqual([]);
  });
});

describe('monthAhead — events plus the closures we already know', () => {
  const from = '2026-09-09';
  const to = '2026-10-09';

  it('folds configured holidays in as closures, free of charge', () => {
    const rows = monthAhead({
      events: [ev({ id: 'fun', date: '2026-09-26', title: 'Pizza Fun Day', type: 'fun-day' })],
      holidays: [{ date: '2026-10-05', name: 'Thanksgiving' }],
      from, to,
    });
    expect(rows.map(r => r.kind)).toEqual(['event', 'closure']);
    expect(rows[1].title).toBe('Thanksgiving — centre closed');
  });

  it('calls a non-statutory closure what it is', () => {
    const rows = monthAhead({
      holidays: [{ date: '2026-09-20', name: 'Renovation day', stat: false }],
      from, to,
    });
    expect(rows[0].note).toBe('Centre closure');
  });

  it('ignores holidays outside the window', () => {
    const rows = monthAhead({
      holidays: [{ date: '2026-12-25', name: 'Christmas' }], from, to,
    });
    expect(rows).toEqual([]);
  });

  it('is empty rather than broken', () => {
    expect(monthAhead({ from, to })).toEqual([]);
  });
});

describe('windows', () => {
  it('a week is today plus six', () => {
    expect(weekWindow('2026-09-09')).toEqual({ from: '2026-09-09', to: '2026-09-15' });
  });
  it('a month runs from today to the end of it, not from the 1st', () => {
    // Somebody opening this on the 28th wants the next few days, not a
    // month that is nearly over.
    expect(monthWindow('2026-09-09')).toEqual({ from: '2026-09-09', to: '2026-09-30' });
    expect(monthWindow('2026-02-15').to).toBe('2026-02-28');   // no invented 30th
  });
});

describe('validateEvent — the admin form', () => {
  it('accepts a complete event', () => {
    expect(validateEvent({ title: 'Staff meeting', date: '2026-09-17', startTime: '18:30', endTime: '19:30' })).toBeNull();
  });
  it('accepts an all-day event with no times at all', () => {
    expect(validateEvent({ title: 'Fun day', date: '2026-09-26' })).toBeNull();
  });
  it('insists on a name and a date', () => {
    expect(validateEvent({ date: '2026-09-17' })).toMatch(/name/i);
    expect(validateEvent({ title: 'x' })).toMatch(/date/i);
  });
  it('refuses an end before its start', () => {
    expect(validateEvent({ title: 'x', date: '2026-09-17', startTime: '19:00', endTime: '18:00' }))
      .toMatch(/end after/i);
  });
  it('refuses an end time with no start', () => {
    expect(validateEvent({ title: 'x', date: '2026-09-17', endTime: '19:00' }))
      .toMatch(/start time/i);
  });
});

describe('eventTypeLabel', () => {
  it('names each type', () => {
    expect(eventTypeLabel('meeting')).toBe('Staff meeting');
    expect(eventTypeLabel('fun-day')).toBe('Fun day');
  });
  it('falls back rather than showing a blank', () => {
    expect(eventTypeLabel('nonsense')).toBe('Something else');
    expect(eventTypeLabel(undefined)).toBe('Something else');
  });
});
