// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import PayrollProjectionCard from './PayrollProjectionCard';
import { projectPayroll } from '../lib/payrollProjection';

/**
 * The card as Manage Payroll draws it. The numbers are the lib's problem
 * and are tested there; what is checked here is that the right one lands
 * in the right box, which is the part a move between pages can break
 * without anything failing to compile.
 */

const shift = (date, extra = {}) => ({
  date, userName: 'Rahul', startTime: '15:00', endTime: '19:00', status: 'posted', ...extra,
});

const draw = (opts) => render(<PayrollProjectionCard projection={projectPayroll(opts)} />);

afterEach(() => { cleanup(); });

describe('the payroll projection card', () => {
  it('puts each run’s hours, window and heads in its own box', () => {
    draw({
      month: '2026-09',
      today: '2026-09-20',
      shifts: [
        shift('2026-08-26'), shift('2026-09-10', { userName: 'Neeru' }),
        shift('2026-09-11'), shift('2026-09-25'),
      ],
    });

    const first = screen.getByText('15th payroll').closest('div').parentElement;
    expect(within(first).getByText('8')).toBeTruthy();
    expect(within(first).getByText('Aug 26 – Sep 10')).toBeTruthy();
    expect(within(first).getByText('2 shifts · 2 instructors')).toBeTruthy();

    const second = screen.getByText('30th payroll').closest('div').parentElement;
    expect(within(second).getByText('8')).toBeTruthy();
    expect(within(second).getByText('2 shifts · 1 instructor')).toBeTruthy();
  });

  it('flags only the run today is accruing into', () => {
    draw({ month: '2026-09', today: '2026-09-20', shifts: [] });
    expect(screen.getAllByText('Upcoming')).toHaveLength(1);
  });

  it('adds the month up and says September', () => {
    draw({ month: '2026-09', shifts: [shift('2026-09-01'), shift('2026-09-12')] });
    expect(screen.getByText('September 2026')).toBeTruthy();
    expect(screen.getByText('8 hrs')).toBeTruthy();
  });

  it('renders nothing rather than an empty frame when there is no month', () => {
    const { container } = draw({ month: null, shifts: [] });
    expect(container.firstChild).toBeNull();
  });
});
