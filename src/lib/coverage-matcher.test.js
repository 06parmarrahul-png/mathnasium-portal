import { describe, it, expect } from 'vitest';
import { isEligible, matchDay, toDraftDay, PRIORITY_WEIGHT_MINUTES, LEAD_HEAD_START_MINUTES } from './coverage-matcher';

const person = (uid, over = {}) => ({
  uid,
  displayName: uid,
  subRoles: ['Elementary'],
  priority: 2,
  availStart: '15:00',
  availEnd: '19:00',
  ...over,
});

const block = (startTime, endTime, capability = 'Instructor') => ({
  capability, startTime, endTime,
  minutes: (Number(endTime.split(':')[0]) * 60 + Number(endTime.split(':')[1]))
         - (Number(startTime.split(':')[0]) * 60 + Number(startTime.split(':')[1])),
});

describe('isEligible', () => {
  it('needs availability to cover the whole block', () => {
    const b = block('16:00', '19:00');
    expect(isEligible(person('a'), b)).toBe(true);
    // Available 17:00–19:00 cannot work a 16:00 start — a partial fit
    // would leave the first hour uncovered.
    expect(isEligible(person('b', { availStart: '17:00' }), b)).toBe(false);
    expect(isEligible(person('c', { availEnd: '18:00' }), b)).toBe(false);
  });

  it('enforces the capability the block asks for', () => {
    const hs = block('16:00', '19:00', 'Highschool');
    expect(isEligible(person('elem'), hs)).toBe(false);
    expect(isEligible(person('hs', { subRoles: ['Highschool'] }), hs)).toBe(true);
    expect(isEligible(person('both', { subRoles: ['Elementary', 'Highschool'] }), hs)).toBe(true);
  });

  it('treats a legacy Both tag as covering either level', () => {
    // Same expansion the rest of the app uses — a Both-tagged instructor
    // is not locked out of Highschool blocks.
    expect(isEligible(person('legacy', { subRoles: ['Both'] }),
      block('16:00', '19:00', 'Highschool'))).toBe(true);
  });

  it('lets a generic Instructor block take anyone', () => {
    expect(isEligible(person('x', { subRoles: [] }), block('16:00', '19:00'))).toBe(true);
  });
});

describe('matchDay — the fairness rule', () => {
  it('gives the shift to whoever has the fewest hours', () => {
    // The owner's rule, verbatim: 12 hours vs 3 hours, pick the 3.
    const { assignments } = matchDay({
      skeletons: [block('15:00', '19:00')],
      candidates: [person('busy'), person('quiet')],
      minutesSoFar: { busy: 12 * 60, quiet: 3 * 60 },
    });
    expect(assignments[0].displayName).toBe('quiet');
  });

  it('counts HOURS, not shift count — the trap the old metric falls into', () => {
    // `many` has MORE shifts (4) but FEWER hours (8) than `few` (3 shifts,
    // 12h). Counting shifts would pick `few`; counting hours picks `many`,
    // which is the person actually owed work.
    const { assignments } = matchDay({
      skeletons: [block('15:00', '19:00')],
      candidates: [person('few'), person('many')],
      minutesSoFar: { few: 12 * 60, many: 8 * 60 },
    });
    expect(assignments[0].displayName).toBe('many');
  });

  it('lets priority lead, but not forever', () => {
    // A priority-1 with a modest head start still wins...
    const lead = matchDay({
      skeletons: [block('15:00', '19:00')],
      candidates: [person('p1', { priority: 1 }), person('p3', { priority: 3 })],
      minutesSoFar: {},
    });
    expect(lead.assignments[0].displayName).toBe('p1');

    // ...but once they're far enough ahead, fairness overtakes.
    const caughtUp = matchDay({
      skeletons: [block('15:00', '19:00')],
      candidates: [person('p1', { priority: 1 }), person('p3', { priority: 3 })],
      minutesSoFar: { p1: 10 * PRIORITY_WEIGHT_MINUTES },
    });
    expect(caughtUp.assignments[0].displayName).toBe('p3');
  });

  it('accrues hours across the day so one person is not stacked', () => {
    const { assignments, minutesSoFar } = matchDay({
      skeletons: [block('15:00', '17:00'), block('17:00', '19:00')],
      candidates: [person('a'), person('b')],
      oneShiftPerPerson: false,
    });
    expect(assignments).toHaveLength(2);
    // Second block goes to the other person, not the same one twice.
    expect(new Set(assignments.map(a => a.displayName)).size).toBe(2);
    expect(minutesSoFar.a).toBe(120);
    expect(minutesSoFar.b).toBe(120);
  });
});

describe('matchDay — scarcity handling', () => {
  it('fills the hardest block first so specialists are not wasted', () => {
    // Only `hsOnly` can work the Highschool block. If the generic block
    // were filled first and took them, the HS block would go unfilled.
    const { assignments, unfilled } = matchDay({
      skeletons: [block('15:00', '19:00', 'Instructor'), block('15:00', '19:00', 'Highschool')],
      candidates: [person('hsOnly', { subRoles: ['Highschool'] }), person('elem')],
    });
    expect(unfilled).toHaveLength(0);
    const hs = assignments.find(a => a.capability === 'Highschool');
    expect(hs.displayName).toBe('hsOnly');
  });

  it('prefers the less flexible person for a specialised block', () => {
    // Keep the dual-capable instructor free for whatever comes next.
    const { assignments } = matchDay({
      skeletons: [block('15:00', '19:00', 'Highschool')],
      candidates: [
        person('flexible', { subRoles: ['Elementary', 'Highschool'] }),
        person('hsOnly',   { subRoles: ['Highschool'] }),
      ],
    });
    expect(assignments[0].displayName).toBe('hsOnly');
  });

  it('reports blocks nobody can work instead of forcing a bad fit', () => {
    const { assignments, unfilled } = matchDay({
      skeletons: [block('10:00', '14:00')],       // nobody is available then
      candidates: [person('a')],
    });
    expect(assignments).toHaveLength(0);
    expect(unfilled).toHaveLength(1);
    expect(unfilled[0].startTime).toBe('10:00');
  });

  it('does not double-book a person on the same day by default', () => {
    const { assignments, unfilled } = matchDay({
      skeletons: [block('15:00', '17:00'), block('17:00', '19:00')],
      candidates: [person('only')],
    });
    expect(assignments).toHaveLength(1);
    expect(unfilled).toHaveLength(1);
  });
});

describe('toDraftDay', () => {
  it('shapes a match into what the existing draft UI renders', () => {
    const { assignments, unfilled } = matchDay({
      skeletons: [block('15:00', '19:00'), block('16:00', '19:00', 'Highschool')],
      candidates: [person('a'), person('b', { subRoles: ['Highschool'] })],
    });
    const day = toDraftDay({
      dateStr: '2026-09-07', dayName: 'Monday', dayNumber: 7, assignments, unfilled,
    });
    expect(day.date).toBe('2026-09-07');
    expect(day.assignedEmployees).toHaveLength(2);
    expect(day.shiftTimes.b).toBe('16:00 - 19:00');
    expect(day.subRoles.b).toBe('Highschool');
    expect(day.roles.a).toBe('Instructor');
    expect(day.openSlotsNeeded).toBe(0);
  });

  it('carries the unfilled blocks through, not just a count', () => {
    const day = toDraftDay({
      dateStr: '2026-09-07', dayName: 'Monday', dayNumber: 7,
      assignments: [],
      unfilled: [block('15:00', '19:00', 'Highschool')],
    });
    expect(day.openSlotsNeeded).toBe(1);
    expect(day.unfilledShifts[0]).toMatchObject({
      capability: 'Highschool', startTime: '15:00', endTime: '19:00',
    });
  });

  it('states the day\'s own target so the review screen stops using minPerDay', () => {
    const day = toDraftDay({
      dateStr: '2026-09-07', dayName: 'Monday', dayNumber: 7,
      assignments: [
        { displayName: 'a', capability: 'Instructor', startTime: '15:00', endTime: '19:00' },
        { displayName: 'b', capability: 'Instructor', startTime: '16:00', endTime: '19:00' },
      ],
      unfilled: [block('16:00', '19:00')],
    });
    // 2 filled + 1 nobody could work = the day genuinely wanted 3.
    expect(day.countingStaffCount).toBe(2);
    expect(day.targetStaffCount).toBe(3);
  });

  it('gives a block to its preferred person when they can work it', () => {
    // The centre's designated host takes the host shift even though a
    // colleague has fewer hours — that's the point of naming them.
    const { assignments } = matchDay({
      skeletons: [{ ...block('15:00', '19:00', 'Host'), preferredNames: ['Rahul Parmar'] }],
      candidates: [
        person('Rahul Parmar', { subRoles: ['Host'] }),
        person('Someone Else', { subRoles: ['Host'] }),
      ],
      minutesSoFar: { 'Rahul Parmar': 20 * 60, 'Someone Else': 0 },
    });
    expect(assignments[0].displayName).toBe('Rahul Parmar');
  });

  it('falls back to anyone host-capable when the preferred host cannot work', () => {
    const { assignments, unfilled } = matchDay({
      skeletons: [{ ...block('15:00', '19:00', 'Host'), preferredNames: ['Rahul Parmar'] }],
      candidates: [
        // Rahul is only free from 17:00, so he can't cover the block.
        person('Rahul Parmar', { subRoles: ['Host'], availStart: '17:00' }),
        person('Someone Else', { subRoles: ['Host'] }),
      ],
    });
    expect(unfilled).toHaveLength(0);
    expect(assignments[0].displayName).toBe('Someone Else');
  });

  it('never gives a host block to someone who cannot host', () => {
    const { assignments, unfilled } = matchDay({
      skeletons: [{ ...block('15:00', '19:00', 'Host'), preferredNames: ['Rahul Parmar'] }],
      candidates: [person('Teacher Only', { subRoles: ['Elementary'] })],
    });
    expect(assignments).toHaveLength(0);
    expect(unfilled).toHaveLength(1);
  });

  it('puts Leads ahead of instructors, without starving them', () => {
    const lead = matchDay({
      skeletons: [block('15:00', '19:00')],
      candidates: [person('lead', { isLead: true }), person('plain')],
    });
    expect(lead.assignments[0].displayName).toBe('lead');

    // ...but a Lead who is already well ahead on hours steps aside.
    const evened = matchDay({
      skeletons: [block('15:00', '19:00')],
      candidates: [person('lead', { isLead: true }), person('plain')],
      minutesSoFar: { lead: 10 * LEAD_HEAD_START_MINUTES },
    });
    expect(evened.assignments[0].displayName).toBe('plain');
  });

});

describe('why the designated host missed out', () => {
  const hostBlock = { ...block('15:00', '19:00', 'Host'), preferredNames: ['Rahul Parmar'] };

  it('says so when they are not ticked as able to host', () => {
    const { notes } = matchDay({
      skeletons: [hostBlock],
      candidates: [
        person('Rahul Parmar', { subRoles: ['Elementary'] }),   // no Host capability
        person('Bri MacDonald', { subRoles: ['Host'] }),
      ],
    });
    expect(notes.join(' ')).toMatch(/Rahul Parmar isn't ticked as able to Host/);
  });

  it('says so when their availability does not cover the block', () => {
    const { notes } = matchDay({
      skeletons: [hostBlock],
      candidates: [
        person('Rahul Parmar', { subRoles: ['Host'], availEnd: '17:00' }),
        person('Bri MacDonald', { subRoles: ['Host'] }),
      ],
    });
    expect(notes.join(' ')).toMatch(/only free 15:00–17:00/);
  });

  it('does not claim "no availability" when a day cap may be the cause', () => {
    const { notes } = matchDay({
      skeletons: [hostBlock],
      candidates: [person('Bri MacDonald', { subRoles: ['Host'] })],
    });
    // The caller drops people over their max-days-per-week before the
    // matcher runs, so the matcher cannot tell the two apart — and must
    // not guess confidently between them.
    expect(notes.join(' ')).toMatch(/wasn't in the pool for this day/);
    expect(notes.join(' ')).toMatch(/maximum days for the week/);
  });

  it('stays quiet when the designated host does get it', () => {
    const { assignments, notes } = matchDay({
      skeletons: [hostBlock],
      candidates: [
        person('Rahul Parmar', { subRoles: ['Host'] }),
        person('Bri MacDonald', { subRoles: ['Host'] }),
      ],
    });
    expect(assignments[0].displayName).toBe('Rahul Parmar');
    expect(notes).toHaveLength(0);
  });

  it('gives the named person their block before a scarcer one takes them', () => {
    // The bug this exists to stop: a person holds one shift a day, so
    // whichever block is filled first keeps them. When plenty of staff
    // can host, the host block looks EASY (high eligible count) and
    // sorted last — an instructor block grabbed the designated host
    // first, and host fell to whoever was left.
    const hostBlock = { ...block('15:00', '19:00', 'Host'), preferredNames: ['Rahul Parmar'] };
    // A deliberately scarce instructor block: only Rahul can work it.
    const scarceBlock = block('15:00', '19:00', 'Instructor');

    const everyoneHosts = { subRoles: ['Host', 'Elementary'] };
    const { assignments } = matchDay({
      skeletons: [scarceBlock, hostBlock],
      candidates: [
        person('Rahul Parmar', everyoneHosts),
        person('Bri MacDonald', everyoneHosts),
        person('Ainsley MacDonald', everyoneHosts),
        person('Dev Prasad', everyoneHosts),
      ],
    });
    const host = assignments.find(a => a.capability === 'Host');
    expect(host.displayName).toBe('Rahul Parmar');
  });

  it('keeps giving the named person their block day after day', () => {
    // Hours accrue, and the preferred head start has to stay decisive
    // across a week or the host rotates for no reason.
    const hostBlock = { ...block('15:00', '19:00', 'Host'), preferredNames: ['Rahul Parmar'] };
    let minutes = {};
    for (let d = 0; d < 5; d++) {
      const { assignments, minutesSoFar } = matchDay({
        skeletons: [hostBlock],
        candidates: [
          person('Rahul Parmar', { subRoles: ['Host'] }),
          person('Bri MacDonald', { subRoles: ['Host'] }),
        ],
        minutesSoFar: minutes,
      });
      expect(assignments[0].displayName).toBe('Rahul Parmar');
      minutes = minutesSoFar;
    }
  });
});

