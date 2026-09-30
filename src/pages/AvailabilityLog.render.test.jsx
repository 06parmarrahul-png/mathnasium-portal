// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The page's two tabs.
 *
 * Coverage by Day came off Centre Analytics. What is checked here is the
 * thing a move like that breaks quietly: that both halves are still
 * reachable, that only one is on screen at a time, and that the Export
 * button — which exports the LOG — does not follow the reader onto the
 * coverage tab and hand them the wrong file.
 */

vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}), query: () => ({}), where: () => ({}),
  onSnapshot: (_q, next) => { if (typeof next === 'function') next({ docs: [] }); return () => {}; },
}));
// The coverage card has a Firestore listener and an editor of its own;
// none of that is what this file is about.
vi.mock('../components/CoverageModelCard', () => ({
  default: () => <div data-testid="coverage-card">coverage model</div>,
}));
vi.mock('../lib/availabilityLog', async (orig) => ({
  ...(await orig()),
  subscribeAvailabilityLog: (_db, _centre, next) => { next([]); return () => {}; },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ activeCenterId: 'langley', canManageOperations: true, isSuperAdmin: false }),
}));

const { default: AvailabilityLog } = await import('./AvailabilityLog');

const draw = (at = '/availability-log') => render(
  <MemoryRouter initialEntries={[at]}><AvailabilityLog /></MemoryRouter>,
);

afterEach(() => { cleanup(); });

describe('Availability Log tabs', () => {
  it('opens on the change log', () => {
    draw();
    expect(screen.getByText('No changes recorded yet')).toBeTruthy();
    expect(screen.queryByTestId('coverage-card')).toBeNull();
  });

  it('shows the coverage card, and only that, on the other tab', () => {
    draw();
    fireEvent.click(screen.getByText('Coverage by Day'));
    expect(screen.getByTestId('coverage-card')).toBeTruthy();
    expect(screen.queryByText('No changes recorded yet')).toBeNull();
  });

  it('is linkable — ?tab=coverage lands on it', () => {
    draw('/availability-log?tab=coverage');
    expect(screen.getByTestId('coverage-card')).toBeTruthy();
  });

  it('falls back to the log for a tab that does not exist', () => {
    draw('/availability-log?tab=nonsense');
    expect(screen.getByText('No changes recorded yet')).toBeTruthy();
  });

  it('only offers Export where there is a log to export', () => {
    draw();
    expect(screen.getByRole('button', { name: /Export/ })).toBeTruthy();
    cleanup();
    draw('/availability-log?tab=coverage');
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
  });
});
