import { describe, it, expect } from 'vitest';
import {
  isOpenSwap, openSwapFor, canRetract, openSwapsFor, SWAP_TYPE,
} from './shiftSwaps';

/**
 * Sarah posted the same shift for swap twice. Nothing stopped her, because
 * nothing was looking — so these are the checks that now do the looking.
 */

const swap = (over = {}) => ({
  id: 'c1', type: SWAP_TYPE, swapStatus: 'open',
  userId: 'sarah', userName: 'Sarah Ghazi',
  shiftId: 's1', shiftDate: '2026-09-20',
  ...over,
});

describe('isOpenSwap', () => {
  it('is true for a live request', () => {
    expect(isOpenSwap(swap())).toBe(true);
  });

  it('is false once it has been taken', () => {
    expect(isOpenSwap(swap({ swapStatus: 'accepted' }))).toBe(false);
  });

  it('is false for an ordinary chat message', () => {
    expect(isOpenSwap({ type: 'text', swapStatus: 'open' })).toBe(false);
    expect(isOpenSwap({ type: 'shift_confirmation' })).toBe(false);
  });

  it('is false for nothing at all', () => {
    expect(isOpenSwap(null)).toBe(false);
    expect(isOpenSwap(undefined)).toBe(false);
    expect(isOpenSwap({})).toBe(false);
  });
});

describe('openSwapFor — the check that was missing', () => {
  it('finds the request already posted for this shift', () => {
    expect(openSwapFor([swap()], 's1')?.id).toBe('c1');
  });

  it('is null when this shift has none', () => {
    expect(openSwapFor([swap({ shiftId: 'other' })], 's1')).toBeNull();
  });

  it('ignores a request that has already been taken', () => {
    // Otherwise a shift that was swapped away, given back and re-posted
    // would look permanently "already posted".
    expect(openSwapFor([swap({ swapStatus: 'accepted' })], 's1')).toBeNull();
  });

  it('is null rather than throwing when there is no shift', () => {
    expect(openSwapFor([swap()], null)).toBeNull();
    expect(openSwapFor([swap()], undefined)).toBeNull();
  });

  it('copes with no list at all', () => {
    expect(openSwapFor(null, 's1')).toBeNull();
    expect(openSwapFor([], 's1')).toBeNull();
  });
});

describe('canRetract', () => {
  it('lets the poster take their own request back', () => {
    expect(canRetract(swap(), 'sarah')).toBe(true);
  });

  it('does not let anybody else take it down', () => {
    expect(canRetract(swap(), 'jason')).toBe(false);
  });

  it('refuses once somebody has taken the shift', () => {
    // The shift has already changed hands by then — un-posting it would
    // leave the taker holding a shift the schedule no longer gives them.
    expect(canRetract(swap({ swapStatus: 'accepted' }), 'sarah')).toBe(false);
  });

  it('refuses when there is no signed-in user', () => {
    expect(canRetract(swap(), null)).toBe(false);
    expect(canRetract(swap(), '')).toBe(false);
  });
});

describe('openSwapsFor — the duplicates that already exist', () => {
  it('returns every open request for one shift, not just the first', () => {
    // Two are already out there from before the guard existed. Taking one
    // down has to leave the other visible rather than appearing to fail.
    const rows = [swap({ id: 'c1' }), swap({ id: 'c2' }), swap({ id: 'c3', shiftId: 'other' })];
    expect(openSwapsFor(rows, 's1').map(s => s.id)).toEqual(['c1', 'c2']);
  });

  it('is empty for a shift with none', () => {
    expect(openSwapsFor([swap()], 'nope')).toEqual([]);
    expect(openSwapsFor(null, 's1')).toEqual([]);
    expect(openSwapsFor([swap()], null)).toEqual([]);
  });
});
