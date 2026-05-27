// GET /api/cron/send-shift-reminders
//
// Daily cron — sends "upcoming shift" reminder emails based on each user's
// notificationPreferences doc. Triggered by Vercel Cron (see vercel.json).
//
// SETUP (one-time)
//   1. Set CRON_SECRET in Vercel env vars (any long random string).
//      Vercel Cron auto-attaches this as `Authorization: Bearer <secret>`
//      on every invocation. The endpoint rejects anything else, so nobody
//      can spam the reminder system by hitting the URL externally.
//   2. RESEND_API_KEY + RESEND_FROM must already be set (same vars the
//      normal /api/send-email handler uses).
//   3. FIREBASE_SERVICE_ACCOUNT must already be set (same as Stripe webhook).
//
// PRECISION CAVEAT
//   Vercel Hobby cron runs at most once a day. So "1 hour before" and
//   "3 hours before" preferences can't be honored precisely — those users
//   get a same-day morning reminder instead. Users on "1 day" / "2 days"
//   get a reminder on the matching day. If precise hourly granularity ever
//   matters, the same endpoint can be pinged by an external cron pinger
//   (cron-job.org, GitHub Actions) every 15–30 mins — the idempotency
//   guard below means no double-sends.
//
// IDEMPOTENCY
//   Each shift gets a `reminderSentAt` timestamp once emailed. The query
//   skips any shift that already has it, so re-running the cron (or having
//   multiple cron services hit the endpoint) won't double-email.

import { Resend } from 'resend';
import { getFirestore } from '../_lib/firebase-admin.js';

// Lazy Resend client — same pattern as the rest of api/.
let _resend = null;
function resendClient() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY env var is not set');
  _resend = new Resend(key);
  return _resend;
}

// Vercel Cron sends Authorization: Bearer <CRON_SECRET>. We refuse anything
// else so the endpoint can't be triggered by random internet traffic.
function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${secret}`;
}

// YYYY-MM-DD for "today + n days" in UTC. Matches the date format stored on
// shift docs (e.g. "2026-05-27").
function dateStrOffset(daysFromNow) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Map a user's reminderTiming preference to the target date we should pull
// shifts for on this cron run. "1hour"/"3hours" can't be honored precisely
// from a daily cron, so they degrade gracefully to a same-day reminder.
function targetDateForPref(pref) {
  switch (pref) {
    case '2days':  return dateStrOffset(2);
    case '1day':   return dateStrOffset(1);
    case '3hours':
    case '1hour':  return dateStrOffset(0);
    default:       return null; // 'none' or missing -> no reminder
  }
}

// "15:00" -> "3:00PM" for human-friendly display.
function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':');
  let hour = parseInt(h, 10);
  if (Number.isNaN(hour)) return hhmm;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  return `${hour}:${m || '00'}${suffix}`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml({ name, dateStr, startTime, endTime, role }) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 14px 0;">Hi ${esc(name)},</p>
<p style="margin:0 0 10px 0;">Reminder of your upcoming shift:</p>
<p style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin:0 0 18px 0;">
  <strong>${esc(dateStr)}</strong><br>
  ${esc(fmtTime(startTime))} – ${esc(fmtTime(endTime))}${role ? ` · ${esc(role)}` : ''}
</p>
<p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;">— Ratio</p>
</div>`;
}

function buildText({ name, dateStr, startTime, endTime, role }) {
  return `Hi ${name},

Reminder of your upcoming shift:
${dateStr}, ${fmtTime(startTime)} – ${fmtTime(endTime)}${role ? ` (${role})` : ''}

— Ratio`;
}

export default async function handler(req, res) {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const fromAddress = process.env.RESEND_FROM;
  if (!fromAddress) {
    return res.status(500).json({ error: 'RESEND_FROM env var is not set' });
  }

  const db = getFirestore();

  // Load every notification-preferences doc. Typical deployment is a
  // handful of centres × ~30 staff each, so this collection stays small
  // enough to scan in one read. If it ever grows past a few thousand,
  // switch to a centre-scoped query.
  const prefsSnap = await db.collection('notificationPreferences').get();
  const lookups = [];
  prefsSnap.docs.forEach(d => {
    const pref = d.data() || {};
    if (!pref.emailEnabled) return;
    if (!pref.email)        return;
    const targetDate = targetDateForPref(pref.reminderTiming);
    if (!targetDate) return;
    lookups.push({
      uid:        d.id,
      email:      pref.email,
      name:       pref.userName || 'Team',
      targetDate,
    });
  });

  if (lookups.length === 0) {
    return res.status(200).json({ scanned: 0, sent: 0, message: 'No users due reminders' });
  }

  // For each (user, target date) pair, pull the matching shift(s) and
  // collect them for sending. One small query per user — cheap, and lets us
  // skip shifts that already have reminderSentAt stamped.
  const toSend = [];
  for (const lookup of lookups) {
    const snap = await db.collection('shifts')
      .where('userId', '==', lookup.uid)
      .where('date',   '==', lookup.targetDate)
      .get();
    for (const docSnap of snap.docs) {
      const shift = docSnap.data() || {};
      if (shift.reminderSentAt) continue; // already emailed for this shift
      toSend.push({
        shiftRef:  docSnap.ref,
        email:     lookup.email,
        name:      lookup.name,
        dateStr:   shift.date,
        startTime: shift.startTime,
        endTime:   shift.endTime,
        role:      shift.role || shift.subRole || '',
      });
    }
  }

  if (toSend.length === 0) {
    return res.status(200).json({ scanned: lookups.length, sent: 0, message: 'No matching shifts' });
  }

  const resend = resendClient();
  let sent = 0;
  let failed = 0;
  const errors = [];
  const BATCH = 100; // Resend batch.send limit

  for (let i = 0; i < toSend.length; i += BATCH) {
    const chunk = toSend.slice(i, i + BATCH);
    const payload = chunk.map(t => ({
      from:    fromAddress,
      to:      [t.email],
      subject: `Reminder: shift on ${t.dateStr}`,
      text:    buildText(t),
      html:    buildHtml(t),
    }));
    try {
      const { error } = await resend.batch.send(payload);
      if (error) throw new Error(error.message || 'Resend batch error');
      // Stamp each shift so we don't email it again on the next run.
      await Promise.all(chunk.map(t => t.shiftRef.set(
        { reminderSentAt: new Date().toISOString() },
        { merge: true },
      )));
      sent += chunk.length;
    } catch (err) {
      console.error('[shift-reminders] batch failed:', err);
      failed += chunk.length;
      errors.push(err.message || String(err));
    }
  }

  return res.status(200).json({
    scanned: lookups.length,
    total:   toSend.length,
    sent,
    failed,
    errors,
  });
}
