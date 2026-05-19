// POST /api/send-email
//
// Sends a batch of transactional emails via Resend. Used by the Mathnasium
// portal for all four notification flows:
//   - schedule posted
//   - new open shift posted
//   - shift claimed (confirmation + admin notice)
//   - time-off request approved / denied
//
// Auth: Firebase ID token in `Authorization: Bearer <token>`. The caller
// must have an approved Firestore profile (so signed-up-but-unapproved
// accounts can't fire mail).
//
// Body:
//   {
//     emails: [
//       { to, subject, body, cta_text?, cta_link? },
//       ...
//     ]
//   }
//
// `body` is plain text — newlines render as line breaks in the email body.
// Up to 100 emails per call (Resend batch limit).
//
// Response: 200 { sent: N, failed: M, errors: [...] }
//
// Required env vars (set in Vercel project settings):
//   RESEND_API_KEY    - from https://resend.com/api-keys
//   RESEND_FROM       - e.g. "Mathnasium Langley <noreply@mathnasiumlangley.com>"
//                       (must use a Resend-verified domain in production;
//                        for testing, use "onboarding@resend.dev")

import { Resend } from 'resend';
import { authenticateRequest } from './_lib/firebase-admin.js';

const BATCH_LIMIT = 100;

// Lazy Resend client — initialised on the first warm-Lambda call.
let _resend = null;
function resendClient() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY env var is not set in Vercel');
  _resend = new Resend(key);
  return _resend;
}

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

// Minimal email regex — we don't need RFC-strict, just "looks roughly like
// an email" so a typo doesn't waste a Resend send.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Convert plain text (\n-separated) to a basic HTML body so Gmail/Outlook
 * render line breaks correctly. Also escape HTML to defeat any accidental
 * injection from user-typed time-off reasons.
 */
function bodyToHtml({ to_name, body, cta_text, cta_link }) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const bodyHtml = esc(body).split('\n').map(line => line === '' ? '<br>' : `<p style="margin:0 0 10px 0;">${line}</p>`).join('');
  const ctaBlock = cta_link
    ? `<p style="margin:20px 0 0 0;"><a href="${esc(cta_link)}" style="background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">${esc(cta_text || 'Open the portal')}</a></p>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 14px 0;">Hi ${esc(to_name || 'Team')},</p>
${bodyHtml}
${ctaBlock}
<p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;">— Mathnasium Langley</p>
</div>`;
}

function bodyToText({ to_name, body, cta_text, cta_link }) {
  let txt = `Hi ${to_name || 'Team'},\n\n${body}`;
  if (cta_link) txt += `\n\n${cta_text || 'Open the portal'}: ${cta_link}`;
  txt += `\n\n— Mathnasium Langley`;
  return txt;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authn — must be a logged-in, approved user.
  const session = await authenticateRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!session.profile?.approved) {
    return res.status(403).json({ error: 'Account not approved' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const emails = Array.isArray(body.emails) ? body.emails : [];
  if (emails.length === 0) {
    return res.status(400).json({ error: 'emails array required' });
  }
  if (emails.length > BATCH_LIMIT) {
    return res.status(400).json({ error: `Max ${BATCH_LIMIT} emails per request` });
  }

  const fromAddress = process.env.RESEND_FROM;
  if (!fromAddress) {
    return res.status(500).json({ error: 'RESEND_FROM env var is not set' });
  }

  // Validate + shape each email, dropping bad ones rather than failing the
  // whole batch. Returns parallel arrays so we can map results back.
  const valid = [];
  const dropped = [];
  emails.forEach((e, i) => {
    const to = String(e?.to || '').trim();
    if (!EMAIL_RE.test(to)) {
      dropped.push({ index: i, reason: 'invalid recipient' });
      return;
    }
    valid.push({
      from: fromAddress,
      to: [to],
      subject: String(e.subject || '(no subject)').slice(0, 200),
      text: bodyToText({
        to_name:  e.to_name,
        body:     e.body || '',
        cta_text: e.cta_text,
        cta_link: e.cta_link,
      }),
      html: bodyToHtml({
        to_name:  e.to_name,
        body:     e.body || '',
        cta_text: e.cta_text,
        cta_link: e.cta_link,
      }),
    });
  });

  if (valid.length === 0) {
    return res.status(400).json({ error: 'No valid emails in batch', dropped });
  }

  try {
    const { data, error } = await resendClient().batch.send(valid);
    if (error) {
      console.error('[send-email] Resend batch error:', error);
      return res.status(502).json({ error: error.message || 'Resend error' });
    }
    return res.status(200).json({
      sent: valid.length,
      dropped: dropped.length,
      ids: data?.data?.map(d => d.id) || [],
    });
  } catch (err) {
    console.error('[send-email]', err);
    return res.status(500).json({ error: err.message || 'Send failed' });
  }
}
