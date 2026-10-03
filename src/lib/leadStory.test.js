import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { storyOf, storyGaps, stageIndex, ymdOf, STORY_KEYS } from './leadStory';

// Frozen clock, same reason as leadFollowUp.test.js: these fixtures are
// fixed dates, and a suite that fails because the calendar moved stops
// being able to say anything about the code.
const NOW = new Date('2026-10-05T09:00:00');
beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

const lead = (over = {}) => ({
  id: 'l1', parentName: 'Valdete Geci', childName: 'Viola',
  status: 'new', createdAt: '2026-10-01T10:00:00', ...over,
});

const by = (steps, key) => steps.find(s => s.key === key);

describe('the day a stamp falls on', () => {
  it('reads the local day, not the UTC one', () => {
    // 5pm in Vancouver is already the next day in UTC. Dating this lead
    // the 2nd would put every evening enquiry on the wrong day — the bug
    // this codebase has already fixed twice elsewhere.
    const evening = new Date(2026, 9, 1, 17, 30).getTime();
    expect(ymdOf(evening)).toBe('2026-10-01');
  });

  it('says nothing when there is no stamp', () => {
    expect(ymdOf(null)).toBe('');
    expect(ymdOf(undefined)).toBe('');
    expect(ymdOf('')).toBe('');
  });

  it('takes a Firestore Timestamp, a Date, millis or a string', () => {
    const d = new Date(2026, 9, 1, 9, 0);
    expect(ymdOf(d)).toBe('2026-10-01');
    expect(ymdOf(d.getTime())).toBe('2026-10-01');
    expect(ymdOf({ toMillis: () => d.getTime() })).toBe('2026-10-01');
    expect(ymdOf('2026-10-01T09:00:00')).toBe('2026-10-01');
  });
});

describe('the six events', () => {
  it('always has the same six, in order', () => {
    expect(storyOf(lead()).map(s => s.key)).toEqual(STORY_KEYS);
  });

  it('counts the enquiry itself as done', () => {
    const got = by(storyOf(lead()), 'inquiry');
    expect(got.state).toBe('done');
    expect(got.on).toBe('2026-10-01');
  });

  it('leaves everything else hollow on a brand new lead', () => {
    const steps = storyOf(lead());
    expect(steps.filter(s => s.state === 'todo').map(s => s.key))
      .toEqual(['leadCall', 'booked', 'completed', 'enrolment', 'enrolled']);
  });
});

describe('leadCall', () => {
  it('counts a logged call', () => {
    expect(by(storyOf(lead({ lastContactOn: '2026-10-02' })), 'leadCall'))
      .toMatchObject({ state: 'done', on: '2026-10-02' });
  });

  it('counts the stamp from moving the status to Contacted', () => {
    expect(by(storyOf(lead({ status: 'contacted', contactedAt: '2026-10-03T14:00:00' })), 'leadCall'))
      .toMatchObject({ state: 'done', on: '2026-10-03' });
  });

  it('shows when they were FIRST reached, not most recently', () => {
    // A family rung again a week after their assessment must not draw a
    // Reached dot dated after the Assessment dot beside it — that is the
    // story told out of order.
    const got = by(storyOf(lead({
      status: 'completed', contactedAt: '2026-10-02T09:00:00', lastContactOn: '2026-10-04',
      assessmentOn: '2026-10-03', assessmentOutcome: 'attended',
    })), 'leadCall');
    expect(got.on).toBe('2026-10-02');
  });

  it('draws the five events in the order they happened', () => {
    const steps = storyOf(lead({
      status: 'completed', contactedAt: '2026-10-02T09:00:00', lastContactOn: '2026-10-04',
      assessmentOn: '2026-10-03', assessmentOutcome: 'attended',
    }));
    const dated = steps.filter(s => s.on).map(s => s.on);
    expect([...dated].sort()).toEqual(dated);
  });

  it('does not count the status word on its own', () => {
    // 'contacted' with no stamp behind it is somebody having changed a
    // dropdown. The dot stays hollow because nothing says when.
    expect(by(storyOf(lead({ status: 'contacted' })), 'leadCall').state).toBe('todo');
  });
});

describe('the assessment — booked is not done', () => {
  it('is planned when the date is still to come', () => {
    const got = by(storyOf(lead({ assessmentOn: '2026-10-09', assessmentOutcome: 'booked' })), 'booked');
    expect(got.state).toBe('planned');
    expect(got.unrecorded).toBe(false);
  });

  it('is still planned on the day itself — it has not happened yet', () => {
    expect(by(storyOf(lead({ assessmentOn: '2026-10-05', assessmentOutcome: 'booked' })), 'booked').state)
      .toBe('planned');
  });

  it('is only done once somebody says they attended', () => {
    expect(by(storyOf(lead({ assessmentOn: '2026-10-02', assessmentOutcome: 'attended' })), 'booked').state)
      .toBe('done');
  });

  it('flags a date that went by with no outcome recorded', () => {
    // The lead a pipeline quietly loses: it looks booked, it is three
    // days past, and nobody wrote down whether they walked in.
    const got = by(storyOf(lead({ assessmentOn: '2026-10-02', assessmentOutcome: 'booked' })), 'booked');
    expect(got.state).toBe('planned');
    expect(got.unrecorded).toBe(true);
  });

  it('does not flag an attended or broken one as unrecorded', () => {
    for (const o of ['attended', 'no-show', 'cancelled']) {
      expect(by(storyOf(lead({ assessmentOn: '2026-10-02', assessmentOutcome: o })), 'booked').unrecorded)
        .toBe(false);
    }
  });

  it('marks a no-show and a cancellation as broken, and says which', () => {
    expect(by(storyOf(lead({ assessmentOn: '2026-10-02', assessmentOutcome: 'no-show' })), 'booked'))
      .toMatchObject({ state: 'miss', label: 'No show' });
    expect(by(storyOf(lead({ assessmentOn: '2026-10-02', assessmentOutcome: 'cancelled' })), 'booked'))
      .toMatchObject({ state: 'miss', label: 'Cancelled' });
  });
});

describe('completed', () => {
  it('counts its own stamp', () => {
    expect(by(storyOf(lead({ status: 'completed', assessedAt: '2026-10-02T16:00:00' })), 'completed'))
      .toMatchObject({ state: 'done', on: '2026-10-02' });
  });

  it('counts an attended assessment on the day it was held', () => {
    expect(by(storyOf(lead({ assessmentOn: '2026-10-02', assessmentOutcome: 'attended' })), 'completed'))
      .toMatchObject({ state: 'done', on: '2026-10-02' });
  });

  it('stays hollow on an enrolled lead nobody wrote an assessment for', () => {
    // Honest rather than tidy: enrolling does not prove an assessment
    // was recorded, and inventing one here would be the confidently
    // wrong dashboard this codebase already deleted once.
    expect(by(storyOf(lead({ status: 'enrolled', enrolledAt: '2026-10-04T10:00:00' })), 'completed').state)
      .toBe('todo');
  });
});

describe('how it ended', () => {
  it('is won, on the day they enrolled', () => {
    expect(by(storyOf(lead({ status: 'enrolled', enrolledAt: '2026-10-04T10:00:00' })), 'enrolled'))
      .toMatchObject({ state: 'won', on: '2026-10-04' });
  });

  it('is lost, and says so', () => {
    expect(by(storyOf(lead({ status: 'lost', lostAt: '2026-10-04T10:00:00' })), 'enrolled'))
      .toMatchObject({ state: 'lost', label: 'Lost' });
  });
});

describe('the enrolment link, and what they did about it', () => {
  it('records sending the link as its own event', () => {
    expect(by(storyOf(lead({ enrolmentLinkSentOn: '2026-10-03' })), 'enrolment'))
      .toMatchObject({ state: 'done', on: '2026-10-03' });
  });

  it('keeps sending it apart from them acting on it', () => {
    // The gap between these two is where families are lost — the link
    // can sit in an inbox for a week. One step cannot show that.
    const steps = storyOf(lead({ enrolmentLinkSentOn: '2026-10-03' }));
    expect(by(steps, 'enrolment').state).toBe('done');
    expect(by(steps, 'enrolled').state).toBe('todo');
  });

  it('stands the family on the link they have not acted on yet', () => {
    const steps = storyOf(lead({
      lastContactOn: '2026-10-01', assessmentOn: '2026-10-02', assessmentOutcome: 'attended',
      assessedAt: '2026-10-02T15:00:00', enrolmentLinkSentOn: '2026-10-03',
    }));
    expect(steps.filter(s => s.now).map(s => s.key)).toEqual(['enrolled']);
  });

  it('measures how long the link has been sitting there', () => {
    const gaps = storyGaps(storyOf(lead({
      enrolmentLinkSentOn: '2026-10-01', status: 'enrolled', enrolledAt: '2026-10-04T10:00:00',
    })));
    expect(gaps[4]).toMatchObject({ days: 3, label: '3d' });
  });

  it('stays hollow when nobody recorded sending one', () => {
    expect(by(storyOf(lead()), 'enrolment').state).toBe('todo');
  });
});

describe('where the family is standing', () => {
  it('marks exactly one step, the first one still open', () => {
    const steps = storyOf(lead({ lastContactOn: '2026-10-02' }));
    expect(steps.filter(s => s.now).map(s => s.key)).toEqual(['booked']);
  });

  it('stands them on a booked assessment rather than past it', () => {
    const steps = storyOf(lead({ lastContactOn: '2026-10-02', assessmentOn: '2026-10-09', assessmentOutcome: 'booked' }));
    expect(steps.filter(s => s.now).map(s => s.key)).toEqual(['booked']);
  });

  it('stands them on the break when one happened', () => {
    const steps = storyOf(lead({ lastContactOn: '2026-10-02', assessmentOn: '2026-10-03', assessmentOutcome: 'no-show' }));
    expect(steps.filter(s => s.now).map(s => s.key)).toEqual(['booked']);
  });

  it('stands nobody anywhere once the story is over', () => {
    expect(storyOf(lead({ status: 'enrolled', enrolledAt: '2026-10-04T10:00:00' })).some(s => s.now)).toBe(false);
    expect(storyOf(lead({ status: 'lost', lostAt: '2026-10-04T10:00:00' })).some(s => s.now)).toBe(false);
  });
});

describe('how long each step took', () => {
  it('measures between two things that both happened', () => {
    const gaps = storyGaps(storyOf(lead({ lastContactOn: '2026-10-03' })));
    expect(gaps[0]).toMatchObject({ days: 2, label: '2d' });
  });

  it('says nothing about a gap with an open end', () => {
    // Nothing has happened after the enquiry, so the segment has no
    // length yet — labelling it "0d" would read as instant.
    expect(storyGaps(storyOf(lead()))).toEqual([null, null, null, null, null, null]);
  });

  it('drops a same-day gap rather than printing 0d', () => {
    expect(storyGaps(storyOf(lead({ lastContactOn: '2026-10-01' })))[0]).toBeNull();
  });

  it('has one entry per gap, with nothing after the last dot', () => {
    const steps = storyOf(lead());
    const gaps = storyGaps(steps);
    expect(gaps).toHaveLength(steps.length);
    expect(gaps[gaps.length - 1]).toBeNull();
  });

  it('labels a hop with how long that hop took, and nothing else', () => {
    const gaps = storyGaps(storyOf(lead({
      lastContactOn: '2026-10-03', assessmentOn: '2026-10-09', assessmentOutcome: 'booked',
    })));
    expect(gaps[0]).toMatchObject({ days: 2, label: '2d' });  // enquiry → reached
    expect(gaps[1]).toMatchObject({ days: 6, label: '6d' });  // reached → assessment
    expect(gaps[0].late).toBeUndefined();
  });

  it('measures to a booked date, because that is the wait the family gets', () => {
    const gaps = storyGaps(storyOf(lead({ lastContactOn: '2026-10-02', assessmentOn: '2026-10-09', assessmentOutcome: 'booked' })));
    expect(gaps[1]).toMatchObject({ days: 7 });
  });
});

describe('lead in, assessed within four days', () => {
  it('measures the whole wait, however many hops it took', () => {
    // Two hops with a call logged in between, one without. The number
    // the centre is judged on is the same either way: enquiry to the
    // day the family is seen.
    const twoHops = by(storyOf(lead({
      lastContactOn: '2026-10-02', assessmentOn: '2026-10-04', assessmentOutcome: 'booked',
    })), 'booked');
    const oneHop = by(storyOf(lead({ assessmentOn: '2026-10-04', assessmentOutcome: 'booked' })), 'booked');
    expect(twoHops.waitDays).toBe(3);
    expect(oneHop.waitDays).toBe(3);
  });

  it('is within the goal at four days and late at five', () => {
    expect(by(storyOf(lead({ assessmentOn: '2026-10-05', assessmentOutcome: 'booked' })), 'booked'))
      .toMatchObject({ waitDays: 4, late: false });
    expect(by(storyOf(lead({ assessmentOn: '2026-10-06', assessmentOutcome: 'booked' })), 'booked'))
      .toMatchObject({ waitDays: 5, late: true });
  });

  it('is not late when there is no assessment to have waited for', () => {
    // Absent, not zero, and certainly not "late" — a lead with nothing
    // booked has not missed a four-day goal, it has no measurement.
    const got = by(storyOf(lead()), 'booked');
    expect(got.waitDays).toBeNull();
    expect(got.late).toBe(false);
  });
});

describe('how far along they are', () => {
  it('counts the steps already behind them', () => {
    expect(stageIndex(lead())).toBe(1);
    expect(stageIndex(lead({ lastContactOn: '2026-10-02' }))).toBe(2);
    expect(stageIndex(lead({ lastContactOn: '2026-10-02', assessmentOn: '2026-10-03', assessmentOutcome: 'attended' }))).toBe(4);
  });

  it('puts a finished story past the end, so it sorts last', () => {
    expect(stageIndex(lead({ status: 'enrolled', enrolledAt: '2026-10-04T10:00:00' }))).toBe(6);
  });
});

describe('it does not fall over', () => {
  it('takes a lead with nothing on it at all', () => {
    const steps = storyOf({});
    expect(steps).toHaveLength(6);
    expect(by(steps, 'inquiry').on).toBe('');
    expect(storyGaps(steps).every(g => g === null)).toBe(true);
  });

  it('takes null', () => {
    expect(storyOf(null)).toHaveLength(6);
  });
});
