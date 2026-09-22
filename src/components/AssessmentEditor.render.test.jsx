// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { validateAssessment, clashWith, slotOf } from '../lib/assessments';

/**
 * Editing a booked assessment.
 *
 * The Calendar could show one and not change one, because an assessment
 * is a `centerIntakes` document rather than a calendar entry. Imported
 * ones arrive with whatever a Google Calendar title gave up — the first
 * live run named every child "Booked" — so read-only meant wrong forever.
 */
const updates = [];
const deletes = [];
vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (...a) => ({ path: a.slice(1).join('/') }),
  updateDoc: async (ref, data) => { updates.push({ path: ref.path, data }); },
  deleteDoc: async (ref) => { deletes.push(ref.path); },
}));
vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn() }, confirmDialog: async () => true,
}));

const { default: AssessmentEditor } = await import('./AssessmentEditor');

const INTAKE = {
  id: 'i1', centerId: 'langley', slot: '2026-09-23T12:00:00', durationMin: 60,
  childName: 'Booked', childGrade: '', childSchool: '',
  guardianName: '', email: '', phone: '',
  status: 'scheduled', notes: '', source: 'google-import', leadId: 'lead1',
};
const OTHER = {
  id: 'i2', slot: '2026-09-23T12:30:00', durationMin: 60,
  childName: 'Marcus Lee', status: 'scheduled',
};

const CONFIG = { intakeSettings: { address: '20151 Fraser Hwy, Langley' } };

const draw = (props = {}) => render(
  <AssessmentEditor intake={INTAKE} intakes={[INTAKE]} centerConfig={CONFIG}
    onClose={() => {}} {...props} />,
);
const save = async () => act(async () => {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
});

beforeEach(() => { updates.length = 0; deletes.length = 0; });
afterEach(cleanup);

describe('who, what, where, when', () => {
  it('opens on the booking it was given', () => {
    draw();
    expect(screen.getByLabelText(/^Date$/i).value).toBe('2026-09-23');
    expect(screen.getByLabelText(/^Start time$/i).value).toBe('12:00');
    expect(screen.getByLabelText(/how long/i).value).toBe('60');
    expect(screen.getByLabelText(/child's name/i).value).toBe('Booked');
  });

  it('works out the end time so nobody has to', () => {
    draw();
    expect(screen.getByText(/ends 13:00/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/how long/i), { target: { value: '90' } });
    expect(screen.getByText(/ends 13:30/i)).toBeTruthy();
  });

  it('shows where it happens, from the centre-s own settings', () => {
    draw();
    expect(screen.getByText(/In centre — 20151 Fraser Hwy, Langley/i)).toBeTruthy();
  });

  it('says where to put an address when there is none', () => {
    draw({ centerConfig: {} });
    expect(screen.getByText(/no address saved yet/i)).toBeTruthy();
  });

  it('says an imported one is a copy, not a link back to Google', () => {
    // Two calendars that both think they are in charge is how a family
    // gets told two different times.
    draw();
    expect(screen.getByText(/does not change the original event/i)).toBeTruthy();
  });

  it('points at the family on the Leads board when there is one', () => {
    draw();
    expect(screen.getByText(/on the Leads board/i)).toBeTruthy();
  });

  it('says nothing about Leads when the assessment has no lead', () => {
    draw({ intake: { ...INTAKE, leadId: null } });
    expect(screen.queryByText(/on the Leads board/i)).toBeNull();
  });
});

describe('saving', () => {
  it('writes the corrected names back to centerIntakes', async () => {
    draw();
    fireEvent.change(screen.getByLabelText(/child's name/i), { target: { value: 'Priya Sharma' } });
    fireEvent.change(screen.getByLabelText(/guardian's name/i), { target: { value: 'Anita Sharma' } });
    fireEvent.change(screen.getByLabelText(/^Grade$/i), { target: { value: '5' } });
    await save();
    expect(updates).toHaveLength(1);
    expect(updates[0].path).toBe('centerIntakes/i1');   // the collection matters
    expect(updates[0].data).toMatchObject({
      childName: 'Priya Sharma', guardianName: 'Anita Sharma', childGrade: '5',
    });
  });

  it('rebuilds the slot when the time moves, in the centre-s own wall clock', async () => {
    // `slot` is what the booking grid and the day cap read. Getting the
    // shape wrong here quietly frees or blocks the wrong hour.
    draw();
    fireEvent.change(screen.getByLabelText(/^Date$/i), { target: { value: '2026-09-24' } });
    fireEvent.change(screen.getByLabelText(/^Start time$/i), { target: { value: '16:30' } });
    await save();
    expect(updates[0].data.slot).toBe('2026-09-24T16:30:00');
  });

  it('lowercases an email the way the booking path does', async () => {
    draw();
    fireEvent.change(screen.getByLabelText(/^Email$/i), { target: { value: 'Anita.Sharma@Example.COM' } });
    await save();
    expect(updates[0].data.email).toBe('anita.sharma@example.com');
  });

  it('refuses a booking with nobody-s name on it', async () => {
    draw();
    fireEvent.change(screen.getByLabelText(/child's name/i), { target: { value: '' } });
    await save();
    expect(screen.getByText(/at least one name/i)).toBeTruthy();
    expect(updates).toHaveLength(0);
  });

  it('accepts a guardian alone', () => {
    expect(validateAssessment({
      date: '2026-09-23', startTime: '12:00', durationMin: 60, guardianName: 'Anita',
    })).toBe(null);
  });

  it('wants a real date and time', () => {
    expect(validateAssessment({ startTime: '12:00', durationMin: 60, childName: 'A' })).toMatch(/date/i);
    expect(validateAssessment({ date: '2026-09-23', durationMin: 60, childName: 'A' })).toMatch(/start time/i);
  });
});

describe('a clash is a warning, not a wall', () => {
  it('names the assessment this one would run into', () => {
    draw({ intakes: [INTAKE, OTHER] });
    expect(screen.getByText(/Runs into Marcus Lee at 12:30/i)).toBeTruthy();
  });

  it('still lets it be saved — two instructors, one hour', async () => {
    draw({ intakes: [INTAKE, OTHER] });
    await save();
    expect(updates).toHaveLength(1);
  });

  it('never reports an assessment clashing with itself', () => {
    expect(clashWith({ id: 'i1', date: '2026-09-23', startTime: '12:00', durationMin: 60 }, [INTAKE]))
      .toBe(null);
  });

  it('ignores a cancelled booking — its hour is free again', () => {
    expect(clashWith(
      { id: 'x', date: '2026-09-23', startTime: '12:00', durationMin: 60 },
      [{ ...OTHER, status: 'cancelled' }],
    )).toBe(null);
  });

  it('does not count a booking that merely sits flush against it', () => {
    expect(clashWith(
      { id: 'x', date: '2026-09-23', startTime: '13:00', durationMin: 60 },
      [OTHER],   // 12:30–13:30 — this one DOES overlap
    )).toBeTruthy();
    expect(clashWith(
      { id: 'x', date: '2026-09-23', startTime: '13:30', durationMin: 60 },
      [OTHER],
    )).toBe(null);
  });
});

describe('status and deleting', () => {
  it('records a no-show without losing the booking', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /^no-show$/i }));
    await save();
    expect(updates[0].data.status).toBe('no_show');
  });

  it('explains what cancelling actually does', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /^cancelled$/i }));
    expect(screen.getByText(/puts the hour back on the public booking page/i)).toBeTruthy();
  });

  it('deletes the intake itself, not a calendar entry', async () => {
    draw();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /delete/i })); });
    expect(deletes).toEqual(['centerIntakes/i1']);
  });
});

describe('who may change one', () => {
  it('turns away anyone the rules would refuse, with the reason', () => {
    // centerIntakes is owner-tier because it carries a parent's name,
    // email and phone — the same boundary that keeps Managers and Hosts
    // off Leads and Supply & Demand.
    draw({ canEdit: false });
    expect(screen.getByText(/only owners, directors and the admin assistant/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });
});

describe('the slot string', () => {
  it('is the centre-s wall clock with no zone on it', () => {
    expect(slotOf('2026-09-23', '12:00')).toBe('2026-09-23T12:00:00');
    expect(slotOf('2026-09-23', '')).toBe('2026-09-23T00:00:00');
  });
});
