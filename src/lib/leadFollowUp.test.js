import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  actionFor, worklist, worklistByKind, ownedBy, unassigned,
  daysToAssessment, daysUntil, daysSince, monthKpis, scoreboard, familyLabel,
  URGENCY, DAYS_TO_ASSESSMENT_GOAL,
} from './leadFollowUp';

/**
 * The clock is frozen, for the reason intakeAvailability.test.js spells
 * out: these fixtures are fixed dates, and a suite that fails because the
 * calendar moved stops being able to say anything about the code.
 */
const NOW = new Date('2026-10-05T09:00:00');
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

const lead = (over = {}) => ({
  id: over.id || 'l1',
  parentName: 'Valdete Geci',
  childName: 'Viola Konjuhi',
  status: 'new',
  assignedTo: '',
  createdAt: daysAgo(1),
  ...over,
});

describe('one lead, one thing to do about it', () => {
  it('has nothing to say about a fresh lead', () => {
    expect(actionFor(lead())).toBeNull();
  });

  it('leaves enrolled and lost leads alone', () => {
    expect(actionFor(lead({ status: 'enrolled', createdAt: daysAgo(40) }))).toBeNull();
    expect(actionFor(lead({ status: 'lost', createdAt: daysAgo(40) }))).toBeNull();
  });

  it('puts today-s assessment at the top, and says who is touring', () => {
    const got = actionFor(lead({ assessmentOn: '2026-10-05', assessmentOutcome: 'booked', tourBy: 'Rahul' }));
    expect(got).toMatchObject({ kind: 'assessment-today', urgency: URGENCY.today });
    expect(got.why).toContain('Rahul');
  });

  it('says so when nobody is down to tour them', () => {
    const got = actionFor(lead({ assessmentOn: '2026-10-05', assessmentOutcome: 'booked' }));
    expect(got.why).toMatch(/nobody is down to tour/i);
  });

  it('asks what happened when an assessment has been and gone', () => {
    const got = actionFor(lead({ assessmentOn: '2026-10-02', assessmentOutcome: 'booked' }));
    expect(got).toMatchObject({ kind: 'assessment-unrecorded', urgency: URGENCY.overdue });
    expect(got.why).toContain('3 days ago');
  });

  it('chases a no-show, which used to look identical to never booking', () => {
    const got = actionFor(lead({ assessmentOn: '2026-10-02', assessmentOutcome: 'no-show' }));
    expect(got).toMatchObject({ kind: 'no-show' });
    expect(got.why).toContain('Valdete');
  });

  it('chases a cancellation', () => {
    expect(actionFor(lead({ assessmentOn: '2026-10-02', assessmentOutcome: 'cancelled' })).kind)
      .toBe('cancelled');
  });

  it('honours a follow-up date somebody set by hand', () => {
    expect(actionFor(lead({ followUpOn: '2026-10-05' })))
      .toMatchObject({ kind: 'follow-up-due', urgency: URGENCY.today });
    const late = actionFor(lead({ followUpOn: '2026-10-01' }));
    expect(late).toMatchObject({ kind: 'follow-up-due', urgency: URGENCY.overdue });
    expect(late.why).toContain('4 days ago');
  });

  it('says nothing about a follow-up that is still in the future', () => {
    expect(actionFor(lead({ followUpOn: '2026-10-09' }))).toBeNull();
  });

  it('nudges a family who were assessed and have not said yes or no', () => {
    const got = actionFor(lead({ status: 'assessed', assessedAt: daysAgo(3) }));
    expect(got).toMatchObject({ kind: 'assessed-undecided' });
    expect(got.why).toContain('3 days ago');
  });

  it('gives them a day or two first', () => {
    expect(actionFor(lead({ status: 'assessed', assessedAt: daysAgo(1) }))).toBeNull();
  });

  it('chases a lead nobody has booked in', () => {
    const got = actionFor(lead({ createdAt: daysAgo(4) }));
    expect(got).toMatchObject({ kind: 'no-assessment' });
    expect(got.why).toMatch(/nobody has reached them/i);
  });

  it('words it differently once somebody HAS reached them', () => {
    const got = actionFor(lead({ status: 'contacted', createdAt: daysAgo(4) }));
    expect(got.why).toMatch(/no assessment booked/i);
  });

  it('gives one lead ONE job, however many things are true of it', () => {
    // No-showed AND overdue follow-up AND old: still one phone call.
    const got = actionFor(lead({
      createdAt: daysAgo(20), assessmentOn: '2026-09-28',
      assessmentOutcome: 'no-show', followUpOn: '2026-10-01',
    }));
    expect(got.kind).toBe('no-show');
  });
});

describe('the list', () => {
  const leads = [
    lead({ id: 'cold', createdAt: daysAgo(9) }),
    lead({ id: 'today', assessmentOn: '2026-10-05', assessmentOutcome: 'booked' }),
    lead({ id: 'late', followUpOn: '2026-09-30' }),
    lead({ id: 'quiet' }),
  ];

  it('puts the person walking in today above everything else', () => {
    // Then, within equally overdue work, whoever has waited longest: the
    // nine-day-old lead nobody has reached outranks a follow-up that
    // slipped five days, because the family has been waiting twice as long.
    expect(worklist(leads).map(i => i.id)).toEqual(['today', 'cold', 'late']);
  });

  it('leaves out the leads with nothing to do', () => {
    expect(worklist(leads).some(i => i.id === 'quiet')).toBe(false);
  });

  it('groups by kind for a screen with headings', () => {
    expect(worklistByKind(leads).map(g => g.kind))
      .toEqual(['assessment-today', 'no-assessment', 'follow-up-due']);
  });

  it('narrows to one person-s own', () => {
    const mine = [lead({ id: 'a', assignedTo: 'Vin', followUpOn: '2026-10-01' }),
      lead({ id: 'b', assignedTo: 'Sabrina', followUpOn: '2026-10-01' })];
    expect(ownedBy(worklist(mine), 'vin').map(i => i.id)).toEqual(['a']);
  });

  it('names the live leads nobody owns', () => {
    const rows = [lead({ id: 'a' }), lead({ id: 'b', assignedTo: 'Vin' }),
      lead({ id: 'c', status: 'enrolled' })];
    expect(unassigned(rows).map(l => l.id)).toEqual(['a']);
  });

  it('survives junk', () => {
    expect(worklist(null)).toEqual([]);
    expect(actionFor(null)).toBeNull();
  });
});

describe('the numbers under the table', () => {
  it('measures the wait a family experiences, to the assessment date', () => {
    expect(daysToAssessment(lead({ createdAt: daysAgo(5), assessmentOn: '2026-10-08' }))).toBe(8);
    expect(daysToAssessment(lead({ createdAt: daysAgo(5) }))).toBeNull();
  });

  it('reports a rate as null, not zero, when there is nothing to divide by', () => {
    const got = monthKpis([]);
    expect(got.assessedRate).toBeNull();
    expect(got.conversionRate).toBeNull();
    expect(got.daysToAssessment).toBeNull();
    expect(got.meetsAssessmentGoal).toBeNull();
  });

  it('counts the way the sheet counts', () => {
    const got = monthKpis([
      lead({ id: '1', status: 'enrolled', assessmentOn: '2026-10-01', assessmentOutcome: 'attended', createdAt: daysAgo(8) }),
      lead({ id: '2', status: 'assessed', assessmentOn: '2026-10-02', assessmentOutcome: 'attended', createdAt: daysAgo(7) }),
      lead({ id: '3', assessmentOn: '2026-10-02', assessmentOutcome: 'no-show', createdAt: daysAgo(7) }),
      lead({ id: '4', assessmentOn: '2026-10-02', assessmentOutcome: 'cancelled', createdAt: daysAgo(7) }),
      lead({ id: '5', createdAt: daysAgo(6) }),
    ]);
    expect(got).toMatchObject({
      leads: 5, assessed: 2, enrolled: 1, noShows: 1, cancelled: 1, noAssessmentBooked: 1,
    });
    expect(got.assessedRate).toBeCloseTo(0.4);
    expect(got.assessedToEnrolled).toBeCloseTo(0.5);
  });

  it('says whether the centre is hitting the four-day goal', () => {
    const fast = monthKpis([lead({ createdAt: daysAgo(1), assessmentOn: '2026-10-07' })]);
    expect(fast.daysToAssessment).toBe(3);
    expect(fast.meetsAssessmentGoal).toBe(true);
    expect(DAYS_TO_ASSESSMENT_GOAL).toBe(4);
    const slow = monthKpis([lead({ createdAt: daysAgo(1), assessmentOn: '2026-10-20' })]);
    expect(slow.meetsAssessmentGoal).toBe(false);
  });
});

describe('who toured, who assessed', () => {
  const rows = [
    lead({ id: '1', tourBy: 'Sabrina', assessedBy: 'Vin', status: 'enrolled' }),
    lead({ id: '2', tourBy: 'Sabrina', assessedBy: 'Sabrina / Vin', status: 'enrolled' }),
    lead({ id: '3', tourBy: 'Rahul', assessedBy: 'Vin', status: 'lost' }),
  ];

  it('credits both names when two people did it together', () => {
    // "Sabrina / Vin" is a real cell in the sheet, and both of them were
    // in the room.
    const board = scoreboard(rows, 'assessedBy');
    expect(board.find(r => r.person === 'Vin')).toMatchObject({ total: 3, enrolled: 2 });
    expect(board.find(r => r.person === 'Sabrina')).toMatchObject({ total: 1, enrolled: 1 });
  });

  it('ranks by enrolments, and carries the rate', () => {
    const board = scoreboard(rows, 'tourBy');
    expect(board.map(r => r.person)).toEqual(['Sabrina', 'Rahul']);
    expect(board[0].rate).toBe(1);
    expect(board[1].rate).toBe(0);
  });

  it('ignores a blank', () => {
    expect(scoreboard([lead({ tourBy: '' })], 'tourBy')).toEqual([]);
  });
});

describe('small print', () => {
  it('names a family the way a person would', () => {
    expect(familyLabel(lead())).toBe('Valdete Geci · Viola Konjuhi');
    expect(familyLabel({ childName: 'Viola' })).toBe('Viola');
    expect(familyLabel({})).toBe('Unnamed lead');
  });

  it('reads a date at local noon, so it cannot slip a day', () => {
    expect(daysUntil('2026-10-05')).toBe(0);
    expect(daysUntil('2026-10-06')).toBe(1);
    expect(daysUntil('2026-10-04')).toBe(-1);
    expect(daysUntil('nonsense')).toBeNull();
  });

  it('reads the shapes a lead timestamp actually arrives in', () => {
    expect(daysSince(daysAgo(3))).toBe(3);
    expect(daysSince({ seconds: Math.floor((NOW.getTime() - 2 * 86400000) / 1000) })).toBe(2);
    expect(daysSince(null)).toBeNull();
  });
});
