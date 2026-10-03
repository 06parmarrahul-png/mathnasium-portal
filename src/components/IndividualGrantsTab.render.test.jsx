// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * Manage Staff → Individuals.
 *
 * This hands one person access their title does not carry, so the things
 * worth pinning are the boundaries: the write lands on THAT person's
 * membership at THIS centre, and the platform-only permissions are not on
 * offer at all.
 */

const writes = [];
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (_db, coll, id) => ({ __path: `${coll}/${id}` }),
  updateDoc: vi.fn(async (ref, payload) => { writes.push({ path: ref.__path, payload }); }),
}));
const toasts = [];
vi.mock('../lib/notify', () => ({
  toast: { success: (m) => toasts.push(['ok', m]), error: (m) => toasts.push(['err', m]) },
}));
const current = { auth: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth, useOptionalAuth: () => current.auth }));

const { default: IndividualGrantsTab } = await import('./IndividualGrantsTab');

const staff = (displayName, over = {}) => ({
  uid: `u-${displayName.split(' ')[0].toLowerCase()}`,
  displayName, role: 'instructor',
  centerMemberships: { langley: { instructorType: 'Instructor', ...over } },
});

const USERS = [
  staff('Ainsley Grant'),
  staff('Kaitlyn MacDonald'),
  staff('Homer Ayuste'),
  staff('Neeru Gill', { instructorType: 'Manager' }),
];

function draw(users = USERS) {
  current.auth = { activeCenterId: 'langley', centerConfig: {} };
  return render(<IndividualGrantsTab users={users} />);
}

const rowFor = (name) => screen.getByRole('button', { name: new RegExp(name) });

beforeEach(() => { writes.length = 0; toasts.length = 0; });
afterEach(cleanup);

describe('the list', () => {
  it('shows every member of staff, by name and title', () => {
    draw();
    expect(screen.getByText('Ainsley Grant')).toBeTruthy();
    expect(screen.getByText('Homer Ayuste')).toBeTruthy();
    expect(screen.getAllByText(/Instructor/).length).toBeGreaterThan(0);
  });

  it('searches', () => {
    draw();
    fireEvent.change(screen.getByLabelText('Search staff'), { target: { value: 'kait' } });
    expect(screen.getByText('Kaitlyn MacDonald')).toBeTruthy();
    expect(screen.queryByText('Homer Ayuste')).toBeNull();
  });

  it('says plainly that it only ever adds', () => {
    // The screen has to answer "can I take something away here?" without
    // anybody having to try it.
    draw();
    expect(screen.getByText(/can give somebody more than their title does, never less/)).toBeTruthy();
  });
});

describe('granting', () => {
  it('writes to that person’s membership at this centre, and nowhere else', async () => {
    draw();
    fireEvent.click(rowFor('Ainsley Grant'));
    fireEvent.click(screen.getByRole('button', { name: 'Grant: Run the Student Scheduler' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].path).toBe('users/u-ainsley');
    expect(writes[0].payload).toEqual({
      'centerMemberships.langley.extraPermissions': ['scheduler.run'],
    });
  });

  it('takes it back on a second press', async () => {
    draw([staff('Ainsley Grant', { extraPermissions: ['scheduler.run'] })]);
    fireEvent.click(rowFor('Ainsley Grant'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove: Run the Student Scheduler' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].payload['centerMemberships.langley.extraPermissions']).toEqual([]);
  });

  it('does not offer the permissions a centre may never grant', () => {
    // Same escalation boundary a role has — otherwise this tab would be
    // the way around it.
    draw();
    fireEvent.click(rowFor('Ainsley Grant'));
    expect(screen.queryByText(/Manage roles/i)).toBeNull();
    expect(screen.queryByText(/district roll-up/i)).toBeNull();
  });

  it('says when a grant would add nothing, because the title covers it', () => {
    draw([staff('Neeru Gill', { instructorType: 'Manager' })]);
    fireEvent.click(rowFor('Neeru Gill'));
    expect(screen.getAllByText(/Their title already includes this/).length).toBeGreaterThan(0);
  });
});

describe('who already has something', () => {
  it('names them up front, so nobody has to open four rows to find out', () => {
    draw([
      staff('Ainsley Grant', { extraPermissions: ['scheduler.run'] }),
      staff('Homer Ayuste', { extraPermissions: ['scheduler.run'] }),
      staff('Neeru Gill'),
    ]);
    expect(screen.getByText(/2 people have extra access/)).toBeTruthy();
    expect(screen.getByText(/Ainsley Grant \(Run the Student Scheduler\)/)).toBeTruthy();
  });

  it('says nothing at all when nobody does', () => {
    draw();
    expect(screen.queryByText(/extra access/)).toBeNull();
  });
});
