import { describe, it, expect } from 'vitest';
import {
  shiftOnDate, blockingShift, isDoubleBooked, conflictLabel, conflictReason,
} from './doubleBooking';

/**
 * The board let people claim a second shift on a day they already worked.
 * These are the checks that now stop it.
 */

const shift = (over = {}) => ({
  id: 's1', userId: 'kai', userName: 'Kai',
  centerId: 'langley', date: '2026-09-21',
  startTime: '15:00', endTime: '19:00',
  status: 'published', ...over,
});

describe('shiftOnDate', () => {
  it('finds the shift standing in the way', () => {
    expect(shiftOnDate([shift()], 'kai', '2026-09-21')?.id).toBe('s1');
  });

  it('ignores somebody else’s shift on that day', () => {
    expect(shiftOnDate([shift({ userId: 'sam' })], 'kai', '2026-09-21')).toBeNull();
  });

  it('ignores their own shift on another day', () => {
    expect(shiftOnDate([shift({ date: '2026-09-22' })], 'kai', '2026-09-21')).toBeNull();
  });

  it('does not count a draft — instructors can’t even see those', () => {
    expect(shiftOnDate([shift({ status: 'draft' })], 'kai', '2026-09-21')).toBeNull();
  });

  it('does not count a cancelled shift', () => {
    expect(shiftOnDate([shift({ status: 'cancelled' })], 'kai', '2026-09-21')).toBeNull();
  });

  it('counts a legacy shift with no status at all', () => {
    const legacy = shift();
    delete legacy.status;
    expect(shiftOnDate([legacy], 'kai', '2026-09-21')?.id).toBe('s1');
  });

  it('is safe with nothing to look at', () => {
    expect(shiftOnDate(null, 'kai', '2026-09-21')).toBeNull();
    expect(shiftOnDate([shift()], null, '2026-09-21')).toBeNull();
    expect(shiftOnDate([shift()], 'kai', null)).toBeNull();
  });
});

describe('blockingShift — for callers already down to one day', () => {
  it('hands back a shift that really is in the way', () => {
    expect(blockingShift(shift())?.id).toBe('s1');
  });

  it('draws the same line on drafts and cancellations', () => {
    expect(blockingShift(shift({ status: 'draft' }))).toBeNull();
    expect(blockingShift(shift({ status: 'cancelled' }))).toBeNull();
  });

  it('is fine with nothing', () => {
    expect(blockingShift(null)).toBeNull();
    expect(blockingShift(undefined)).toBeNull();
  });
});

describe('isDoubleBooked', () => {
  it('blocks a same-day pickup even when the hours don’t overlap', () => {
    const morning = shift({ startTime: '09:00', endTime: '12:00' });
    expect(isDoubleBooked([morning], 'kai', '2026-09-21')).toBe(true);
  });

  it('allows a pickup on a free day', () => {
    expect(isDoubleBooked([shift()], 'kai', '2026-09-22')).toBe(false);
  });
});

describe('the wording people actually see', () => {
  it('names the hours in the way', () => {
    expect(conflictLabel(shift())).toBe('Already on 3:00 PM – 7:00 PM');
    expect(conflictReason(shift())).toContain('3:00 PM – 7:00 PM');
  });

  it('still says something sensible without times', () => {
    expect(conflictLabel(null)).toBe('Already working this day');
    expect(conflictReason(shift({ startTime: '', endTime: '' }))).toBe(
      'You already work this day. Speak to a centre admin if you need a second shift.',
    );
  });
});
