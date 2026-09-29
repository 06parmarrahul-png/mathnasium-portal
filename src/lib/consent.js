/**
 * consent.js — may we send this person this message.
 *
 * ONE GATE. Every send path — reminder, confirmation, campaign, whatever
 * gets built next — asks maySend() and honours the answer. A second way
 * to send is a second way to text somebody who said stop, and the point
 * of a suppression list is that nothing gets past it.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TWO KINDS OF MESSAGE, AND THEY ARE NOT THE SAME QUESTION.
 *
 *   transactional  "your assessment is tomorrow at 4pm". It exists only
 *                  because the family booked, and it is the whole reason
 *                  a reminder system exists.
 *
 *   marketing      "half-term offer". Wanted by some, not all, and never
 *                  the price of booking an assessment.
 *
 * The booking form today captures ONE checkbox, and its wording is
 * marketing consent — "recurring advertising text messages… about
 * promotions". It is optional, and rightly so. What it is not is
 * permission to send a reminder: a family who books and leaves it
 * unticked still expects to be reminded, and this module says yes to that
 * and no to the promotion.
 *
 * WITHDRAWAL OUTRANKS EVERYTHING. A STOP applies to every kind on that
 * channel, immediately, without asking why. There is no message important
 * enough to send to somebody who has asked you not to.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * THIS FILE IMPLEMENTS A POLICY; IT DOES NOT CERTIFY ONE. Whether the
 * consent wording, retention and sender identification meet CASL and the
 * carrier rules is a question for whoever owns compliance — especially as
 * the current wording names Mathnasium corporate and points at an address
 * this app does not control. What this guarantees is narrower and worth
 * having: whatever the policy, every send obeys it, and every change of
 * mind is recorded with the words the person used.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

export const CHANNELS = ['email', 'sms'];
export const MESSAGE_KINDS = ['transactional', 'marketing'];

/** What a person's standing is on one channel. */
export const STATES = ['granted', 'withdrawn', 'unknown'];

/**
 * The words carriers expect to work, and that the booking form promises.
 *
 * Matched on the whole message, trimmed and case-folded, because a reply
 * of "stop." or "Please STOP" is a person asking to stop. Deliberately
 * generous: the cost of over-reading a stop is one missed reminder, and
 * the cost of under-reading it is texting somebody who told you not to.
 */
const STOP_WORDS  = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt out', 'opt-out', 'remove'];
const START_WORDS = ['start', 'unstop', 'yes', 'optin', 'opt in', 'opt-in', 'subscribe'];
const HELP_WORDS  = ['help', 'info'];

const fold = (s) => String(s ?? '').trim().toLowerCase().replace(/[.!,?]+$/, '');

/**
 * What an inbound text is asking for: 'stop' | 'start' | 'help' | null.
 *
 * A message that merely CONTAINS the word is not a request — "please
 * don't stop the lessons" is not an opt-out — so this matches the whole
 * message, with one exception: a leading keyword followed by nothing but
 * punctuation or a single courtesy word ("stop please").
 */
export function parseInboundKeyword(text) {
  const t = fold(text);
  if (!t) return null;
  const first = t.split(/\s+/)[0];
  const isOnly = (list) => list.includes(t)
    || (list.includes(first) && t.split(/\s+/).length <= 2);
  if (isOnly(STOP_WORDS)) return 'stop';
  if (isOnly(START_WORDS)) return 'start';
  if (isOnly(HELP_WORDS)) return 'help';
  return null;
}

/** "(604) 555-0143" → "+16045550143". Null when it cannot be one number. */
export function normalisePhone(raw, defaultCountry = '1') {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) {
    const rest = digits.slice(1).replace(/\D/g, '');
    return rest.length >= 8 && rest.length <= 15 ? `+${rest}` : null;
  }
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return `+${defaultCountry}${d}`;
  if (d.length === 11 && d.startsWith(defaultCountry)) return `+${d}`;
  return null;
}

export function normaliseEmail(raw) {
  const e = String(raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** The address, normalised for its channel, or null if unusable. */
export function normaliseAddress(channel, raw) {
  if (channel === 'sms') return normalisePhone(raw);
  if (channel === 'email') return normaliseEmail(raw);
  return null;
}

/**
 * The Firestore document id for one person on one channel.
 *
 * Keyed by the address rather than by a lead or an intake, because the
 * same family books twice and the same phone belongs to one person. A
 * stop has to outlive the booking it was sent from.
 */
export function contactKey(channel, address) {
  const norm = normaliseAddress(channel, address);
  if (!norm) return null;
  return `${channel}:${norm.replace(/[^a-zA-Z0-9+@._-]/g, '')}`;
}

/**
 * May we send it.
 *
 * `record` is the stored consent for that address, or null if we have
 * never heard from them. Returns { allowed, reason } — the reason is for
 * the audit trail and for anyone later asking why a reminder never went.
 */
export function maySend({ record, kind, hasTransactionalBasis = false }) {
  if (!MESSAGE_KINDS.includes(kind)) {
    return { allowed: false, reason: 'unknown-kind' };
  }
  if (record && record.state === 'withdrawn') {
    // The one answer that is the same for every kind.
    return { allowed: false, reason: 'withdrawn' };
  }
  if (kind === 'marketing') {
    return record && record.state === 'granted'
      ? { allowed: true, reason: 'granted' }
      : { allowed: false, reason: 'no-marketing-consent' };
  }
  // Transactional: the booking itself is the basis. Without one there is
  // no transaction to be messaging about.
  if (hasTransactionalBasis || (record && record.state === 'granted')) {
    return { allowed: true, reason: hasTransactionalBasis ? 'booking' : 'granted' };
  }
  return { allowed: false, reason: 'no-basis' };
}

/**
 * The record a consent change writes.
 *
 * `wording` is the text the person was shown, or the text they sent.
 * Keeping it is the difference between "they consented" and being able to
 * show what they consented to, which is the only version worth anything
 * when somebody asks months later.
 */
export function consentEntry({ channel, address, state, source, wording, at, actor = 'system' }) {
  return {
    channel,
    address: normaliseAddress(channel, address),
    state,
    source,                       // 'booking-form' | 'sms-reply' | 'email-link' | 'staff'
    wording: wording ? String(wording).slice(0, 2000) : null,
    at: at || new Date().toISOString(),
    actor,
  };
}

/** What to text back when somebody asks for HELP. */
export function helpReply(centreName, contact) {
  const who = centreName || 'Mathnasium';
  const where = contact ? ` or contact ${contact}` : '';
  return `${who}: appointment reminders. Reply STOP to opt out${where}. Msg & data rates may apply.`;
}

/** What to text back to confirm a STOP. Carriers expect one, and only one. */
export function stopReply(centreName) {
  return `${centreName || 'Mathnasium'}: you will not receive further messages. Reply START to opt back in.`;
}
