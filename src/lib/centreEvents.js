/**
 * centreEvents.js — things that happen at the centre that aren't shifts.
 *
 * WHY THIS EXISTS AS ITS OWN THING
 *   Staff meetings, fun days and training sessions had nowhere to live.
 *   "Fun Day" was an announcement CATEGORY, but announcements only carry the
 *   date they were POSTED, so nothing could say "the fun day is on the 26th"
 *   in a way anything could sort, group or count down to. It had also never
 *   once been used in a year of announcements, which is what a feature with
 *   no home looks like.
 *
 *   A calendar needs real dates. So an event is its own document with a
 *   date, not a message with a date buried in the prose.
 *
 * SHAPE — `centers/{centerId}/events/{id}`
 *   {
 *     title:     'Staff meeting',
 *     date:      '2026-09-17',        // required, centre-local
 *     startTime: '18:30' | null,      // optional — all-day if absent
 *     endTime:   '19:30' | null,
 *     type:      'meeting' | 'fun-day' | 'training' | 'other',
 *     note:      'Everyone in, pizza after',
 *     createdAt, createdBy
 *   }
 */

export const EVENT_TYPES = {
  meeting:   { key: 'meeting',   label: 'Staff meeting', short: 'Meeting' },
  'fun-day': { key: 'fun-day',   label: 'Fun day',       short: 'Fun day' },
  training:  { key: 'training',  label: 'Training',      short: 'Training' },
  other:     { key: 'other',     label: 'Something else', short: 'Event' },
};

export const EVENT_TYPE_LIST = Object.values(EVENT_TYPES);

export function eventTypeLabel(type) {
  return EVENT_TYPES[type]?.label || EVENT_TYPES.other.label;
}

/**
 * The short form, for a badge sitting beside a title.
 *
 * "Staff meeting" as both the title and the badge is the title repeating
 * itself; the badge only has to say "this is an event, not a shift".
 */
export function eventTypeShort(type) {
  return EVENT_TYPES[type]?.short || EVENT_TYPES.other.short;
}

/** Local-noon parse. A bare YYYY-MM-DD is UTC midnight — the day before here. */
export function asDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0);
}

const pad = (n) => String(n).padStart(2, '0');
export function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** An event has to have a title and a real date to be worth showing. */
export function isUsableEvent(e) {
  return !!(e && String(e.title || '').trim() && asDate(e.date));
}

/** Minutes past midnight for "HH:MM", or null. Used only for ordering. */
export function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function eventsBetween(events, from, to) {
  return (events || [])
    .filter(isUsableEvent)
    .filter(e => e.date >= from && e.date <= to)
    .sort(byDateThenTime);
}

function byDateThenTime(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const am = minutesOf(a.startTime);
  const bm = minutesOf(b.startTime);
  // An all-day event sorts before timed ones on the same day — it frames
  // the whole day rather than slotting into it.
  if (am == null && bm == null) return 0;
  if (am == null) return -1;
  if (bm == null) return 1;
  return am - bm;
}

/**
 * The week's shifts and events as ONE date-ordered list.
 *
 * Deliberately merged rather than two sections. The question a person has
 * is "what's happening this week", not "show me shifts, and separately show
 * me events" — splitting them makes the reader do the interleaving.
 *
 * @returns Array<{ kind: 'shift'|'event', date, sortTime, ...original }>
 */
export function weekAhead({ shifts = [], events = [], from, to }) {
  const rows = [];

  for (const s of shifts) {
    if (!s?.date || s.date < from || s.date > to) continue;
    if (s.status === 'draft' || s.status === 'cancelled') continue;
    rows.push({
      kind: 'shift',
      id: s.id,
      date: s.date,
      sortTime: minutesOf(s.startTime),
      startTime: s.startTime,
      endTime: s.endTime,
      subRole: s.subRole || null,
      shift: s,
    });
  }

  for (const e of eventsBetween(events, from, to)) {
    rows.push({
      kind: 'event',
      id: e.id,
      date: e.date,
      sortTime: minutesOf(e.startTime),
      startTime: e.startTime || null,
      endTime: e.endTime || null,
      title: e.title,
      type: e.type || 'other',
      note: e.note || '',
    });
  }

  return rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.sortTime == null && b.sortTime == null) return 0;
    if (a.sortTime == null) return -1;
    if (b.sortTime == null) return 1;
    return a.sortTime - b.sortTime;
  });
}

/**
 * "What's on" for a month — events plus the centre's own closures.
 *
 * Closures come free: the centre already configures holidays with real
 * dates and a statutory flag, so a closed day is already known and does not
 * need entering twice.
 *
 * @param holidays  centerConfig.holidays
 */
export function monthAhead({ events = [], holidays = [], from, to }) {
  const rows = eventsBetween(events, from, to).map(e => ({
    kind: 'event',
    id: e.id,
    date: e.date,
    startTime: e.startTime || null,
    title: e.title,
    type: e.type || 'other',
    note: e.note || '',
  }));

  for (const h of holidays || []) {
    if (!h?.date || h.date < from || h.date > to) continue;
    rows.push({
      kind: 'closure',
      id: `holiday-${h.date}`,
      date: h.date,
      startTime: null,
      title: `${h.name || 'Holiday'} — centre closed`,
      type: 'closure',
      note: h.stat === false ? 'Centre closure' : 'Statutory holiday',
    });
  }

  return rows.sort(byDateThenTime);
}

/** The window "this month" means, starting today rather than on the 1st. */
export function monthWindow(todayISO) {
  const d = asDate(todayISO);
  if (!d) return { from: todayISO, to: todayISO };
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 12, 0, 0);
  return { from: todayISO, to: toISO(end) };
}

/** The next seven days, today included. */
export function weekWindow(todayISO) {
  const d = asDate(todayISO);
  if (!d) return { from: todayISO, to: todayISO };
  const end = new Date(d);
  end.setDate(end.getDate() + 6);
  return { from: todayISO, to: toISO(end) };
}

/** Validation for the admin form. Returns an error string, or null. */
export function validateEvent(draft) {
  if (!String(draft?.title || '').trim()) return 'Give it a name.';
  if (!asDate(draft?.date)) return 'Pick a date.';
  const s = minutesOf(draft?.startTime);
  const e = minutesOf(draft?.endTime);
  if (draft?.startTime && s == null) return 'That start time is not a time.';
  if (draft?.endTime && e == null) return 'That end time is not a time.';
  if (s != null && e != null && e <= s) return 'It has to end after it starts.';
  if (draft?.endTime && s == null) return 'Add a start time as well as an end time.';
  return null;
}
