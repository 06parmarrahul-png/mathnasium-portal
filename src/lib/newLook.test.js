import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isNewLookOn, setNewLook, newLookKey, newLookHomeFor, newLookActive,
} from './newLook';

const store = new Map();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the opt-OUT switch', () => {
  // It shipped opt-IN and flipped on 2026-09-25. Two homes meant every
  // change to a home was two changes, and the better one was the one most
  // people never saw.
  it('is ON for somebody who has never touched it', () => {
    expect(isNewLookOn('u1')).toBe(true);
  });

  it('remembers per person, so switching accounts does not carry it over', () => {
    setNewLook('u1', false);
    expect(isNewLookOn('u1')).toBe(false);
    expect(isNewLookOn('u2')).toBe(true);      // the next login starts new
  });

  it('turns back on', () => {
    setNewLook('u1', false);
    setNewLook('u1', true);
    expect(isNewLookOn('u1')).toBe(true);
  });

  it('FAILS TO THE NEW HOME when storage is unavailable', () => {
    // localStorage is exactly the thing that comes back empty in a private
    // window or on a borrowed laptop. Somebody whose browser forgets
    // should see what everyone else sees, not quietly get the old portal.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => isNewLookOn('u1')).not.toThrow();
    expect(isNewLookOn('u1')).toBe(true);
    expect(() => setNewLook('u1', false)).not.toThrow();
  });

  it('only the exact word off opts out', () => {
    // A value left by an older build must not strand somebody on classic.
    store.set(newLookKey('u1'), 'on');
    expect(isNewLookOn('u1')).toBe(true);
    store.set(newLookKey('u1'), '');
    expect(isNewLookOn('u1')).toBe(true);
    store.set(newLookKey('u1'), 'OFF');
    expect(isNewLookOn('u1')).toBe(true);        // not the exact string
    store.set(newLookKey('u1'), 'off');
    expect(isNewLookOn('u1')).toBe(false);
  });

  it('anyone who opted in before still gets the new home', () => {
    store.set(newLookKey('u1'), 'on');
    expect(isNewLookOn('u1')).toBe(true);
  });

  it('keys anonymous separately from a real uid', () => {
    expect(newLookKey(null)).not.toBe(newLookKey('u1'));
  });
});

describe('newLookHomeFor — which of the two doors', () => {
  it('sends the people who work shifts to the floor home', () => {
    expect(newLookHomeFor({ isInstructor: true })).toBe('floor');
    expect(newLookHomeFor({ isTraining: true })).toBe('floor');
    expect(newLookHomeFor({ isVolunteer: true })).toBe('floor');
    expect(newLookHomeFor({ isLead: true })).toBe('floor');
    expect(newLookHomeFor({ isHost: true })).toBe('floor');   // a host is an instructor
  });

  it('sends the people who run the centre to the board', () => {
    expect(newLookHomeFor({ isOwner: true })).toBe('leadership');
    expect(newLookHomeFor({ isSuperAdmin: true })).toBe('leadership');
    expect(newLookHomeFor({ isDirector: true })).toBe('leadership');
    expect(newLookHomeFor({ isAdminAssistant: true })).toBe('leadership');
    expect(newLookHomeFor({ isAdmin: true })).toBe('leadership');
    expect(newLookHomeFor({ isOwnerLike: true })).toBe('leadership');
  });

  it('moves Managers onto the board, where they were floor staff before', () => {
    // Managers became the admin tier in their own right on 2026-09-14,
    // and they carry most of the desk. This is the one role whose home
    // changes hands.
    expect(newLookHomeFor({ isManager: true })).toBe('leadership');
  });

  it('lets leadership win over an instructor flag that is also set', () => {
    expect(newLookHomeFor({ isInstructor: true, isDirector: true })).toBe('leadership');
    expect(newLookHomeFor({ isLead: true, isOwnerLike: true })).toBe('leadership');
  });

  it('treats an empty auth object as floor staff', () => {
    // Fails toward the page that shows one person their own shifts,
    // rather than one that shows a stranger the whole centre.
    expect(newLookHomeFor({})).toBe('floor');
    expect(newLookHomeFor()).toBe('floor');
  });
});

describe('newLookActive — unless they opted out', () => {
  const instructor = { profile: { uid: 'u1' }, isInstructor: true };
  const director = { profile: { uid: 'u2' }, isDirector: true };

  it('is TRUE for someone who has never touched the switch', () => {
    expect(newLookActive(instructor)).toBe(true);
  });

  it('is false once they opt out', () => {
    setNewLook('u1', false);
    expect(newLookActive(instructor)).toBe(false);
  });

  it('is true for a director too, now that they have a home of their own', () => {
    expect(newLookActive(director)).toBe(true);
    expect(newLookHomeFor(director)).toBe('leadership');
  });

  it('survives a missing profile, and still lands on the new home', () => {
    // Mid-load, before the profile arrives. Both new homes render a
    // loading state for a null profile, so there is nothing to protect
    // them from — and flickering classic-then-new would be worse.
    expect(() => newLookActive({ isInstructor: true })).not.toThrow();
    expect(newLookActive({ isInstructor: true })).toBe(true);
  });
});
