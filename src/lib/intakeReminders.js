/**
 * intakeReminders.js — which families are due a reminder, and when.
 *
 * This is the half of Apptoto that actually matters: a family books an
 * assessment three weeks out and needs telling the day before.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * A MISSED WINDOW MUST NOT MEAN A MISSED REMINDER.
 *
 * The obvious rule — "send when now is within a few minutes of
 * slot − 24h" — quietly fails every time a cron run is late, throttled,
 * or the plan only allows a daily run. The family then gets nothing, and
 * nobody finds out until they do not turn up.
 *
 * So a reminder is due from the moment its lead time passes until the
 * appointment itself, and idempotency comes from a per-offset stamp
 * rather than from timing. A run at any point inside that window sends
 * it once; every later run skips it.
 *
 * The consequence is deliberate: a cron that has been down for six hours
 * sends a late "tomorrow" reminder rather than no reminder. Late is
 * information. Silence is not.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

/** Lead times, longest first, so the earliest due one is found first. */
export const REMINDER_OFFSETS = [
  { key: '24h', minutes: 24 * 60, label: 'tomorrow' },
  { key: '2h',  minutes: 2 * 60,  label: 'in about two hours' },
];

const MIN = 60000;

/** Already sent? Reads the per-offset stamp map, tolerating its absence. */
export function alreadySent(intake, offsetKey) {
  const sent = intake?.remindersSent;
  return Boolean(sent && sent[offsetKey]);
}

/**
 * The reminder this intake is due right now, or null.
 *
 * Returns at most one — the longest lead time still unsent. A family who
 * booked inside the 2h window gets the 2h reminder and is never sent a
 * "tomorrow" one for an appointment that is today.
 */
export function dueReminder(intake, now = Date.now()) {
  if (!intake || intake.status !== 'scheduled') return null;
  const slotMs = Date.parse(intake.slot || '');
  if (Number.isNaN(slotMs)) return null;
  // Past appointments are not reminded about.
  if (slotMs <= now) return null;

  for (const offset of REMINDER_OFFSETS) {
    const dueFrom = slotMs - offset.minutes * MIN;
    if (now < dueFrom) continue;          // not yet
    if (alreadySent(intake, offset.key)) continue;
    return { ...offset, slotMs, minutesUntil: Math.round((slotMs - now) / MIN) };
  }
  return null;
}

/**
 * Everything due across a list, newest appointment last.
 *
 * Shaped as { intake, reminder } so the caller does not have to re-derive
 * which offset it was about to send.
 */
export function dueReminders(intakes, now = Date.now()) {
  const out = [];
  for (const intake of intakes || []) {
    const reminder = dueReminder(intake, now);
    if (reminder) out.push({ intake, reminder });
  }
  return out.sort((a, b) => a.reminder.slotMs - b.reminder.slotMs);
}

/**
 * What the text actually says.
 *
 * Under 160 characters wherever it can be, because each segment past that
 * is another fraction of a cent and another chance of it arriving in
 * pieces. The STOP line is not decoration — the consent wording on the
 * booking form promises it, and every message has to carry it.
 */
export function reminderSms({ centreName, childName, whenText, label }) {
  const who = childName ? `${childName}'s` : 'your';
  const when = label === 'tomorrow' ? `tomorrow at ${whenText}` : `at ${whenText}`;
  return `${centreName}: reminder, ${who} assessment is ${when}. Reply STOP to opt out.`;
}

/** The same thing for email, where there is room to be a bit warmer. */
export function reminderEmail({ centreName, childName, whenText, label, unsubscribeUrl }) {
  const who = childName ? `${childName}'s` : 'your';
  const when = label === 'tomorrow' ? `tomorrow at ${whenText}` : `today at ${whenText}`;
  return {
    subject: `Reminder: ${who} assessment is ${label === 'tomorrow' ? 'tomorrow' : 'today'}`,
    body: [
      `This is a reminder that ${who} assessment at ${centreName} is ${when}.`,
      '',
      'If you need to change or cancel it, just reply to this email.',
      '',
      'See you then.',
      unsubscribeUrl ? `\nTo stop reminder emails: ${unsubscribeUrl}` : '',
    ].filter(Boolean).join('\n'),
  };
}
