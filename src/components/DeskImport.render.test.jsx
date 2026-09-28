// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * Clearing a spreadsheet import, rendered.
 *
 * The one thing that must never go wrong here: a note somebody typed in
 * Ratio being deleted because it happened to be sitting next to an
 * imported one. The spreadsheet cannot put those back. So most of this
 * file is about what is KEPT.
 */

// Rows as they sit in Firestore, keyed by collection.
const store = {};
const deleted = [];
const confirms = [];
let confirmAnswer = true;

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (_db, ...path) => ({ __c: path[path.length - 1] }),
  doc: () => ({}),
  query: (coll, ...clauses) => ({ ...coll, __where: clauses.filter(Boolean) }),
  where: (field, op, value) => ({ field, op, value }),
  getDocs: async (q) => {
    const rows = store[q.__c] || [];
    const wants = (q.__where || []).find(w => w.field === 'imported');
    const matching = wants ? rows.filter(r => r.imported === wants.value) : rows;
    return {
      size: matching.length,
      docs: matching.map(r => ({ id: r.id, data: () => r, ref: { __id: r.id, __c: q.__c } })),
    };
  },
  writeBatch: () => ({
    delete: (ref) => deleted.push(`${ref.__c}/${ref.__id}`),
    set: () => {},
    commit: async () => {},
  }),
}));

const toasts = [];
vi.mock('../lib/notify', () => ({
  toast: { success: (m) => toasts.push(['ok', m]), error: (m) => toasts.push(['err', m]) },
  confirmDialog: async (opts) => { confirms.push(opts); return confirmAnswer; },
}));

const { default: DeskImport } = await import('./DeskImport');

const row = (id, imported) => ({ id, imported, subject: id });

function seed() {
  // 3 imported notes and 2 the team typed in Ratio, plus a couple of
  // tracker rows of each kind.
  store.notes = [row('n1', true), row('n2', true), row('n3', true), row('own1'), row('own2')];
  store.giftCards = [row('g1', true), row('g2', true)];
  store.receipts = [row('r1', true), row('ownR')];
  store.referrals = [];
  store.studentOfMonth = [row('s1', true)];
}

const draw = (props = {}) => render(
  <DeskImport centerId="langley" members={[]} students={[]} existingCount={5}
    canReset {...props} />,
);

const count = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Count what the import left/ }));
  await waitFor(() => expect(screen.getByText(/This would remove|nothing to clear/)).toBeTruthy());
};

beforeEach(() => {
  seed();
  deleted.length = 0;
  confirms.length = 0;
  toasts.length = 0;
  confirmAnswer = true;
});
afterEach(cleanup);

describe('who is offered it', () => {
  it('is nobody, unless they are the tier the rules let delete', () => {
    render(<DeskImport centerId="langley" members={[]} students={[]} existingCount={5} />);
    expect(screen.queryByText(/Clear the last import/)).toBeNull();
  });

  it('is the owner tier', () => {
    draw();
    expect(screen.getByText(/Clear the last import/)).toBeTruthy();
  });
});

describe('counting first', () => {
  it('says what goes, per collection', async () => {
    draw();
    await count();
    expect(screen.getByText('3 notes')).toBeTruthy();
    expect(screen.getByText('2 gift cards')).toBeTruthy();
    expect(screen.getByText('1 receipt')).toBeTruthy();
    expect(screen.getByText('1 student of the month row')).toBeTruthy();
  });

  it('says what it is keeping, which is the part worth reading', async () => {
    draw();
    await count();
    expect(screen.getByText('2 notes written in Ratio')).toBeTruthy();
    expect(screen.getByText('1 receipt written in Ratio')).toBeTruthy();
  });

  it('offers nothing when none of it came from an import', async () => {
    store.notes = [row('own1'), row('own2')];
    store.giftCards = []; store.receipts = []; store.referrals = []; store.studentOfMonth = [];
    draw();
    await count();
    expect(screen.getByText(/nothing to clear/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });
});

describe('removing', () => {
  it('deletes the imported rows and nothing else', async () => {
    const onCleared = vi.fn();
    draw({ onCleared });
    await count();
    fireEvent.click(screen.getByRole('button', { name: /Remove 7 imported rows/ }));

    await waitFor(() => expect(deleted.length).toBe(7));
    expect(deleted).toEqual([
      'notes/n1', 'notes/n2', 'notes/n3',
      'giftCards/g1', 'giftCards/g2',
      'receipts/r1',
      'studentOfMonth/s1',
    ]);
    // The two notes and the receipt somebody typed here are untouched.
    expect(deleted).not.toContain('notes/own1');
    expect(deleted).not.toContain('notes/own2');
    expect(deleted).not.toContain('receipts/ownR');
  });

  it('makes you type the centre’s name, not just "delete"', async () => {
    draw();
    await count();
    fireEvent.click(screen.getByRole('button', { name: /Remove 7 imported rows/ }));
    await waitFor(() => expect(confirms).toHaveLength(1));
    expect(confirms[0].requireText).toBe('DELETE LANGLEY');
    expect(confirms[0].danger).toBe(true);
    expect(confirms[0].message).toMatch(/3 rows the team has written here since are kept/);
    expect(confirms[0].message).toMatch(/no undo/);
  });

  it('does nothing at all if the confirmation is declined', async () => {
    confirmAnswer = false;
    draw();
    await count();
    fireEvent.click(screen.getByRole('button', { name: /Remove 7 imported rows/ }));
    await waitFor(() => expect(confirms).toHaveLength(1));
    expect(deleted).toEqual([]);
  });

  it('tells the page, so the cached archive stops showing deleted notes', async () => {
    const onCleared = vi.fn();
    draw({ onCleared });
    await count();
    fireEvent.click(screen.getByRole('button', { name: /Remove 7 imported rows/ }));
    await waitFor(() => expect(onCleared).toHaveBeenCalled());
    expect(onCleared.mock.calls[0][0].removed).toBe(7);
    expect(toasts[0][1]).toMatch(/7 imported rows removed/);
  });
});
