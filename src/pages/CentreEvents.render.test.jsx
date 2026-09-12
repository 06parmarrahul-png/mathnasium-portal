// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Centre Events, rendered.
 *
 * Written because this page just gained an upload panel and a month grid
 * wrapped in a <details>, and a mis-nested tag there is a blank page for
 * whoever goes looking for the upload. eslint caught one already; only
 * rendering catches the rest.
 */
const snapshots = {};
const docData = {};

vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {}, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c) => c, where: () => ({}), orderBy: () => ({}), limit: () => ({}),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  addDoc: async () => ({ id: 'x' }), updateDoc: async () => {}, deleteDoc: async () => {},
  setDoc: async () => {},
  writeBatch: () => ({ set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} }),
  onSnapshot: (ref, next) => {
    if (typeof next === 'function') {
      if (ref?.__d) {
        const v = docData[ref.__d];
        next({ exists: () => v !== undefined, data: () => v });
      } else {
        const rows = snapshots[String(ref?.__c || '').split('/').pop()] || [];
        next({ docs: rows.map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
      }
    }
    return () => {};
  },
}));
vi.mock('firebase/storage', () => ({
  ref: () => ({}), uploadBytes: async () => {},
  getDownloadURL: async () => 'https://example.test/x.png', deleteObject: async () => {},
}));
vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn() }, confirmDialog: async () => true,
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authValue.current }));

const { default: CentreEvents } = await import('./CentreEvents');

const ADMIN = {
  activeCenterId: 'langley',
  profile: { uid: 'vin', displayName: 'Vin Bhatia' },
  canSeeAdminPanel: true, canManageOperations: true,
};
// Rahul: runs the floor, no admin panel at a centre that has not granted it.
const FLOOR = { ...ADMIN, profile: { uid: 'rahul', displayName: 'Rahul Parmar' },
  canSeeAdminPanel: false, canManageOperations: true };

const draw = () => render(<MemoryRouter><CentreEvents /></MemoryRouter>);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));
  authValue.current = { ...ADMIN };
  for (const k of ['events']) snapshots[k] = [];
  for (const k of Object.keys(docData)) delete docData[k];
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('it renders', () => {
  it('for an admin, with the upload on it', () => {
    expect(() => draw()).not.toThrow();
    expect(screen.getByText('Centre Events')).toBeTruthy();
    expect(screen.getByText(/Upload the September 2026 sheet/)).toBeTruthy();
  });

  it('for somebody who runs the floor but has no admin panel', () => {
    // They get the fun-day calendar and nothing else — the rules draw the
    // same line, and a page that offers what Firestore refuses is a
    // slower no.
    authValue.current = { ...FLOOR };
    draw();
    expect(screen.getByText('Fun Days')).toBeTruthy();
    expect(screen.getByText(/Upload the September 2026 sheet/)).toBeTruthy();
    expect(screen.queryByText('Add an event')).toBeNull();
  });

  it('turns away somebody who runs neither', () => {
    authValue.current = { ...ADMIN, canSeeAdminPanel: false, canManageOperations: false };
    draw();
    expect(screen.getByText(/managed by admins/)).toBeTruthy();
  });

  it('shows the sheet once one is up, with a way to replace it', () => {
    docData['centers/langley/funDayCalendars/2026-09'] = {
      month: '2026-09', imageUrl: 'https://example.test/sept.png', uploadedBy: 'Rahul Parmar',
    };
    draw();
    expect(screen.getByAltText('Fun days for September 2026')).toBeTruthy();
    expect(screen.getByText('Replace')).toBeTruthy();
    expect(screen.getByText('Take down')).toBeTruthy();
  });

  it('still offers typing the days in, behind the disclosure', () => {
    draw();
    expect(screen.getByText(/Or type the days in/)).toBeTruthy();
  });

  it('steps months without falling over', () => {
    draw();
    fireEvent.click(screen.getByTitle('Next month'));
    expect(screen.getByText(/Upload the October 2026 sheet/)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Previous month'));
    fireEvent.click(screen.getByTitle('Previous month'));
    expect(screen.getByText(/Upload the August 2026 sheet/)).toBeTruthy();
  });
});
