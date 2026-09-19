import { describe, it, expect } from 'vitest';
import { shiftsToRelabel, disagreeingShiftsByRole, batches } from './roleBackfill';

const CENTRE = 'langley';
const TODAY = '2026-09-17';

const shift = (over = {}) => ({
  id: 's1', centerId: CENTRE, date: TODAY, role: 'Instructor', ...over,
});

const ids = (list) => list.map(s => s.id);

describe('which shifts a promotion rewrites', () => {
  const promote = (shifts, over = {}) => shiftsToRelabel(shifts, {
    oldTitle: 'Instructor', newTitle: 'Lead', centerId: CENTRE, from: TODAY, ...over,
  });

  it('takes today and everything after it', () => {
    expect(ids(promote([
      shift({ id: 'today', date: TODAY }),
      shift({ id: 'tomorrow', date: '2026-09-18' }),
      shift({ id: 'december', date: '2026-12-01' }),
    ]))).toEqual(['today', 'tomorrow', 'december']);
  });

  it('leaves worked shifts alone, because a timesheet records the job done', () => {
    expect(promote([
      shift({ id: 'yesterday', date: '2026-09-16' }),
      shift({ id: 'august', date: '2026-08-02' }),
    ])).toEqual([]);
  });

  it('leaves a future shift deliberately scheduled as another role', () => {
    // The grid is built for "LEAD 11-3 covering for the owner, HOST 3-7".
    // A Host shift is real data, not a title that failed to keep up.
    expect(ids(promote([
      shift({ id: 'stale', role: 'Instructor' }),
      shift({ id: 'deliberate', role: 'Host' }),
      shift({ id: 'training', role: 'Training' }),
    ]))).toEqual(['stale']);
  });

  it('treats a shift with no role as the default the grid draws for it', () => {
    expect(ids(promote([shift({ id: 'bare', role: undefined })]))).toEqual(['bare']);
    // ...and only when that default is what they are being promoted out of.
    expect(promote([shift({ id: 'bare', role: undefined })], { oldTitle: 'Host' })).toEqual([]);
  });

  it('stays inside the centre the title changed at', () => {
    // instructorType lives on centerMemberships[centreId]; a promotion at
    // Langley says nothing about the same person's Burnaby shifts.
    expect(ids(promote([
      shift({ id: 'here', centerId: CENTRE }),
      shift({ id: 'elsewhere', centerId: 'burnaby' }),
    ]))).toEqual(['here']);
  });

  it('is a no-op the second time, since nothing carries the old title any more', () => {
    const shifts = [shift({ id: 'a' }), shift({ id: 'b' })];
    const first = promote(shifts);
    expect(ids(first)).toEqual(['a', 'b']);
    const after = shifts.map(s => ({ ...s, role: 'Lead' }));
    expect(promote(after)).toEqual([]);
  });

  it('does nothing when the title did not actually change', () => {
    expect(promote([shift()], { newTitle: 'Instructor' })).toEqual([]);
    expect(promote([shift()], { oldTitle: 'lead', newTitle: 'Lead' })).toEqual([]);
  });

  it('matches titles case-insensitively, since a centre can invent one', () => {
    expect(ids(promote([shift({ id: 'x', role: 'instructor' })]))).toEqual(['x']);
  });

  it('survives junk rather than throwing mid-promotion', () => {
    expect(shiftsToRelabel(null, { oldTitle: 'a', newTitle: 'b', centerId: CENTRE, from: TODAY })).toEqual([]);
    expect(promote([null, undefined, shift({ id: 'ok' }), { centerId: CENTRE }])).toHaveLength(1);
    expect(promote([shift()], { from: '' })).toEqual([]);
    expect(promote([shift()], { centerId: '' })).toEqual([]);
  });
});

describe('what disagrees with a title now', () => {
  const look = (shifts) => disagreeingShiftsByRole(shifts, {
    title: 'Lead', centerId: CENTRE, from: TODAY,
  });

  it('groups future shifts by the role they still carry', () => {
    const found = look([
      shift({ id: 'a', role: 'Instructor' }),
      shift({ id: 'b', role: 'Instructor' }),
      shift({ id: 'c', role: 'Host' }),
      shift({ id: 'd', role: 'Lead' }),
      shift({ id: 'past', role: 'Instructor', date: '2026-09-01' }),
      shift({ id: 'away', role: 'Instructor', centerId: 'burnaby' }),
    ]);
    expect([...found.keys()].sort()).toEqual(['Host', 'Instructor']);
    expect(ids(found.get('Instructor'))).toEqual(['a', 'b']);
    expect(ids(found.get('Host'))).toEqual(['c']);
  });

  it('is empty when every future shift already agrees', () => {
    expect(look([shift({ role: 'Lead' }), shift({ role: 'lead' })]).size).toBe(0);
  });
});

describe('batching the writes', () => {
  it('chunks under the 500-op Firestore cap', () => {
    const list = Array.from({ length: 900 }, (_, i) => i);
    const out = batches(list);
    expect(out.map(b => b.length)).toEqual([400, 400, 100]);
    expect(out.flat()).toEqual(list);
  });

  it('gives nothing back for nothing', () => {
    expect(batches([])).toEqual([]);
  });
});
