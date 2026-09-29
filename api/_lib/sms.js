/**
 * sms.js — sending a text, and the gate it has to get past first.
 *
 * THE GATE IS NOT OPTIONAL AND IS NOT THE CALLER'S JOB TO REMEMBER.
 * sendSms() checks consent itself. There is no exported "send without
 * checking", because the moment one exists somebody will call it from a
 * hurry and text a family who asked us to stop.
 *
 * Twilio credentials are account-level env vars rather than per-centre
 * documents: one Mathnasium account, one toll-free number, and a number
 * that has been through toll-free verification is not something a centre
 * swaps out on its own.
 */

import { Buffer } from 'node:buffer';
import { checkBeforeSend, recordConsent } from './consentStore.js';

const API = 'https://api.twilio.com/2010-04-01';

function credentials() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) return null;
  return { sid, token, from };
}

/** Is SMS switched on at all? Lets callers skip cleanly before trying. */
export function smsConfigured() {
  return credentials() !== null;
}

/**
 * Send one message, if we are allowed to.
 *
 * Returns { sent, reason, sid? }. `reason` is always populated — a
 * reminder that did not go is a thing somebody will ask about later, and
 * "withdrawn" and "twilio-error" want different answers.
 */
export async function sendSms(fs, centreId, { to, body, kind = 'transactional', hasTransactionalBasis = false }) {
  const creds = credentials();
  if (!creds) return { sent: false, reason: 'sms-not-configured' };

  const verdict = await checkBeforeSend(fs, centreId, {
    channel: 'sms', address: to, kind, hasTransactionalBasis,
  });
  if (!verdict.allowed) return { sent: false, reason: verdict.reason };

  const form = new URLSearchParams({ To: verdict.address, From: creds.from, Body: body });
  const auth = Buffer.from(`${creds.sid}:${creds.token}`).toString('base64');

  let r;
  try {
    r = await fetch(`${API}/Accounts/${creds.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch (e) {
    return { sent: false, reason: 'network', error: e.message };
  }

  const payload = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 21610 is Twilio's "this number has opted out" — it knows before we
    // do, because a STOP can be handled by the carrier without ever
    // reaching our webhook. Record it so the next send never tries.
    if (payload?.code === 21610) {
      await recordConsent(fs, centreId, {
        channel: 'sms', address: to, state: 'withdrawn',
        source: 'carrier', wording: 'Carrier reported this number as opted out',
        actor: 'twilio',
      }).catch(() => {});
      return { sent: false, reason: 'withdrawn-at-carrier' };
    }
    return { sent: false, reason: 'twilio-error', error: payload?.message || `HTTP ${r.status}` };
  }

  return { sent: true, reason: 'ok', sid: payload?.sid || null };
}
