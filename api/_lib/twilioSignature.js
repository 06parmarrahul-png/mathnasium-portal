/**
 * twilioSignature.js — is this inbound webhook really from Twilio.
 *
 * WHY IT MATTERS MORE HERE THAN ON MOST WEBHOOKS. The inbound endpoint
 * exists so a family can text STOP. It therefore has the power to mark
 * any number as withdrawn, and — via START — to mark one as consenting
 * again. Without a signature check, anyone who finds the URL can forge a
 * consent record for a number they do not own, which is the one thing
 * this whole subsystem exists to be able to prove.
 *
 * Twilio signs the full request URL plus the POST body's fields, sorted
 * by name and concatenated, with HMAC-SHA1 under the account auth token.
 *
 * PURE except for node:crypto — no network, no Firebase.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Rebuild the string Twilio signed.
 *
 * Sorted by key, key and value concatenated with no separator, appended
 * to the URL. An empty body signs the URL alone.
 */
export function signingString(url, params) {
  const keys = Object.keys(params || {}).sort();
  let out = String(url || '');
  for (const k of keys) out += k + String(params[k] ?? '');
  return out;
}

/** The signature Twilio would have sent for this request. */
export function expectedSignature(authToken, url, params) {
  return createHmac('sha1', String(authToken || ''))
    .update(Buffer.from(signingString(url, params), 'utf-8'))
    .digest('base64');
}

/**
 * Does the X-Twilio-Signature header check out?
 *
 * Constant-time, and false rather than throwing on anything malformed —
 * a bad signature and a missing one deserve the same answer.
 */
export function verifyTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  let expected;
  try {
    expected = expectedSignature(authToken, url, params);
  } catch {
    return false;
  }
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}
