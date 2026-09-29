import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runIntakeReminderSweep } from './intake-reminders.js';

/**
 * The sweep's own report.
 *
 * Written after a live run came back `{ due: 1, sms: 0, email: 1,
 * skipped: [] }` — one text that never went and nothing at all to say
 * why. Twilio was simply not configured yet, which is a perfectly good
 * answer; the bug was that the summary could not give it. Anything that
 * decides not to message a family has to be able to say what it decided.
 */

const HOUR = 3600000;

/** Enough of a Firestore handle for the sweep: one range query, one write. */
function fakeDb(intakes) {
  const writes = [];
  const query = { where: () => query, get: async () => ({
    docs: intakes.map(i => ({ id: i.id, data: () => i })),
  }) };
  return {
    writes,
    collection: () => query,
    doc: (path) => ({
      get: async () => (path.startsWith('centers/')
        ? { exists: true, data: () => ({ name: 'Mathnasium of Langley', timezone: 'America/Vancouver' }) }
        : { exists: false, data: () => ({}) }),
      set: async (data) => { writes.push({ path, data }); },
    }),
  };
}

const NOW = Date.UTC(2026, 8, 29, 16, 0, 0);
const intake = (extra) => ({
  id: 'intake-1',
  centerId: 'langley',
  status: 'scheduled',
  childName: 'Priya',
  // Tomorrow-ish: inside the 24h reminder window, so it is genuinely due.
  slot: new Date(NOW + 20 * HOUR).toISOString(),
  ...extra,
});

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  // Both channels off, which is the state that produced the silent run.
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});
afterEach(() => { process.env = savedEnv; });

describe('the reminder sweep explains itself', () => {
  it('says SMS is not configured rather than silently sending nothing', async () => {
    const db = fakeDb([intake({ phone: '+16045551234' })]);
    const summary = await runIntakeReminderSweep({ db, resend: null, now: NOW });

    expect(summary.due).toBe(1);
    expect(summary.sms).toBe(0);
    expect(summary.skipped).toContainEqual({ id: 'intake-1', channel: 'sms', reason: 'sms-not-configured' });
  });

  it('distinguishes "we have no number for them" from "we cannot text"', async () => {
    const db = fakeDb([intake({ email: 'parent@example.com' })]);
    const summary = await runIntakeReminderSweep({ db, resend: null, now: NOW });

    expect(summary.skipped).toContainEqual({ id: 'intake-1', channel: 'sms', reason: 'no-phone' });
    expect(summary.skipped).toContainEqual({ id: 'intake-1', channel: 'email', reason: 'email-not-configured' });
  });

  it('leaves no reminder stamped when nothing actually went out', async () => {
    const db = fakeDb([intake({ phone: '+16045551234', email: 'parent@example.com' })]);
    const summary = await runIntakeReminderSweep({ db, resend: null, now: NOW });

    // The stamp is what stops a second attempt. Writing it after a run
    // that sent nothing would lose the reminder for good.
    expect(db.writes).toEqual([]);
    expect(summary.errors).toEqual([]);
  });
});
