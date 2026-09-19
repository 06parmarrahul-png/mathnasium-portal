import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INTAKE_SETTINGS, intakeCapFor, countIntakesOn,
  computeWeekSlots, validateSlot,
} from './intakeAvailability';

// A Sunday, so the 7-day grid runs Sun..Sat from here.
const WEEK = '2026-09-20';
const FRIDAY = '2026-09-25';
const THURSDAY = '2026-09-24';

// Open 15:00–19:00 every day, which gives 4 hour-long starts a day.
const HOURS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  .reduce((acc, d) => ({ ...acc, [d]: { start: '15:00', end: '19:00' } }), {});

const settings = (over = {}) => ({
  ...DEFAULT_INTAKE_SETTINGS,
  enabled: true,
  slotDurationMin: 60,
  slotIntervalMin: 60,
  advanceNoticeHrs: 0,
  // The fixture week is in the past relative to nothing in particular, so
  // give the engine room rather than fighting its clock.
  maxAdvanceDays: 365 * 50,
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
