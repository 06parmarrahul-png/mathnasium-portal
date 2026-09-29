/**
 * intake-reminders.js — telling families their assessment is coming up.
 *
 * This is the half of Apptoto that matters. It rides inside the existing
 * cron rather than owning a Serverless Function, for the same reason the
 * inventory sweep does: Vercel's Hobby plan caps a deployment at twelve
 * and this project is at the ceiling. Anything under api/_lib/ is a
 * module, not a function, so it costs nothing.
 *
 * EVERY SEND GOES THROUGH THE CONSENT GATE. Not as a courtesy — the
 * booking form promises a working STOP, and a reminder that ignores one
 * is the promise broken. SMS is gated inside sendSms(); email is gated
 * here, against the same records.
 *
 * WHAT COUNTS AS BASIS. The family booked an assessment, which is what
 * makes a reminder about it transactional. That basis is passed
 * explicitly rather than assumed, so nothing in here can quietly start
 * sending promotions on the strength of a booking.
 */

import { dueReminders, reminderSms, reminderEmail } from '../../src/lib/intakeReminders.js';
import { sendSms, smsConfigured } from './sms.js';
import { checkBeforeSend } from './consentStore.js';
import { unsubscribeUrl } from './unsubscribe.js';

const HOUR = 3600000;

/** "2026-10-03T16:00:00Z" → "4:00 PM" in the centre's own timezone. */
function clockText(iso, timezone) {
  try {
    return new Date(iso).toLocaleTimeString('en-CA', {
      hour: 'numeric', minute: '2-digit', timeZone: timezone || 'America/Vancouver',
    });
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

/**
 * Send whatever is due, once.
 *
 * Idempotency is a per-offset stamp on the intake, written BEFORE the
 * send is attempted would be wrong (a failure would silently skip it
 * forever) and AFTER every attempt is also wrong (a crash mid-loop
 * re-sends). It is written after a successful send on at least one
 * channel — so a family whose SMS bounced but whose email went is not
 * reminded twice, and one where both failed is retried next run.
 */
export async function runIntakeReminderSweep({ db, fromAddress, portalUrl, resend, now = Date.now() }) {
  const summary = { considered: 0, due: 0, sms: 0, email: 0, skipped: [], errors: [] };

  // Range on one field only — no composite index needed. Status is
  // filtered in memory, which is cheap at this volume and one less thing
  // to have to deploy alongside the code.
  const fromISO = new Date(now).toISOString();
  const toISO = new Date(now + 25 * HOUR).toISOString();
  const snap = await db.collection('centerIntakes')
    .where('slot', '>=', fromISO).where('slot', '<=', toISO).get();

  const intakes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  summary.considered = intakes.length;

  const centres = new Map();
  const centreOf = async (centreId) => {
    if (centres.has(centreId)) return centres.get(centreId);
    const [cSnap, cfgSnap] = await Promise.all([
      db.doc(`centers/${centreId}`).get(),
      db.doc(`centers/${centreId}/config/main`).get(),
    ]);
    const info = {
      name: (cSnap.exists && cSnap.data().name) || 'Mathnasium',
      timezone: (cfgSnap.exists && cfgSnap.data().timezone) || 'America/Vancouver',
    };
    centres.set(centreId, info);
    return info;
  };

  for (const { intake, reminder } of dueReminders(intakes, now)) {
    summary.due += 1;
    const centreId = intake.centerId;
    if (!centreId) { summary.skipped.push({ id: intake.id, reason: 'no-centre' }); continue; }

    let centre;
    try { centre = await centreOf(centreId); }
    catch (e) { summary.errors.push({ id: intake.id, error: e.message }); continue; }

    const whenText = clockText(intake.slot, centre.timezone);
    const shared = {
      centreName: centre.name,
      childName: intake.childName || '',
      whenText,
      label: reminder.label,
    };

    let anySent = false;

    // ── text ──
    if (intake.phone && smsConfigured()) {
      try {
        const r = await sendSms(db, centreId, {
          to: intake.phone,
          body: reminderSms(shared),
          kind: 'transactional',
          hasTransactionalBasis: true,
        });
        if (r.sent) { summary.sms += 1; anySent = true; }
        else summary.skipped.push({ id: intake.id, channel: 'sms', reason: r.reason });
      } catch (e) {
        summary.errors.push({ id: intake.id, channel: 'sms', error: e.message });
      }
    }

    // ── email ──
    if (intake.email && resend && fromAddress) {
      try {
        const verdict = await checkBeforeSend(db, centreId, {
          channel: 'email', address: intake.email,
          kind: 'transactional', hasTransactionalBasis: true,
        });
        if (!verdict.allowed) {
          summary.skipped.push({ id: intake.id, channel: 'email', reason: verdict.reason });
        } else {
          const link = portalUrl ? unsubscribeUrl(portalUrl, centreId, verdict.address) : null;
          const { subject, body } = reminderEmail({ ...shared, unsubscribeUrl: link });
          await resend.emails.send({
            from: fromAddress,
            to: verdict.address,
            subject,
            text: body,
            // What a mail client's own one-click unsubscribe uses. Without
            // it, "this is spam" becomes the easiest way out for a family
            // who just wants the reminders to stop.
            headers: link ? { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
          });
          summary.email += 1;
          anySent = true;
        }
      } catch (e) {
        summary.errors.push({ id: intake.id, channel: 'email', error: e.message });
      }
    }

    if (anySent) {
      try {
        await db.doc(`centerIntakes/${intake.id}`).set({
          remindersSent: { ...(intake.remindersSent || {}), [reminder.key]: new Date().toISOString() },
        }, { merge: true });
      } catch (e) {
        // Worth shouting about: the send happened and the stamp did not,
        // so the next run will send it again.
        summary.errors.push({ id: intake.id, error: `stamp failed: ${e.message}` });
      }
    }
  }

  return summary;
}
