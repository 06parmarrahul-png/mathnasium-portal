// @vitest-environment jsdom
import React from 'react';   // transformed with the classic JSX runtime
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * HomeSwitch picks the home, and catches it when one falls over.
 *
 * That boundary used to drop people onto the classic Home. The classic
 * Home was deleted on 2026-09-28, so what it does instead is the only
 * thing standing between a render error and somebody with no navigation
 * at all — App.jsx's boundary replaces the whole UI, sidebar included.
 */
const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authValue.current,
  useOptionalAuth: () => authValue.current,
}));

const blowUp = { current: false };
vi.mock('./homes/InstructorHome', () => ({
  default: () => { if (blowUp.current) throw new Error('boom'); return <div>FLOOR HOME</div>; },
}));
vi.mock('./homes/LeadershipHome', () => ({
  default: () => { if (blowUp.current) throw new Error('boom'); return <div>LEADERSHIP HOME</div>; },
}));

const { default: HomeSwitch } = await import('./HomeSwitch');

const draw = () => render(<MemoryRouter><HomeSwitch /></MemoryRouter>);

beforeEach(() => {
  blowUp.current = false;
  authValue.current = { profile: { uid: 'u1' }, isInstructor: true };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('which home', () => {
  it('sends somebody who works shifts to the floor home', async () => {
    await waitFor(() => expect(draw()).toBeTruthy());
    await waitFor(() => expect(screen.getByText('FLOOR HOME')).toBeTruthy());
  });

  it('sends somebody who runs the centre to the board', async () => {
    authValue.current = { profile: { uid: 'u2' }, isOwner: true };
    draw();
    await waitFor(() => expect(screen.getByText('LEADERSHIP HOME')).toBeTruthy());
  });

  it('NEVER OFFERS THE CLASSIC HOME — it does not exist', async () => {
    draw();
    await waitFor(() => expect(screen.getByText('FLOOR HOME')).toBeTruthy());
    expect(screen.queryByText(/classic/i)).toBeNull();
  });
});

describe('when a home falls over', () => {
  it('says so instead of showing a blank page', async () => {
    blowUp.current = true;
    draw();
    await waitFor(() => expect(screen.getByText(/didn't load/i)).toBeTruthy());
  });

  it('HANDS OVER SOMEWHERE TO GO, because the home was the way in', async () => {
    // Without these somebody whose home is broken has a sidebar of twenty
    // links and no idea which one they wanted.
    blowUp.current = true;
    draw();
    await waitFor(() => expect(screen.getByText('My schedule')).toBeTruthy());
    expect(screen.getByText('Management Desk')).toBeTruthy();
    expect(screen.getByText('Open shifts')).toBeTruthy();
    expect(screen.getByText('Reload')).toBeTruthy();
  });

  it('catches it HERE rather than letting the app-wide boundary take the sidebar', async () => {
    blowUp.current = true;
    const { container } = draw();
    await waitFor(() => expect(screen.getByText(/didn't load/i)).toBeTruthy());
    // The failure is contained in this card; nothing rethrows past it.
    expect(container.textContent).not.toMatch(/boom/);
  });
});
