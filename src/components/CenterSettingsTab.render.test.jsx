// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * The Ratio Games switch in Centre Settings.
 *
 * It starts and stops a contest with a prize attached, so it is the
 * owner's and Enterprise's alone — narrower than the page around it, which
 * the Admin Assistant, a Director and any role granted `centre.settings`
 * can all open. The Firestore rules enforce the same split; this is the
 * half of it people actually see.
 */

const writes = [];
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  setDoc: vi.fn(async (ref, payload) => { writes.push(payload); }),
  serverTimestamp: () => 'ts',
}));
const current = { auth: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth }));

const { default: CenterSettingsTab } = await import('./CenterSettingsTab');
const { DEFAULT_CENTER_CONFIG } = await import('../lib/centerConfig');

function setup({ owner = true, enterprise = false, enabled = false } = {}) {
  current.auth = { isOwner: owner, isSuperAdmin: enterprise };
  const config = { ...DEFAULT_CENTER_CONFIG, name: 'Mathnasium Langley', gamesEnabled: enabled };
  render(<CenterSettingsTab activeCenterId="langley" centerConfig={config} />);
  return config;
}

const theSwitch = () => screen.queryByRole('checkbox', { name: /staff can play|hidden from everyone/i });

beforeEach(() => { writes.length = 0; });
afterEach(cleanup);

describe('who sees the switch', () => {
  it('the owner does', () => {
    setup({ owner: true });
    expect(theSwitch()).toBeTruthy();
  });

  it('Enterprise does', () => {
    setup({ owner: false, enterprise: true });
    expect(theSwitch()).toBeTruthy();
  });

  it('the Admin Assistant and Directors do not — they get the rest of the page', () => {
    setup({ owner: false, enterprise: false });
    expect(theSwitch()).toBeNull();
    expect(screen.queryByText('Ratio Games')).toBeNull();
    // The page is still theirs.
    expect(screen.getByText('Centre Settings')).toBeTruthy();
    expect(screen.getByText('Instructional Hours')).toBeTruthy();
  });
});

describe('the switch itself', () => {
  it('reads off when the centre has never turned it on', () => {
    setup({ enabled: false });
    expect(theSwitch().checked).toBe(false);
    expect(screen.getByText('Off — hidden from everyone')).toBeTruthy();
  });

  it('reads on when it is on', () => {
    setup({ enabled: true });
    expect(theSwitch().checked).toBe(true);
    expect(screen.getByText('On — staff can play')).toBeTruthy();
  });

  it('flipping it needs a save, and writes the flag', async () => {
    setup({ enabled: false });
    fireEvent.click(theSwitch());
    expect(theSwitch().checked).toBe(true);
    expect(writes).toHaveLength(0);                 // nothing written yet
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].gamesEnabled).toBe(true);
  });

  it('says what switching it off actually does', () => {
    // People need to know this deletes nothing before they dare press it.
    setup({ enabled: true });
    expect(screen.getByText(/Nothing is deleted: scores stay where they are/i)).toBeTruthy();
  });
});
