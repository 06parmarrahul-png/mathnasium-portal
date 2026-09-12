// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Management Desk, rendered.
 *
 * The page carries parent account questions and notes about individual
 * students' funding, so the first thing tested is that somebody without
 * access sees none of it. After that: the inbox question the spreadsheet
 * could not answer ("what is waiting on ME"), and that a tracker's
 * checkbox writes straight through rather than needing an edit round trip.
 */

const snapshots = {};
const writes = [];

// The mock HONOURS where() clauses. It has to: the page now subscribes to
// open notes and fetches the settled archive separately, so a mock that
// handed every listener the whole collection would let those two tests
// pass without either query being right.
const rowsFor = (q) => {
  const key = String(q?.__c || '').split('/').pop();
  const rows = snapshots[key] || [];
  return rows.filter(r => (q?.__w || []).every(([field, op, value]) => {
    if (op === '==') return r[field] === value;
    if (op === 'array-contains') return (r[field] || []).includes(value);
    return true;
  }));
};

vi.mock('../firebase', () => ({ db: {}, auth: {}, serverTimestamp: () => 'ts' }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a.slice(1).join('/') }),
  query: (c, ...rest) => ({ ...c, __w: rest.filter(r => r?.__w).map(r => r.__w) }),
  where: (field, op, value) => ({ __w: [field, op, value] }),
  orderBy: () => ({}), limit: () => ({}),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  addDoc: async (ref, data) => { writes.push({ op: 'add', path: ref.__c, data }); return { id: 'new' }; },
  updateDoc: async (ref, data) => { writes.push({ op: 'update', path: ref.__d, data }); },
  getDocs: async (q) => ({
    docs: rowsFor(q).map((r, i) => ({ id: r.id || `g${i}`, data: () => r })),
  }),
  onSnapshot: (q, next) => {
    if (typeof next === 'function') {
      next({ docs: rowsFor(q).map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));

vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  confirmDialog: async () => true,
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authValue.current }));

const { default: ManagementDesk } = await import('./ManagementDesk');

const CAN_ALL = new Set(['notes.access', 'admin.panel']);
const BASE_AUTH = {
  profile: { uid: 'vin', displayName: 'Vin Bhatia', role: 'director' },
  activeCenterId: 'langley',
  centerConfig: { name: 'Mathnasium Langley' },
  can: (id) => CAN_ALL.has(id),
};

const note = (over = {}) => ({
  id: 'n1', toUids: ['vin'], toLabel: 'VB', toAll: false,
  fromUid: 'rachel', fromName: 'Rachel R', fromInitials: 'RR',
  subject: 'Account: Manjeet Kaur',
  body: 'Card was declined for this month.',
  loggedAt: '2026-09-01', createdAt: '2026-09-01T17:00:00.000Z',
  status: 'open', replies: [], ...over,
});

const user = (uid, displayName, over = {}) => ({
  id: uid, uid, displayName, role: 'instructor', centerIds: ['langley'], ...over,
});

const draw = () => render(<MemoryRouter><ManagementDesk /></MemoryRouter>);

beforeEach(() => {
  authValue.current = { ...BASE_AUTH };
  writes.length = 0;
  for (const k of ['notes', 'users', 'giftCards', 'receipts', 'referrals', 'studentOfMonth']) {
    snapshots[k] = [];
  }
});
afterEach(() => { cleanup(); });

describe('who can see it', () => {
  it('turns away somebody without desk access, and shows them no data', () => {
    authValue.current = { ...BASE_AUTH, can: () => false };
    snapshots.notes = [note()];
    draw();
    expect(screen.getByText(/for the management team/i)).toBeTruthy();
    expect(screen.queryByText('Account: Manjeet Kaur')).toBeNull();
  });

  it('lets a management account in', () => {
    draw();
    expect(screen.getByText('Management Desk')).toBeTruthy();
  });
});

describe('it renders', () => {
  it('with nothing at all', () => {
    expect(() => draw()).not.toThrow();
  });

  it('with a profile that has not loaded', () => {
    authValue.current = { ...BASE_AUTH, profile: null, activeCenterId: null };
    expect(() => draw()).not.toThrow();
  });

  it('opens every tab without falling over', () => {
    snapshots.notes = [note()];
    draw();
    for (const label of ['Gift cards', 'Receipts', 'Referral rally', 'Student of the month', 'Notes']) {
      expect(() => fireEvent.click(screen.getByText(label))).not.toThrow();
    }
  });
});

describe('the question the spreadsheet could not answer', () => {
  it('opens on what is waiting for ME', () => {
    snapshots.notes = [
      note({ id: 'mine', toUids: ['vin'] }),
      note({ id: 'theirs', toUids: ['neeru'], subject: 'Somebody else’s problem' }),
    ];
    draw();
    expect(screen.getByText('Account: Manjeet Kaur')).toBeTruthy();
    expect(screen.queryByText('Somebody else’s problem')).toBeNull();
  });

  it('counts them on the tab', () => {
    snapshots.notes = [
      note({ id: 'a', toUids: ['vin'] }),
      note({ id: 'b', toUids: ['vin'], subject: 'Another' }),
      note({ id: 'c', toUids: ['vin'], subject: 'Settled one', status: 'closed' }),
    ];
    draw();
    expect(screen.getByText('2')).toBeTruthy();      // not 3 — settled doesn't count
  });

  it('keeps settled notes out of the inbox but findable under Settled', async () => {
    // The settled note is NOT in the live subscription — it arrives only
    // when Settled is opened, which is the whole point of the split.
    snapshots.notes = [note({ status: 'closed' })];
    draw();
    expect(screen.queryByText('Account: Manjeet Kaur')).toBeNull();
    fireEvent.click(screen.getByText('Settled'));
    expect(await screen.findByText('Account: Manjeet Kaur')).toBeTruthy();
  });

  it('puts an ALL note in my list too', () => {
    snapshots.notes = [note({ toUids: [], toAll: true })];
    draw();
    expect(screen.getByText('Account: Manjeet Kaur')).toBeTruthy();
    expect(screen.getByText(/Everyone/)).toBeTruthy();
  });

  it('searches settled history, which is why it was imported', async () => {
    snapshots.notes = [
      note({ id: 'old', status: 'closed', subject: 'Student: Harshad',
        body: 'Amazon gift card was refunded' }),
    ];
    draw();
    fireEvent.click(screen.getByText('Settled'));
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'harshad' } });
    expect(await screen.findByText('Student: Harshad')).toBeTruthy();
  });

  it('reaches the archive from a search WITHOUT opening Settled first', async () => {
    // Looking up an old decision is the reason the history was imported.
    // A search that only covered the twenty live notes would miss it.
    snapshots.notes = [
      note({ id: 'old', status: 'closed', subject: 'Student: Harshad',
        body: 'Amazon gift card was refunded' }),
    ];
    draw();
    fireEvent.click(screen.getByText('All open'));
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'harshad' } });
    fireEvent.click(screen.getByText('Settled'));
    expect(await screen.findByText('Student: Harshad')).toBeTruthy();
  });
});

describe('settling a note', () => {
  it('closes it and records who did', async () => {
    snapshots.notes = [note()];
    draw();
    fireEvent.click(screen.getByText('Settle it'));
    await Promise.resolve();
    expect(writes.length).toBe(1);
    expect(writes[0].path).toBe('centers/langley/notes/n1');
    expect(writes[0].data.status).toBe('closed');
    expect(writes[0].data.settledByName).toBe('Vin Bhatia');
  });

  it('offers a settled note back, rather than making it final', async () => {
    snapshots.notes = [note({ status: 'closed' })];
    draw();
    fireEvent.click(screen.getByText('Settled'));
    expect(await screen.findByText('Reopen')).toBeTruthy();
  });
});

describe('replying', () => {
  it('adds a reply with a name on it', async () => {
    snapshots.notes = [note()];
    draw();
    fireEvent.change(screen.getByPlaceholderText('Reply…'), { target: { value: 'Noted, thanks' } });
    fireEvent.click(screen.getByTitle('Send reply'));
    await Promise.resolve();
    expect(writes[0].data.replies[0].text).toBe('Noted, thanks');
    expect(writes[0].data.replies[0].name).toBe('Vin Bhatia');
  });

  it('keeps the replies already there', async () => {
    // The spreadsheet had two reply COLUMNS, split by which half of the
    // team was answering. One thread, appended to, replaces both.
    snapshots.notes = [note({ replies: [{ name: 'Rachel R', text: 'First', at: '2026-09-02T00:00:00Z' }] })];
    draw();
    expect(screen.getByText('First')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Reply…'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByTitle('Send reply'));
    await Promise.resolve();
    expect(writes[0].data.replies.map(r => r.text)).toEqual(['First', 'Second']);
  });
});

describe('writing a note', () => {
  it('offers only people who can actually open the desk', () => {
    snapshots.users = [
      user('neeru', 'Neeru Sharma', { role: 'director' }),
      user('kaitlyn', 'Kaitlyn MacDonald', { centerMemberships: { langley: { instructorType: 'Instructor' } } }),
    ];
    draw();
    fireEvent.click(screen.getByText('New note'));
    expect(screen.getByText('Neeru Sharma')).toBeTruthy();
    // Addressing a note to an instructor would file it where they cannot
    // read it, and the sender would believe it had been passed on.
    expect(screen.queryByText('Kaitlyn MacDonald')).toBeNull();
  });

  it('refuses an incomplete note and says which bit', () => {
    draw();
    fireEvent.click(screen.getByText('New note'));
    fireEvent.click(screen.getByText('Post it'));
    expect(screen.getByText(/Give it a subject/)).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('posts a complete one', async () => {
    snapshots.users = [user('neeru', 'Neeru Sharma', { role: 'director' })];
    draw();
    fireEvent.click(screen.getByText('New note'));
    fireEvent.click(screen.getByText('Neeru Sharma'));
    fireEvent.change(screen.getByPlaceholderText(/Account: Manjeet Kaur/), { target: { value: 'Student: Ranbir R.' } });
    fireEvent.change(screen.getByPlaceholderText(/Card was declined/), { target: { value: 'Funding changes' } });
    fireEvent.click(screen.getByText('Post it'));
    await Promise.resolve();
    expect(writes.length).toBe(1);
    expect(writes[0].data.subject).toBe('Student: Ranbir R.');
    expect(writes[0].data.toUids).toEqual(['neeru']);
    expect(writes[0].data.status).toBe('open');
    expect(writes[0].data.fromName).toBe('Vin Bhatia');
  });
});

describe('the trackers', () => {
  const card = (over = {}) => ({
    id: 'g1', studentName: 'Ananya B', type: 'Starbucks', amount: 15,
    purchasedOn: '2026-09-10', handedOverOn: null, initials: 'NG', ...over,
  });

  it('opens on what is still outstanding', () => {
    snapshots.giftCards = [
      card({ id: 'g1', studentName: 'Ananya B' }),
      card({ id: 'g2', studentName: 'Jackson Jing', handedOverOn: '2026-09-11' }),
    ];
    draw();
    fireEvent.click(screen.getByText('Gift cards'));
    expect(screen.getByText('Ananya B')).toBeTruthy();
    expect(screen.queryByText('Jackson Jing')).toBeNull();
  });

  it('shows the handed-over ones when asked', () => {
    snapshots.giftCards = [card({ studentName: 'Jackson Jing', handedOverOn: '2026-09-11' })];
    draw();
    fireEvent.click(screen.getByText('Gift cards'));
    fireEvent.click(screen.getByText('Handed over'));
    expect(screen.getByText('Jackson Jing')).toBeTruthy();
  });

  it('ticks a checkbox straight through, with no edit round trip', async () => {
    // Ticking "prize collected" is the commonest thing anyone does on
    // these tabs. Making it a three-step edit is how a tracker stops
    // being kept up to date.
    snapshots.referrals = [{
      id: 'r1', studentName: 'Mia Palliardi', referredName: 'Alexa Palliardi',
      emailSent: false, prizeCollected: false, cardsGiven: false,
    }];
    draw();
    fireEvent.click(screen.getByText('Referral rally'));
    fireEvent.click(screen.getByTitle('Email'));
    await Promise.resolve();
    expect(writes.length).toBe(1);
    expect(writes[0].path).toBe('centers/langley/referrals/r1');
    expect(writes[0].data).toEqual({ emailSent: true });
  });

  it('refuses an incomplete row and says which bit', () => {
    draw();
    fireEvent.click(screen.getByText('Gift cards'));
    fireEvent.click(screen.getByText('Add'));
    fireEvent.click(screen.getByText('Add it'));
    expect(screen.getByText(/Whose card is it/)).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('shows a receipt with its money formatted', () => {
    snapshots.receipts = [{
      id: 'x1', supplier: 'One Source', description: '2 boxes of paper',
      amount: 129.67, orderedOn: '2025-06-16', paymentMethod: 'CC (0562)', received: false,
    }];
    draw();
    fireEvent.click(screen.getByText('Receipts'));
    expect(screen.getByText('$129.67')).toBeTruthy();
  });

  it('keeps a refund negative rather than showing it as a spend', () => {
    snapshots.receipts = [{
      id: 'x1', supplier: 'One Source', description: 'REFUND for 4 hole punchers',
      amount: -34.94, orderedOn: '2025-06-11', received: true,
    }];
    draw();
    fireEvent.click(screen.getByText('Receipts'));
    fireEvent.click(screen.getByText('Arrived'));
    expect(screen.getByText('-$34.94')).toBeTruthy();
  });
});

describe('the import panel', () => {
  it('is offered to an owner-tier account only', () => {
    authValue.current = { ...BASE_AUTH, canSeeCenterSettings: true };
    draw();
    expect(screen.getByText(/Import the old spreadsheet/i)).toBeTruthy();
  });

  it('is not offered to a manager', () => {
    // It writes about 1,900 documents. Not a button every manager reaches.
    authValue.current = { ...BASE_AUTH, canSeeCenterSettings: false };
    draw();
    expect(screen.queryByText(/Import the old spreadsheet/i)).toBeNull();
  });

  it('warns before a second run would duplicate everything', () => {
    // There is no id in the spreadsheet to match rows on, so re-running
    // cannot merge. The warning is the only defence.
    authValue.current = { ...BASE_AUTH, canSeeCenterSettings: true };
    snapshots.notes = [note(), note({ id: 'n2' })];
    draw();
    expect(screen.getByText(/add a second copy of everything/i)).toBeTruthy();
  });

  it('says nothing about duplicates on an empty desk', () => {
    authValue.current = { ...BASE_AUTH, canSeeCenterSettings: true };
    draw();
    expect(screen.queryByText(/second copy of everything/i)).toBeNull();
  });
});
