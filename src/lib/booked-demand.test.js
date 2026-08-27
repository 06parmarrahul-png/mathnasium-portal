import { describe, it, expect } from 'vitest';
import { bookedByTime, demandForSlots } from './booked-demand';

/** Shape the appointments endpoint returns. */
const appts = (rows) => ({
  slots: rows.map(([slot, em = [], hs = []]) => ({
    slot,
    students: {
      EM: { onHour: em, halfHour: [] },
      HS: { onHour: hs, halfHour: [] },
    },
  })),
});

const student = (duration) => ({ id: Math.random().toString(36), duration });

describe('bookedByTime', () => {
  it('spreads a booking across every slot its duration covers', () => {
    // A 60-minute booking at 16:00 occupies 16:00 AND 16:30. Counting only
    // the starting slot is what would undercount the floor at the busiest
    // moment of the day.
    const out = bookedByTime(appts([['16:00', [student(60)]]]));
    expect(out['16:00']).toBe(1);
    expect(out['16:30']).toBe(1);
    expect(out['17:00']).toBeUndefined();
  });

  it('handles 90-minute bookings', () => {
    const out = bookedByTime(appts([['16:00', [student(90)]]]));
    expect(out['16:00']).toBe(1);
    expect(out['16:30']).toBe(1);
    expect(out['17:00']).toBe(1);
    expect(out['17:30']).toBeUndefined();
  });

  it('assumes 60 minutes when a duration is missing', () => {
    const out = bookedByTime(appts([['16:00', [{ id: 'x' }]]]));
    expect(out['16:00']).toBe(1);
    expect(out['16:30']).toBe(1);
  });

  it('sums Elementary and Highschool onto one floor count', () => {
    const out = bookedByTime(appts([['16:00', [student(30)], [student(30), student(30)]]]));
    expect(out['16:00']).toBe(3);
  });

  it('adds up overlapping bookings from different start times', () => {
    // 15:30 (60min) covers 15:30+16:00; 16:00 (60min) covers 16:00+16:30.
    const out = bookedByTime(appts([
      ['15:30', [student(60)]],
      ['16:00', [student(60)]],
    ]));
    expect(out['15:30']).toBe(1);
    expect(out['16:00']).toBe(2);
    expect(out['16:30']).toBe(1);
  });

  it('survives an empty or failed payload', () => {
    expect(bookedByTime(null)).toEqual({});
    expect(bookedByTime({})).toEqual({});
    expect(bookedByTime({ slots: [] })).toEqual({});
  });

  it('ignores rows with an unusable slot time', () => {
    expect(bookedByTime({ slots: [{ slot: null, students: { EM: { onHour: [student(60)] } } }] }))
      .toEqual({});
  });
});

describe('demandForSlots', () => {
  it('lines demand up with a day\'s own slot keys', () => {
    const byTime = { '15:00': 4, '15:30': 6 };
    expect(demandForSlots(byTime, ['15:00', '15:30', '16:00'])).toEqual([4, 6, 0]);
  });

  it('reads zero for times the day does not cover, rather than guessing', () => {
    // Saturday opens at 09:00. Afternoon bookings must not bleed in.
    expect(demandForSlots({ '15:00': 9 }, ['09:00', '09:30'])).toEqual([0, 0]);
  });

  it('survives missing input', () => {
    expect(demandForSlots(undefined, ['15:00'])).toEqual([0]);
    expect(demandForSlots({}, [])).toEqual([]);
  });
});
