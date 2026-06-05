// POST /api/users/create-staff
//
// Owner / AA / admin / super-admin creates a new staff Firebase Auth +
// Firestore user account at their active centre. The new user is
// auto-approved (no pending-approval round trip — the owner is
// pre-vetting them by entering them manually) and immediately able to
// log in once they reset their password.
//
// Why this is a server route:
//   - The client SDK can only create accounts via signInWithEmailAndPassword
//     which then signs the *current* user as the new account. We don't want
//     the owner to be signed out of their own session every time they add a
//     staff member.
//   - Admin SDK can create accounts on the server without touching the
//     caller's auth state. Cleaner UX, plus we can set custom-claim-style
//     fields and auto-approve in a single batched write.
//
// Password handling:
//   We never store or display passwords. The endpoint generates a strong
//   random temporary password (the user never sees it). Optionally — and
//   by default — we also fire a password-reset email so the new user can
//   set their own password the moment the owner clicks Create. The reset
//   email is the *only* path to log in for the new account.
//
// Request body: {
//   email:          'staff@example.com',
//   displayName:    'Jane Doe',
//   phone:          '604-555-0199' (optional),
//   instructorType: 'Instructor' | 'Lead' | 'Host' | etc. (default Instructor),
//   priority:       1 | 2 | 3 (default 2),
//   subRoles:       ['Elementary' | 'Highschool' | 'Online'] (default []),
//   sendResetEmail: boolean (default true) — fire a reset email so the
//                    new user can set their own password immediately.
// }
//
// Response: 200 { ok: true, uid, email, displayName, resetEmailSent }
//           400 / 403 / 409 / 500 on errors

import { authenticateRequest, getAuth, getFirestore } from '../_lib/firebase-admin.js';
import { Resend } from 'resend';

const ALLOWED_INSTRUCTOR_TYPES = new Set([
  'Instructor', 'Lead', 'Host', 'Admin', 'Manager',
  'Center Director', 'Dir. of Education', 'Volunteer',
]);
const ALLOWED_SUBROLES = new Set(['Elementary', 'Highschool', 'Online']);

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// 24 chars of cryptographically random base36. Strong enough that nobody
// will brute it before the reset link expires; gibberish enough that the
// owner won't be tempted to share it. The user never sees this anyway.
function randomTempPassword() {
  const len = 24;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  let out = '';
  // crypto.getRandomValues exists in modern Node runtimes (Vercel Edge / Node 18+).
  const buf = new Uint8Array(len);
  globalThis.crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) {
    out += alphabet[buf[i] % alphabet.length];
  }
  return out;
}

let _resend = null;
function resendClient() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY env var is not set');
  _resend = new Resend(key);
  return _resend;
}

// Build the password-reset email body. Mirrors the styling of
// api/send-password-reset.js so the new user gets a consistent-looking
// "set your password" message no matter which path triggered it.
function buildResetHtml({ displayName, link, centerName }) {
  const safe = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const greeting = displayName ? `Hi ${safe(displayName.split(' ')[0])},` : 'Hello,';
  const centre = centerName ? ` at <strong>${safe(centerName)}</strong>` : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 14px 0;">${greeting}</p>
<p style="margin:0 0 14px 0;">An account has been created for you${centre}. Click below to set your password and sign in.</p>
<p style="margin:0 0 18px 0;">
  <a href="${safe(link)}" style="background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">Set your password</a>
</p>
<p style="margin:0 0 6px 0;color:#6b7280;font-size:12px;">Or paste this link into your browser:</p>
<p style="margin:0 0 18px 0;word-break:break-all;color:#6b7280;font-size:12px;"><a href="${safe(link)}" style="color:#6b7280;">${safe(link)}</a></p>
<p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;">— Ratio</p>
</div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await authenticateRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const caller = session.profile;
  const callerRole = caller?.role || '';
  // Anyone with admin-panel access can create staff (owner / AA / admin /
  // super-admin). Plain instructors can't.
  if (!['super_admin', 'owner', 'admin_assistant', 'admin'].includes(callerRole)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  if (!caller?.approved) {
    return res.status(403).json({ error: 'Account not approved' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  // ── Validate inputs ─────────────────────────────────────────────────
  const email = String(body.email || '').trim().toLowerCase();
  const displayName = String(body.displayName || '').trim();
  const phone = String(body.phone || '').trim();
  const instructorType = String(body.instructorType || 'Instructor').trim();
  const priority = Number.isFinite(Number(body.priority)) ? Number(body.priority) : 2;
  const subRolesArr = Array.isArray(body.subRoles) ? body.subRoles : [];
  const centerIdParam = String(body.centerId || '').trim();
  const sendResetEmail = body.sendResetEmail !== false; // default true

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email is required.' });
  }
  if (!displayName) {
    return res.status(400).json({ error: 'Display name is required.' });
  }
  if (!ALLOWED_INSTRUCTOR_TYPES.has(instructorType)) {
    return res.status(400).json({ error: `instructorType must be one of: ${[...ALLOWED_INSTRUCTOR_TYPES].join(', ')}` });
  }
  if (priority < 1 || priority > 3) {
    return res.status(400).json({ error: 'priority must be 1, 2, or 3.' });
  }
  for (const s of subRolesArr) {
    if (!ALLOWED_SUBROLES.has(s)) {
      return res.status(400).json({ error: `Invalid subRole "${s}". Allowed: ${[...ALLOWED_SUBROLES].join(', ')}` });
    }
  }

  // Resolve which centre this staff member belongs to. Super-admins may
  // pass `centerId`; everyone else creates at their own active centre.
  let targetCenterId;
  if (callerRole === 'super_admin') {
    targetCenterId = centerIdParam || (
      Array.isArray(caller?.centerIds) && caller.centerIds[0]
    ) || caller?.centerId;
  } else {
    targetCenterId = (Array.isArray(caller?.centerIds) && caller.centerIds[0]) || caller?.centerId;
  }
  if (!targetCenterId) {
    return res.status(400).json({ error: 'Could not determine target centre.' });
  }

  // ── Create the Auth account ─────────────────────────────────────────
  const auth = getAuth();
  const db = getFirestore();

  // If an Auth account already exists for this email, refuse — the owner
  // should be told so they can decide whether to merge / approve the
  // existing user instead of duplicating.
  let existing = null;
  try { existing = await auth.getUserByEmail(email); }
  catch { /* no existing account, which is what we want */ }
  if (existing) {
    return res.status(409).json({
      error: `A user with email ${email} already exists. Check Manage Staff for their account.`,
    });
  }

  const tempPassword = randomTempPassword();
  let userRecord;
  try {
    userRecord = await auth.createUser({
      email,
      password: tempPassword,
      displayName,
      emailVerified: false,
      disabled: false,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Could not create Auth account: ' + (err?.message || 'unknown error'),
    });
  }

  // ── Write the Firestore profile ─────────────────────────────────────
  // Mirrors AuthContext.signup() with the additions that (1) the profile
  // is pre-approved, and (2) per-centre membership is seeded so the user
  // shows up at the target centre immediately.
  const now = new Date().toISOString();
  const profileDoc = {
    uid: userRecord.uid,
    email,
    displayName,
    phone: phone || '',
    role: 'instructor', // platform role — Manage Roles still controls owner/admin
    instructorType,
    priority,
    subRoles: subRolesArr,
    maxDaysPerWeek: 5,
    guaranteed: false,
    approved: true,        // pre-approved by the owner who created them
    isVolunteer: instructorType === 'Volunteer',
    centerId: targetCenterId,
    centerIds: [targetCenterId],
    centerMemberships: {
      [targetCenterId]: {
        instructorType,
        priority,
        maxDaysPerWeek: 5,
        subRoles: subRolesArr,
        guaranteed: false,
        approved: true,
        isVolunteer: instructorType === 'Volunteer',
      },
    },
    createdAt: now,
    createdBy: caller?.uid || session.decoded?.uid || 'unknown',
  };

  try {
    await db.collection('users').doc(userRecord.uid).set(profileDoc, { merge: true });
  } catch (err) {
    // Try to roll back the Auth account so we don't strand a credential
    // without a profile.
    try { await auth.deleteUser(userRecord.uid); } catch { /* ignore */ }
    return res.status(500).json({
      error: 'Created Auth account but failed to write profile. Auth rolled back: '
        + (err?.message || 'unknown error'),
    });
  }

  // ── Fire the "set your password" email (optional) ───────────────────
  let resetEmailSent = false;
  let resetEmailError = null;
  if (sendResetEmail) {
    try {
      const fromAddress = process.env.RESEND_FROM;
      if (!fromAddress) throw new Error('RESEND_FROM env var is not set');

      // Pull the centre's display name for the email body.
      let centerName = null;
      try {
        const cSnap = await db.collection('centers').doc(targetCenterId).get();
        if (cSnap.exists) centerName = cSnap.data()?.name || targetCenterId;
      } catch { /* non-fatal */ }

      const continueUrl = String(body.continueUrl || '').trim()
        || (req.headers['origin'] ? `${req.headers['origin']}/login` : null);
      const linkOpts = continueUrl ? { url: continueUrl, handleCodeInApp: false } : undefined;
      const resetLink = await auth.generatePasswordResetLink(email, linkOpts);

      const text = `An account has been created for you${centerName ? ` at ${centerName}` : ''}. ` +
        `Set your password and sign in here: ${resetLink}\n\n— Ratio`;
      const { error } = await resendClient().emails.send({
        from: fromAddress,
        to: [email],
        subject: `Your ${centerName || 'Ratio'} account — set your password`,
        text,
        html: buildResetHtml({ displayName, link: resetLink, centerName }),
      });
      if (error) throw new Error(error.message || 'Resend send error');
      resetEmailSent = true;
    } catch (err) {
      resetEmailError = err?.message || String(err);
      // eslint-disable-next-line no-console
      console.error('[create-staff] reset email failed:', resetEmailError);
    }
  }

  return res.status(200).json({
    ok: true,
    uid: userRecord.uid,
    email,
    displayName,
    centerId: targetCenterId,
    resetEmailSent,
    resetEmailError, // null when success
  });
}
