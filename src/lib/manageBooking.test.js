import { describe, it, expect } from 'vitest';
import {
  tokenOk, changeWindow, publicBooking, isUpcoming,
  MIN_NOTICE_HOURS, CANCELLED,
} from './manageBooking';

const NOW = '2026-10-01T18:00:00.000Z';
const at = (iso, over = {}) => ({ slot: iso, status: 'scheduled', ...over });

describe('the token in the link', () => {
  it('accepts the right one', () => {
    expect(tokenOk('abc123', 'abc123')).toBe(true);
  });

  it('refuses a wrong one, a short one, and a missing one', () => {
    expect(tokenOk('abc124', 'abc123')).toBe(false);
    expect(tokenOk('abc', 'abc123')).toBe(false);
    expect(tokenOk('', 'abc123')).toBe(false);
    expect(tokenOk(null, 'abc123')).toBe(false);
    expect(tokenOk('abc123', '')).toBe(false);
    expect(tokenOk('abc123', undefined)).toBe(false);
  });

  it('refuses a prefix of the right one', () => {
    // The length check is first for exactly this.
    expect(tokenOk('abc12', 'abc123')).toBe(false);
  });
});

describe('whether the family can still change it', () => {
  it('yes, when it is comfortably ahead', () => {
    expect(changeWindow(at('2026-10-03T23:00:00.000Z'), NOW).canChange).toBe(true);
  });

  it('no, once it has happened', () => {
    const w = changeWindow(at('2026-10-01T17:00:00.000Z'), NOW);
    expect(w.canChange).toBe(false);
    expect(w.past).toBe(true);
  });

  it('no, inside the notice window — and says to ring instead', () => {
    const soon = new Date(Date.parse(NOW) + (MIN_NOTICE_HOURS * 3600 * 1000) - 60000).toISOString();
    const w = changeWindow(at(soon), NOW);
    expect(w.canChange).toBe(false);
    expect(w.tooLate).toBe(true);
    expect(w.reason).toMatch(/call the centre/);
  });

  it('yes, right on the edge of the window', () => {
    const edge = new Date(Date.parse(NOW) + (MIN_NOTICE_HOURS * 3600 * 1000) + 1000).toISOString();
    expect(changeWindow(at(edge), NOW).canChange).toBe(true);
  });

  it('no, when it is already cancelled — and says so rather than "not found"', () => {
    const w = changeWindow(at('2026-10-03T23:00:00.000Z', { status: CANCELLED }), NOW);
    expect(w.canChange).toBe(false);
    expect(w.cancelled).toBe(true);
    expect(w.reason).toMatch(/cancelled/);
  });

  it('copes with a booking that is missing or unreadable', () => {
    expect(changeWindow(null, NOW).canChange).toBe(false);
    expect(changeWindow(at('not a date'), NOW).canChange).toBe(false);
  });
});

describe('what leaves the server', () => {
  const doc = {
    id: 'i1', slot: '2026-10-03T23:00:00.000Z', durationMin: 60, status: 'scheduled',
    childName: 'Wren K', guardianName: 'Alex K', centerId: 'langley',
    // None of this may go to a public page.
    cancelToken: 'secret-token-here', phone: '604-555-0100', email: 'alex@example.com',
    notes: 'dad is anxious about grade 7 math', smsOptIn: true,
  };

  it('is an allow-list — the token, the phone and the notes stay behind', () => {
    const view = publicBooking(doc);
    expect(view).toEqual({
      id: 'i1', slot: '2026-10-03T23:00:00.000Z', durationMin: 60, status: 'scheduled',
      childName: 'Wren K', guardianName: 'Alex K', centerId: 'langley',
    });
    expect(JSON.stringify(view)).not.toMatch(/secret-token-here|604-555|anxious|example\.com/);
  });

  it('ships nothing for nothing', () => {
    expect(publicBooking(null)).toBe(null);
  });
});

describe('which bookings to send somebody links for', () => {
  it('is the ones still to come', () => {
    expect(isUpcoming(at('2026-10-03T23:00:00.000Z'), NOW)).toBe(true);
    expect(isUpcoming(at('2026-09-30T23:00:00.000Z'), NOW)).toBe(false);
    expect(isUpcoming(at(''), NOW)).toBe(false);
  });
});
