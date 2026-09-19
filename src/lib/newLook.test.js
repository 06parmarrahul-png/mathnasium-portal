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

describe('the opt-in switch', () => {
  it('is off until someone turns it on', () => {
    expect(isNewLookOn('u1')).toBe(false);
  });

  it('remembers per person, so switching accounts does not carry it over', () => {
    setNewLook('u1', true);
    expect(isNewLookOn('u1')).toBe(true);
    expect(isNewLookOn('u2')).toBe(false);      // the next login starts classic
  });

  it('turns back off', () => {
    setNewLook('u1', true);
    setNewLook('u1', false);
    expect(isNewLookOn('u1')).toBe(false);
  });

  it('survives storage being unavailable rather than crashing the app', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => isNewLookOn('u1')).not.toThrow();
    expect(isNewLookOn('u1')).toBe(false);       // fails closed, to classic
    expect(() => setNewLook('u1', true)).not.toThrow();
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

describe('newLookActive — opted in', () => {
  const instructor = { profile: { uid: 'u1' }, isInstructor: true };
  const director = { profile: { uid: 'u2' }, isDirector: true };

  it('is false for someone who has not opted in', () => {
    expect(newLookActive(instructor)).toBe(false);
  });

  it('is true once they opt in', () => {
    setNewLook('u1', true);
    expect(newLookActive(instructor)).toBe(true);
  });

  it('is true for a director too, now that they have a home of their own', () => {
    setNewLook('u2', true);
    expect(newLookActive(director)).toBe(true);
    expect(newLookHomeFor(director)).toBe('leadership');
  });

  it('survives a missing profile', () => {
    expect(() => newLookActive({ isInstructor: true })).not.toThrow();
    expect(newLookActive({ isInstructor: true })).toBe(false);
  });
});
