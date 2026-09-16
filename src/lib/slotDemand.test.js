import { describe, it, expect } from 'vitest';
import { demandBySide } from './slotDemand';

// 3:00–7:00pm in half hours.
const WINDOW = { startMin: 15 * 60, slotCount: 8 };

const booking = (name, duration = 60) => ({ id: `id-${name}`, name, duration });

const DAY = [
  { slot: '15:00', students: {
    EM: { onHour: [booking('Layek Athwal'), booking('Yug Mann')], halfHour: [] },
    HS: { onHour: [booking('Eshan Athwal')], halfHour: [] },
  } },
  { slot: '15:30', students: {
    EM: { onHour: [], halfHour: [booking('Jackson Jing', 30)] },
    HS: { onHour: [], halfHour: [booking('Zoe Ally', 90)] },
  } },
];

describe('demand per side', () => {
  it('keeps an hour-long booking on the floor for both half hours', () => {
    const d = demandBySide({ slots: DAY, dayWindow: WINDOW });
    expect(d.EM.counts).toEqual([2, 3, 0, 0, 0, 0, 0, 0]);
    expect(d.EM.students[1].map(s => s.name)).toEqual(['Layek Athwal', 'Yug Mann', 'Jackson Jing']);
    expect(d.EM.students[1][0].source).toBe('Acuity (rollover · 60min)');
  });

  it('fans a 90-minute booking across three half hours', () => {
    const d = demandBySide({ slots: DAY, dayWindow: WINDOW });
    expect(d.HS.counts).toEqual([1, 2, 1, 1, 0, 0, 0, 0]);
  });

  it('counts walk-ins and call-ins — the people who never booked on Acuity', () => {
    // The real shape of scheduleAddOns on 16 Sept 2026.
    const addOns = {
      'EM|15:00': [{ id: 'wi_1', name: 'Kabir Cheema', duration: 60 }],
      'HS|16:30': [{ id: 'wi_2', name: 'Melody Lee', duration: 60 }],
      slotOverrides: { something: true },
    };
    const d = demandBySide({ slots: DAY, addOns, dayWindow: WINDOW });
    expect(d.EM.counts[0]).toBe(3);
    // 4:30 already holds the tail of Zoe Ally's 90-minute booking, so
    // Melody Lee makes two.
    expect(d.HS.counts[3]).toBe(2);
    expect(d.HS.students[3].map(s => s.name)).toEqual(['Zoe Ally', 'Melody Lee']);
    expect(d.walkIns).toBe(2);
    expect(d.EM.students[0].find(s => s.name === 'Kabir Cheema').source).toBe('Walk-in');
  });

  it('takes a no-show and a cancellation off the count, but still lists them', () => {
    const checkIns = { 'id-Yug Mann': { status: 'noshow' }, 'id-Eshan Athwal': 'cancel' };
    const d = demandBySide({ slots: DAY, checkIns, dayWindow: WINDOW });
    expect(d.EM.counts[0]).toBe(1);
    expect(d.HS.counts[0]).toBe(0);
    expect(d.EM.students[0].map(s => s.name)).toContain('Yug Mann');
    expect(d.EM.students[0].find(s => s.name === 'Yug Mann').status).toBe('noshow');
    expect(d.notCounted).toBe(2);
  });

  it('reads a legacy check-in written as a plain string', () => {
    const d = demandBySide({ slots: DAY, checkIns: { 'id-Yug Mann': 'in' }, dayWindow: WINDOW });
    expect(d.EM.counts[0]).toBe(2);
  });

  it('drops a walk-in marked as a no-show from the count', () => {
    const addOns = { 'EM|15:00': [{ id: 'wi_1', name: 'Kabir Cheema', duration: 60 }] };
    const d = demandBySide({ slots: DAY, addOns, checkIns: { wi_1: { status: 'noshow' } }, dayWindow: WINDOW });
    expect(d.EM.counts[0]).toBe(2);
    expect(d.EM.students[0].find(s => s.name === 'Kabir Cheema')).toBeTruthy();
  });

  it('ignores anything outside the day window and copes with nothing at all', () => {
    const early = demandBySide({ slots: [{ slot: '10:00', students: { EM: { onHour: [booking('Early Bird')] } } }], dayWindow: WINDOW });
    expect(early.EM.counts.every(n => n === 0)).toBe(true);
    const nothing = demandBySide({ dayWindow: WINDOW });
    expect(nothing.EM.counts).toEqual(new Array(8).fill(0));
    expect(nothing.walkIns).toBe(0);
  });
});

describe('16 September 2026, the day this was found on', () => {
  // Elementary, as the Student Scheduler showed it: 10 at 3:00, which is
  // 9 booked plus Kabir Cheema walking in.
  it('matches the floor once the walk-in is counted', () => {
    const slots = [{ slot: '15:00', students: {
      EM: { onHour: Array.from({ length: 9 }, (_, i) => booking(`Student ${i + 1}`)), halfHour: [] },
    } }];
    const addOns = { 'EM|15:00': [{ id: 'wi_k', name: 'Kabir Cheema', duration: 60 }] };
    expect(demandBySide({ slots, dayWindow: WINDOW }).EM.counts[0]).toBe(9);
    expect(demandBySide({ slots, addOns, dayWindow: WINDOW }).EM.counts[0]).toBe(10);
  });
});
