// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * My Account, rendered — specifically the Clock card.
 *
 * The thing worth pinning is the FIELD NAME. Everything downstream reads
 * `users/{uid}.timeFormat`; if this card wrote `timeFmt` instead, every
 * page would keep showing 12-hour and nothing would complain.
 */

const writes = [];
vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (_db, col, id) => ({ __path: `${col}/${id}` }),
  updateDoc: async (ref, data) => { writes.push({ path: ref.__path, data }); },
  serverTimestamp: () => 'NOW',
}));
vi.mock('firebase/auth', () => ({
  reauthenticateWithCredential: async () => {},
  EmailAuthProvider: { credential: () => ({}) },
  updatePassword: async () => {},
  verifyBeforeUpdateEmail: async () => {},
}));
vi.mock('firebase/storage', () => ({
  ref: () => ({}), uploadBytes: async () => {}, getDownloadURL: async () => '', deleteObject: async () => {},
}));
vi.mock('../lib/userContact', () => ({
  watchOwnContact: () => () => {},
  saveContact: async () => {},
  lazyMigrateContact: async () => {},
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authValue.current, useOptionalAuth: () => authValue.current,
}));

const { default: AccountDetails } = await import('./AccountDetails');

const draw = () => render(<MemoryRouter><AccountDetails /></MemoryRouter>);
const clockButton = (name) => screen.getByRole('button', { name: new RegExp(name) });

beforeEach(() => {
  writes.length = 0;
  authValue.current = {
    profile: { uid: 'u1', displayName: 'Rahul Sharma' },
    user: { email: 'rahul@example.com' },
  };
});
afterEach(cleanup);

describe('the Clock card', () => {
  it('offers both clocks, with an example of each', () => {
    draw();
    expect(clockButton('12-hour')).toBeTruthy();
    expect(clockButton('24-hour')).toBeTruthy();
    expect(screen.getByText(/9:30 AM · 3:00 PM · 7:45 PM/)).toBeTruthy();
    expect(screen.getByText(/09:30 · 15:00 · 19:45/)).toBeTruthy();
  });

  it('starts on 12-hour for somebody who has never chosen', () => {
    draw();
    expect(clockButton('12-hour').getAttribute('aria-pressed')).toBe('true');
    expect(clockButton('24-hour').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the saved choice as the one that is on', () => {
    authValue.current.profile = { ...authValue.current.profile, timeFormat: '24h' };
    draw();
    expect(clockButton('24-hour').getAttribute('aria-pressed')).toBe('true');
  });

  it('saves the pick to the field every page reads', () => {
    draw();
    fireEvent.click(clockButton('24-hour'));
    expect(writes).toEqual([
      { path: 'users/u1', data: { timeFormat: '24h', profileUpdatedAt: 'NOW' } },
    ]);
  });

  it('does not write when you press the clock you are already on', () => {
    draw();
    fireEvent.click(clockButton('12-hour'));
    expect(writes).toEqual([]);
  });
});
