import { describe, it, expect } from 'vitest';
import {
  BUDGET_BUCKETS,
  BUCKET_KEYS,
  ACTIVE_BUCKETS,
  ACTIVE_BUCKET_KEYS,
  isRetiredBucket,
  WEEKDAY_DEFAULTS,
  WEEKDAY_ORDER,
  DOW_NAMES,
  resolveWeekdayModel,
  weekdayBudgetTotal,
  weekdayBudgetBuckets,
  budgetForDates,
  datesBetween,
  serializeWeekdayModel,
  wholeShiftBucket,
  bucketHoursForShift,
} from './budgetBuckets';

const MODEL = resolveWeekdayModel(null);

describe('the bucket list', () => {
  it('keeps the retired buckets so history still reports', () => {
    expect(BUCKET_KEYS).toContain('steam');
    expect(BUCKET_KEYS).toContain('summerCamp');
    expect(isRetiredBucket('steam')).toBe(true);
    expect(isRetiredBucket('summerCamp')).toBe(true);
  });

  it('does not offer them for new budgeting', () => {
    expect(ACTIVE_BUCKET_KEYS).not.toContain('steam');
    expect(ACTIVE_BUCKET_KEYS).not.toContain('summerCamp');
    expect(ACTIVE_BUCKETS.length).toBe(BUDGET_BUCKETS.length - 2);
  });

  it('treats every other bucket as active', () => {
    for (const k of ['instructional', 'online', 'adminHours', 'adminAssistant', 'host']) {
      expect(isRetiredBucket(k)).toBe(false);
      expect(ACTIVE_BUCKET_KEYS).toContain(k);
    }
  });

  it('is safe on an unknown key', () => {
    expect(isRetiredBucket('nope')).toBe(false);
  });
});

describe('the default day model', () => {
  // The centre stopped running STEAM and Summer Camp, so the default no
  // longer budgets for either. Any centre that wants them back types them
  // into the editor — or, better, makes a role.
  it('budgets nothing for the retired work', () => {
    for (const wd of WEEKDAY_ORDER) {
      expect(WEEKDAY_DEFAULTS[wd].steam).toBeUndefined();
      expect(WEEKDAY_DEFAULTS[wd].summerCamp).toBeUndefined();
    }
  });

  it('prices each open day', () => {
    expect(weekdayBudgetTotal('Monday', MODEL)).toBe(48);
    expect(weekdayBudgetTotal('Tuesday', MODEL)).toBe(39);
    expect(weekdayBudgetTotal('Wednesday', MODEL)).toBe(48);
    expect(weekdayBudgetTotal('Thursday', MODEL)).toBe(39);
    expect(weekdayBudgetTotal('Friday', MODEL)).toBe(36.5);
    expect(weekdayBudgetTotal('Saturday', MODEL)).toBe(35.5);
  });

  it('prices a closed day at zero', () => {
    expect(weekdayBudgetTotal('Sunday', MODEL)).toBe(0);
    expect(weekdayBudgetTotal('Notaday', MODEL)).toBe(0);
  });

  it('comes to 492h over a full fortnight', () => {
    const week = WEEKDAY_ORDER.reduce((n, wd) => n + weekdayBudgetTotal(wd, MODEL), 0);
    expect(week).toBe(246);
    expect(week * 2).toBe(492);
  });
});

describe('resolveWeekdayModel', () => {
  it('falls back to the default when the centre has saved nothing', () => {
    expect(resolveWeekdayModel(null)).toEqual(resolveWeekdayModel({}));
    expect(weekdayBudgetTotal('Monday', resolveWeekdayModel({}))).toBe(48);
  });

  it('uses a centre\'s own numbers', () => {
    const m = resolveWeekdayModel({
      staffingBudget: { weekdayModel: { Monday: { instructional: 40, host: 4 } } },
    });
    expect(weekdayBudgetTotal('Monday', m)).toBe(44);
  });

  // A centre that only edited Monday must still have a working Tuesday,
  // or every other day silently reads as a closed day worth nothing.
  it('leaves untouched weekdays on the default', () => {
    const m = resolveWeekdayModel({
      staffingBudget: { weekdayModel: { Monday: { instructional: 40 } } },
    });
    expect(weekdayBudgetTotal('Tuesday', m)).toBe(39);
    expect(weekdayBudgetTotal('Saturday', m)).toBe(35.5);
  });

  it('lets a centre zero a whole day', () => {
    const m = resolveWeekdayModel({ staffingBudget: { weekdayModel: { Saturday: {} } } });
    expect(weekdayBudgetTotal('Saturday', m)).toBe(0);
  });

  it('lets a centre re-add a retired bucket if it genuinely runs it again', () => {
    const m = resolveWeekdayModel({
      staffingBudget: { weekdayModel: { Monday: { instructional: 31, steam: 6 } } },
    });
    expect(weekdayBudgetBuckets('Monday', m).steam).toBe(6);
  });

  it('ignores junk without collapsing the model', () => {
    const m = resolveWeekdayModel({ staffingBudget: { weekdayModel: { Monday: 'nope', Tuesday: null } } });
    expect(weekdayBudgetTotal('Monday', m)).toBe(48);
    expect(weekdayBudgetTotal('Tuesday', m)).toBe(39);
  });

  it('drops zero and negative entries rather than storing them', () => {
    const m = resolveWeekdayModel({
      staffingBudget: { weekdayModel: { Monday: { instructional: 31, online: 0, host: -4 } } },
    });
    expect(weekdayBudgetTotal('Monday', m)).toBe(31);
  });
});

describe('datesBetween', () => {
  it('is inclusive of both ends', () => {
    expect(datesBetween('2026-09-11', '2026-09-14'))
      .toEqual(['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14']);
  });

  it('handles a single day', () => {
    expect(datesBetween('2026-09-11', '2026-09-11')).toEqual(['2026-09-11']);
  });

  it('crosses a month end', () => {
    const d = datesBetween('2026-08-26', '2026-09-10');
    expect(d.length).toBe(16);
    expect(d[0]).toBe('2026-08-26');
    expect(d[15]).toBe('2026-09-10');
  });

  it('crosses a year end', () => {
    const d = datesBetween('2026-12-30', '2027-01-02');
    expect(d).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('returns nothing when the range is backwards', () => {
    expect(datesBetween('2026-09-14', '2026-09-11')).toEqual([]);
  });
});

// This is the heart of the fix: a pay period's budget is the SUM of the
// same per-day numbers Manage Staff Schedule shows in its headers. The two
// pages cannot disagree because there is only one set of numbers.
describe('budgetForDates — a period is the sum of its days', () => {
  it('prices the 11th–25th', () => {
    const dates = datesBetween('2026-09-11', '2026-09-25');
    const { total, openDays, closedDays } = budgetForDates(dates, MODEL);
    // 15 days: Sun 13 and Sun 20 are closed, so 13 open days.
    expect(openDays).toBe(13);
    expect(closedDays).toBe(0);
    const expected = dates
      .map(d => weekdayBudgetTotal(DOW_NAMES[new Date(`${d}T12:00:00`).getDay()], MODEL))
      .reduce((a, b) => a + b, 0);
    expect(total).toBe(expected);
  });

  it('agrees with the day headers, day for day', () => {
    const dates = datesBetween('2026-09-11', '2026-09-25');
    const { byCat } = budgetForDates(dates, MODEL);
    const sumOfHeaders = {};
    for (const k of BUCKET_KEYS) sumOfHeaders[k] = 0;
    for (const d of dates) {
      const wd = DOW_NAMES[new Date(`${d}T12:00:00`).getDay()];
      const b = weekdayBudgetBuckets(wd, MODEL);
      for (const k of BUCKET_KEYS) sumOfHeaders[k] += b[k];
    }
    expect(byCat).toEqual(sumOfHeaders);
  });

  // A 16-day period simply has more days in it. No 'extra day' arithmetic.
  it('handles a 16-day period without special-casing it', () => {
    const short = budgetForDates(datesBetween('2026-09-11', '2026-09-25'), MODEL);
    const long  = budgetForDates(datesBetween('2026-08-26', '2026-09-10'), MODEL);
    expect(long.openDays).toBeGreaterThan(short.openDays);
    expect(long.total).toBeGreaterThan(short.total);
  });

  it('drops closed days from both the total and the buckets', () => {
    const dates = datesBetween('2026-09-11', '2026-09-25');
    const open = budgetForDates(dates, MODEL);
    const withHoliday = budgetForDates(dates, MODEL, { isClosed: d => d === '2026-09-14' });
    expect(withHoliday.closedDays).toBe(1);
    expect(withHoliday.openDays).toBe(open.openDays - 1);
    // 2026-09-14 is a Monday, worth 48h.
    expect(open.total - withHoliday.total).toBe(48);
    expect(open.byCat.instructional - withHoliday.byCat.instructional).toBe(31);
  });

  it('never counts a Sunday, holiday or not', () => {
    const { total, openDays } = budgetForDates(['2026-09-13'], MODEL);
    expect(total).toBe(0);
    expect(openDays).toBe(0);
  });

  it('is safe on empty input', () => {
    expect(budgetForDates([], MODEL).total).toBe(0);
    expect(budgetForDates(null, MODEL).total).toBe(0);
  });

  it('reflects an edit to the day model immediately', () => {
    const dates = datesBetween('2026-09-11', '2026-09-25');
    const before = budgetForDates(dates, MODEL).total;
    const edited = resolveWeekdayModel({
      staffingBudget: { weekdayModel: { Monday: { ...WEEKDAY_DEFAULTS.Monday, instructional: 41 } } },
    });
    const after = budgetForDates(dates, edited).total;
    // Two Mondays in an 11th–25th window, +10h each.
    expect(after - before).toBe(20);
  });
});

describe('serializeWeekdayModel', () => {
  it('round-trips through resolve unchanged', () => {
    const stored = serializeWeekdayModel(MODEL);
    expect(resolveWeekdayModel({ staffingBudget: { weekdayModel: stored } })).toEqual(MODEL);
  });

  it('writes every weekday, including closed ones', () => {
    const out = serializeWeekdayModel(MODEL);
    expect(Object.keys(out).sort()).toEqual([...WEEKDAY_ORDER].sort());
    expect(out.Sunday).toEqual({});
  });

  it('drops zeros so the stored doc stays small', () => {
    const out = serializeWeekdayModel({ Monday: { instructional: 10, online: 0, host: null } });
    expect(out.Monday).toEqual({ instructional: 10 });
  });

  it('coerces numeric strings from the number inputs', () => {
    expect(serializeWeekdayModel({ Monday: { instructional: '31' } }).Monday.instructional).toBe(31);
  });

  it('is safe on junk', () => {
    expect(serializeWeekdayModel(null).Monday).toEqual({});
  });
});

// Bucketing a shift is unchanged by any of the above — pinned so the day
// model work can't quietly move how hours are attributed.
describe('shift bucketing is untouched', () => {
  const shift = (o) => ({ startTime: '15:00', endTime: '19:00', role: 'Instructor', ...o });
  const WINDOW = { start: '15:00', end: '19:00' };

  it('splits a floor shift at the instructional window', () => {
    const out = bucketHoursForShift(shift({ startTime: '14:00', endTime: '19:00' }), 5, WINDOW);
    expect(out.instructional).toBeCloseTo(4, 5);
    expect(out.adminHours).toBeCloseTo(1, 5);
  });

  it('keeps whole-shift buckets whole', () => {
    expect(wholeShiftBucket(shift({ role: 'Host' }))).toBe('host');
    expect(wholeShiftBucket(shift({ role: 'Admin' }))).toBe('adminAssistant');
    expect(wholeShiftBucket(shift({ subRole: 'Online' }))).toBe('online');
    expect(wholeShiftBucket(shift({}))).toBe(null);
  });

  it('still buckets the retired flex tag for historical shifts', () => {
    expect(wholeShiftBucket(shift({ flexRole: 'STEAM' }))).toBe('steam');
    expect(wholeShiftBucket(shift({ flexRole: 'Summer Camp' }))).toBe('summerCamp');
    expect(bucketHoursForShift(shift({ flexRole: 'STEAM' }), 4, WINDOW)).toEqual({ steam: 4 });
  });

  it('pays nothing for zero hours', () => {
    expect(bucketHoursForShift(shift({}), 0, WINDOW)).toEqual({});
  });
});
