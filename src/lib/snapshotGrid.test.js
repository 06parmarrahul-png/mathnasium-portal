import { describe, it, expect } from 'vitest';
import {
  mins, dayAxis, snapshotRows, groupRows, instructorsPerSlot, snapshotTotals,
  whoIsRunningIt, peakWindow, rolePriority, subPriorityInTier, isTrainingRole,
} from './snapshotGrid';

/**
 * Langley's REAL roster for Thursday 17 September 2026, copied out of
 * Firestore — the day in the screenshot this card was built from.
 *
 * It is here so the condensed snapshot can be checked against the classic
 * one figure by figure. If these tests start failing, either the rules
 * changed or the two surfaces have drifted; both are worth stopping for.
 */
const SEP17 = [
  ['Aidan Jeremy Yun', '16:00', '19:00', 'Training', 'Highschool'],
  ['Ainsley MacDonald', '15:30', '19:00', 'Instructor', 'Elementary'],
  ['Anthony Fung', '15:30', '19:00', 'Instructor', 'Elementary'],
  ['Arham Ahmed', '15:30', '19:00', 'Instructor', 'Highschool'],
  ['Bri MacDonald', '15:00', '19:00', 'Lead', 'Elementary'],
  ['Caleb Schelp', '15:00', '18:30', 'Instructor', 'Highschool'],
  ['Idan Kanevsky', '16:00', '18:30', 'Instructor', 'Elementary'],
  ['Krishnaja Tikkisetty', '15:00', '19:00', 'Lead', 'Online'],
  ['Luke Huang', '13:00', '19:00', 'Lead', 'Highschool'],
  ['Maria Fahim', '15:00', '19:00', 'Instructor', 'Elementary'],
  ['Meekal Jiwani', '15:30', '18:30', 'Instructor', 'Elementary'],
  ['Mohid Rashid', '15:00', '18:30', 'Instructor', 'Highschool'],
  ['Neeru Gill', '11:30', '19:30', 'Dir. of Education', ''],
  ['Rachel Rozelle', '10:00', '14:00', 'Admin', ''],
  ['Rahul Parmar', '14:45', '18:45', 'Host', ''],
  ['Sofie Rzepinski', '15:30', '18:30', 'Instructor', 'Elementary'],
].map(([userName, startTime, endTime, role, subRole], i) => ({
  id: `s${i}`, userName, startTime, endTime, role, subRole,
  centerId: 'langley', date: '2026-09-17', status: 'live',
}));

const rowsOf = (shifts = SEP17, opts) => snapshotRows(shifts, opts);

describe('reading a time off a shift', () => {
  it('parses the wall clock the shifts actually store', () => {
    expect(mins('15:30')).toBe(930);
    expect(mins('9:05')).toBe(545);
  });

  it('gives NaN for junk rather than a plausible zero', () => {
    // 0 would be midnight, and midnight sorts first — a bad row would
    // silently lead the grid.
    expect(mins('')).toBeNaN();
    expect(mins(undefined)).toBeNaN();
    expect(mins('soon')).toBeNaN();
  });
});

describe('the day the shifts describe', () => {
  it('spans the real roster, not a hardcoded 3-to-7', () => {
    const a = dayAxis(rowsOf());
    expect(a.from).toBe(mins('10:00'));      // Rachel opens
    expect(a.to).toBe(mins('19:30'));        // Neeru closes
    expect(a.slots).toHaveLength(19);        // the screenshot's 19 half hours
  });

  it('snaps outwards so an odd start still has a column', () => {
    const a = dayAxis([{ startTime: '14:45', endTime: '18:45' }]);
    expect(a.from).toBe(mins('14:30'));
    expect(a.to).toBe(mins('19:00'));
  });

  it('has nothing to draw for a day with nobody on', () => {
    expect(dayAxis([]).slots).toEqual([]);
    expect(dayAxis(null).slots).toEqual([]);
    expect(dayAxis([{ startTime: 'x', endTime: 'y' }]).slots).toEqual([]);
  });
});

describe('who is on, in what order', () => {
  it('drops drafts and cancellations — they are not shifts anyone works', () => {
    const rows = rowsOf([
      ...SEP17,
      { id: 'd', userName: 'Draft', startTime: '15:00', endTime: '19:00', role: 'Instructor', status: 'draft' },
      { id: 'c', userName: 'Gone', startTime: '15:00', endTime: '19:00', role: 'Instructor', status: 'cancelled' },
    ]);
    expect(rows).toHaveLength(16);
  });

  it('groups exactly as the classic grid does', () => {
    const groups = groupRows(rowsOf());
    expect(groups.map(g => [g.label, g.rows.length])).toEqual([
      ['Hosts & Management', 3],
      ['Online Instructors', 1],
      ['In-Centre Instructors', 11],
      ['Training', 1],
    ]);
  });

  it('orders management, then leads, then high school, then elementary', () => {
    const groups = groupRows(rowsOf());
    // Neeru (Dir. of Education), then Rahul (Host), then Rachel — which
    // is the order the classic grid shows on this day, so it is the order
    // pinned here. It is NOT the order the rule intends: that table reads
    // CD -> Dir Ed -> Manager -> Admin Assistant -> Host, but it matches
    // the string 'Admin Assistant' while an admin assistant's shift stores
    // role 'Admin'. So she never matches and falls to the bottom of the
    // tier instead of fourth. Left alone deliberately — correcting it here
    // would reorder the classic grid people already read.
    expect(groups[0].rows.map(r => r.userName))
      .toEqual(['Neeru Gill', 'Rahul Parmar', 'Rachel Rozelle']);
    expect(groups[2].rows.map(r => r.userName)).toEqual([
      'Bri MacDonald', 'Luke Huang',                                 // Leads, alphabetical
      'Arham Ahmed', 'Caleb Schelp', 'Mohid Rashid',                 // High school
      'Ainsley MacDonald', 'Anthony Fung', 'Idan Kanevsky',
      'Maria Fahim', 'Meekal Jiwani', 'Sofie Rzepinski',             // Elementary
    ]);
  });

  it('files an online lead under Online, on the sub-role alone', () => {
    // Krishnaja is role:'Lead', subRole:'Online'. Most centres tag online
    // staff this way rather than with an 'Online Instructor' role.
    const k = rowsOf().find(r => r.userName === 'Krishnaja Tikkisetty');
    expect(k.tier).toBe(1);
  });

  it('keeps a volunteer out of the in-centre block whatever their shift says', () => {
    const rows = rowsOf(SEP17, { volunteerNames: new Set(['Maria Fahim']) });
    expect(rows.find(r => r.userName === 'Maria Fahim').tier).toBe(3);
  });

  it('keeps a trainee out of it too', () => {
    expect(rowsOf().find(r => r.userName === 'Aidan Jeremy Yun').tier).toBe(5);
    expect(isTrainingRole('Training')).toBe(true);
    expect(isTrainingRole('training')).toBe(true);
    expect(isTrainingRole('Instructor')).toBe(false);
  });

  it('sends a legacy flexRole shift to its own tier', () => {
    expect(rolePriority('Instructor', 'Elementary', false, 'STEAM')).toBe(4);
  });

  it('drops an unrecognised role to the bottom of its tier rather than hiding it', () => {
    expect(subPriorityInTier(0, 'Caretaker')).toBe(5);
    expect(subPriorityInTier(2, 'Something', 'Other')).toBe(3);
  });
});

describe('the figures, against the real day', () => {
  it('counts instructors each half hour exactly as the screenshot does', () => {
    // This is the classic grid's Instructors footer row for 17 Sep. If the
    // condensed card ever disagrees with the full one, it disagrees here.
    const rows = rowsOf();
    expect(instructorsPerSlot(rows, dayAxis(rows).slots))
      .toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 6, 11, 12, 12, 12, 12, 12, 7, 0]);
  });

  it('totals the day the way the classic tiles do', () => {
    const t = snapshotTotals(rowsOf());
    expect(t.people).toBe(16);
    expect(t.instructors).toBe(12);
    expect(t.host).toBe(1);
    expect(t.hours).toBe(63.0);
  });

  it('counts the online lead, where the classic tile reads zero', () => {
    // The classic tile asks role === 'Online Instructor' and so reads 0 on
    // this day, while the grid beneath it files Krishnaja under Online.
    // This is the fixed reading; the classic one is still wrong.
    expect(snapshotTotals(rowsOf()).online).toBe(1);
  });

  it('obeys the shift-s own ratio field over its role', () => {
    // The whole point of the includedInRatio toggle: a Host explicitly in
    // counts, an Instructor explicitly out does not. Nothing here may
    // re-decide that from the role.
    const rows = rowsOf([
      { id: 'a', userName: 'Host In', startTime: '15:00', endTime: '16:00', role: 'Host', includedInRatio: true },
      { id: 'b', userName: 'Tutor Out', startTime: '15:00', endTime: '16:00', role: 'Instructor', includedInRatio: false },
    ]);
    expect(snapshotTotals(rows).instructors).toBe(1);
    expect(instructorsPerSlot(rows, [mins('15:00')])).toEqual([1]);
  });

  it('never counts a volunteer toward the floor', () => {
    const rows = rowsOf(SEP17, { volunteerNames: new Set(['Maria Fahim']) });
    expect(snapshotTotals(rows).instructors).toBe(11);
  });

  it('names everyone leading, not whichever one came back first', () => {
    // Three Leads were on that day. The floor card used to name one of
    // them, whichever Firestore happened to return first.
    const { leads, host } = whoIsRunningIt(rowsOf());
    expect(leads).toEqual(['Bri MacDonald', 'Luke Huang', 'Krishnaja Tikkisetty'].sort(
      (a, b) => rowsOf().findIndex(r => r.userName === a) - rowsOf().findIndex(r => r.userName === b)));
    expect(host).toBe('Rahul Parmar');
  });

  it('finds the longest run at the busiest level', () => {
    const rows = rowsOf();
    const slots = dayAxis(rows).slots;
    const peak = peakWindow(instructorsPerSlot(rows, slots), slots);
    expect(peak.max).toBe(12);
    expect(peak.from).toBe(mins('16:00'));
    expect(peak.to).toBe(mins('18:30'));
  });

  it('has no peak on an empty day rather than a peak of nothing', () => {
    expect(peakWindow([], [])).toBe(null);
    expect(peakWindow([0, 0], [600, 630])).toBe(null);
  });
});
