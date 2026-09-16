// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
const reads = [];      // every one-shot getDocs, so a lazy fetch can be pinned
const listeners = [];  // live onSnapshot subscriptions, re-fired on a write

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
  // Like the real listener, an update reaches every live query again — so a
  // note marked done actually leaves the open list, as it does in the app.
  updateDoc: async (ref, data) => {
    writes.push({ op: 'update', path: ref.__d, data });
    const parts = ref.__d.split('/');
    const key = parts[parts.length - 2]; const id = parts[parts.length - 1];
    if (snapshots[key]) {
      snapshots[key] = snapshots[key].map(r => (r.id === id ? { ...r, ...data } : r));
    }
    for (const l of listeners) {
      l.next({ docs: rowsFor(l.q).map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
  },
  getDocs: async (q) => {
    reads.push(JSON.stringify(q?.__w || []));
    return { docs: rowsFor(q).map((r, i) => ({ id: r.id || `g${i}`, data: () => r })) };
  },
  writeBatch: () => {
    const ops = [];
    return {
      delete: (ref) => ops.push(ref.__d),
      set: () => {},
      commit: async () => {
        writes.push({ op: 'deleteBatch', ids: ops.slice() });
        for (const path of ops) {
          const parts = path.split('/');
          const key = parts[parts.length - 2]; const id = parts[parts.length - 1];
          if (snapshots[key]) snapshots[key] = snapshots[key].filter(r => r.id !== id);
        }
        for (const l of listeners) {
          l.next({ docs: rowsFor(l.q).map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
        }
      },
    };
  },
  onSnapshot: (q, next) => {
    if (typeof next !== 'function') return () => {};
    const l = { q, next };
    listeners.push(l);
    next({ docs: rowsFor(q).map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
  },
}));

const confirmAnswer = { current: true };
const confirmsAsked = [];
vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  confirmDialog: async (opts) => { confirmsAsked.push(opts); return confirmAnswer.current; },
}));
vi.mock('../lib/audit', () => ({
  logAuditEvent: vi.fn(async () => {}),
  AUDIT_ACTIONS: { DESK_NOTES_DELETED: 'desk.notes_deleted' },
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => authValue.current }));

const { default: ManagementDesk } = await import('./ManagementDesk');

const BASE_AUTH = {
  profile: { uid: 'vin', displayName: 'Vin Bhatia', role: 'director' },
  myInstructorType: 'Center Director',
  activeCenterId: 'langley',
  centerConfig: { name: 'Mathnasium Langley' },
  permissions: new Set(['notes.access', 'admin.panel']),
};

// A Host at a centre that has customised its roles: the stored registry
// froze before `notes.access` existed, so the permission never reaches
// them. The rules let them in by title, and so must the page.
const HOST_AUTH = {
  profile: { uid: 'rahul', displayName: 'Rahul Parmar', role: 'instructor' },
  myInstructorType: 'Host',
  activeCenterId: 'langley',
  centerConfig: { name: 'Mathnasium Langley' },
  permissions: new Set(['scheduler.run', 'admin.operations']),
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
  reads.length = 0;
  confirmsAsked.length = 0;
  confirmAnswer.current = true;
  listeners.length = 0;
  for (const k of ['notes', 'users', 'schedulerStudents', 'giftCards',
    'receipts', 'referrals', 'studentOfMonth']) {
    snapshots[k] = [];
  }
});
afterEach(() => { cleanup(); });

describe('who can see it', () => {
  it('turns away somebody without desk access, and shows them no data', () => {
    authValue.current = {
      ...BASE_AUTH,
      profile: { uid: 'k', displayName: 'Kaitlyn MacDonald', role: 'instructor' },
      myInstructorType: 'Instructor',
      permissions: new Set(['shifts.take']),
    };
    snapshots.notes = [note()];
    draw();
    expect(screen.getByText(/for the management team/i)).toBeTruthy();
    expect(screen.queryByText('Account: Manjeet Kaur')).toBeNull();
  });

  it('lets a management account in', () => {
    draw();
    expect(screen.getByText('Management Desk')).toBeTruthy();
  });

  it('lets a HOST in even when the permission never reached them', () => {
    // Rahul. The centre had saved its roles from Manage Roles, and the
    // editor writes the whole list back — so the stored 'Host' entry was
    // frozen with the permissions that existed that day. notes.access was
    // not one of them. The Firestore rules admit him by title; before
    // this, the page did not, so he could not find the door.
    authValue.current = { ...HOST_AUTH };
    draw();
    expect(screen.getByText('Management Desk')).toBeTruthy();
    expect(screen.queryByText(/for the management team/i)).toBeNull();
  });

  it('lets a Manager in the same way', () => {
    authValue.current = { ...HOST_AUTH, myInstructorType: 'Manager' };
    draw();
    expect(screen.getByText('Management Desk')).toBeTruthy();
  });

  it('still refuses a Lead', () => {
    // Running the floor for a shift is not the same job as settling a
    // parent's account question.
    authValue.current = { ...HOST_AUTH, myInstructorType: 'Lead' };
    draw();
    expect(screen.getByText(/for the management team/i)).toBeTruthy();
  });

  it('lets in anybody granted the permission in Manage Roles', () => {
    authValue.current = {
      ...HOST_AUTH,
      myInstructorType: 'Assistant Lead',
      permissions: new Set(['notes.access']),
    };
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

describe('the chain', () => {
  it('opens on Everyone — the whole chain, not just yours', () => {
    // Seeing what Rachel already answered is the reason this beats email.
    snapshots.notes = [
      note({ id: 'a', toUids: ['vin'], body: 'Mine' }),
      note({ id: 'b', toUids: ['neeru'], body: 'Somebody else\u2019s' }),
    ];
    draw();
    expect(screen.getByText('Mine')).toBeTruthy();
    expect(screen.getByText('Somebody else\u2019s')).toBeTruthy();
  });

  it('filters to what is waiting on ME', () => {
    snapshots.notes = [
      note({ id: 'a', toUids: ['vin'], body: 'Mine' }),
      note({ id: 'b', toUids: ['neeru'], body: 'Theirs' }),
    ];
    draw();
    fireEvent.click(screen.getByText('For me'));
    expect(screen.getByText('Mine')).toBeTruthy();
    expect(screen.queryByText('Theirs')).toBeNull();
  });

  it('puts a note addressed to Everyone in my list too', () => {
    // 82 of the imported notes are addressed to ALL.
    snapshots.notes = [note({ toUids: [], toAll: true, body: 'Fun day Saturday' })];
    draw();
    fireEvent.click(screen.getByText('For me'));
    expect(screen.getByText('Fun day Saturday')).toBeTruthy();
    expect(screen.getAllByText('Everyone').length).toBeGreaterThan(0);
  });

  it('opens on Open, so a settled note is not in the way', () => {
    // "General" and "Settled Notes" were the spreadsheet's two tabs, and
    // General was everybody's LIVE notes. This is that habit.
    snapshots.notes = [note({ status: 'closed', body: 'Sorted last week' })];
    draw();
    expect(screen.queryByText('Sorted last week')).toBeNull();
  });

  it('greys a settled note but leaves it in the chain under Settled', async () => {
    snapshots.notes = [note({ status: 'closed', body: 'Sorted last week' })];
    draw();
    fireEvent.click(screen.getByText('Settled'));
    expect(await screen.findByText('Sorted last week')).toBeTruthy();
    expect(screen.getByText('Reopen')).toBeTruthy();
  });

  it('does not read the 1,730-note archive until somebody asks', () => {
    // The whole reason Open is the default: opening the page costs the
    // twenty live notes, not seventeen hundred settled ones.
    snapshots.notes = [note({ status: 'closed', body: 'Old' })];
    draw();
    expect(reads.filter(r => r.includes('closed')).length).toBe(0);
    fireEvent.click(screen.getByText('Settled'));
    expect(reads.filter(r => r.includes('closed')).length).toBe(1);
  });

  it('marks one done and records who did it', async () => {
    snapshots.notes = [note()];
    draw();
    fireEvent.click(screen.getByText('Mark done'));
    await Promise.resolve();
    expect(writes.length).toBe(1);
    expect(writes[0].path).toBe('centers/langley/notes/n1');
    expect(writes[0].data.status).toBe('closed');
    expect(writes[0].data.settledByName).toBe('Vin Bhatia');
  });

  it('replies without leaving the chain', async () => {
    snapshots.notes = [note()];
    draw();
    fireEvent.change(screen.getByPlaceholderText('Reply\u2026'), { target: { value: 'On it' } });
    fireEvent.click(screen.getByTitle('Send reply'));
    await Promise.resolve();
    expect(writes[0].data.replies[0].text).toBe('On it');
    expect(writes[0].data.replies[0].name).toBe('Vin Bhatia');
  });

  it('points at the settled matches rather than hiding them', async () => {
    // Searching from Open would otherwise bury the answer, because the
    // thing you are looking up is usually settled — that is what settled
    // means. It says how many are through there and offers the click.
    snapshots.notes = [note({ status: 'closed', subject: 'Student: Harshad',
      body: 'Amazon gift card was refunded' })];
    draw();
    fireEvent.change(screen.getByPlaceholderText('Search\u2026'), { target: { value: 'harshad' } });
    const more = await screen.findByText(/1 more match in Settled/);
    fireEvent.click(more);
    expect(await screen.findByText(/Amazon gift card was refunded/)).toBeTruthy();
  });
});

describe('Settled, most recently settled first', () => {
  const bodies = () => screen.getAllByText(/^(Imported, top|Imported, lower|Settled in Ratio|Just dealt)/)
    .map(el => el.textContent);

  it('is ordered by when it was settled, not when it was logged', async () => {
    snapshots.notes = [
      // Logged later, but lower down the spreadsheet's Settled tab.
      note({ id: 'imp2', status: 'closed', body: 'Imported, lower', loggedAt: '2026-09-10', sheetOrder: 1 }),
      note({ id: 'imp1', status: 'closed', body: 'Imported, top', loggedAt: '2026-08-13', sheetOrder: 0 }),
      // Logged in May, settled in Ratio on Saturday.
      note({ id: 'r1', status: 'closed', body: 'Settled in Ratio', loggedAt: '2026-05-27',
        settledAt: '2026-09-12T03:14:43Z', settledByName: 'Neeru Gill' }),
    ];
    draw();
    fireEvent.click(screen.getByText('Settled'));
    await screen.findByText('Settled in Ratio');
    expect(bodies()).toEqual(['Settled in Ratio', 'Imported, top', 'Imported, lower']);
    // The local day it was settled — the day, so the timezone of the
    // machine running this decides 11th or 12th.
    expect(screen.getByText(/by Neeru · Sep 1[12], 2026/)).toBeTruthy();
  });

  it('puts the note you just marked done at the top, without a reload', async () => {
    snapshots.notes = [
      note({ id: 'imp1', status: 'closed', body: 'Imported, top', sheetOrder: 0 }),
      note({ id: 'r1', status: 'closed', body: 'Settled in Ratio', settledAt: '2026-09-12T03:14:43Z' }),
      note({ id: 'live', body: 'Just dealt with' }),
    ];
    draw();
    // Settled is fetched once. Open it first so the fetch has already
    // happened, which is the case that used to lose the note.
    fireEvent.click(screen.getByText('Settled'));
    await screen.findByText('Settled in Ratio');
    fireEvent.click(screen.getByText('Open'));
    fireEvent.click(await screen.findByText('Mark done'));
    await waitFor(() => expect(writes.length).toBe(1));
    fireEvent.click(screen.getByText('Settled'));
    await waitFor(() => expect(bodies()).toEqual(['Just dealt with', 'Settled in Ratio', 'Imported, top']));
    // Once each — not also lingering as a stale open copy.
    expect(screen.getAllByText('Just dealt with')).toHaveLength(1);
  });

  it('takes a reopened note out of Settled straight away', async () => {
    snapshots.notes = [
      note({ id: 'r1', status: 'closed', body: 'Settled in Ratio', settledAt: '2026-09-12T03:14:43Z' }),
      note({ id: 'imp1', status: 'closed', body: 'Imported, top', sheetOrder: 0 }),
    ];
    draw();
    fireEvent.click(screen.getByText('Settled'));
    await screen.findByText('Settled in Ratio');
    fireEvent.click(screen.getAllByText('Reopen')[0]);
    await waitFor(() => expect(bodies()).toEqual(['Imported, top']));
  });
});

describe('writing one', () => {
  const setup = () => {
    snapshots.users = [user('neeru', 'Neeru Gill', { role: 'director' })];
    snapshots.schedulerStudents = [{ name: 'Lexie Liu' }];
    draw();
    // The composer is closed until asked for — writing is the rarer act.
    fireEvent.click(screen.getByRole('button', { name: /Add entry/ }));
    return screen.getByPlaceholderText(/can you please complete a care call/);
  };

  it('reads initials, the student and the topic before you send', () => {
    const box = setup();
    fireEvent.change(box, { target: { value: 'NG, can you please complete a care call for Lexie Liu' } });
    expect(screen.getByText(/Vin \u2192 Neeru/)).toBeTruthy();
    // The name shows in the preview chip; it is also inside the typed text.
    expect(screen.getAllByText(/Lexie Liu/).length).toBeGreaterThan(0);
    expect(screen.getByText('Care call')).toBeTruthy();
  });

  it('sends it, with everything it read attached', async () => {
    const box = setup();
    fireEvent.change(box, { target: { value: 'NG, can you please complete a care call for Lexie Liu' } });
    fireEvent.click(screen.getByText('Send'));
    await Promise.resolve(); await Promise.resolve();
    const post = writes.find(w => w.op === 'add');
    expect(post.data.toUids).toEqual(['neeru']);
    expect(post.data.about).toBe('Lexie Liu');
    expect(post.data.topic).toBe('Care call');
    expect(post.data.status).toBe('open');
    expect(post.data.body).toBe('can you please complete a care call for Lexie Liu');
  });

  it('handles Everyone', async () => {
    const box = setup();
    fireEvent.change(box, { target: { value: 'Everyone can you please remind staff of the meeting?' } });
    expect(screen.getByText(/Vin \u2192 Everyone/)).toBeTruthy();
    fireEvent.click(screen.getByText('Send'));
    await Promise.resolve(); await Promise.resolve();
    const post = writes.find(w => w.op === 'add');
    expect(post.data.toAll).toBe(true);
    expect(post.data.toUids).toEqual([]);
  });

  it('will not send a line with nobody named', () => {
    const box = setup();
    fireEvent.change(box, { target: { value: 'All the gift cards arrived today' } });
    expect(screen.getByText('Send').disabled).toBe(true);
  });

  it('will not send an address with nothing said', () => {
    const box = setup();
    fireEvent.change(box, { target: { value: 'NG,' } });
    expect(screen.getByText('Send').disabled).toBe(true);
  });

  it('flags a code with no Ratio account rather than dropping it', () => {
    const box = setup();
    fireEvent.change(box, { target: { value: 'MY, new AFU family enrolled' } });
    expect(screen.getByText(/MY \u2014 no Ratio account yet/)).toBeTruthy();
    expect(screen.getByText('Send').disabled).toBe(false);
  });

  it('offers a correction for a near-miss name', () => {
    const box = setup();
    fireEvent.change(box, { target: { value: 'NG Lexi Lu needs a progress check' } });
    expect(screen.getByText(/did you mean Lexie Liu/)).toBeTruthy();
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

describe('deleting notes — the desk settles, it does not erase', () => {
  const tidyButton = () => screen.queryByTitle(/Delete notes/i);

  it('a Manager or Host is not offered it — the rules refuse them anyway', () => {
    snapshots.notes = [note()];
    authValue.current = { ...HOST_AUTH };
    draw();
    expect(screen.getByText(/Card was declined/)).toBeTruthy();       // they're on the desk
    expect(tidyButton()).toBeNull();                                  // but not this
  });

  it('the owner tier is', () => {
    snapshots.notes = [note()];
    draw();       // BASE_AUTH is a Centre Director
    expect(tidyButton()).toBeTruthy();
  });

  it('nothing is deleted until notes are ticked and it is confirmed', async () => {
    snapshots.notes = [note({ id: 'a' }), note({ id: 'b', subject: 'Second note' })];
    draw();
    fireEvent.click(tidyButton());
    expect(screen.getByText(/Tick the notes to delete/)).toBeTruthy();

    const del = screen.getByRole('button', { name: /^Delete$/ });
    expect(del.disabled).toBe(true);        // nothing selected yet

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Delete 1/ }));

    await waitFor(() => expect(writes.some(w => w.op === 'deleteBatch')).toBe(true));
    const batch = writes.find(w => w.op === 'deleteBatch');
    expect(batch.ids).toEqual(['centers/langley/notes/a']);
    // It says how many, and that it cannot be undone.
    expect(confirmsAsked[0].title).toMatch(/Delete 1 note\?/);
    expect(confirmsAsked[0].message).toMatch(/no undo/i);
    expect(confirmsAsked[0].danger).toBe(true);
  });

  it('answering no deletes nothing', async () => {
    snapshots.notes = [note({ id: 'a' })];
    confirmAnswer.current = false;
    draw();
    fireEvent.click(tidyButton());
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: /Delete 1/ }));
    await waitFor(() => expect(confirmsAsked).toHaveLength(1));
    expect(writes.some(w => w.op === 'deleteBatch')).toBe(false);
  });

  it('clears several in one go — the reason this exists', async () => {
    snapshots.notes = [note({ id: 'a' }), note({ id: 'b' }), note({ id: 'c' })];
    draw();
    fireEvent.click(tidyButton());
    screen.getAllByRole('checkbox').forEach(box => fireEvent.click(box));
    fireEvent.click(screen.getByRole('button', { name: /Delete 3/ }));
    await waitFor(() => expect(writes.some(w => w.op === 'deleteBatch')).toBe(true));
    expect(writes.find(w => w.op === 'deleteBatch').ids).toHaveLength(3);
    expect(confirmsAsked[0].title).toMatch(/Delete 3 notes\?/);
  });

  it('cancel leaves the mode without touching anything', () => {
    snapshots.notes = [note({ id: 'a' })];
    draw();
    fireEvent.click(tidyButton());
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(writes.some(w => w.op === 'deleteBatch')).toBe(false);
    // And the notes are still there.
    expect(screen.getByText(/Card was declined/)).toBeTruthy();
  });
});

describe('the composer stays out of the way', () => {
  it('is closed when the desk opens', () => {
    snapshots.notes = [note()];
    draw();
    expect(screen.queryByPlaceholderText(/care call/)).toBeNull();
    expect(screen.getByRole('button', { name: /Add entry/ })).toBeTruthy();
  });

  it('opens on Add entry and closes on Cancel', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Add entry/ }));
    expect(screen.getByPlaceholderText(/care call/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.queryByPlaceholderText(/care call/)).toBeNull();
  });

  it('closes on Escape without losing what was typed', () => {
    // A stray Escape must not bin a half-written note.
    snapshots.users = [user('neeru', 'Neeru Gill', { role: 'director' })];
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Add entry/ }));
    const box = screen.getByPlaceholderText(/care call/);
    fireEvent.change(box, { target: { value: 'NG, half a thought' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/care call/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add entry/ }));
    expect(screen.getByPlaceholderText(/care call/).value).toBe('NG, half a thought');
  });

  it('closes itself once the note is sent', async () => {
    snapshots.users = [user('neeru', 'Neeru Gill', { role: 'director' })];
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Add entry/ }));
    fireEvent.change(screen.getByPlaceholderText(/care call/), {
      target: { value: 'NG, please call the Liu family back' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
    await waitFor(() => expect(writes.some(w => w.op === 'add')).toBe(true));
    await waitFor(() => expect(screen.queryByPlaceholderText(/care call/)).toBeNull());
  });

  it('is not offered while you are deleting — one mode at a time', () => {
    snapshots.notes = [note()];
    draw();
    fireEvent.click(screen.getByTitle(/Delete notes/i));
    expect(screen.queryByRole('button', { name: /Add entry/ })).toBeNull();
  });
});

describe('who a note is for, on the card', () => {
  it('names the recipient in a chip, and the sender in plain text', () => {
    snapshots.users = [user('neeru', 'Neeru Gill', { role: 'director' })];
    snapshots.notes = [note({ toUids: ['neeru'], toLabel: 'NG', fromName: 'Vin Bhatia' })];
    draw();
    expect(screen.getByText('Neeru')).toBeTruthy();       // the chip
    expect(screen.getByText('Vin')).toBeTruthy();         // the sender
    expect(screen.getByText(/^from$/)).toBeTruthy();
  });

  it('says You, in the red that means yours', () => {
    // BASE_AUTH is Vin, uid 'vin'.
    snapshots.notes = [note({ toUids: ['vin'], toLabel: 'VB' })];
    draw();
    const chip = screen.getByText('You');
    expect(chip).toBeTruthy();
    expect(chip.closest('span').getAttribute('style')).toContain('#dc2626');
  });

  it('shows Everyone as its own chip', () => {
    snapshots.notes = [note({ toAll: true, toLabel: 'ALL' })];
    draw();
    expect(screen.getByText('Everyone')).toBeTruthy();
  });

  it('renders one chip per recipient', () => {
    snapshots.users = [
      user('neeru', 'Neeru Gill', { role: 'director' }),
      user('sabrina', 'Sabrina Kaur', { role: 'director' }),
    ];
    snapshots.notes = [note({ toUids: ['neeru', 'sabrina'], toLabel: 'NG/SK' })];
    draw();
    expect(screen.getByText('Neeru')).toBeTruthy();
    expect(screen.getByText('Sabrina')).toBeTruthy();
  });

  it('keeps an imported note’s initials when the person has no account', () => {
    // MY, JW and VS are in the history with nobody behind them.
    snapshots.notes = [note({ toUids: [], toLabel: 'MY' })];
    draw();
    expect(screen.getByText('MY')).toBeTruthy();
  });

  it('gives two different people two different colours', () => {
    snapshots.users = [
      user('neeru', 'Neeru Gill', { role: 'director' }),
      user('sabrina', 'Sabrina Kaur', { role: 'director' }),
    ];
    snapshots.notes = [
      note({ id: 'n1', toUids: ['neeru'], toLabel: 'NG' }),
      note({ id: 'n2', toUids: ['sabrina'], toLabel: 'SK' }),
    ];
    draw();
    const colourOf = (label) => screen.getByText(label).closest('span').getAttribute('style');
    expect(colourOf('Neeru')).not.toBe(colourOf('Sabrina'));
  });
});
