// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

/**
 * The board as a section of another page.
 *
 * It moved inside Manage Staff Schedule's auto-scheduler, which means it
 * now renders somewhere that already has a heading and a container. The
 * `embedded` prop is what drops its own — and a prop that quietly breaks
 * the render is exactly the kind of thing `vite build` and eslint cannot
 * see, because neither runs React.
 */

vi.mock('../firebase', () => ({ db: {}, auth: { currentUser: null }, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}), query: () => ({}), where: () => ({}), orderBy: () => ({}),
  doc: () => ({}), writeBatch: () => ({ set: () => {}, commit: async () => {} }),
  onSnapshot: (_q, next) => { if (typeof next === 'function') next({ docs: [] }); return () => {}; },
}));
const AUTH = { activeCenterId: 'langley', centerConfig: {}, profile: {} };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => AUTH, useOptionalAuth: () => AUTH,
}));

const { default: StaffingBoard } = await import('./StaffingBoard');

afterEach(() => { cleanup(); });

describe('the staffing board', () => {
  it('keeps its own title when it is the page', () => {
    render(<StaffingBoard />);
    expect(screen.getByRole('heading', { name: 'Staffing Board' })).toBeTruthy();
  });

  it('drops the page chrome when it is a section of another page', () => {
    const { container } = render(<StaffingBoard embedded />);
    // No second <h1>, and no page gutter — the host supplies both.
    expect(screen.queryByRole('heading', { name: 'Staffing Board' })).toBeNull();
    expect(container.firstChild.className).not.toMatch(/max-w-|px-5|py-7/);
    // Still the board: its own controls are there either way.
    expect(screen.getByText('Range')).toBeTruthy();
  });

  it('no longer carries the coverage card, which lives on the Availability Log', () => {
    render(<StaffingBoard />);
    expect(screen.queryByText(/Coverage target/i)).toBeNull();
    expect(screen.queryByText(/instructors available/i)).toBeNull();
  });
});
