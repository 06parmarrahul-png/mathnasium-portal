import { describe, it, expect } from 'vitest';
import {
  runsForMonth, projectPayroll, monthOfPeriodEnd, monthLabel, windowLabel,
} from './payrollProjection';

const shift = (date, extra = {}) => ({
  date, userName: 'Rahul', startTime: '15:00', endTime: '19:00', status: 'posted', ...extra,
});

describe('the semi-monthly cycle', () => {
  it('reaches back a month for the 15th run, because the cycle is lagged', () => {
    expect(runsForMonth('2026-09')).toEqual([
      { key: '15th', label: '15th payroll', start: '2026-08-26', end: '2026-09-10' },
      { key: '30th', label: '30th payroll', start: '2026-09-11', end: '2026-09-25' },
    ]);
  });

  it('crosses the year for January', () => {
    expect(runsForMonth('2026-01')[0].start).toBe('2025-12-26');
  });

  it('has nothing to say about a month it cannot read', () => {
    expect(runsForMonth('')).toEqual([]);
    expect(runsForMonth('2026-13')).toEqual([]);
  });

  it('files a period under the month it pays out in', () => {
    // Sep 26 – Oct 10 is OCTOBER's 15th run, not September's anything.
    expect(monthOfPeriodEnd('2026-10-10')).toBe('2026-10');
    expect(monthOfPeriodEnd('2026-09-25')).toBe('2026-09');
  });

  it('writes the labels the card shows', () => {
    expect(monthLabel('2026-09')).toBe('September 2026');
    expect(windowLabel('2026-08-26', '2026-09-10')).toBe('Aug 26 – Sep 10');
  });
});

describe('what each run is owed', () => {
  const shifts = [
    shift('2026-08-26'),                         // p1
    shift('2026-09-10', { userName: 'Neeru' }),  // p1, second head
    shift('2026-09-11'),                         // p2
    shift('2026-09-25', { payHoursOverride: 2 }),// p2, override wins
    shift('2026-09-26'),                         // next month's 15th run
  ];

  it('splits shifts by the window they fall in and counts heads, not rows', () => {
    const { runs, totalHours } = projectPayroll({ shifts, month: '2026-09' });
    expect(runs[0]).toMatchObject({ hours: 8, shifts: 2, instructors: 2 });
    expect(runs[1]).toMatchObject({ hours: 6, shifts: 2, instructors: 1 });
    // The 26th is outside both — that is the lag, not a missing shift.
    expect(totalHours).toBe(14);
  });

  it('pays a no-show nothing, whatever the override says', () => {
    const { totalHours } = projectPayroll({
      shifts: [shift('2026-09-12', { noShow: true, payHoursOverride: 4 })], month: '2026-09',
    });
    expect(totalHours).toBe(0);
  });

  it('counts only who the caller says is payable', () => {
    const { totalHours } = projectPayroll({
      shifts, month: '2026-09', isPayable: s => s.userName !== 'Rahul',
    });
    expect(totalHours).toBe(4);   // Neeru's one shift
  });

  it('marks the run that today is accruing into', () => {
    const on = (today) => projectPayroll({ shifts, month: '2026-09', today }).runs.map(r => r.upcoming);
    expect(on('2026-09-03')).toEqual([true, false]);
    expect(on('2026-09-20')).toEqual([false, true]);
    // From the 26th the money is already going to October's 15th, so
    // neither card in September is upcoming.
    expect(on('2026-09-27')).toEqual([false, false]);
    expect(on(null)).toEqual([false, false]);
  });
});
