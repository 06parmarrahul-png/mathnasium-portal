// @vitest-environment jsdom
import React from 'react';   // transformed with the classic JSX runtime
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const writes = [];
vi.mock('../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  setDoc: async (ref, data) => { writes.push({ path: ref.__d, data }); },
  serverTimestamp: () => 'ts',
}));
vi.mock('../lib/notify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: HolidaysEditor } = await import('./HolidaysEditor');

// Dates well in the future so "upcoming" stays true whenever this runs.
const CONFIG = {
  holidays: [
    { date: '2099-12-25', name: 'Christmas Day' },      // a stat, by date
    { date: '2099-12-27', name: 'Winter break' },       // not a stat
    { date: '2099-09-30', name: 'Truth and Reconciliation' },
  ],
};

const draw = (config = CONFIG) => render(
  <HolidaysEditor activeCenterId="langley" centerConfig={config} activeCenterName="Langley" />,
);

afterEach(() => { cleanup(); writes.length = 0; });

describe('holidays are a view of the closures, not a second list', () => {
  it('opens on Closures — adding a closed day is why people come here', () => {
    draw();
    expect(screen.getByText('Winter break')).toBeTruthy();
    expect(screen.getByText('Christmas Day')).toBeTruthy();
  });

  it('marks which of them are statutory', () => {
    draw();
    // Two of the three: Christmas and Sept 30. Not Winter break.
    expect(screen.getAllByText('Stat')).toHaveLength(2);
  });

  it('Holidays hides the centre’s own closures', () => {
    draw();
    fireEvent.click(screen.getByTitle(/Statutory holidays only/));
    expect(screen.queryByText('Winter break')).toBeNull();
    expect(screen.getByText('Christmas Day')).toBeTruthy();
  });

  it('drops the Stat chips once every row is one', () => {
    draw();
    fireEvent.click(screen.getByTitle(/Statutory holidays only/));
    expect(screen.queryByText('Stat')).toBeNull();
  });

  it('counts what is actually on screen', () => {
    draw();
    expect(screen.getByTitle(/Every day the centre is shut/).textContent).toMatch(/3/);
    expect(screen.getByTitle(/Statutory holidays only/).textContent).toMatch(/2/);
  });
});

describe('closing a stretch in one go', () => {
  const firstDay = () => document.querySelector('input[type="date"]');
  const lastDay = () => screen.getByLabelText(/Last day of the closure/);

  it('adds every day between, in one write', async () => {
    // The complaint this fixes: winter break was ten separate adds.
    draw({ holidays: [] });
    fireEvent.change(firstDay(), { target: { value: '2099-12-24' } });
    fireEvent.change(lastDay(), { target: { value: '2099-12-28' } });
    fireEvent.change(screen.getByPlaceholderText(/Christmas Day/), { target: { value: 'Winter break' } });
    fireEvent.click(screen.getByRole('button', { name: /Add 5 days/ }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].data.holidays.map(h => h.date)).toEqual([
      '2099-12-24', '2099-12-25', '2099-12-26', '2099-12-27', '2099-12-28',
    ]);
  });

  it('says how many days the button is about to close', () => {
    draw({ holidays: [] });
    fireEvent.change(firstDay(), { target: { value: '2099-12-24' } });
    expect(screen.getByRole('button', { name: /^Add$/ })).toBeTruthy();
    fireEvent.change(lastDay(), { target: { value: '2099-12-26' } });
    expect(screen.getByRole('button', { name: /Add 3 days/ })).toBeTruthy();
  });

  it('LEAVES A DAY THAT IS ALREADY THERE ALONE', async () => {
    // Closing the week around Christmas must not rename Christmas Day.
    draw({ holidays: [{ date: '2099-12-25', name: 'Christmas Day' }] });
    fireEvent.change(firstDay(), { target: { value: '2099-12-24' } });
    fireEvent.change(lastDay(), { target: { value: '2099-12-26' } });
    fireEvent.change(screen.getByPlaceholderText(/Christmas Day/), { target: { value: 'Winter break' } });
    fireEvent.click(screen.getByRole('button', { name: /Add 3 days/ }));

    await waitFor(() => expect(writes).toHaveLength(1));
    const saved = writes[0].data.holidays;
    expect(saved.find(h => h.date === '2099-12-25').name).toBe('Christmas Day');
    expect(saved).toHaveLength(3);
  });

  it('refuses an end before the start, and writes nothing', () => {
    draw({ holidays: [] });
    fireEvent.change(firstDay(), { target: { value: '2099-12-28' } });
    fireEvent.change(lastDay(), { target: { value: '2099-12-24' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(screen.getByText(/last day is before/i)).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it('refuses a mis-keyed year rather than writing thousands of entries', () => {
    draw({ holidays: [] });
    fireEvent.change(firstDay(), { target: { value: '2099-12-24' } });
    fireEvent.change(lastDay(), { target: { value: '2109-12-24' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(screen.getByText(/more than 60 days/i)).toBeTruthy();
    expect(writes).toHaveLength(0);
  });
});
