// GET /api/cron/send-shift-reminders
//
// Frequent cron — sends "upcoming shift" reminder emails based on each
// user's notificationPreferences doc. Triggered every 15 min by Vercel
// Cron (see vercel.json).
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
// TIMING — how lead-time preferences are honoured
//   Each reminderTiming maps to a lead time (1hour=60m, 3hours=180m,
//   1day=24h, 2days=48h). For every candidate shift we compute its REAL
//   start instant in the centre's timezone, then send once the current
//   time has reached (shiftStart − leadTime). Because this runs every
//   15 min, a "3 hours before" user with a 3:00 PM shift gets the email
//   at ~12:00 PM — not at a fixed 6 AM blast. Granularity is the cron
//   interval (~15 min), which is fine for shift reminders.
//
//   PLAN NOTE: sub-daily Vercel Cron requires the Pro plan. On the Hobby
//   plan (daily-only), keep vercel.json but ALSO hit this same URL every
//   15–30 min from a free external pinger (cron-job.org, GitHub Actions)
//   with header `Authorization: Bearer <CRON_SECRET>`. The idempotency
//   guard below makes any number of pingers safe.
//
// IDEMPOTENCY
//   Each shift gets a `reminderSentAt` timestamp once emailed. The loop
//   skips any shift that already has it, so re-running the cron (or having
//   multiple cron services hit the endpoint) won't double-email.

import { Resend } from 'resend';
import { getFirestore } from '../_lib/firebase-admin.js';
import { runInventorySweep } from '../_lib/inventory-alerts.js';

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

// Centre timezone. Shift `date`/`startTime` are stored as centre-local wall
// clock (e.g. "2026-05-27" + "15:00"), so all date/time math must happen in
// this zone — not the UTC that Vercel Lambdas run in. Overridable via env in
// case a centre in another zone is added later.
const CENTER_TZ = process.env.CENTER_TZ || 'America/Vancouver';

// reminderTiming preference -> lead time in minutes before shift start.
const LEAD_MINUTES = {
  '2days':  2 * 24 * 60,
  '1day':   1 * 24 * 60,
  '3hours': 3 * 60,
  '1hour':  1 * 60,
  // 'none' / missing -> no entry -> no reminder
};

// Offset (ms) to ADD to a UTC instant to get the wall-clock reading in `tz`.
// Uses Intl so DST is handled correctly for the specific instant.
function tzOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - (date.getTime() - date.getMilliseconds());
}

// Combine a centre-local date ("YYYY-MM-DD") + time ("HH:MM") into the true
// UTC instant that wall clock represents. Refines once for DST boundaries.
function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  const guess = new Date(Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0, 0));
  const off1 = tzOffsetMs(timeZone, guess);
  let result = new Date(guess.getTime() - off1);
  const off2 = tzOffsetMs(timeZone, result);
  if (off2 !== off1) result = new Date(guess.getTime() - off2);
  return result;
}

// Centre-local calendar date ("YYYY-MM-DD") for now + offsetDays.
function centerDateStr(offsetDays, timeZone) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const p = {};
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  for (const part of dtf.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

// Which centre-local date to query for a given lead time, so we only pull
// the shifts whose reminder could plausibly be due right now:
//   1hour / 3hours -> shift is TODAY   (reminder window is same-day)
//   1day           -> shift is TOMORROW (sendAt = start − 24h = today)
//   2days          -> shift is in 2 days (sendAt = start − 48h = today)
// This keeps the cheap one-exact-date-per-user query and needs no new index.
function targetDateForLead(leadMin) {
  if (leadMin == null) return null;
  const days = leadMin >= 24 * 60 ? Math.round(leadMin / (24 * 60)) : 0;
  return centerDateStr(days, CENTER_TZ);
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

  // ─── Inventory low-stock sweep ──────────────────────────────────────
  // Rides along inside this cron rather than owning a Serverless Function
  // of its own — Vercel's Hobby plan caps a deployment at 12 and this
  // project sits at the ceiling. Anything under api/_lib/ is a module,
  // not a function, so this costs nothing.
  //
  // The sweep self-throttles (see api/_lib/inventory-alerts.js): a daily
  // run only emails a centre when something newly hits zero, when the
  // low-stock list has changed and it's been 3+ days, or once a week
  // while the same list stays outstanding. Wrapped in try/catch so an
  // inventory problem can never stop shift reminders going out.
  let inventory = null;
  try {
    inventory = await runInventorySweep({
      db,
      fromAddress,
      force: !!req.query?.force,
    });
  } catch (err) {
    console.error('[inventory-alerts] sweep failed:', err);
    inventory = { error: err.message || String(err) };
  }

  // ?inventoryOnly=1 runs just the sweep and returns — lets you test the
  // low-stock email without firing shift reminders at real staff.
  // Add &force=1 to bypass throttling.
  if (req.query?.inventoryOnly) {
    return res.status(200).json({ inventoryOnly: true, inventory });
  }

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
    const leadMin = LEAD_MINUTES[pref.reminderTiming];
    if (leadMin == null) return; // 'none' or missing -> no reminder
    const targetDate = targetDateForLead(leadMin);
    if (!targetDate) return;
    lookups.push({
      uid:        d.id,
      email:      pref.email,
      name:       pref.userName || 'Team',
      leadMin,
      targetDate,
    });
  });

  if (lookups.length === 0) {
    return res.status(200).json({ scanned: 0, sent: 0, message: 'No users due reminders', inventory });
  }

  // For each (user, target date) pair, pull the matching shift(s) and decide
  // whether each one is DUE right now: due when now >= (shiftStart − leadTime)
  // and the shift hasn't started yet. One small query per user — cheap, and
  // lets us skip shifts already stamped with reminderSentAt.
  const now = Date.now();
  const toSend = [];
  for (const lookup of lookups) {
    const snap = await db.collection('shifts')
      .where('userId', '==', lookup.uid)
      .where('date',   '==', lookup.targetDate)
      .get();
    for (const docSnap of snap.docs) {
      const shift = docSnap.data() || {};
      if (shift.reminderSentAt) continue; // already emailed for this shift
      // Skip drafts — instructor hasn't been told about this shift yet.
      if (shift.status === 'draft') continue;

      // Time gate. If the shift has a start time, only send once we're
      // inside the window [start − leadTime, start]. If startTime is
      // missing (legacy/all-day), fall back to sending on the target date.
      if (shift.startTime) {
        const startMs = zonedToUtc(shift.date, shift.startTime, CENTER_TZ).getTime();
        const sendAtMs = startMs - lookup.leadMin * 60 * 1000;
        if (now < sendAtMs) continue; // not due yet
        if (now > startMs)  continue; // shift already started — don't nag
      }

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
    return res.status(200).json({ scanned: lookups.length, sent: 0, message: 'No matching shifts', inventory });
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
    inventory,
  });
}
