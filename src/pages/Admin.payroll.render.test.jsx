// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * Manage Payroll's three new pieces, rendered: the pay-period stepper, the
 * sick days for one pay period, and the stat holiday grid. Admin.jsx is
 * ten thousand lines and a throw in any of these blanks the Payroll tab,
 * which nothing but rendering catches.
 */

vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {}, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({}));
vi.mock('firebase/storage', () => ({}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../lib/notify', () => ({ toast: { success: vi.fn(), error: vi.fn() }, confirmDialog: async () => true }));

const { PayPeriodStepper, PeriodSickDays, StatHolidaysTab } = await import('./Admin');
const { holidayCards } = await import('../lib/statHolidayGrid');

afterEach(() => { cleanup(); });

describe('PayPeriodStepper', () => {
  it('shows the period and the day it is paid, and steps both ways', () => {
    const onStep = vi.fn();
    render(<PayPeriodStepper start="2026-08-26" end="2026-09-10" isDefault onStep={onStep} onReset={() => {}} />);
    expect(screen.getByText('Aug 26 – Sep 10')).toBeTruthy();
    expect(screen.getByText(/paid Sep 15/)).toBeTruthy();
    expect(screen.getByText('Upcoming payroll')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Previous pay period'));
    fireEvent.click(screen.getByLabelText('Next pay period'));
    expect(onStep.mock.calls).toEqual([[-1], [1]]);
  });

  it('offers the way back once you have moved off the upcoming payroll', () => {
    const onReset = vi.fn();
    render(<PayPeriodStepper start="2026-08-11" end="2026-08-25" isDefault={false} onStep={() => {}} onReset={onReset} />);
    fireEvent.click(screen.getByText('Back to upcoming payroll'));
    expect(onReset).toHaveBeenCalled();
  });
});

describe('PeriodSickDays', () => {
  const people = [
    { name: 'Sam Lee', role: 'Instructor', paidHours: 4, unpaidHours: 3.5, usedThisYear: 5,
      dates: [
        { date: '2026-08-28', hours: 4, paid: true, external: false },
        { date: '2026-09-02', hours: 3.5, paid: false, external: false },
      ] },
    { name: 'Ann Park', role: 'Lead Instructor', paidHours: 0, unpaidHours: 0, usedThisYear: 2,
      dates: [{ date: '2026-09-01', hours: 0, paid: false, external: true }] },
  ];
  const draw = (over = {}) => render(
    <PeriodSickDays start="2026-08-26" end="2026-09-10" isDefault onStep={() => {}} onReset={() => {}} people={people} {...over} />,
  );

  it('is titled Current Pay Period Sick Days on the upcoming payroll', () => {
    draw();
    expect(screen.getByText('Current Pay Period Sick Days')).toBeTruthy();
  });

  it('lists who was off, which days were paid, and the totals', () => {
    draw();
    expect(screen.getByText('Sam Lee')).toBeTruthy();
    expect(screen.getByText('Ann Park')).toBeTruthy();
    expect(screen.getByText('5 of 5')).toBeTruthy();
    expect(screen.getByText('unpaid')).toBeTruthy();
    expect(screen.getByText('off-system')).toBeTruthy();
    expect(screen.getByText('2 people off sick')).toBeTruthy();
  });

  it('drops the word Current for another period, and says when nobody was off', () => {
    draw({ isDefault: false, people: [], start: '2026-08-11', end: '2026-08-25' });
    expect(screen.getByText('Pay Period Sick Days')).toBeTruthy();
    expect(screen.getByText('No sick days in Aug 11 – Aug 25.')).toBeTruthy();
  });
});

describe('StatHolidaysTab', () => {
  const HOLIDAYS = [
    { name: 'Good Friday', date: '2026-04-03' }, { name: 'BC Day', date: '2026-08-03' },
    { name: 'Labour Day', date: '2026-09-07' }, { name: 'Thanksgiving', date: '2026-10-12' },
    { name: 'Remembrance Day', date: '2026-11-11' }, { name: "New Year's Day", date: '2027-01-01' },
  ];
  const cards = holidayCards(HOLIDAYS, '2026-09-14');
  const row = (name, count, statTotal) => ({
    name, role: 'Instructor', qualifies: count >= 15, totalStat: statTotal, shifts: count, sickDays: 0,
    perHoliday: [{ holiday: HOLIDAYS[2], count, qualifies: count >= 15, statHours: statTotal, days: [], totalHours: 0, sickDays: 0 }],
  });
  const rowsFor = (date) => (date === '2026-09-07' ? [row('Sam Lee', 17, 4.5), row('Ann Park', 9, 0)] : []);
  const draw = (openDate = null, onOpen = () => {}) => render(
    <StatHolidaysTab cards={cards} rowsFor={rowsFor} openDate={openDate} onOpen={onOpen}
      todayKey="2026-09-14" historyFrom="2026-03-18" />,
  );

  it('shows every holiday with its pay period, pay date and which is next', () => {
    draw();
    expect(screen.getByText('Thanksgiving')).toBeTruthy();
    expect(screen.getByText('Next up')).toBeTruthy();
    expect(screen.getByText('Being paid')).toBeTruthy();
    expect(screen.getAllByText('Paid Oct 30').length).toBeGreaterThan(0);
  });

  it('counts who qualifies, and admits when a window is still open', () => {
    draw();
    expect(screen.getByText('1 eligible')).toBeTruthy();
    expect(screen.getAllByText(/Window still open/).length).toBeGreaterThan(0);
  });

  it('says a holiday before the loaded records cannot be counted, rather than 0 eligible', () => {
    draw();
    expect(screen.getByText('Before Ratio’s shift records')).toBeTruthy();
  });

  it('opens a holiday into its full roster', () => {
    const onOpen = vi.fn();
    const { rerender } = draw(null, onOpen);
    fireEvent.click(screen.getByText('Labour Day'));
    expect(onOpen).toHaveBeenCalledWith('2026-09-07');
    rerender(<StatHolidaysTab cards={cards} rowsFor={rowsFor} openDate="2026-09-07" onOpen={onOpen}
      todayKey="2026-09-14" historyFrom="2026-03-18" />);
    expect(screen.getByText('Sam Lee')).toBeTruthy();
    expect(screen.getByText('4.50h')).toBeTruthy();
  });

  it('switches year', () => {
    draw();
    fireEvent.click(screen.getByText('2027'));
    expect(screen.getByText("New Year's Day")).toBeTruthy();
    expect(screen.queryByText('Thanksgiving')).toBeNull();
  });
});
