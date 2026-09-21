// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Sign-up, rendered — for the character picker. The page had no render
 * test, and it is the first screen a new instructor ever sees.
 */

const signup = vi.fn(async () => {});
vi.mock('../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}),
  getDocs: async () => ({ docs: [{ id: 'langley', data: () => ({ name: 'Mathnasium Langley' }) }] }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ signup }), useOptionalAuth: () => ({ signup }) }));

const { default: Signup } = await import('./Signup');

const draw = () => render(<MemoryRouter><Signup /></MemoryRouter>);
const heroSrc = () => screen.getAllByRole('img')[0].getAttribute('src');

beforeEach(() => { signup.mockClear(); });
afterEach(() => { cleanup(); });

describe('picking a character at sign-up', () => {
  it('offers all eight, with the original already chosen', () => {
    draw();
    const radios = screen.getAllByRole('radio');
    expect(radios.map(r => r.value))
      .toEqual(['classic', 'coach', 'cool', 'bot', 'gamer', 'coffee', 'corgi', 'sleepy']);
    expect(radios.find(r => r.checked).value).toBe('classic');
    for (const name of ['Cole', 'Coach Cole', 'Cool Cole', 'Cole-bot', 'Gamer Cole', 'Cole-feine', 'Cole-gi', 'Sleepy Cole']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('shows the pick at the top of the page straight away', () => {
    draw();
    const before = heroSrc();
    fireEvent.click(screen.getByText('Cole-bot'));
    expect(heroSrc()).not.toBe(before);
    expect(screen.getAllByRole('radio').find(r => r.checked).value).toBe('bot');
  });

  it('creates the account with the pick', async () => {
    const { container } = draw();
    await screen.findByRole('option', { name: /Mathnasium Langley/ });
    fireEvent.click(screen.getByText('Coach Cole'));
    fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Sam Lee' } });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('At least 6 characters'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByPlaceholderText('Confirm your password'), { target: { value: 'secret123' } });
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(signup).toHaveBeenCalledTimes(1));
    expect(signup.mock.calls[0][3]).toMatchObject({ centerId: 'langley', mascot: 'coach' });
  });
});
