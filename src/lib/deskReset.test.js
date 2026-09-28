import { describe, it, expect } from 'vitest';
import {
  DESK_COLLECTIONS, isImported, countLabel, resetPlan, confirmWordFor,
} from './deskReset';

describe('what counts as imported', () => {
  it('is the stamp an import leaves, and nothing else', () => {
    expect(isImported({ imported: true })).toBe(true);
    expect(isImported({ imported: false })).toBe(false);
    expect(isImported({})).toBe(false);
    expect(isImported(null)).toBe(false);
    expect(isImported(undefined)).toBe(false);
  });

  it('does not take a truthy value for the stamp', () => {
    // The stamp is written as a boolean. Anything else is a row somebody
    // wrote themselves, and those stay.
    expect(isImported({ imported: 'true' })).toBe(false);
    expect(isImported({ imported: 1 })).toBe(false);
  });
});

describe('the plan', () => {
  const counts = {
    notes: { imported: 1853, kept: 24 },
    giftCards: { imported: 57, kept: 0 },
    receipts: { imported: 129, kept: 3 },
    referrals: { imported: 28, kept: 0 },
    studentOfMonth: { imported: 15, kept: 0 },
  };

  it('adds up what goes and what stays, separately', () => {
    const plan = resetPlan(counts);
    expect(plan.total).toBe(1853 + 57 + 129 + 28 + 15);
    expect(plan.kept).toBe(27);
    expect(plan.isEmpty).toBe(false);
  });

  it('words each line, singular and plural', () => {
    const plan = resetPlan({ notes: { imported: 1, kept: 0 }, receipts: { imported: 2, kept: 0 } });
    expect(plan.lines.map(l => l.label)).toEqual(['1 note', '2 receipts']);
  });

  it('leaves out the collections with nothing to say', () => {
    // Five zeroes on screen read as five problems.
    const plan = resetPlan(counts);
    expect(plan.keptLines.map(l => l.key)).toEqual(['notes', 'receipts']);
    expect(plan.lines).toHaveLength(5);
  });

  it('knows when there is nothing to remove', () => {
    expect(resetPlan({}).isEmpty).toBe(true);
    expect(resetPlan({ notes: { imported: 0, kept: 9 } }).isEmpty).toBe(true);
    expect(resetPlan({ notes: { imported: 0, kept: 9 } }).kept).toBe(9);
  });

  it('ignores a count that isn’t a number', () => {
    const plan = resetPlan({ notes: { imported: NaN, kept: undefined } });
    expect(plan.total).toBe(0);
    expect(plan.kept).toBe(0);
  });

  it('words a count on its own, for a sentence that needs one', () => {
    expect(countLabel('notes', 1)).toBe('1 note');
    expect(countLabel('notes', 0)).toBe('0 notes');
    expect(countLabel('studentOfMonth', 2)).toBe('2 student of the month rows');
    expect(countLabel('nothing', 3)).toBe('3');
  });

  it('covers every collection an import writes', () => {
    expect(DESK_COLLECTIONS.map(c => c.key))
      .toEqual(['notes', 'giftCards', 'receipts', 'referrals', 'studentOfMonth']);
  });
});

describe('the word you have to type', () => {
  it('names the centre, so muscle memory cannot hit the wrong one', () => {
    expect(confirmWordFor('langley')).toBe('DELETE LANGLEY');
    expect(confirmWordFor('burnaby')).toBe('DELETE BURNABY');
  });

  it('holds up with no centre rather than producing a stray space', () => {
    expect(confirmWordFor('')).toBe('DELETE');
    expect(confirmWordFor(null)).toBe('DELETE');
  });
});
