// @vitest-environment jsdom
import React from 'react';   // transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

/**
 * One student's row on the Student Scheduler sheet.
 *
 * The page itself needs a parsed feed day, check-ins, assignments, a ratio
 * config and a roster before it renders anything, so this tests the row —
 * which is the part staff actually read, standing at the desk.
 */
vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}), query: () => ({}), where: () => ({}), orderBy: () => ({}),
  limit: () => ({}), doc: () => ({}), onSnapshot: () => () => {},
  getDocs: async () => ({ docs: [] }), getDoc: async () => ({ exists: () => false, data: () => ({}) }),
  setDoc: async () => {}, updateDoc: async () => {}, deleteDoc: async () => {},
  addDoc: async () => ({ id: 'x' }), writeBatch: () => ({ set: () => {}, delete: () => {}, commit: async () => {} }),
  serverTimestamp: () => 'ts', arrayUnion: (...v) => v, arrayRemove: (...v) => v, increment: (n) => n,
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { uid: 'u1' }, activeCenterId: 'langley' }),
  useOptionalAuth: () => ({ profile: { uid: 'u1' }, activeCenterId: 'langley' }),
}));
vi.mock('../lib/notify', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  confirmDialog: async () => true,
}));

const { StudentRow } = await import('./SchedulerCreation');

const student = (over = {}) => ({
  id: 's1', name: 'Amaria Yngreso', duration: 60, type: 'Langley In-Centre 60 minute math tutoring', ...over,
});

const draw = (s, props = {}) => render(
  <ul>
    <StudentRow
      s={s} entry={{}} centerId="langley" date="2026-10-01"
      onStatusClick={() => {}} onStatusMenu={() => {}} currentSlot="15:00"
      {...props} />
  </ul>,
);

beforeEach(() => {});
afterEach(() => { cleanup(); });

describe('a student who leaves early', () => {
  it('marks the half-hour block on the sheet', () => {
    // The whole point. She sits in the same on-the-hour column as the
    // full-hour students and gets up thirty minutes sooner; before this
    // nothing on the row said so.
    draw(student({ duration: 30, type: 'Langley In-Centre 30 minute math tutoring' }));
    expect(screen.getByText('Amaria Yngreso')).toBeTruthy();
    expect(screen.getByText('30 min')).toBeTruthy();
  });

  it('says when she actually gets up', () => {
    draw(student({ duration: 30 }), { currentSlot: '15:00' });
    expect(screen.getByTitle(/leaves at 3:30/)).toBeTruthy();
  });

  it('reads the Saturday hours the same way', () => {
    draw(student({ duration: 30 }), { currentSlot: '10:00' });
    expect(screen.getByTitle(/leaves at 10:30/)).toBeTruthy();
  });

  it('says nothing about a leaving time it cannot work out', () => {
    draw(student({ duration: 30 }), { currentSlot: undefined });
    expect(screen.getByText('30 min')).toBeTruthy();
    expect(screen.queryByTitle(/leaves at/)).toBeNull();
  });

  it('SAYS NOTHING ON AN ORDINARY HOUR', () => {
    // Every other student on the sheet is one. A badge on all of them is
    // a badge on none of them.
    draw(student({ duration: 60 }));
    expect(screen.queryByText(/min$/)).toBeNull();
  });

  it('says nothing on a longer session either', () => {
    // The Highschool side already gives those their own column.
    draw(student({ duration: 90 }));
    expect(screen.queryByText(/min$/)).toBeNull();
  });

  it('stays quiet when the booking carries no length', () => {
    draw(student({ duration: undefined }));
    expect(screen.queryByText(/min$/)).toBeNull();
  });

  it('still shows the badge beside the other flags, not instead of them', () => {
    draw(student({ duration: 30, isAssessment: true }));
    expect(screen.getByText('30 min')).toBeTruthy();
    expect(screen.getByText('(A)')).toBeTruthy();
  });

  it('renders a walk-in with a short duration too', () => {
    draw(student({ duration: 30, isWalkIn: true }));
    expect(screen.getByText('30 min')).toBeTruthy();
  });
});

describe('the note sits under the student, not beside them', () => {
  const noteBox = () => screen.getByPlaceholderText('note…');

  it('takes a full line of its own', () => {
    // It used to share the line with the name and take whatever width was
    // left, so the box changed size with the length of the name above it.
    // basis-full is what puts it on its own row inside the student's <li>.
    draw(student());
    expect(noteBox().className).toMatch(/basis-full/);
    expect(noteBox().className).not.toMatch(/basis-\[/);
  });

  it('is still that one student’s note', () => {
    // On its own line but INSIDE the same <li>, which is what keeps it
    // unmistakably attached to the name above it rather than floating
    // between two students.
    draw(student());
    const li = noteBox().closest('li');
    expect(li).toBeTruthy();
    expect(li.textContent).toContain('Amaria Yngreso');
  });

  it('still saves what was typed', () => {
    draw(student());
    expect(noteBox().getAttribute('maxlength')).toBe('400');
  });

  it('prints as plain text — no box, no placeholder on paper', () => {
    draw(student());
    expect(noteBox().className).toMatch(/print:border-0/);
    expect(noteBox().className).toMatch(/print:placeholder:text-transparent/);
  });
});
