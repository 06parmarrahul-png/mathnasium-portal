import { describe, it, expect } from 'vitest';
import {
  dateKey, newestDate, unreadCount, unreadLabel,
} from './announcementReads';

/**
 * The badge has one job: be right. A number that says "2 new" when there is
 * nothing new trains people to ignore it, and a badge that stays lit after
 * they read everything trains them faster.
 */

const post = (date, over = {}) => ({ id: date, title: 't', text: 'x', date, ...over });

describe('dateKey', () => {
  it('passes an ISO string straight through — the shape every post uses', () => {
    expect(dateKey(post('2026-09-08T17:00:00.000Z'))).toBe('2026-09-08T17:00:00.000Z');
  });

  it('handles a Firestore Timestamp, so one odd legacy doc cannot skew the count', () => {
    const ts = { toDate: () => new Date('2026-09-08T17:00:00.000Z') };
    expect(dateKey({ date: ts })).toBe('2026-09-08T17:00:00.000Z');
  });

  it('handles a Date', () => {
    expect(dateKey({ date: new Date('2026-09-08T17:00:00.000Z') }))
      .toBe('2026-09-08T17:00:00.000Z');
  });

  it('gives nothing for a post with no usable date, rather than guessing', () => {
    expect(dateKey({})).toBe('');
    expect(dateKey(null)).toBe('');
    expect(dateKey({ date: 42 })).toBe('');
    expect(dateKey({ date: { toDate: () => { throw new Error('nope'); } } })).toBe('');
  });
});

describe('newestDate', () => {
  it('finds the newest whatever order they arrive in', () => {
    expect(newestDate([
      post('2026-09-01T10:00:00.000Z'),
      post('2026-09-09T10:00:00.000Z'),
      post('2026-09-05T10:00:00.000Z'),
    ])).toBe('2026-09-09T10:00:00.000Z');
  });

  it('is empty for no announcements', () => {
    expect(newestDate([])).toBe('');
    expect(newestDate(null)).toBe('');
  });

  it('ignores a dateless post instead of returning its empty key', () => {
    expect(newestDate([post('2026-09-01T10:00:00.000Z'), { id: 'x' }]))
      .toBe('2026-09-01T10:00:00.000Z');
  });
});

describe('unreadCount', () => {
  const rows = [
    post('2026-09-09T10:00:00.000Z'),
    post('2026-09-05T10:00:00.000Z'),
    post('2026-09-01T10:00:00.000Z'),
  ];

  it('counts everything for somebody who has never opened them', () => {
    expect(unreadCount(rows, null)).toBe(3);
  });

  it('counts only what arrived after they last looked', () => {
    expect(unreadCount(rows, '2026-09-04T00:00:00.000Z')).toBe(2);
  });

  it('is zero once they are caught up', () => {
    expect(unreadCount(rows, '2026-09-09T10:00:00.000Z')).toBe(0);
  });

  it('does not count the one they just read as still unread', () => {
    // Exact equality is "seen", not "newer than". Off by one here means the
    // badge never clears.
    expect(unreadCount([post('2026-09-09T10:00:00.000Z')], '2026-09-09T10:00:00.000Z'))
      .toBe(0);
  });

  it('never counts a post with no date — it cannot be newer than anything', () => {
    expect(unreadCount([{ id: 'x' }], null)).toBe(0);
  });

  it('is zero for no announcements at all', () => {
    expect(unreadCount([], null)).toBe(0);
    expect(unreadCount(null, null)).toBe(0);
  });
});

describe('unreadLabel', () => {
  it('says nothing when there is nothing new', () => {
    expect(unreadLabel(0, 5, 5)).toBe('');
  });

  it('gives the plain number when the fetch was not full', () => {
    expect(unreadLabel(2, 3, 5)).toBe('2');
  });

  it('says "5+" rather than "5" when the count fills the fetch', () => {
    // The home fetches five. If all five are unread there may be a sixth,
    // and "5" would be a quiet undercount.
    expect(unreadLabel(5, 5, 5)).toBe('5+');
  });

  it('gives the exact number when nothing caps it', () => {
    expect(unreadLabel(7, 7, 0)).toBe('7');
  });
});
