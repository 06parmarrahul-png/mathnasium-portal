import { describe, it, expect } from 'vitest';
import {
  parseInboundKeyword, normalisePhone, normaliseEmail, contactKey,
  maySend, consentEntry, helpReply, stopReply,
} from './consent';

/**
 * The rule these all serve: a person who said stop is not sent anything,
 * on any pretext, and a person who merely booked still gets reminded.
 */

describe('reading an inbound text', () => {
  it('hears every stop word a carrier expects', () => {
    for (const w of ['STOP', 'stop', 'Stop.', 'STOPALL', 'unsubscribe', 'CANCEL', 'end', 'quit', 'opt out']) {
      expect(parseInboundKeyword(w), w).toBe('stop');
    }
  });

  it('hears stop with one courtesy word attached', () => {
    expect(parseInboundKeyword('stop please')).toBe('stop');
    expect(parseInboundKeyword('STOP NOW')).toBe('stop');
  });

  it('does not read a stop into an ordinary sentence', () => {
    // The cost of getting this wrong in the other direction is silently
    // dropping a family who was making conversation.
    expect(parseInboundKeyword('please don’t stop the lessons')).toBeNull();
    expect(parseInboundKeyword('can we cancel tuesday and rebook')).toBeNull();
  });

  it('hears start and help', () => {
    expect(parseInboundKeyword('START')).toBe('start');
    expect(parseInboundKeyword('yes')).toBe('start');
    expect(parseInboundKeyword('HELP')).toBe('help');
    expect(parseInboundKeyword('info')).toBe('help');
  });

  it('is null for anything else, including nothing', () => {
    expect(parseInboundKeyword('see you then!')).toBeNull();
    expect(parseInboundKeyword('')).toBeNull();
    expect(parseInboundKeyword(null)).toBeNull();
  });
});

describe('normalising who we are sending to', () => {
  it('turns the ways people write a number into one key', () => {
    for (const n of ['604-555-0143', '(604) 555-0143', '6045550143', '+1 604 555 0143', '1-604-555-0143']) {
      expect(normalisePhone(n), n).toBe('+16045550143');
    }
  });

  it('refuses something that is not a number rather than guessing', () => {
    expect(normalisePhone('call the centre')).toBeNull();
    expect(normalisePhone('555')).toBeNull();
    expect(normalisePhone('')).toBeNull();
  });

  it('lowercases and validates an email', () => {
    expect(normaliseEmail('  Amrit@Example.CA ')).toBe('amrit@example.ca');
    expect(normaliseEmail('not-an-email')).toBeNull();
  });

  it('keys a person by address, so a stop outlives the booking', () => {
    expect(contactKey('sms', '(604) 555-0143')).toBe('sms:+16045550143');
    expect(contactKey('email', 'A@B.ca')).toBe('email:a@b.ca');
    expect(contactKey('sms', 'nope')).toBeNull();
  });

  it('gives one key however the same number was typed', () => {
    expect(contactKey('sms', '604-555-0143')).toBe(contactKey('sms', '+16045550143'));
  });
});

describe('may we send it', () => {
  const withdrawn = { state: 'withdrawn' };
  const granted   = { state: 'granted' };

  it('reminds a family who booked, even with no marketing consent', () => {
    // The case the whole thing turns on: they left the box unticked and
    // still expect to be told their assessment is tomorrow.
    const out = maySend({ record: null, kind: 'transactional', hasTransactionalBasis: true });
    expect(out.allowed).toBe(true);
    expect(out.reason).toBe('booking');
  });

  it('does not market to them on the strength of that booking', () => {
    const out = maySend({ record: null, kind: 'marketing', hasTransactionalBasis: true });
    expect(out.allowed).toBe(false);
    expect(out.reason).toBe('no-marketing-consent');
  });

  it('markets only to somebody who said yes', () => {
    expect(maySend({ record: granted, kind: 'marketing' }).allowed).toBe(true);
  });

  it('sends nothing at all to somebody who said stop', () => {
    // Every kind, including the one they booked. There is no message
    // important enough to override it.
    for (const kind of ['transactional', 'marketing']) {
      const out = maySend({ record: withdrawn, kind, hasTransactionalBasis: true });
      expect(out.allowed, kind).toBe(false);
      expect(out.reason).toBe('withdrawn');
    }
  });

  it('will not send a reminder to somebody who never booked', () => {
    expect(maySend({ record: null, kind: 'transactional' }).allowed).toBe(false);
  });

  it('refuses a kind it does not recognise rather than allowing it', () => {
    expect(maySend({ record: granted, kind: 'newsletter' }).allowed).toBe(false);
  });
});

describe('what gets written down', () => {
  it('keeps the words the person was shown', () => {
    const e = consentEntry({
      channel: 'sms', address: '604-555-0143', state: 'granted',
      source: 'booking-form', wording: 'By checking this box you agree…',
      at: '2026-10-02T12:00:00.000Z',
    });
    expect(e.address).toBe('+16045550143');
    expect(e.wording).toContain('By checking this box');
    expect(e.source).toBe('booking-form');
    expect(e.at).toBe('2026-10-02T12:00:00.000Z');
  });

  it('keeps the words they sent when they withdrew', () => {
    const e = consentEntry({
      channel: 'sms', address: '+16045550143', state: 'withdrawn',
      source: 'sms-reply', wording: 'STOP',
    });
    expect(e.state).toBe('withdrawn');
    expect(e.wording).toBe('STOP');
  });

  it('caps a pasted essay rather than storing it whole', () => {
    const e = consentEntry({ channel: 'sms', address: '+16045550143', state: 'withdrawn', source: 'sms-reply', wording: 'x'.repeat(5000) });
    expect(e.wording.length).toBe(2000);
  });
});

describe('what we say back', () => {
  it('answers HELP with who we are and how to stop', () => {
    const r = helpReply('Mathnasium of Langley', 'sms@mathnasium.com');
    expect(r).toContain('Mathnasium of Langley');
    expect(r).toContain('STOP');
    expect(r).toContain('sms@mathnasium.com');
  });

  it('confirms a STOP once, and says how to come back', () => {
    const r = stopReply('Mathnasium of Langley');
    expect(r).toMatch(/no further messages|not receive further messages/i);
    expect(r).toContain('START');
  });
});
