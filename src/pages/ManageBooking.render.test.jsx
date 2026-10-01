// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * The page a family opens from their reminder.
 *
 * What matters here is what it does NOT offer: a booking that is
 * cancelled, finished, or two hours away must not show buttons that would
 * fail on the server, and nothing on the page may carry the token or the
 * notes the centre keeps on the family.
 */

const posts = [];
let bookingResponse;
let availability;

vi.stubGlobal('fetch', vi.fn(async (url, init) => {
  if (init?.method === 'POST') {
    posts.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true }) };
  }
  if (String(url).includes('action=booking')) {
    return { ok: bookingResponse.ok !== false, json: async () => bookingResponse };
  }
  return { ok: true, json: async () => availability };
}));

const { default: ManageBooking } = await import('./ManageBooking');

const draw = (path = '/booking/i1?k=tok') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/booking" element={<ManageBooking />} />
      <Route path="/booking/:intakeId" element={<ManageBooking />} />
    </Routes>
  </MemoryRouter>,
);

const BOOKING = {
  ok: true,
  booking: {
    id: 'i1', slot: '2026-10-09T23:30:00.000Z', durationMin: 60,
    status: 'scheduled', childName: 'Wren', guardianName: 'Alex', centerId: 'langley',
  },
  centre: { name: 'Mathnasium of Langley', timezone: 'America/Vancouver' },
  canChange: true,
  reason: '',
};

beforeEach(() => {
  posts.length = 0;
  bookingResponse = JSON.parse(JSON.stringify(BOOKING));
  availability = { days: [{ date: '2026-10-12', label: 'Mon 12 Oct', slots: [
    { startISO: '2026-10-12T23:00:00.000Z', available: true },
    { startISO: '2026-10-12T23:30:00.000Z', available: false },
  ] }] };
});
afterEach(cleanup);

describe('opening your own booking', () => {
  it('shows whose it is and when', async () => {
    draw();
    expect(await screen.findByText(/Wren’s assessment/)).toBeTruthy();
    expect(screen.getByText(/Mathnasium of Langley/)).toBeTruthy();
    expect(screen.getByText(/60 minutes/)).toBeTruthy();
  });

  it('offers the three things, and only those', async () => {
    draw();
    expect(await screen.findByRole('button', { name: /be there/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pick another time/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancel it/ })).toBeTruthy();
  });

  it('confirms without asking anything else', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /be there/i }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ action: 'confirm', id: 'i1', token: 'tok' });
  });

  it('cancels, carrying the token from the link', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Cancel it/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].action).toBe('cancel');
    expect(posts[0].token).toBe('tok');
  });
});

describe('moving it', () => {
  it('offers only the times that are free', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Pick another time/ }));
    await waitFor(() => expect(screen.getByText(/Mon 12 Oct/)).toBeTruthy());
    const slots = screen.getAllByRole('button', { name: /AM|PM/ });
    expect(slots).toHaveLength(1);        // the taken 23:30 is not offered
  });

  it('sends the new slot', async () => {
    draw();
    fireEvent.click(await screen.findByRole('button', { name: /Pick another time/ }));
    const slot = await screen.findByRole('button', { name: /PM|AM/ });
    fireEvent.click(slot);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ action: 'reschedule', id: 'i1', slot: '2026-10-12T23:00:00.000Z' });
  });
});

describe('when it cannot be changed', () => {
  it('says why, and offers nothing that would fail', async () => {
    bookingResponse.canChange = false;
    bookingResponse.reason = 'It’s less than 2 hours away, so please call the centre instead — they can still help.';
    draw();
    expect(await screen.findByText(/call the centre instead/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pick another time/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel it/ })).toBeNull();
    // Confirming still stands: "yes, we're coming" is useful at any hour.
    expect(screen.getByRole('button', { name: /be there/i })).toBeTruthy();
  });

  it('says a cancelled one is cancelled, rather than offering to cancel it again', async () => {
    bookingResponse.booking.status = 'cancelled';
    bookingResponse.canChange = false;
    draw();
    expect(await screen.findByText(/This assessment is cancelled/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancel it/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /be there/i })).toBeNull();
  });

  it('is honest about a link that does not open anything', async () => {
    bookingResponse = { ok: false, error: 'We couldn’t find that booking. Check the link, or call the centre.' };
    draw();
    expect(await screen.findByText(/couldn’t find that booking/)).toBeTruthy();
  });
});

describe('arriving with only the text message', () => {
  it('asks for the email it was booked with', async () => {
    draw('/booking');
    expect(await screen.findByText(/Find your assessment/)).toBeTruthy();
    expect(screen.getByLabelText('Your email')).toBeTruthy();
  });

  it('says the same thing whether or not that address has a booking', async () => {
    draw('/booking');
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'alex@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Email me the link/ }));
    expect(await screen.findByText(/Check your email/)).toBeTruthy();
    expect(screen.getByText(/If we have a booking under that address/)).toBeTruthy();
    expect(posts[0]).toMatchObject({ action: 'send-link', email: 'alex@example.com' });
  });
});
