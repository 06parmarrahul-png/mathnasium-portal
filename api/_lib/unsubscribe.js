/**
 * unsubscribe.js — the token that makes a one-click opt-out link work.
 *
 * DERIVED, NOT STORED. An HMAC of centre + channel + address under a
 * server secret: nothing to look up, nothing to leak from the database,
 * and a link cannot be edited into somebody else's address without the
 * secret. It also means a link keeps working for as long as the secret
 * does — which matters, because these sit in inboxes for years.
 *
 * Rotating UNSUBSCRIBE_SECRET invalidates every link already sent. That
 * is the right trade for a compromised secret and the wrong one for a
 * tidy-up, so it should not be rotated casually.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function unsubscribeToken(centreId, channel, address) {
  const secret = process.env.UNSUBSCRIBE_SECRET || process.env.RESEND_API_KEY || '';
  return createHmac('sha256', secret)
    .update(`${centreId}|${channel}|${String(address).toLowerCase()}`)
    .digest('base64url')
    .slice(0, 32);
}

export function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  if (!a.length || a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/** The full link to put at the foot of an email. */
export function unsubscribeUrl(baseUrl, centreId, address, channel = 'email') {
  const token = unsubscribeToken(centreId, channel, address);
  const q = new URLSearchParams({ action: 'unsubscribe', centerId: centreId, addr: address, token, channel });
  return `${String(baseUrl || '').replace(/\/$/, '')}/api/notify?${q}`;
}
