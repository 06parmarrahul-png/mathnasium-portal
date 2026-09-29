import { describe, it, expect } from 'vitest';
import {
  dueReminder, dueReminders, alreadySent, reminderSms, reminderEmail, REMINDER_OFFSETS,
} from './intakeReminders';

const HOUR = 3600000;
const NOW = Date.parse('2026-10-02T12:00:00Z');
const inHours = (h) => new Date(NOW + h * HOUR).toISOString();

const intake = (over = {}) => ({
  id: 'i1', status: 'scheduled', slot: inHours(30), ...over,
});

describe('when a reminder becomes due', () => {
  it('is not due while the appointment is further off than the longest lead', () => {
    expect(dueReminder(intake({ slot: inHours(30) }), NOW)).toBeNull();
  });

  it('becomes due the moment the 24h lead passes', () => {
    expect(dueReminder(intake({ slot: inHours(23.9) }), NOW).key).toBe('24h');
  });

  it('STAYS due hours later, so a late cron still sends it', () => {
    // The failure this guards: a run that missed its window sends nothing
    // and nobody finds out until the family does not arrive.
    expect(dueReminder(intake({ slot: inHours(6) }), NOW).key).toBe('24h');
  });

  it('sends the 2h reminder once the 24h one is done', () => {
    const i = intake({ slot: inHours(1.5), remindersSent: { '24h': 'yes' } });
    expect(dueReminder(i, NOW).key).toBe('2h');
  });

  it('never sends the same offset twice', () => {
    const i = intake({ slot: inHours(6), remindersSent: { '24h': 'yes' } });
    expect(dueReminder(i, NOW)).toBeNull();
  });

  it('does not send a "tomorrow" reminder for something booked inside 2 hours', () => {
    // Booked at short notice: they get the 2h one and never a stale
    // "tomorrow" about an appointment that is today.
    const i = intake({ slot: inHours(1) });
    const first = dueReminder(i, NOW);
    expect(first.key).toBe('24h');   // longest unsent wins...
    const after = dueReminder({ ...i, remindersSent: { '24h': 'x' } }, NOW);
    expect(after.key).toBe('2h');
  });

  it('says nothing about an appointment that has passed', () => {
    expect(dueReminder(intake({ slot: inHours(-1) }), NOW)).toBeNull();
  });

  it('ignores anything not still scheduled', () => {
    for (const status of ['cancelled', 'completed', 'noshow', undefined]) {
      expect(dueReminder(intake({ slot: inHours(6), status }), NOW), String(status)).toBeNull();
    }
  });

  it('ignores an intake whose slot will not parse', () => {
    expect(dueReminder(intake({ slot: 'sometime' }), NOW)).toBeNull();
    expect(dueReminder(intake({ slot: null }), NOW)).toBeNull();
  });

  it('is safe with nothing at all', () => {
    expect(dueReminder(null, NOW)).toBeNull();
    expect(alreadySent(null, '24h')).toBe(false);
    expect(alreadySent({}, '24h')).toBe(false);
  });
});

describe('the whole list', () => {
  it('returns the soonest appointment first', () => {
    const out = dueReminders([
      intake({ id: 'later', slot: inHours(20) }),
      intake({ id: 'sooner', slot: inHours(3) }),
      intake({ id: 'notyet', slot: inHours(40) }),
    ], NOW);
    expect(out.map(x => x.intake.id)).toEqual(['sooner', 'later']);
  });

  it('carries which offset it decided on, so the caller need not re-derive it', () => {
    const [first] = dueReminders([intake({ slot: inHours(1.5), remindersSent: { '24h': 'x' } })], NOW);
    expect(first.reminder.key).toBe('2h');
    expect(first.reminder.minutesUntil).toBe(90);
  });

  it('is empty rather than throwing on junk', () => {
    expect(dueReminders(null, NOW)).toEqual([]);
    expect(dueReminders([null, undefined, {}], NOW)).toEqual([]);
  });
});

describe('what the family actually receives', () => {
  it('names the child and carries the STOP line the consent promised', () => {
    const t = reminderSms({
      centreName: 'Mathnasium of Langley', childName: 'Priya',
      whenText: '4:00 PM', label: 'tomorrow',
    });
    expect(t).toContain("Priya's assessment is tomorrow at 4:00 PM");
    expect(t).toContain('Reply STOP to opt out');
  });

  it('stays inside one SMS segment for a normal case', () => {
    // Every segment past the first is another fraction of a cent and
    // another chance of it arriving in pieces.
    const t = reminderSms({
      centreName: 'Mathnasium of Langley', childName: 'Priya',
      whenText: '4:00 PM', label: 'tomorrow',
    });
    expect(t.length).toBeLessThanOrEqual(160);
  });

  it('copes when nobody recorded the child’s name', () => {
    const t = reminderSms({ centreName: 'Mathnasium', whenText: '4:00 PM', label: 'tomorrow' });
    expect(t).toContain('your assessment is tomorrow');
  });

  it('puts an unsubscribe link in the email, and omits it when there is none', () => {
    const withLink = reminderEmail({
      centreName: 'Mathnasium', whenText: '4:00 PM', label: 'tomorrow',
      unsubscribeUrl: 'https://x/api/notify?action=unsubscribe',
    });
    expect(withLink.body).toContain('https://x/api/notify?action=unsubscribe');
    expect(withLink.subject).toMatch(/tomorrow/);

    const without = reminderEmail({ centreName: 'Mathnasium', whenText: '4:00 PM', label: 'tomorrow' });
    expect(without.body).not.toMatch(/unsubscribe/i);
  });

  it('offers exactly two lead times, longest first', () => {
    expect(REMINDER_OFFSETS.map(o => o.key)).toEqual(['24h', '2h']);
  });
});
