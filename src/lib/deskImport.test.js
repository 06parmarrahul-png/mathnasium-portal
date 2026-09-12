import { describe, it, expect } from 'vitest';
import {
  resolveInitials, isEveryone, parseReplySignature,
  noteFromRow, notesFromRows, importSummary, chunk, BATCH_LIMIT,
} from './deskImport';

/**
 * Rows here are real ones out of the workbook. The import writes 1,853
 * documents into a live centre, so the cases that matter are the ones
 * where it could quietly lose something: a note whose recipient has left,
 * a reply nobody signed, a row that is blank padding.
 */

const MEMBERS = [
  { uid: 'u-vin', displayName: 'Vin Bhatia' },        // VB
  { uid: 'u-neeru', displayName: 'Neeru Gill' },      // NG
  { uid: 'u-rachel', displayName: 'Rachel Reyes' },   // RR
  { uid: 'u-rahul', displayName: 'Rahul Parmar' },    // RP
];

describe('resolveInitials', () => {
  it('finds one person', () => {
    expect(resolveInitials('VB', MEMBERS)).toEqual(['u-vin']);
  });

  it('finds both halves of a shared note', () => {
    // 'VB/NG' appears 14 times, 'NG/SK' 23 times.
    expect(resolveInitials('VB/NG', MEMBERS)).toEqual(['u-vin', 'u-neeru']);
  });

  it('handles the other separators the sheet uses', () => {
    expect(resolveInitials('VB, NG', MEMBERS)).toEqual(['u-vin', 'u-neeru']);
    expect(resolveInitials('RR & RP', MEMBERS)).toEqual(['u-rachel', 'u-rahul']);
  });

  it('ignores case and stray spacing', () => {
    expect(resolveInitials(' vb / ng ', MEMBERS)).toEqual(['u-vin', 'u-neeru']);
  });

  it('returns nothing for somebody who has left', () => {
    // JW, VS, MY, DP and others are all over the history with no current
    // account. The note keeps its label instead.
    expect(resolveInitials('JW/VS', MEMBERS)).toEqual([]);
  });

  it('keeps the people it CAN find when one of them has left', () => {
    expect(resolveInitials('VB/JW', MEMBERS)).toEqual(['u-vin']);
  });

  it('does not resolve ALL to a person', () => {
    expect(resolveInitials('ALL', MEMBERS)).toEqual([]);
    expect(isEveryone('ALL')).toBe(true);
    expect(isEveryone('All')).toBe(true);
    expect(isEveryone('VB')).toBe(false);
  });

  it('never lists the same person twice', () => {
    expect(resolveInitials('VB/VB', MEMBERS)).toEqual(['u-vin']);
  });

  it('copes with nothing', () => {
    expect(resolveInitials('', MEMBERS)).toEqual([]);
    expect(resolveInitials(null, MEMBERS)).toEqual([]);
    expect(resolveInitials('VB', null)).toEqual([]);
  });
});

describe('parseReplySignature', () => {
  it('lifts a signature off the end', () => {
    const out = parseReplySignature("9/2: Thanks, I've taken note of this! - RR");
    expect(out.initials).toBe('RR');
    expect(out.text).toBe("9/2: Thanks, I've taken note of this!");
  });

  it('handles an en dash', () => {
    expect(parseReplySignature('9/11: Done – VB').initials).toBe('VB');
  });

  it('leaves an unsigned reply unattributed rather than guessing', () => {
    // The reply columns were headed with a GROUP, so there is often no
    // way to know who wrote one. Inventing an author would be worse.
    const out = parseReplySignature('8/18: Looks good; can you pop the notes into Radius?');
    expect(out.initials).toBeNull();
    expect(out.text).toBe('8/18: Looks good; can you pop the notes into Radius?');
  });

  it('does not mistake a trailing dash for a signature', () => {
    expect(parseReplySignature('Noted -').initials).toBeNull();
  });

  it('does not eat the whole reply when it is only a signature', () => {
    expect(parseReplySignature('- RR').text).toBe('- RR');
  });
});

describe('noteFromRow', () => {
  const row = (over = {}) => ({
    to: 'VB', from: 'RR',
    subject: 'Account: Manjeet Kaur',
    body: 'Card was declined for this month’s payment.',
    loggedAt: '2026-09-01', status: 'open',
    replies: ["9/2: Thanks, I've taken note of this! - RR"],
    ...over,
  });

  it('maps a row onto a note', () => {
    const n = noteFromRow(row(), MEMBERS);
    expect(n.toUids).toEqual(['u-vin']);
    expect(n.fromUid).toBe('u-rachel');
    expect(n.fromName).toBe('Rachel Reyes');
    expect(n.subject).toBe('Account: Manjeet Kaur');
    expect(n.status).toBe('open');
    expect(n.imported).toBe(true);
  });

  it('turns the reply columns into one thread', () => {
    const n = noteFromRow(row({ replies: ['8/18: Looks good', '9/2: Sorted - RR'] }), MEMBERS);
    expect(n.replies.map(r => r.text)).toEqual(['8/18: Looks good', '9/2: Sorted']);
    expect(n.replies[1].initials).toBe('RR');
  });

  it('drops empty reply columns rather than making blank replies', () => {
    const n = noteFromRow(row({ replies: ['', '   ', null] }), MEMBERS);
    expect(n.replies).toEqual([]);
  });

  it('keeps the label when nobody matches, so the note still says who', () => {
    const n = noteFromRow(row({ to: 'JW/VS' }), MEMBERS);
    expect(n.toUids).toEqual([]);
    expect(n.toLabel).toBe('JW/VS');
  });

  it('marks an ALL note as everyone’s', () => {
    const n = noteFromRow(row({ to: 'ALL' }), MEMBERS);
    expect(n.toAll).toBe(true);
    expect(n.toLabel).toBe('Everyone');
  });

  it('carries the logged date into createdAt so sorting works', () => {
    const n = noteFromRow(row({ loggedAt: '2025-11-18' }), MEMBERS);
    expect(n.createdAt.startsWith('2025-11-18')).toBe(true);
  });

  it('skips a blank padding row', () => {
    // The settled tab runs to row 1733 with empties in it.
    expect(noteFromRow({ to: '', from: '', subject: '', body: '' }, MEMBERS)).toBeNull();
    expect(noteFromRow({}, MEMBERS)).toBeNull();
  });

  it('keeps a row that has a body but no subject', () => {
    const n = noteFromRow(row({ subject: '' }), MEMBERS);
    expect(n.subject).toBe('(no subject)');
    expect(n.body).toBeTruthy();
  });

  it('treats anything but "closed" as open', () => {
    expect(noteFromRow(row({ status: '' }), MEMBERS).status).toBe('open');
    expect(noteFromRow(row({ status: 'closed' }), MEMBERS).status).toBe('closed');
  });
});

describe('notesFromRows', () => {
  it('drops the empties and keeps the order', () => {
    const rows = [
      { subject: 'A', body: 'x', loggedAt: '2026-01-01' },
      {},
      { subject: 'B', body: 'y', loggedAt: '2026-01-02' },
    ];
    expect(notesFromRows(rows, MEMBERS).map(n => n.subject)).toEqual(['A', 'B']);
  });

  it('copes with no rows', () => {
    expect(notesFromRows(null, MEMBERS)).toEqual([]);
  });
});

describe('importSummary — what it will do, before it does it', () => {
  it('counts everything, and says how much it could not address', () => {
    // Writing 1,853 documents into a live centre is not a thing to do on
    // a button press with no idea of the shape of it.
    const payload = {
      notes: [
        { to: 'VB', subject: 'A', body: 'x', status: 'open' },
        { to: 'JW', subject: 'B', body: 'y', status: 'closed' },
        { to: 'ALL', subject: 'C', body: 'z', status: 'closed' },
        {},
      ],
      giftCards: [{}, {}],
      receipts: [{}],
      referrals: [],
      studentOfMonth: [{}],
    };
    const s = importSummary(payload, MEMBERS);
    expect(s.notes).toBe(3);
    expect(s.notesAddressed).toBe(2);       // VB and ALL
    expect(s.notesUnmatched).toBe(1);       // JW has no account
    expect(s.open).toBe(1);
    expect(s.giftCards).toBe(2);
    expect(s.receipts).toBe(1);
    expect(s.referrals).toBe(0);
    expect(s.studentOfMonth).toBe(1);
  });

  it('copes with a payload missing whole sections', () => {
    const s = importSummary({}, MEMBERS);
    expect(s.notes).toBe(0);
    expect(s.giftCards).toBe(0);
  });
});

describe('chunk', () => {
  it('splits under the Firestore batch limit', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    const out = chunk(rows);
    expect(out.length).toBe(Math.ceil(1000 / BATCH_LIMIT));
    expect(out.flat().length).toBe(1000);
    expect(Math.max(...out.map(c => c.length))).toBeLessThanOrEqual(500);
  });

  it('copes with nothing and with less than one chunk', () => {
    expect(chunk([])).toEqual([]);
    expect(chunk(null)).toEqual([]);
    expect(chunk([1, 2, 3])).toEqual([[1, 2, 3]]);
  });
});
