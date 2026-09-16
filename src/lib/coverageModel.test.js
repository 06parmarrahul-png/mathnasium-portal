import { describe, it, expect } from 'vitest';
import {
  slotKeysFor, resolveCoverageModel, targetFor, hasTargets, countsOnFloor,
  coverageForDate, summariseSlots, classifySlot, upcomingDatesFor,
  setSlotTarget, fillWeekday,
} from './coverageModel';
import { builtInRoles, resolveRoles } from './roles';
import { buildTimeOffIndex } from './timeOff';

const ROLES = builtInRoles(() => '#000');
const user = (uid, instructorType, extra = {}) => ({
  uid, displayName: uid, instructorType, ...extra,
});
const avail = (uid, date, startTime, endTime) => ({ userId: uid, date, startTime, endTime });
const shift = (userName, date, startTime, endTime, extra = {}) => ({
  userName, date, startTime, endTime, role: 'Instructor', ...extra,
});

describe('slot keys', () => {
  it('spans the instructional window in half hours, end-exclusive', () => {
    expect(slotKeysFor({ start: '15:00', end: '17:00' }))
      .toEqual(['15:00', '15:30', '16:00', '16:30']);
  });

  it('survives a missing or backwards window rather than throwing', () => {
    expect(slotKeysFor(null)).toEqual([]);
    expect(slotKeysFor({ start: '19:00', end: '15:00' })).toEqual([]);
  });
});

describe('the stored model', () => {
  it('keeps real counts and drops anything unusable', () => {
    const model = resolveCoverageModel({
      coverageModel: {
        Monday: { '15:00': 4, '15:30': '5', '16:00': 'lots', '16:30': -2, 'teatime': 3 },
        Tuesday: 'nope',
      },
    });
    expect(model.Monday).toEqual({ '15:00': 4, '15:30': 5 });
    expect(model.Tuesday).toBeUndefined();
  });

  it('a slot nobody has set reads as null, never as zero', () => {
    // "we want nobody at 4pm" and "nobody has said" are different answers,
    // and a view that renders 0 for the second invents a decision.
    const model = resolveCoverageModel({ coverageModel: { Monday: { '15:00': 4 } } });
    expect(targetFor(model, 'Monday', '15:00')).toBe(4);
    expect(targetFor(model, 'Monday', '16:00')).toBeNull();
    expect(targetFor(model, 'Friday', '15:00')).toBeNull();
    expect(hasTargets(model, 'Monday')).toBe(true);
    expect(hasTargets(model, 'Friday')).toBe(false);
  });

  it('a target of zero is a real answer and survives', () => {
    const model = resolveCoverageModel({ coverageModel: { Saturday: { '09:00': 0 } } });
    expect(targetFor(model, 'Saturday', '09:00')).toBe(0);
  });

  it('missing config is an empty model, not a crash', () => {
    expect(resolveCoverageModel(null)).toEqual({});
    expect(resolveCoverageModel({})).toEqual({});
  });
});

describe('who counts on the floor', () => {
  it('Instructor, Lead and Manager do; the desks and the directors do not', () => {
    for (const t of ['Instructor', 'Lead', 'Manager']) {
      expect(countsOnFloor(user('u', t), ROLES)).toBe(true);
    }
    for (const t of ['Host', 'Admin', 'Center Director', 'Dir. of Education']) {
      expect(countsOnFloor(user('u', t), ROLES)).toBe(false);
    }
  });

  it('trainees and volunteers never fill a slot', () => {
    expect(countsOnFloor(user('u', 'Training'), ROLES)).toBe(false);
    expect(countsOnFloor(user('u', 'Volunteer'), ROLES)).toBe(false);
    // Volunteer is a per-centre FLAG as well as a title — an instructor
    // volunteering at this centre is still not supply.
    expect(countsOnFloor(user('u', 'Instructor', { isVolunteer: true }), ROLES)).toBe(false);
  });

  it('follows a custom role’s own ratio setting, without knowing its name', () => {
    const roles = resolveRoles({
      staffRoles: [
        { id: 'al', name: 'Assistant Lead', permissions: [], countsInRatio: true, order: 9 },
        { id: 'gr', name: 'Greeter', permissions: [], countsInRatio: false, order: 10 },
      ],
    }, () => '#000');
    expect(countsOnFloor(user('u', 'Assistant Lead'), roles)).toBe(true);
    expect(countsOnFloor(user('u', 'Greeter'), roles)).toBe(false);
  });
});

describe('one date’s supply', () => {
  const D = '2026-09-21';
  const slots = ['15:00', '15:30', '16:00'];
  const users = [user('a', 'Instructor'), user('b', 'Lead'), user('h', 'Host'), user('t', 'Training')];

  it('counts availability only where it covers the WHOLE slot', () => {
    const rows = coverageForDate({
      date: D, slotKeys: slots, users, roles: ROLES,
      availability: [avail('a', D, '15:00', '16:00'), avail('b', D, '15:20', '16:30')],
    });
    // b starts at 15:20, so the 15:00 slot is not covered; 15:30 is.
    expect(rows.map(r => r.available)).toEqual([1, 2, 1]);
  });

  it('counts a person once however many rows they submitted, and merges the seam', () => {
    const rows = coverageForDate({
      date: D, slotKeys: slots, users, roles: ROLES,
      availability: [avail('a', D, '15:00', '15:30'), avail('a', D, '15:30', '16:30')],
    });
    expect(rows.map(r => r.available)).toEqual([1, 1, 1]);
    expect(rows[0].availableNames).toEqual(['a']);
  });

  it('ignores hosts and trainees on both lines', () => {
    const rows = coverageForDate({
      date: D, slotKeys: slots, users, roles: ROLES,
      availability: [avail('h', D, '15:00', '17:00'), avail('t', D, '15:00', '17:00')],
      shifts: [shift('h', D, '15:00', '17:00', { role: 'Host' }), shift('t', D, '15:00', '17:00', { role: 'Training' })],
    });
    expect(rows.map(r => r.available)).toEqual([0, 0, 0]);
    expect(rows.map(r => r.scheduled)).toEqual([0, 0, 0]);
  });

  it('approved time off removes them; a pending request does not', () => {
    const index = buildTimeOffIndex([
      { userId: 'a', startDate: D, endDate: D, status: 'approved' },
      { userId: 'b', startDate: D, endDate: D, status: 'pending' },
    ]);
    const rows = coverageForDate({
      date: D, slotKeys: slots, users, roles: ROLES, timeOffIndex: index,
      availability: [avail('a', D, '15:00', '17:00'), avail('b', D, '15:00', '17:00')],
    });
    expect(rows.map(r => r.available)).toEqual([1, 1, 1]);
    expect(rows[0].availableNames).toEqual(['b']);
  });

  it('reads the shift’s own ratio flag, never the role', () => {
    const rows = coverageForDate({
      date: D, slotKeys: slots, users, roles: ROLES,
      shifts: [
        // An instructor deliberately toggled OUT of the ratio.
        shift('a', D, '15:00', '17:00', { includedInRatio: false }),
        // A host deliberately toggled IN.
        shift('h', D, '15:00', '17:00', { role: 'Host', includedInRatio: true }),
      ],
    });
    expect(rows.map(r => r.scheduled)).toEqual([1, 1, 1]);
    expect(rows[0].scheduledNames).toEqual(['h']);
  });

  it('only looks at the date it was asked about', () => {
    const rows = coverageForDate({
      date: D, slotKeys: slots, users, roles: ROLES,
      availability: [avail('a', '2026-09-28', '15:00', '17:00')],
      shifts: [shift('a', '2026-09-28', '15:00', '17:00')],
    });
    expect(rows.map(r => r.available)).toEqual([0, 0, 0]);
    expect(rows.map(r => r.scheduled)).toEqual([0, 0, 0]);
  });
});

describe('averaging weeks', () => {
  it('keeps the worst week as well as the average', () => {
    const summary = summariseSlots([
      [{ slot: '15:00', available: 6, scheduled: 4 }],
      [{ slot: '15:00', available: 6, scheduled: 2 }],
    ]);
    expect(summary[0].scheduled).toBe(3);
    expect(summary[0].worstScheduled).toBe(2);
    expect(summary[0].samples).toBe(2);
  });
});

describe('what to say about a slot', () => {
  it('separates a rota problem from a people problem', () => {
    // Enough free, not enough rostered — fixable this afternoon.
    expect(classifySlot({ target: 4, available: 7, scheduled: 3 }))
      .toEqual({ status: 'fillable', short: 1, shortAvailable: 0 });
    // Not enough people free at all — no rota shuffle fixes this.
    expect(classifySlot({ target: 5, available: 4, scheduled: 4 }))
      .toEqual({ status: 'unstaffable', short: 1, shortAvailable: 1 });
    expect(classifySlot({ target: 4, available: 7, scheduled: 4 }).status).toBe('met');
    expect(classifySlot({ target: 4, available: 7, scheduled: 6 }).status).toBe('met');
  });

  it('says nothing when no target is set', () => {
    expect(classifySlot({ target: null, available: 0, scheduled: 0 }).status).toBe('none');
  });

  it('does not shout about a rounding-sized gap', () => {
    // 3.8 rostered on average against a want of 4 is not a shortfall.
    expect(classifySlot({ target: 4, available: 7, scheduled: 3.8 }).status).toBe('met');
  });
});

describe('the dates a weekday view reads', () => {
  it('starts today when today IS that weekday', () => {
    // 2026-09-21 is a Monday.
    expect(upcomingDatesFor('Monday', 3, new Date('2026-09-21T12:00:00')))
      .toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);
  });

  it('otherwise runs from the next one', () => {
    expect(upcomingDatesFor('Saturday', 2, new Date('2026-09-21T12:00:00')))
      .toEqual(['2026-09-26', '2026-10-03']);
  });

  it('crosses a month and a DST change without slipping a day', () => {
    // Pacific DST ends 2026-11-01; local-noon dates must stay put.
    expect(upcomingDatesFor('Wednesday', 3, new Date('2026-10-28T12:00:00')))
      .toEqual(['2026-10-28', '2026-11-04', '2026-11-11']);
  });

  it('refuses a name that isn’t a weekday', () => {
    expect(upcomingDatesFor('Someday', 4, new Date('2026-09-21T12:00:00'))).toEqual([]);
  });
});

describe('editing the model', () => {
  it('sets, rounds and clears a slot', () => {
    let model = setSlotTarget({}, 'Monday', '15:00', '4');
    expect(model.Monday['15:00']).toBe(4);
    model = setSlotTarget(model, 'Monday', '15:00', '');
    expect(model.Monday['15:00']).toBeUndefined();
  });

  it('does not mutate what it was given', () => {
    const before = { Monday: { '15:00': 4 } };
    const after = setSlotTarget(before, 'Monday', '15:30', 5);
    expect(before.Monday['15:30']).toBeUndefined();
    expect(after.Monday).toEqual({ '15:00': 4, '15:30': 5 });
  });

  it('fills a whole weekday in one go', () => {
    const model = fillWeekday({}, 'Tuesday', ['15:00', '15:30'], 3);
    expect(model.Tuesday).toEqual({ '15:00': 3, '15:30': 3 });
  });
});

describe('when nobody has submitted availability', () => {
  // The live centre has none on file for most days (839 of 1,848 shifts).
  // Reading that as "nobody is free" would mark every slot unstaffable.
  it('never calls a slot unstaffable on an absence of data', () => {
    expect(classifySlot({ target: 5, available: null, scheduled: 3 }))
      .toEqual({ status: 'fillable', short: 2, shortAvailable: 0 });
    expect(classifySlot({ target: 2, available: null, scheduled: 3 }).status).toBe('met');
  });

  it('still counts a real zero as a real zero', () => {
    // Somebody DID submit, and nobody who counts is free.
    expect(classifySlot({ target: 2, available: 0, scheduled: 0 }).status).toBe('unstaffable');
  });
});
