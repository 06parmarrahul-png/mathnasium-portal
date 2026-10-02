import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_INTAKE_SETTINGS, intakeCapFor, countIntakesOn,
  computeWeekSlots, validateSlot,
} from './intakeAvailability';

// A Sunday, so the 7-day grid runs Sun..Sat from here.
const WEEK = '2026-09-20';
const FRIDAY = '2026-09-25';
const THURSDAY = '2026-09-24';

/**
 * THE CLOCK IS FROZEN, and it has to be.
 *
 * The booking engine will not offer a slot that has already passed — it
 * compares every start against Date.now(). The fixture week above is a
 * fixed set of dates, so as the real clock moved past them the tests
 * started failing one at a time: three on 24 Sep, five by the evening,
 * thirteen of thirty-four by the 28th. Nothing was broken; the fixtures
 * had simply expired, and a suite that fails for calendar reasons stops
 * being able to tell anybody that intake booking is broken for real ones.
 *
 * Frozen to the Sunday morning the fixture week opens, so every slot in
 * it is in the future exactly as the author intended, for good. Anything
 * in here that needs a different "now" sets it for itself.
 */
const FROZEN_NOW = new Date('2026-09-20T08:00:00');

beforeEach(() => { vi.useFakeTimers({ now: FROZEN_NOW, toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

// Open 15:00–19:00 every day, which gives 4 hour-long starts a day.
const HOURS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  .reduce((acc, d) => ({ ...acc, [d]: { start: '15:00', end: '19:00' } }), {});

const settings = (over = {}) => ({
  ...DEFAULT_INTAKE_SETTINGS,
  enabled: true,
  slotDurationMin: 60,
  slotIntervalMin: 60,
  advanceNoticeHrs: 0,
  // Was 365 * 50, to reach a fixture week the real clock had left behind.
  // The clock is frozen at the start of that week now, so the engine's
  // ordinary window covers it and the tests exercise the real default
  // rather than a number chosen to get out of the way.
  maxAdvanceDays: 60,
  ...over,
});

const booking = (ymd, hhmm, over = {}) => ({
  startISO: `${ymd}T${hhmm}:00`, durationMin: 60, status: 'scheduled', ...over,
});

const dayOf = (days, ymd) => days.find(d => d.date === ymd);

describe('reading the cap off the settings', () => {
  it('is no cap at all by default, so an untouched centre is unchanged', () => {
    expect(intakeCapFor(DEFAULT_INTAKE_SETTINGS, 'Friday')).toBe(null);
    expect(intakeCapFor({}, 'Friday')).toBe(null);
    expect(intakeCapFor(undefined, 'Friday')).toBe(null);
  });

  it('applies the everyday number to every day', () => {
    const s = { maxIntakesPerDay: 3 };
    expect(intakeCapFor(s, 'Monday')).toBe(3);
    expect(intakeCapFor(s, 'Friday')).toBe(3);
  });

  it('lets one weekday differ — three a day, two on Friday', () => {
    const s = { maxIntakesPerDay: 3, maxIntakesPerWeekday: { Friday: 2 } };
    expect(intakeCapFor(s, 'Thursday')).toBe(3);
    expect(intakeCapFor(s, 'Friday')).toBe(2);
  });

  it('treats a blank weekday as "no opinion", not as zero', () => {
    // An emptied number input hands back '', which must not close the day.
    const s = { maxIntakesPerDay: 3, maxIntakesPerWeekday: { Friday: '', Monday: null } };
    expect(intakeCapFor(s, 'Friday')).toBe(3);
    expect(intakeCapFor(s, 'Monday')).toBe(3);
  });

  it('treats an explicit zero as a real answer: closed to booking', () => {
    const s = { maxIntakesPerDay: 3, maxIntakesPerWeekday: { Sunday: 0 } };
    expect(intakeCapFor(s, 'Sunday')).toBe(0);
  });

  it('ignores junk rather than capping a centre at NaN', () => {
    expect(intakeCapFor({ maxIntakesPerDay: 'lots' }, 'Monday')).toBe(null);
    expect(intakeCapFor({ maxIntakesPerDay: -2 }, 'Monday')).toBe(null);
  });
});

describe('counting what is already booked on a day', () => {
  it('counts by the centre\'s own date, not the server\'s', () => {
    // startISO is wall-clock with no zone. A 6pm booking must count on
    // ITS day — going through Date would push it to tomorrow in UTC.
    const rows = [booking(FRIDAY, '18:00'), booking(FRIDAY, '15:00'), booking(THURSDAY, '18:00')];
    expect(countIntakesOn(rows, FRIDAY)).toBe(2);
    expect(countIntakesOn(rows, THURSDAY)).toBe(1);
  });

  it('does not count a cancellation, so the day reopens', () => {
    const rows = [booking(FRIDAY, '15:00'), booking(FRIDAY, '16:00', { status: 'cancelled' })];
    expect(countIntakesOn(rows, FRIDAY)).toBe(1);
  });

  it('survives junk rows', () => {
    expect(countIntakesOn([null, undefined, {}, booking(FRIDAY, '15:00')], FRIDAY)).toBe(1);
    expect(countIntakesOn(null, FRIDAY)).toBe(0);
  });
});

describe('the cap closing a day on the public grid', () => {
  it('leaves every day open when no cap is set', () => {
    const days = computeWeekSlots(WEEK, settings(), [], HOURS);
    expect(dayOf(days, FRIDAY).dayFull).toBe(false);
    expect(dayOf(days, FRIDAY).slots.some(s => s.available)).toBe(true);
  });

  it('closes the WHOLE day once the cap is reached, hours notwithstanding', () => {
    const s = settings({ maxIntakesPerDay: 3, maxIntakesPerWeekday: { Friday: 2 } });
    const booked = [booking(FRIDAY, '15:00'), booking(FRIDAY, '16:00')];
    const days = computeWeekSlots(WEEK, s, booked, HOURS);
    const fri = dayOf(days, FRIDAY);
    expect(fri.dayFull).toBe(true);
    expect(fri.slots.every(x => x.available === false)).toBe(true);
    // 17:00 and 18:00 are nobody's booking — they are closed by the cap.
    const free = fri.slots.find(x => x.startISO.endsWith('17:00:00'));
    expect(free.taken).toBe(false);
    expect(free.dayFull).toBe(true);
    expect(free.available).toBe(false);
  });

  it('caps each day on its own count', () => {
    const s = settings({ maxIntakesPerDay: 3, maxIntakesPerWeekday: { Friday: 2 } });
    // Two on Friday fills it; two on Thursday does not, since Thursday allows three.
    const booked = [
      booking(FRIDAY, '15:00'), booking(FRIDAY, '16:00'),
      booking(THURSDAY, '15:00'), booking(THURSDAY, '16:00'),
    ];
    const days = computeWeekSlots(WEEK, s, booked, HOURS);
    expect(dayOf(days, FRIDAY).dayFull).toBe(true);
    expect(dayOf(days, THURSDAY).dayFull).toBe(false);
    expect(dayOf(days, THURSDAY).slots.some(x => x.available)).toBe(true);
  });

  it('reopens the day when a booking is cancelled', () => {
    const s = settings({ maxIntakesPerDay: 2 });
    const booked = [booking(FRIDAY, '15:00'), booking(FRIDAY, '16:00', { status: 'cancelled' })];
    expect(dayOf(computeWeekSlots(WEEK, s, booked, HOURS), FRIDAY).dayFull).toBe(false);
  });

  it('closes a day capped at zero even with nothing booked', () => {
    const s = settings({ maxIntakesPerDay: 3, maxIntakesPerWeekday: { Sunday: 0 } });
    const days = computeWeekSlots(WEEK, s, [], HOURS);
    expect(dayOf(days, '2026-09-20').dayFull).toBe(true);
  });
});

describe('the cap on the server, where it actually counts', () => {
  const s = settings({ maxIntakesPerDay: 3, maxIntakesPerWeekday: { Friday: 2 } });

  it('refuses a booking on a full day even from a stale tab', () => {
    // The grid this parent is looking at was drawn before the day filled.
    const booked = [booking(FRIDAY, '15:00'), booking(FRIDAY, '16:00')];
    const out = validateSlot({
      slotISO: `${FRIDAY}T17:00:00`, settings: s, bookedSlots: booked, instructionalHours: HOURS,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fully booked/i);
  });

  it('says the DAY is full rather than that the time is taken', () => {
    // Both are true of 15:00. The day message is the one that moves them
    // somewhere bookable.
    const booked = [booking(FRIDAY, '15:00'), booking(FRIDAY, '16:00')];
    const out = validateSlot({
      slotISO: `${FRIDAY}T15:00:00`, settings: s, bookedSlots: booked, instructionalHours: HOURS,
    });
    expect(out.error).toMatch(/fully booked/i);
  });

  it('still allows a day that is under its own cap', () => {
    const booked = [booking(THURSDAY, '15:00'), booking(THURSDAY, '16:00')];
    const out = validateSlot({
      slotISO: `${THURSDAY}T17:00:00`, settings: s, bookedSlots: booked, instructionalHours: HOURS,
    });
    expect(out.ok).toBe(true);
  });

  it('is silent when no cap is configured', () => {
    const booked = Array.from({ length: 4 }, (_, i) => booking(FRIDAY, `1${5 + i}:00`.slice(-5)));
    const out = validateSlot({
      slotISO: `${FRIDAY}T15:00:00`, settings: settings(), bookedSlots: booked.slice(1), instructionalHours: HOURS,
    });
    expect(out.error || '').not.toMatch(/fully booked/i);
  });
});

/**
 * Holds and closures — the two lists that are not bookings.
 *
 * The fixture is Langley's Friday 25 September 2026: the centre teaches
 * 3–7pm, an assessment runs 60 minutes and the grid offers one every 30,
 * so the day has seven start times. A 3–5pm training holds the page.
 *
 * src/lib/ratioCalendar.test.js pins the same day from the front-end
 * side. A Vercel function may not import from src/, so the two
 * implementations are separate on purpose and the shared fixture is what
 * stops them drifting apart quietly.
 */
describe('a calendar entry that holds the booking page', () => {
  const half = (over = {}) => settings({ slotIntervalMin: 30, ...over });
  const hold = (ymd, from, to) => ({ startISO: `${ymd}T${from}:00`, durationMin: to });
  // 3–5pm on the Friday, as holdBlocks() emits it.
  const TRAINING = { startISO: `${FRIDAY}T15:00:00`, durationMin: 120 };

  const labels = (day, pick) => day.slots.filter(pick).map(s => s.label);

  it('offers the whole day when nothing holds it', () => {
    const days = computeWeekSlots(WEEK, half(), [], HOURS, null);
    expect(labels(dayOf(days, FRIDAY), s => s.available))
      .toEqual(['3:00pm', '3:30pm', '4:00pm', '4:30pm', '5:00pm', '5:30pm', '6:00pm']);
  });

  it('takes exactly the overlapping starts off that day', () => {
    // 4:30 goes because the assessment starting there runs to 5:30 and
    // overlaps the tail of the training. 5:00 stays because it sits
    // flush against the end — blocking it would cost a bookable hour.
    const days = computeWeekSlots(WEEK, half(), [], HOURS, null, { holds: [TRAINING] });
    const fri = dayOf(days, FRIDAY);
    expect(labels(fri, s => s.held)).toEqual(['3:00pm', '3:30pm', '4:00pm', '4:30pm']);
    expect(labels(fri, s => s.available)).toEqual(['5:00pm', '5:30pm', '6:00pm']);
  });

  it('leaves every other day alone', () => {
    const days = computeWeekSlots(WEEK, half(), [], HOURS, null, { holds: [TRAINING] });
    expect(labels(dayOf(days, THURSDAY), s => s.available)).toHaveLength(7);
  });

  it('DOES NOT use up the day-s assessment allowance', () => {
    // The whole reason holds travel in their own list. Friday takes two
    // assessments; one is booked and a training holds two hours. If the
    // hold counted, the day would read full and the remaining slot would
    // vanish — a staff meeting would have eaten a family's assessment.
    const days = computeWeekSlots(
      WEEK, half({ maxIntakesPerWeekday: { Friday: 2 } }),
      [booking(FRIDAY, '18:00')], HOURS, null, { holds: [TRAINING] },
    );
    const fri = dayOf(days, FRIDAY);
    expect(fri.dayFull).toBe(false);
    expect(labels(fri, s => s.available)).toEqual(['5:00pm']);
  });

  it('still fills the day when the real bookings reach the cap', () => {
    const days = computeWeekSlots(
      WEEK, half({ maxIntakesPerWeekday: { Friday: 2 } }),
      [booking(FRIDAY, '17:00'), booking(FRIDAY, '18:00')], HOURS, null,
      { holds: [TRAINING] },
    );
    expect(dayOf(days, FRIDAY).dayFull).toBe(true);
    expect(labels(dayOf(days, FRIDAY), s => s.available)).toEqual([]);
  });

  it('reads a booked slot as booked, not as held', () => {
    // Both are unavailable, but a family who lost a race and a family
    // who picked a blocked time need different sentences.
    const days = computeWeekSlots(WEEK, half(), [booking(FRIDAY, '17:00')], HOURS, null,
      { holds: [TRAINING] });
    const five = dayOf(days, FRIDAY).slots.find(s => s.label === '5:00pm');
    expect(five).toMatchObject({ taken: true, held: false, available: false });
  });

  it('changes nothing when no holds are passed at all', () => {
    // Every existing caller passes five arguments. They must keep the
    // behaviour they had before this parameter existed.
    const before = computeWeekSlots(WEEK, half(), [booking(FRIDAY, '17:00')], HOURS, null);
    const after  = computeWeekSlots(WEEK, half(), [booking(FRIDAY, '17:00')], HOURS, null, {});
    expect(labels(dayOf(after, FRIDAY), s => s.available))
      .toEqual(labels(dayOf(before, FRIDAY), s => s.available));
    expect(dayOf(before, FRIDAY).slots.every(s => s.held === false)).toBe(true);
  });

  it('refuses a held time server-side, with its own message', () => {
    const v = validateSlot({
      slotISO: `${FRIDAY}T16:00:00`, settings: half(), bookedSlots: [],
      instructionalHours: HOURS, holds: [TRAINING],
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/not taking assessments at that time/i);
  });

  it('still lets the flush 5pm slot through', () => {
    expect(validateSlot({
      slotISO: `${FRIDAY}T17:00:00`, settings: half(), bookedSlots: [],
      instructionalHours: HOURS, holds: [TRAINING],
    })).toEqual({ ok: true });
  });

  it('says "someone else booked it" ahead of "we are not taking any"', () => {
    const v = validateSlot({
      slotISO: `${FRIDAY}T16:00:00`, settings: half(),
      bookedSlots: [booking(FRIDAY, '16:00')], instructionalHours: HOURS,
      holds: [TRAINING],
    });
    expect(v.error).toMatch(/just booked by someone else/i);
  });

  it('holds a whole day when the entry is all-day', () => {
    const days = computeWeekSlots(WEEK, half(), [], HOURS, null,
      { holds: [hold(FRIDAY, '00:00', 24 * 60)] });
    expect(labels(dayOf(days, FRIDAY), s => s.available)).toEqual([]);
  });
});

describe('a centre closure shuts the day', () => {
  const CLOSURES = { [FRIDAY]: { name: 'Labour Day', stat: true } };

  it('offers no times at all, however open the hours are', () => {
    // Before closures were read here, nothing in the booking path ever
    // looked at centerConfig.holidays — the weekday had instructional
    // hours, so a family could book an assessment on a stat holiday.
    const days = computeWeekSlots(WEEK, settings(), [], HOURS, null, { closures: CLOSURES });
    const fri = dayOf(days, FRIDAY);
    expect(fri.slots).toEqual([]);
    expect(fri.closed).toBe(true);
    expect(fri.closureName).toBe('Labour Day');
  });

  it('leaves the rest of the week open', () => {
    const days = computeWeekSlots(WEEK, settings(), [], HOURS, null, { closures: CLOSURES });
    expect(dayOf(days, THURSDAY).closed).toBe(false);
    expect(dayOf(days, THURSDAY).slots).toHaveLength(4);
  });

  it('is not the same thing as being full', () => {
    // "Full" sends a parent looking for another time; "closed" sends
    // them to another day.
    expect(dayOf(computeWeekSlots(WEEK, settings(), [], HOURS, null, { closures: CLOSURES }), FRIDAY).dayFull)
      .toBe(false);
  });

  it('refuses the booking server-side and names the closure', () => {
    const v = validateSlot({
      slotISO: `${FRIDAY}T16:00:00`, settings: settings(), bookedSlots: [],
      instructionalHours: HOURS, closures: CLOSURES,
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/closed that day \(Labour Day\)/);
  });

  it('marks every day open when no closures are passed', () => {
    const days = computeWeekSlots(WEEK, settings(), [], HOURS, null);
    expect(days.every(d => d.closed === false)).toBe(true);
  });
});

/**
 * Times opened and closed by hand, from the grid in Centre Settings.
 *
 * The layer under test is deliberately thin — a map of date → time →
 * boolean — but it is the only one a person edits by tapping, so the two
 * things worth pinning are that it is PER DATE (closing Tuesday the 22nd
 * says nothing about the 29th) and that an absent rule means "follow the
 * hours" rather than "closed", which is what would happen if anything in
 * here tested for falsiness.
 */
describe('a time somebody shut by hand', () => {
  const TUE = '2026-09-22';
  const NEXT_TUE = '2026-09-29';
  const open = {
    ...DEFAULT_INTAKE_SETTINGS,
    enabled: true,
    useCustomAvailability: true,
    availability: { ...DEFAULT_INTAKE_SETTINGS.availability, Tuesday: [{ start: '15:00', end: '19:00' }] },
  };
  const tuesdayOf = (settings, weekStart = WEEK) =>
    computeWeekSlots(weekStart, settings, [], null, null, {}).find(d => d.date === TUE);

  it('changes nothing at all when no rule is set', () => {
    const day = tuesdayOf(open);
    expect(day.slots.every(sl => sl.available)).toBe(true);
    expect(day.slots.every(sl => sl.staffClosed === false)).toBe(true);
  });

  it('takes exactly the time that was shut, and leaves the rest', () => {
    const day = tuesdayOf({ ...open, slotRules: { [TUE]: { '15:30': false } } });
    const shut = day.slots.filter(sl => !sl.available);
    expect(shut).toHaveLength(1);
    expect(shut[0].startISO).toBe(`${TUE}T15:30:00`);
    expect(shut[0].staffClosed).toBe(true);
  });

  it('says nothing about the same time next week', () => {
    const rules = { slotRules: { [TUE]: { '15:30': false } } };
    const next = computeWeekSlots('2026-09-27', { ...open, ...rules }, [], null, null, {})
      .find(d => d.date === NEXT_TUE);
    expect(next.slots.every(sl => sl.available)).toBe(true);
  });

  it('reopens on `true`, which is how the grid undoes a tap', () => {
    // The key is set to true rather than deleted: the settings panel
    // saves with a merge write, and a merge write would keep the old
    // `false` for a key that was removed locally.
    const day = tuesdayOf({ ...open, slotRules: { [TUE]: { '15:30': true } } });
    expect(day.slots.every(sl => sl.available)).toBe(true);
  });

  it('ignores a rule that is neither true nor false', () => {
    for (const junk of ['false', 0, null, undefined, {}]) {
      const day = tuesdayOf({ ...open, slotRules: { [TUE]: { '15:30': junk } } });
      expect(day.slots.every(sl => sl.available)).toBe(true);
    }
  });

  it('survives a half-written map without closing the centre', () => {
    for (const junk of [null, 'nope', 42, []]) {
      const day = tuesdayOf({ ...open, slotRules: junk });
      expect(day.slots.every(sl => sl.available)).toBe(true);
    }
  });

  it('does NOT use up the day-s assessment allowance', () => {
    // Same rule as a calendar hold: shutting a time is not an assessment
    // and must not eat one of the day's two.
    const capped = { ...open, maxIntakesPerDay: 2, slotRules: { [TUE]: { '15:30': false, '16:00': false } } };
    const day = tuesdayOf(capped);
    expect(day.dayFull).toBe(false);
    expect(day.slots.some(sl => sl.available)).toBe(true);
  });

  it('refuses the booking on the server too, not just on the grid', () => {
    const got = validateSlot({
      slotISO: `${TUE}T15:30:00`,
      settings: { ...open, slotRules: { [TUE]: { '15:30': false } } },
      bookedSlots: [],
      instructionalHours: null,
    });
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/no longer being offered/i);
  });

  it('still takes the booking when the rule is for another time', () => {
    const got = validateSlot({
      slotISO: `${TUE}T15:30:00`,
      settings: { ...open, slotRules: { [TUE]: { '16:00': false } } },
      bookedSlots: [],
      instructionalHours: null,
    });
    expect(got.ok).toBe(true);
  });
});
