import { describe, it, expect } from 'vitest';
import {
  normaliseStatus,
  isOpen,
  initialsOf,
  isForMe,
  isFromMe,
  matchesQuery,
  sortNotes,
  sortSettled,
  applyToArchive,
  filterNotes,
  myOpenCount,
  validateNote,
  recipientNames,
  deskMembers,
  LIVE_STATUSES,
  statusFields,
  dueState,
  dueLabel,
  daysUntilDue,
  dueSuggestions,
  sortByDue,
  deskSummary,
  canDeleteNotes,
} from './deskNotes';

/**
 * Fixtures taken from the real workbook, including the mess: three
 * spellings of "Closed", notes addressed to two people at once, notes
 * addressed to ALL, and rows whose author has no Ratio account.
 */
const note = (over = {}) => ({
  id: 'n1',
  toUids: ['vin'], toLabel: 'VB', toAll: false,
  fromUid: 'rahul', fromName: 'Rahul Parmar', fromInitials: 'RP',
  subject: 'Account: Manjeet Kaur',
  body: 'Card was declined for this month’s payment.',
  loggedAt: '2026-09-01', createdAt: '2026-09-01T17:00:00.000Z',
  status: 'open', replies: [],
  ...over,
});

describe('normaliseStatus — the hand-typed mess, solved once', () => {
  it('accepts every spelling the spreadsheet actually contains', () => {
    // 1,594 'Closed', 124 'closed', 12 'CLOSED'. All one thing.
    for (const v of ['Closed', 'closed', 'CLOSED', ' Closed ']) {
      expect(normaliseStatus(v)).toBe('closed');
    }
  });

  it('treats a blank status as open, not as unknown', () => {
    // Rows exist with no status at all. An unstatused note is one nobody
    // has dealt with, which is the definition of open.
    expect(normaliseStatus('')).toBe('open');
    expect(normaliseStatus(null)).toBe('open');
    expect(normaliseStatus(undefined)).toBe('open');
  });

  it('treats anything unrecognised as open rather than silently closing it', () => {
    expect(normaliseStatus('waiting on parent')).toBe('open');
  });

  it('isOpen agrees', () => {
    expect(isOpen(note({ status: 'CLOSED' }))).toBe(false);
    expect(isOpen(note({ status: undefined }))).toBe(true);
  });
});

describe('initialsOf', () => {
  it('takes first and last', () => {
    expect(initialsOf('Rahul Parmar')).toBe('RP');
    expect(initialsOf('Neeru Sharma')).toBe('NS');
  });

  it('skips a bracketed preferred name', () => {
    // Two real employees are recorded this way.
    expect(initialsOf('Jieun (Joanne) Lee')).toBe('JL');
    expect(initialsOf('Darshveer (Diya) Brar')).toBe('DB');
  });

  it('copes with one name and with none', () => {
    expect(initialsOf('Rahul')).toBe('R');
    expect(initialsOf('')).toBe('');
    expect(initialsOf(null)).toBe('');
  });
});

describe('who a note is for', () => {
  it('finds me among several recipients', () => {
    // 'VB/NG' in the sheet — two people, one note.
    expect(isForMe(note({ toUids: ['vin', 'neeru'] }), 'neeru')).toBe(true);
  });

  it('is false for somebody else’s note', () => {
    expect(isForMe(note({ toUids: ['vin'] }), 'rachel')).toBe(false);
  });

  it('puts an ALL note in everybody’s list', () => {
    // 82 notes are addressed to ALL. They are everyone's business.
    expect(isForMe(note({ toAll: true, toUids: [] }), 'anyone')).toBe(true);
  });

  it('is false when nobody is signed in', () => {
    expect(isForMe(note(), null)).toBe(false);
    expect(isForMe(null, 'vin')).toBe(false);
  });

  it('knows what I sent', () => {
    expect(isFromMe(note(), 'rahul')).toBe(true);
    expect(isFromMe(note(), 'vin')).toBe(false);
  });
});

describe('search', () => {
  it('finds a note by its subject', () => {
    expect(matchesQuery(note(), 'manjeet')).toBe(true);
  });

  it('finds one by words that are not next to each other', () => {
    const n = note({ subject: 'Student: Harshad', body: 'Amazon gift card was refunded' });
    expect(matchesQuery(n, 'harshad gift')).toBe(true);
  });

  it('searches the replies too — that is where the answer usually is', () => {
    const n = note({ replies: [{ name: 'Vin Bhatia', text: 'Sorted, refunded to the card' }] });
    expect(matchesQuery(n, 'refunded')).toBe(true);
  });

  it('finds one by who it came from', () => {
    expect(matchesQuery(note(), 'rahul')).toBe(true);
  });

  it('matches everything on an empty query', () => {
    expect(matchesQuery(note(), '')).toBe(true);
    expect(matchesQuery(note(), '   ')).toBe(true);
  });

  it('does not match a word that is absent', () => {
    expect(matchesQuery(note(), 'parking')).toBe(false);
  });
});

describe('sorting', () => {
  it('puts the newest LOGGED date first', () => {
    const rows = [
      note({ id: 'a', loggedAt: '2026-09-01' }),
      note({ id: 'b', loggedAt: '2026-09-10' }),
      note({ id: 'c', loggedAt: '2026-08-24' }),
    ];
    expect(sortNotes(rows).map(n => n.id)).toEqual(['b', 'a', 'c']);
  });

  it('breaks a same-day tie on when it was created', () => {
    const rows = [
      note({ id: 'a', loggedAt: '2026-09-10', createdAt: '2026-09-10T09:00:00Z' }),
      note({ id: 'b', loggedAt: '2026-09-10', createdAt: '2026-09-10T17:00:00Z' }),
    ];
    expect(sortNotes(rows).map(n => n.id)).toEqual(['b', 'a']);
  });

  it('does not mutate what it was given', () => {
    const rows = [note({ id: 'a', loggedAt: '2026-09-01' }), note({ id: 'b', loggedAt: '2026-09-10' })];
    sortNotes(rows);
    expect(rows.map(n => n.id)).toEqual(['a', 'b']);
  });
});

describe('sortSettled — most recently settled, not most recently logged', () => {
  const closed = (over) => note({ status: 'closed', ...over });

  it('orders notes settled in Ratio by when they were settled', () => {
    const rows = [
      closed({ id: 'old-note-settled-today', loggedAt: '2026-05-27', settledAt: '2026-09-14T16:01:39Z' }),
      closed({ id: 'new-note-settled-earlier', loggedAt: '2026-09-10', settledAt: '2026-09-12T03:14:43Z' }),
    ];
    expect(sortSettled(rows).map(n => n.id)).toEqual(['old-note-settled-today', 'new-note-settled-earlier']);
  });

  it('follows the spreadsheet row order for imported notes, whatever their logged date', () => {
    // The real top of the Settled Notes tab: 28 Aug above 2 Sep above 13 Aug.
    const rows = [
      closed({ id: 'row2', loggedAt: '2026-08-13', sheetOrder: 2 }),
      closed({ id: 'row0', loggedAt: '2026-08-28', sheetOrder: 0 }),
      closed({ id: 'row1', loggedAt: '2026-09-02', sheetOrder: 1 }),
    ];
    expect(sortSettled(rows).map(n => n.id)).toEqual(['row0', 'row1', 'row2']);
  });

  it('puts anything settled in Ratio above the whole import', () => {
    const rows = [
      closed({ id: 'imported', loggedAt: '2026-09-08', sheetOrder: 0 }),
      closed({ id: 'ratio', loggedAt: '2025-06-01', settledAt: '2026-09-12T00:00:00Z' }),
    ];
    expect(sortSettled(rows).map(n => n.id)).toEqual(['ratio', 'imported']);
  });

  it('falls back to the logged date for an import with no row order', () => {
    const rows = [
      closed({ id: 'unranked-new', loggedAt: '2026-09-09' }),
      closed({ id: 'ranked', loggedAt: '2025-01-01', sheetOrder: 1700 }),
      closed({ id: 'unranked-old', loggedAt: '2026-01-01' }),
    ];
    expect(sortSettled(rows).map(n => n.id)).toEqual(['ranked', 'unranked-new', 'unranked-old']);
  });

  it('treats a reopened note (settledAt cleared to null) as having no settle time', () => {
    const rows = [
      closed({ id: 'nulled', settledAt: null, sheetOrder: 5 }),
      closed({ id: 'ranked', sheetOrder: 3 }),
    ];
    expect(sortSettled(rows).map(n => n.id)).toEqual(['ranked', 'nulled']);
  });

  it('does not mutate what it was given', () => {
    const rows = [closed({ id: 'a', sheetOrder: 1 }), closed({ id: 'b', sheetOrder: 0 })];
    sortSettled(rows);
    expect(rows.map(n => n.id)).toEqual(['a', 'b']);
  });
});

describe('applyToArchive — Settled hears about writes it did not fetch', () => {
  const closed = (over) => note({ status: 'closed', ...over });

  it('puts a note just marked done into Settled', () => {
    const out = applyToArchive([closed({ id: 'x' })], note({ id: 'n1' }),
      { status: 'closed', settledAt: '2026-09-14T18:00:00Z' });
    expect(out.map(n => n.id)).toEqual(['n1', 'x']);
    expect(out[0].settledAt).toBe('2026-09-14T18:00:00Z');
  });

  it('takes a reopened note out of Settled', () => {
    const out = applyToArchive([closed({ id: 'n1' }), closed({ id: 'x' })], closed({ id: 'n1' }),
      { status: 'open', settledAt: null });
    expect(out.map(n => n.id)).toEqual(['x']);
  });

  it('keeps a reply to a settled note, in place of the old copy', () => {
    const r = [{ text: 'Called back, all sorted' }];
    const out = applyToArchive([closed({ id: 'n1' })], closed({ id: 'n1' }), { replies: r });
    expect(out).toHaveLength(1);
    expect(out[0].replies).toEqual(r);
  });

  it('leaves Settled alone when a reply goes on an open note', () => {
    const a = [closed({ id: 'x' })];
    expect(applyToArchive(a, note({ id: 'n1' }), { replies: [] }).map(n => n.id)).toEqual(['x']);
  });

  it('does nothing before Settled has been fetched', () => {
    expect(applyToArchive(null, note(), { status: 'closed' })).toBeNull();
  });
});

describe('the views', () => {
  const rows = [
    note({ id: 'forMe',     toUids: ['vin'], status: 'open' }),
    note({ id: 'forMeShut', toUids: ['vin'], status: 'Closed' }),
    note({ id: 'forOther',  toUids: ['neeru'], status: 'open' }),
    note({ id: 'toAll',     toUids: [], toAll: true, status: 'open' }),
    note({ id: 'fromMe',    fromUid: 'vin', toUids: ['neeru'], status: 'open' }),
  ];

  it('"For me" is open notes addressed to me, and nothing else', () => {
    // A settled note is not a thing you have to do. Leaving them in is
    // how an inbox stops being read.
    expect(filterNotes(rows, { view: 'mine', uid: 'vin' }).map(n => n.id).sort())
      .toEqual(['forMe', 'toAll']);
  });

  it('"All open" is everybody’s open notes', () => {
    expect(filterNotes(rows, { view: 'open', uid: 'vin' }).map(n => n.id).sort())
      .toEqual(['forMe', 'forOther', 'fromMe', 'toAll']);
  });

  it('"I sent" is mine regardless of status', () => {
    expect(filterNotes(rows, { view: 'sent', uid: 'vin' }).map(n => n.id))
      .toEqual(['fromMe']);
  });

  it('"Settled" is the old Settled Notes tab — a filter, not a second place', () => {
    expect(filterNotes(rows, { view: 'closed', uid: 'vin' }).map(n => n.id))
      .toEqual(['forMeShut']);
  });

  it('applies the search inside the view', () => {
    const withSubject = [
      note({ id: 'x', toUids: ['vin'], subject: 'Gift card for Ananya' }),
      note({ id: 'y', toUids: ['vin'], subject: 'Blog post reminder' }),
    ];
    expect(filterNotes(withSubject, { view: 'mine', uid: 'vin', q: 'ananya' }).map(n => n.id))
      .toEqual(['x']);
  });

  it('falls back to "For me" for a view that does not exist', () => {
    expect(filterNotes(rows, { view: 'nonsense', uid: 'vin' }).map(n => n.id).sort())
      .toEqual(['forMe', 'toAll']);
  });
});

describe('myOpenCount — the badge', () => {
  it('counts only open notes addressed to me', () => {
    const rows = [
      note({ toUids: ['vin'] }),
      note({ toUids: ['vin'], status: 'Closed' }),
      note({ toUids: ['neeru'] }),
      note({ toAll: true, toUids: [] }),
    ];
    expect(myOpenCount(rows, 'vin')).toBe(2);
  });

  it('is zero for nobody', () => {
    expect(myOpenCount([note()], null)).toBe(0);
    expect(myOpenCount(null, 'vin')).toBe(0);
  });
});

describe('validateNote', () => {
  const draft = { subject: 'Account: X', body: 'something', toUids: ['vin'], loggedAt: '2026-09-11' };

  it('accepts a complete note', () => {
    expect(validateNote(draft)).toBeNull();
  });

  it('insists on a subject, a body, a recipient and a date', () => {
    expect(validateNote({ ...draft, subject: '  ' })).toMatch(/subject/i);
    expect(validateNote({ ...draft, body: '' })).toMatch(/what the note is/i);
    expect(validateNote({ ...draft, toUids: [] })).toMatch(/who it/i);
    expect(validateNote({ ...draft, loggedAt: '' })).toMatch(/date/i);
  });

  it('accepts "everyone" instead of named recipients', () => {
    expect(validateNote({ ...draft, toUids: [], toAll: true })).toBeNull();
  });
});

describe('recipientNames', () => {
  const names = { vin: 'Vin Bhatia', neeru: 'Neeru Sharma' };

  it('names live accounts', () => {
    expect(recipientNames(note({ toUids: ['vin', 'neeru'] }), names))
      .toBe('Vin Bhatia, Neeru Sharma');
  });

  it('says Everyone for an ALL note', () => {
    expect(recipientNames(note({ toAll: true }), names)).toBe('Everyone');
  });

  it('falls back to the initials the spreadsheet had', () => {
    // Imported history is addressed to people who may have left. The
    // note must not lose who it was for.
    expect(recipientNames(note({ toUids: [], toLabel: 'JW/VS' }), names)).toBe('JW/VS');
  });

  it('says so plainly when there is nothing at all', () => {
    expect(recipientNames(note({ toUids: [], toLabel: '' }), names)).toBe('Unassigned');
  });
});

describe('deskMembers — who can be sent a note', () => {
  const roles = [
    { id: 'manager', name: 'Manager', permissions: ['notes.access'] },
    { id: 'host', name: 'Host', permissions: ['notes.access'] },
    { id: 'lead', name: 'Lead', permissions: ['scheduler.run'] },
    { id: 'instructor', name: 'Instructor', permissions: [] },
  ];
  const u = (uid, displayName, over = {}) => ({ uid, displayName, role: 'instructor', ...over });

  it('includes the seven management titles and nobody else', () => {
    const users = [
      u('o', 'Owner One', { role: 'owner' }),
      u('aa', 'Rachel R', { role: 'admin_assistant' }),
      u('ad', 'Admin One', { role: 'admin' }),
      u('d', 'Vin B', { role: 'director' }),
      u('m', 'Manager One', { centerMemberships: { c1: { instructorType: 'Manager' } } }),
      u('h', 'Host One', { centerMemberships: { c1: { instructorType: 'Host' } } }),
      u('l', 'Lead One', { centerMemberships: { c1: { instructorType: 'Lead' } } }),
      u('i', 'Instructor One', { centerMemberships: { c1: { instructorType: 'Instructor' } } }),
    ];
    expect(deskMembers(users, 'c1', roles).map(x => x.uid).sort())
      .toEqual(['aa', 'ad', 'd', 'h', 'm', 'o']);
  });

  it('sorts by name, so the picker is scannable', () => {
    const users = [u('b', 'Zoe Z', { role: 'admin' }), u('a', 'Aaron A', { role: 'admin' })];
    expect(deskMembers(users, 'c1', roles).map(x => x.displayName))
      .toEqual(['Aaron A', 'Zoe Z']);
  });

  it('picks up a role granted notes.access in Manage Roles', () => {
    // The escape hatch has to reach the picker too — a person you cannot
    // address is not really on the desk.
    const custom = [...roles, { id: 'al', name: 'Assistant Lead', permissions: ['notes.access'] }];
    const users = [u('x', 'Custom One', { centerMemberships: { c1: { instructorType: 'Assistant Lead' } } })];
    expect(deskMembers(users, 'c1', custom).map(x => x.uid)).toEqual(['x']);
  });

  it('leaves out a volunteer carrying a management title', () => {
    // Employment state beats job title everywhere else in Ratio.
    const users = [u('v', 'Vol One', { centerMemberships: { c1: { instructorType: 'Manager', isVolunteer: true } } })];
    expect(deskMembers(users, 'c1', roles).map(x => x.uid)).toEqual(['v']);
  });

  it('copes with no users at all', () => {
    expect(deskMembers(null, 'c1', roles)).toEqual([]);
    expect(deskMembers([], 'c1', roles)).toEqual([]);
  });
});

// ── Statuses: two became four, and the other two are sub-states of open ──

describe('the four statuses', () => {
  it('in progress and waiting are still OPEN work', () => {
    // isOpen means "not settled". The badge, the inbox and the archive
    // split all hang off it, so this is the load-bearing line.
    expect(isOpen({ status: 'open' })).toBe(true);
    expect(isOpen({ status: 'in_progress' })).toBe(true);
    expect(isOpen({ status: 'waiting' })).toBe(true);
    expect(isOpen({ status: 'closed' })).toBe(false);
  });

  it('still reads the spreadsheet’s hand-typed values', () => {
    // 1,853 imported rows, with 'Closed', 'closed' and 'CLOSED' all in them.
    expect(normaliseStatus('CLOSED')).toBe('closed');
    expect(normaliseStatus('Settled')).toBe('closed');
    expect(normaliseStatus('')).toBe('open');
    expect(normaliseStatus(undefined)).toBe('open');
    expect(normaliseStatus('In Progress')).toBe('in_progress');
    expect(normaliseStatus('in-progress')).toBe('in_progress');
    expect(normaliseStatus('blocked')).toBe('waiting');
    expect(normaliseStatus('anything else')).toBe('open');
  });

  it('the live query asks for exactly the open-ish ones', () => {
    // If these drift apart, a note changed to "in progress" vanishes off
    // the desk — which is what the old `status == "open"` query did.
    expect(LIVE_STATUSES).toEqual(['open', 'in_progress', 'waiting']);
    expect(LIVE_STATUSES.every(s => isOpen({ status: s }))).toBe(true);
    expect(LIVE_STATUSES).not.toContain('closed');
  });

  it('settling stamps who and when; moving back out clears it', () => {
    const closed = statusFields('closed', 'Neeru Gupta');
    expect(closed.status).toBe('closed');
    expect(closed.settledByName).toBe('Neeru Gupta');
    expect(closed.settledAt).toBeTruthy();
    // A reopened note must not keep the old settle date — the archive is
    // sorted by it.
    const reopened = statusFields('in_progress', 'Neeru Gupta');
    expect(reopened.settledAt).toBeNull();
    expect(reopened.settledByName).toBeNull();
  });
});

describe('due dates', () => {
  const TODAY = '2026-09-16';
  const due = (dueDate, extra = {}) => ({ status: 'open', dueDate, ...extra });

  it('says how it stands', () => {
    expect(dueState(due('2026-09-14'), TODAY)).toBe('overdue');
    expect(dueState(due('2026-09-16'), TODAY)).toBe('today');
    expect(dueState(due('2026-09-19'), TODAY)).toBe('soon');
    expect(dueState(due('2026-10-30'), TODAY)).toBe('later');
    expect(dueState(due(null), TODAY)).toBeNull();
    expect(dueState(due('nonsense'), TODAY)).toBeNull();
  });

  it('a settled note is never overdue — a thing that is done cannot be late', () => {
    expect(dueState(due('2026-09-01', { status: 'closed' }), TODAY)).toBe('settled');
  });

  it('counts days in centre-local time, not UTC', () => {
    // new Date('2026-09-17') is the 16th in Pacific; parsing at noon avoids it.
    expect(daysUntilDue(due('2026-09-17'), TODAY)).toBe(1);
    expect(daysUntilDue(due('2026-09-15'), TODAY)).toBe(-1);
    expect(daysUntilDue(due('2026-09-16'), TODAY)).toBe(0);
  });

  it('crosses a month end and a DST change without slipping a day', () => {
    expect(daysUntilDue(due('2026-10-01'), '2026-09-30')).toBe(1);
    // Pacific DST ends 2026-11-01.
    expect(daysUntilDue(due('2026-11-02'), '2026-10-31')).toBe(2);
  });

  it('reads in words', () => {
    expect(dueLabel(due('2026-09-15'), TODAY)).toBe('Overdue by a day');
    expect(dueLabel(due('2026-09-14'), TODAY)).toBe('Overdue by 2 days');
    expect(dueLabel(due('2026-09-16'), TODAY)).toBe('Due today');
    expect(dueLabel(due('2026-09-17'), TODAY)).toBe('Due tomorrow');
    expect(dueLabel(due(null), TODAY)).toBe('');
  });

  it('offers quick picks that are real dates', () => {
    const picks = dueSuggestions(TODAY);
    expect(picks.map(p => p.date)).toEqual(['2026-09-16', '2026-09-17', '2026-09-19', '2026-09-23']);
    expect(picks[0].label).toBe('Today');
  });
});

describe('your own list, ordered by what is pressing', () => {
  const TODAY = '2026-09-16';
  const n = (id, dueDate, loggedAt = '2026-09-10') => ({ id, status: 'open', dueDate, loggedAt });

  it('late first, then today, then the rest — undated last', () => {
    const rows = sortByDue([
      n('later', '2026-09-30'), n('undated', null), n('late', '2026-09-10'),
      n('today', '2026-09-16'), n('later-still', null, '2026-09-01'),
    ], TODAY);
    expect(rows.map(r => r.id)).toEqual(['late', 'today', 'later', 'undated', 'later-still']);
  });

  it('most overdue at the top', () => {
    const rows = sortByDue([n('a', '2026-09-14'), n('b', '2026-09-02')], TODAY);
    expect(rows.map(r => r.id)).toEqual(['b', 'a']);
  });
});

describe('the summary both the desk and the home card read', () => {
  const TODAY = '2026-09-16';
  const mine = (id, dueDate, extra = {}) => ({
    id, status: 'open', toUids: ['me'], loggedAt: '2026-09-05', dueDate, ...extra,
  });

  it('counts only what is waiting on you', () => {
    const s = deskSummary([
      mine('a', '2026-09-10'),                       // overdue
      mine('b', '2026-09-16'),                       // today
      mine('c', null),                               // no date
      mine('d', '2026-09-01', { status: 'closed' }), // settled — not yours to do
      { id: 'e', status: 'open', toUids: ['someone-else'], dueDate: '2026-09-10' },
    ], 'me', TODAY);
    expect(s.onYou).toBe(3);
    expect(s.overdue).toBe(1);
    expect(s.dueThisWeek).toBe(1);
    expect(s.items.map(i => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts a note addressed to everyone as yours', () => {
    const s = deskSummary([{ id: 'all', status: 'open', toAll: true, loggedAt: '2026-09-15' }], 'me', TODAY);
    expect(s.onYou).toBe(1);
  });

  it('reports the oldest thing on your desk, in days', () => {
    const s = deskSummary([mine('a', null, { loggedAt: '2026-09-05' })], 'me', TODAY);
    expect(s.oldestDays).toBe(11);
  });

  it('is all zeroes when you are clear', () => {
    const s = deskSummary([], 'me', TODAY);
    expect(s).toMatchObject({ onYou: 0, overdue: 0, dueThisWeek: 0, oldestDays: 0 });
    expect(s.items).toEqual([]);
  });
});

describe('who may erase a note rather than settle it', () => {
  // Mirrors `isOwnerLike() || isSuperAdmin()` on the notes rule. If these
  // drift apart, somebody gets a delete button that Firestore refuses.
  it('the owner tier can', () => {
    for (const platformRole of ['owner', 'admin_assistant', 'director', 'super_admin']) {
      expect(canDeleteNotes({ platformRole })).toBe(true);
    }
  });

  it('a director by legacy title can, the way the rules read it', () => {
    expect(canDeleteNotes({ platformRole: 'instructor', instructorType: 'Center Director' })).toBe(true);
    expect(canDeleteNotes({ platformRole: 'instructor', instructorType: 'Dir. of Education' })).toBe(true);
  });

  it('Managers, Hosts and the old Admin role cannot — they run the desk, they don’t clear it', () => {
    for (const instructorType of ['Manager', 'Host', 'Admin', 'Lead', 'Instructor']) {
      expect(canDeleteNotes({ platformRole: 'instructor', instructorType })).toBe(false);
    }
    expect(canDeleteNotes({ platformRole: 'admin', instructorType: 'Manager' })).toBe(false);
    expect(canDeleteNotes({})).toBe(false);
  });
});
