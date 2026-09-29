import { describe, it, expect } from 'vitest';
import {
  normaliseApptotoEvent, eventIdOf, startISOOf, contactOf, ASSESSMENT_RE,
} from './apptotoEvent';

/**
 * Apptoto's payload shape is not dependable — the two places in this app
 * that already read it each carry their own list of key spellings. These
 * are the shapes both of them were written to survive.
 */

describe('finding the booking’s id', () => {
  it('takes whichever spelling turned up', () => {
    expect(eventIdOf({ id: 'a1' })).toBe('a1');
    expect(eventIdOf({ event_id: 'b2' })).toBe('b2');
    expect(eventIdOf({ calendar_event_id: 'c3' })).toBe('c3');
    expect(eventIdOf({ calendar_event: { id: 'd4' } })).toBe('d4');
  });

  it('accepts a numeric id, because some accounts send one', () => {
    expect(eventIdOf({ id: 90210 })).toBe('90210');
  });

  it('is null when there is none — not undefined, not ""', () => {
    expect(eventIdOf({})).toBeNull();
    expect(eventIdOf(null)).toBeNull();
  });
});

describe('finding when it starts', () => {
  it('reads the spellings, nested or not', () => {
    expect(startISOOf({ start_time: '2026-10-02T17:00:00Z' })).toBe('2026-10-02T17:00:00.000Z');
    expect(startISOOf({ calendar_event: { starts_at: '2026-10-02T17:00:00Z' } })).toBe('2026-10-02T17:00:00.000Z');
    expect(startISOOf({ time: { when: '2026-10-02T17:00:00Z' } })).toBe('2026-10-02T17:00:00.000Z');
  });

  it('refuses a date it cannot parse rather than inventing one', () => {
    expect(startISOOf({ start_time: 'next tuesday' })).toBeNull();
    expect(startISOOf({})).toBeNull();
  });
});

describe('finding who booked', () => {
  it('takes a name off the event itself', () => {
    expect(contactOf({ contact_name: 'Amrit Sanghera' }).name).toBe('Amrit Sanghera');
  });

  it('takes one off a contact object', () => {
    expect(contactOf({ contact: { name: 'Wei Chen' } }).name).toBe('Wei Chen');
  });

  it('joins a split name', () => {
    expect(contactOf({ contact: { first_name: 'Dana', last_name: 'Kowalski' } }).name)
      .toBe('Dana Kowalski');
  });

  it('falls back to the first participant', () => {
    expect(contactOf({ participants: [{ name: 'Priya Raj' }] }).name).toBe('Priya Raj');
  });

  it('picks up email and phone wherever they sit', () => {
    const c = contactOf({ contact: { email: 'a@b.ca' }, phone: '604-555-0100' });
    expect(c.email).toBe('a@b.ca');
    expect(c.phone).toBe('604-555-0100');
  });

  it('gives nulls rather than empty strings when nobody is named', () => {
    expect(contactOf({})).toEqual({ name: null, email: null, phone: null });
    expect(contactOf(null)).toEqual({ name: null, email: null, phone: null });
  });
});

describe('is it an assessment', () => {
  it('matches what centres actually title these', () => {
    for (const t of ['Free Assessment', 'New Student Intake', 'Consult', 'Appointment Booked', 'Trial session']) {
      expect(ASSESSMENT_RE.test(t), t).toBe(true);
    }
  });

  it('leaves ordinary calendar entries alone', () => {
    for (const t of ['Staff meeting', 'Parent call', 'Supply order']) {
      expect(ASSESSMENT_RE.test(t), t).toBe(false);
    }
  });
});

describe('the whole event, as Ratio will store it', () => {
  const raw = {
    id: 'apt_123',
    title: 'Free Assessment',
    start_time: '2026-10-02T17:00:00Z',
    contact: { first_name: 'Amrit', last_name: 'Sanghera', email: 'amrit@example.ca', phone: '604-555-0143' },
  };

  it('reads a well-formed booking', () => {
    const e = normaliseApptotoEvent(raw);
    expect(e).toMatchObject({
      eventId: 'apt_123',
      startISO: '2026-10-02T17:00:00.000Z',
      title: 'Free Assessment',
      name: 'Amrit Sanghera',
      email: 'amrit@example.ca',
      isAssessment: true,
      usable: true,
    });
  });

  it('is unusable without an id — a retry could not be recognised', () => {
    const { id, ...noId } = raw;
    expect(id).toBeTruthy();
    expect(normaliseApptotoEvent(noId).usable).toBe(false);
  });

  it('is unusable without a start — that is not an appointment', () => {
    const { start_time: _s, ...noStart } = raw;
    expect(normaliseApptotoEvent(noStart).usable).toBe(false);
  });

  it('is still usable when nobody is named, because the slot is real', () => {
    const { contact: _c, ...anon } = raw;
    const e = normaliseApptotoEvent(anon);
    expect(e.usable).toBe(true);
    expect(e.name).toBeNull();
  });

  it('survives junk without throwing', () => {
    for (const junk of [null, undefined, {}, [], 'nope', 42]) {
      expect(() => normaliseApptotoEvent(junk), String(junk)).not.toThrow();
      expect(normaliseApptotoEvent(junk).usable).toBe(false);
    }
  });
});
