/**
 * emailService.js
 * Handles all notification emails for the Ratio platform (Mathnasium
 * Langley, Chilliwack, and any future centres). Sign-off in every
 * template is "— Ratio" so the branding stays consistent across
 * centres; centre-specific context appears in the subject line and
 * body, not the footer.
 *
 * Architecture: this file builds the subject + plain-text body for each
 * notification, batches the recipients into a single payload, and POSTs to
 * /api/send-email — a Vercel serverless function that fans the batch out
 * through Resend (see api/send-email.js + RESEND_SETUP.md).
 *
 * The serverless function requires a Firebase ID token, so we attach the
 * current user's token before sending.
 *
 * The four public APIs (notifyOpenShift, notifySchedulePosted,
 * notifyShiftClaimed, notifyTimeOffDecision) keep the same signatures
 * they had under EmailJS, so callers (Admin / Schedule / ShiftBoard) need
 * no changes.
 */

import { auth } from '../firebase';

const SEND_ENDPOINT = '/api/send-email';

// ─── Send primitive ────────────────────────────────────────────────────────

/**
 * POST a batch of emails to /api/send-email. Fire-and-forget by default —
 * failures are logged but don't throw, so a Resend outage won't disrupt
 * the user-facing UX flow that triggered the email.
 *
 * @param {Array} emails - array of { to, to_name, subject, body, cta_text?, cta_link? }
 */
async function sendBatch(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return;

  let idToken = null;
  try {
    idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  } catch (err) {
    console.error('[emailService] Failed to read ID token:', err);
    return;
  }
  if (!idToken) {
    console.warn('[emailService] No signed-in user; skipping email batch.');
    return;
  }

  try {
    const r = await fetch(SEND_ENDPOINT, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ emails }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      console.error('[emailService] Send failed:', r.status, data);
    }
  } catch (err) {
    console.error('[emailService] Network error sending batch:', err);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h}:00 ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function firstName(displayName, fallback = 'Team') {
  return displayName?.split(' ')[0] || fallback;
}

function portalUrl() {
  // window is fine — every caller of these functions is browser-side.
  return typeof window !== 'undefined' ? window.location.origin : '';
}

// ─── Notify: new open shift posted ─────────────────────────────────────────

/**
 * @param {object} shift        - the openShift Firestore document
 * @param {Array}  staffEmails  - array of { email, displayName } for all approved staff
 */
export async function notifyOpenShift(shift, staffEmails) {
  if (!Array.isArray(staffEmails) || staffEmails.length === 0) return;

  const dateFormatted = fmtDate(shift.date);
  const shiftTime = `${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)}`;
  const shiftRole = shift.subRole || shift.role || 'Any role';

  const subject = `New open shift posted: ${dateFormatted}`;
  const body =
    `A new open shift has been posted:\n\n` +
    `Date: ${dateFormatted}\n` +
    `Time: ${shiftTime}\n` +
    `Role: ${shiftRole}\n\n` +
    `First come, first served — claim it on the portal.`;
  const cta_link = portalUrl();

  const emails = staffEmails
    .filter(s => s?.email)
    .map(({ email, displayName }) => ({
      to:       email,
      to_name:  firstName(displayName, 'Instructor'),
      subject,
      body,
      cta_text: 'Claim the shift',
      cta_link,
    }));

  await sendBatch(emails);
}

// ─── Notify: schedule posted ───────────────────────────────────────────────

/**
 * @param {object} schedule     - the draftSchedule from generateSchedule()
 * @param {Array}  staffEmails  - array of { email, displayName } for all approved staff
 */
export async function notifySchedulePosted(schedule, staffEmails) {
  if (!Array.isArray(staffEmails) || staffEmails.length === 0) return;

  const totalShifts = schedule.days.reduce((s, d) => s + d.assignedEmployees.length, 0);
  const monthYear = `${schedule.month} ${schedule.year}`;

  const subject = `${monthYear} schedule is posted (${totalShifts} shifts)`;
  const body =
    `The ${monthYear} schedule has been posted.\n\n` +
    `${totalShifts} total shifts across ${schedule.days.length} working days.\n\n` +
    `Check your assignments on the portal.`;
  const cta_link = portalUrl();

  const emails = staffEmails
    .filter(s => s?.email)
    .map(({ email, displayName }) => ({
      to:       email,
      to_name:  firstName(displayName, 'Instructor'),
      subject,
      body,
      cta_text: 'View your schedule',
      cta_link,
    }));

  await sendBatch(emails);
}

// ─── Notify: shift claimed (confirms claimer + CCs admins) ─────────────────

/**
 * @param {object} shift           - the openShift doc
 * @param {object} claimer         - { email, displayName }
 * @param {Array}  adminRecipients - array of { email, displayName } for admins to CC
 */
export async function notifyShiftClaimed(shift, claimer, adminRecipients = []) {
  if (!claimer?.email) return;

  const dateFormatted = fmtDate(shift.date);
  const shiftTime = `${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)}`;
  const shiftRole = shift.subRole || shift.role || '';
  const cta_link  = portalUrl();

  const emails = [];

  // 1) Confirmation to the person who claimed it
  emails.push({
    to:       claimer.email,
    to_name:  firstName(claimer.displayName, 'Instructor'),
    subject:  `Shift confirmed: ${dateFormatted}`,
    body:
      `You've successfully claimed the open shift:\n\n` +
      `Date: ${dateFormatted}\n` +
      `Time: ${shiftTime}\n` +
      (shiftRole ? `Role: ${shiftRole}\n\n` : `\n`) +
      `It's now on your schedule.`,
    cta_text: 'View your schedule',
    cta_link,
  });

  // 2) Notify each admin (skip the claimer if they're also an admin)
  adminRecipients
    .filter(a => a?.email && a.email !== claimer.email)
    .forEach(admin => {
      emails.push({
        to:       admin.email,
        to_name:  firstName(admin.displayName, 'Admin'),
        subject:  `${claimer.displayName || 'A staff member'} claimed the ${dateFormatted} shift`,
        body:
          `${claimer.displayName || 'A staff member'} just claimed an open shift:\n\n` +
          `Date: ${dateFormatted}\n` +
          `Time: ${shiftTime}\n` +
          (shiftRole ? `Role: ${shiftRole}\n` : ''),
        cta_text: 'View the schedule',
        cta_link,
      });
    });

  await sendBatch(emails);
}

// ─── Notify: time-off decision ─────────────────────────────────────────────

/**
 * @param {object} request   - the timeOffRequests doc (startDate, endDate, reason, ...)
 * @param {object} recipient - { email, displayName }
 * @param {'approved'|'denied'} decision
 */
export async function notifyTimeOffDecision(request, recipient, decision) {
  if (!recipient?.email) return;

  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  const startLabel = request.startDate
    ? new Date(request.startDate + 'T00:00:00').toLocaleDateString('en-US', opts)
    : '';
  const endLabel = request.endDate
    ? new Date(request.endDate + 'T00:00:00').toLocaleDateString('en-US', opts)
    : '';
  const sameDay = request.startDate === request.endDate;
  const dateRange = sameDay ? startLabel : `${startLabel} – ${endLabel}`;

  const approved = decision === 'approved';
  const subject = approved ? `Time-off request approved` : `Time-off request update`;
  const body = approved
    ? `Your time-off request for ${dateRange} has been approved.\n\n` +
      (request.reason ? `Reason you submitted: ${request.reason}\n\n` : '') +
      `Enjoy the time off.`
    : `Your time-off request for ${dateRange} was not approved this time.\n\n` +
      (request.reason ? `Reason you submitted: ${request.reason}\n\n` : '') +
      `If you have questions, please follow up with management.`;

  await sendBatch([{
    to:       recipient.email,
    to_name:  firstName(recipient.displayName),
    subject,
    body,
    cta_text: 'View your schedule',
    cta_link: portalUrl(),
  }]);
}
