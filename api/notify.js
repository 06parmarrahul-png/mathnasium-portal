// /api/notify — everything Ratio sends, and everything that says stop.
//
//   POST /api/notify                         staff email batch (authenticated)
//   POST /api/notify?action=sms-inbound      Twilio: STOP / START / HELP  (public, signed)
//   GET  /api/notify?action=unsubscribe      one-click email opt-out      (public, tokened)
//
// It was send-email.js. The two public routes joined it rather than
// becoming files of their own because Vercel's Hobby plan allows twelve
// functions and this project has exactly twelve — the same reason
// api/apptoto.js and api/intakes.js each carry two halves.
//
// THE PUBLIC ROUTES ARE ANSWERED BEFORE THE AUTH GATE. Neither a carrier
// nor a family clicking a link in an email has a Firebase token. They
// prove themselves with a Twilio signature and a per-address token.
//
// ── the original contract, unchanged ────────────────────────────────
// POST /api/notify
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
//   RESEND_FROM       - e.g. "Ratio <noreply@mathnasiumlangley.com>"
//                       (must use a Resend-verified domain in production;
//                        for testing, use "onboarding@resend.dev")

import { Resend } from 'resend';
import { authenticateRequest, getFirestore } from './_lib/firebase-admin.js';
import { verifyTwilioSignature } from './_lib/twilioSignature.js';
import { unsubscribeToken, tokenMatches } from './_lib/unsubscribe.js';
import { recordConsent, contactKey } from './_lib/consentStore.js';
import { parseInboundKeyword, stopReply, helpReply, normalisePhone } from '../src/lib/consent.js';

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
<p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;">— Ratio</p>
</div>`;
}

function bodyToText({ to_name, body, cta_text, cta_link }) {
  let txt = `Hi ${to_name || 'Team'},\n\n${body}`;
  if (cta_link) txt += `\n\n${cta_text || 'Open the portal'}: ${cta_link}`;
  txt += `\n\n— Ratio`;
  return txt;
}

/** Twilio wants TwiML back, or an empty 200 to say nothing. */
function twiml(res, message) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${message
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response/>');
}

/**
 * A family texting STOP, START or HELP.
 *
 * Signature-checked: this route can mark a number as withdrawn, and via
 * START as consenting again, so an unsigned caller could forge the very
 * record the system exists to be able to prove.
 */
async function handleSmsInbound(req, res) {
  const centreId = req.query.centerId;
  if (!centreId) return res.status(400).json({ error: 'centerId required' });

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('sms-inbound: TWILIO_AUTH_TOKEN not set — refusing to trust the request');
    return res.status(500).json({ error: 'Not configured' });
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${req.headers.host}${req.url}`;
  const ok = verifyTwilioSignature({
    authToken, url, params: req.body || {},
    signature: req.headers['x-twilio-signature'],
  });
  if (!ok) return res.status(403).json({ error: 'Bad signature' });

  const from = normalisePhone(req.body?.From);
  const keyword = parseInboundKeyword(req.body?.Body);
  if (!from || !keyword) {
    // A real reply from a real person that is not a keyword. Not an
    // error, and not ours to answer.
    return twiml(res, null);
  }

  const fs = getFirestore();
  const centreSnap = await fs.doc(`centers/${centreId}`).get();
  const centreName = centreSnap.exists ? (centreSnap.data().name || 'Mathnasium') : 'Mathnasium';

  if (keyword === 'help') {
    return twiml(res, helpReply(centreName, process.env.SMS_HELP_CONTACT || null));
  }

  await recordConsent(fs, centreId, {
    channel: 'sms',
    address: from,
    state: keyword === 'stop' ? 'withdrawn' : 'granted',
    source: 'sms-reply',
    wording: String(req.body?.Body || '').slice(0, 200),
    actor: from,
  });

  // Carriers expect exactly one confirmation for a STOP, and nothing
  // further afterwards.
  return twiml(res, keyword === 'stop'
    ? stopReply(centreName)
    : `${centreName}: you are opted back in. Reply STOP to opt out again.`);
}

/**
 * The unsubscribe link at the foot of an email.
 *
 * One click, no login, no confirmation step — a link that asks somebody
 * to sign in before it will stop emailing them is not an opt-out. GET is
 * deliberate: it is what List-Unsubscribe and every mail client expect.
 */
async function handleUnsubscribe(req, res) {
  const { centerId, addr, token, channel = 'email' } = req.query;
  if (!centerId || !addr || !token) {
    return res.status(400).send('This link is incomplete.');
  }
  if (!tokenMatches(token, unsubscribeToken(centerId, channel, addr))) {
    return res.status(403).send('This link is not valid.');
  }
  if (!contactKey(channel, addr)) {
    return res.status(400).send('This link is not valid.');
  }

  try {
    await recordConsent(getFirestore(), centerId, {
      channel, address: addr, state: 'withdrawn',
      source: 'email-link', wording: 'Unsubscribed via email link', actor: String(addr),
    });
  } catch (e) {
    console.error('unsubscribe failed:', e?.message || e);
    return res.status(500).send('Something went wrong. Please reply to the email instead.');
  }

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title>
<div style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6">
  <h1 style="font-size:1.25rem;margin:0 0 .5rem">You're unsubscribed</h1>
  <p style="color:#555;margin:0">We won't email ${String(addr).replace(/[<>&"]/g, '')} again.
  If this was a mistake, reply to any earlier email and we'll put it back.</p>
</div>`);
}

export default async function handler(req, res) {
  // Public routes, answered before the staff auth gate — neither a
  // carrier nor a family clicking a link has a Firebase token.
  try {
    if (req.query.action === 'sms-inbound' && req.method === 'POST') {
      return await handleSmsInbound(req, res);
    }
    if (req.query.action === 'unsubscribe') {
      return await handleUnsubscribe(req, res);
    }
  } catch (e) {
    console.error('notify public route error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }

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

  // Respect each recipient's email opt-out. Anyone who toggled "Email
  // Notifications" off on the /notifications page has emailEnabled:false on
  // their notificationPreferences doc. We drop those recipients from EVERY
  // batch here — so all notification flows (schedule posted, open shift,
  // shift claimed, announcement, time-off decision) honour the setting
  // centrally, instead of only the shift-reminder cron checking it.
  //
  // The collection is tiny (a handful of centres × ~30 staff), so one
  // scan per request is cheap. Password resets go through a different
  // endpoint (/api/send-password-reset) and are intentionally unaffected —
  // auth mail must always send.
  //
  // Fail OPEN: if the lookup errors, we send unfiltered rather than
  // silently swallowing notifications on a transient Firestore hiccup.
  let optedOut = new Set();
  try {
    const db = getFirestore();
    const snap = await db.collection('notificationPreferences')
      .where('emailEnabled', '==', false)
      .get();
    snap.forEach(d => {
      const addr = String(d.data()?.email || '').trim().toLowerCase();
      if (addr) optedOut.add(addr);
    });
  } catch (err) {
    console.error('[send-email] opt-out lookup failed; sending unfiltered:', err);
    optedOut = new Set();
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
    if (optedOut.has(to.toLowerCase())) {
      dropped.push({ index: i, reason: 'recipient opted out of email' });
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
    // If everyone in the batch opted out, that's a successful no-op — not a
    // client error. Only 400 when the batch had genuinely invalid input.
    const onlyOptOuts = dropped.length > 0 &&
      dropped.every(d => d.reason === 'recipient opted out of email');
    if (onlyOptOuts) {
      return res.status(200).json({ sent: 0, suppressed: dropped.length });
    }
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
      suppressed: dropped.filter(d => d.reason === 'recipient opted out of email').length,
      ids: data?.data?.map(d => d.id) || [],
    });
  } catch (err) {
    console.error('[send-email]', err);
    return res.status(500).json({ error: err.message || 'Send failed' });
  }
}
