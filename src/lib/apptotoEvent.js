/**
 * apptotoEvent.js — one reading of an Apptoto event.
 *
 * Apptoto's /events response uses different field names across endpoints
 * and account versions, and its webhook payload is a third shape again.
 * Two places in this app were already coping with that independently —
 * the appointments card and the API proxy — each with its own list of key
 * spellings. This is those lists, gathered, before the webhook made it
 * three copies that could disagree about who booked.
 *
 * NOTHING HERE TRUSTS THE PAYLOAD. Every field is optional, every
 * container may be missing, and the answer to "what is this" is allowed
 * to be "I cannot tell" rather than a guess. A booking that arrives
 * unreadable should be visible as unreadable, not silently filed as a
 * family called "(untitled)".
 *
 * PURE MODULE — no React, no Firebase, no network.
 */

const START_KEYS = [
  'start_time', 'start_date', 'start', 'startTime', 'starts_at', 'startsAt',
  'dt_start', 'dtstart', 'event_start', 'calendar_event_start', 'time_start',
  'datetime', 'at', 'when',
];

const TITLE_KEYS = [
  'title', 'calendar_event_name', 'name', 'summary', 'subject',
  'event_title', 'appointment_type',
];

const ID_KEYS = ['id', 'event_id', 'eventId', 'uuid', 'guid', 'calendar_event_id'];

/**
 * Which events are an assessment booking.
 *
 * "Appointment Booked" is Apptoto's default subject when something is
 * booked through the calendar, so it counts. The rest are the words
 * centres actually title these with.
 */
export const ASSESSMENT_RE =
  /\b(assess|intake|consult|trial|new\s*student|tour|appointment\s*booked|booked)\b/i;

const pickFromKeys = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
};

/** The containers Apptoto has been seen to nest an event's fields in. */
const containersOf = (e) => [e, e?.calendar_event, e?.time, e?.event].filter(Boolean);

const firstAcross = (e, keys) => {
  for (const c of containersOf(e)) {
    const hit = pickFromKeys(c, keys);
    if (hit) return hit;
  }
  return null;
};

/** Apptoto's own id for the booking — the key idempotency turns on. */
export function eventIdOf(e) {
  return firstAcross(e, ID_KEYS);
}

/** When it starts, as an ISO string, or null if no field parses. */
export function startISOOf(e) {
  const raw = firstAcross(e, START_KEYS);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** What it is called. Null rather than "(untitled)" — the caller decides. */
export function titleOf(e) {
  return firstAcross(e, TITLE_KEYS);
}

/**
 * Who booked it: a name, an email and a phone, each possibly missing.
 *
 * Apptoto puts the person on the event itself, on a contact object, or
 * first in a participants array, and splits the name in two about half
 * the time.
 */
export function contactOf(e) {
  if (!e || typeof e !== 'object') return { name: null, email: null, phone: null };

  const direct = pickFromKeys(e, ['contact_name', 'attendee_name', 'client_name']);
  const c = e.contact
    || e.address_book_contact
    || (Array.isArray(e.participants) ? e.participants[0] : null)
    || (Array.isArray(e.attendees) ? e.attendees[0] : null)
    || {};

  const joined = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  const name = direct
    || pickFromKeys(c, ['name', 'full_name', 'display_name'])
    || (joined || null);

  return {
    name: name || null,
    email: pickFromKeys(c, ['email', 'email_address']) || pickFromKeys(e, ['email', 'contact_email']),
    phone: pickFromKeys(c, ['phone', 'mobile', 'phone_number']) || pickFromKeys(e, ['phone', 'contact_phone']),
  };
}

/**
 * Everything Ratio needs from one Apptoto event.
 *
 * `usable` is the honest gate: without an id there is no way to recognise
 * a retry, and without a start time there is no appointment. Either
 * missing means the caller should reject the payload rather than write
 * half a booking it can never reconcile.
 */
export function normaliseApptotoEvent(raw) {
  const eventId = eventIdOf(raw);
  const startISO = startISOOf(raw);
  const title = titleOf(raw);
  const contact = contactOf(raw);
  return {
    eventId,
    startISO,
    title,
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    isAssessment: ASSESSMENT_RE.test(title || ''),
    usable: Boolean(eventId && startISO),
  };
}
