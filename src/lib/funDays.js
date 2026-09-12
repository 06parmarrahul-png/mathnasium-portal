/**
 * funDays.js — the fun-day calendar.
 *
 * The centre runs an activity most days — Bingo, Four Corners, Doodle
 * Challenge, Instructor Says — and it lives in a PowerPoint somebody
 * remakes every month. Instructors find out by looking at the printed
 * sheet, or by asking.
 *
 * A fun day is already modelled: a centre event with `type: 'fun-day'`.
 * Nothing new is stored and nothing else changes — the same rows already
 * feed "What's on this month".
 *
 * WHY IT NEEDS ITS OWN CARD RATHER THAN LIVING IN "WHAT'S ON"
 *   There is one nearly every day. Twenty fun days would bury the two
 *   staff meetings that "What's on" exists to show, and a list of twenty
 *   is not the question anyone asks anyway. The question is "what is it
 *   today", so today is the headline and the next few are a footnote.
 */

const pad = (n) => String(n).padStart(2, '0');

export function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-noon parse. A bare YYYY-MM-DD is UTC midnight — the day before here. */
export function asDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0);
}

export const isFunDay = (e) =>
  !!e && e.type === 'fun-day' && !!e.date && !!String(e.title || '').trim();

/** Every fun day in a YYYY-MM, in date order. */
export function funDaysInMonth(events, ym) {
  return (events || [])
    .filter(isFunDay)
    .filter(e => String(e.date).slice(0, 7) === ym)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** What is on today, or null. */
export function funDayOn(events, iso) {
  return (events || []).find(e => isFunDay(e) && e.date === iso) || null;
}

/**
 * Today's, plus the next few.
 *
 * `days` counts calendar days forward, not entries — "the next three days"
 * is the useful window, and skipping over a weekend to find three more
 * would promise something that is not coming up.
 */
export function funDaysAhead(events, todayISO, days = 4) {
  const start = asDate(todayISO);
  if (!start) return [];
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  const to = toISO(end);
  return (events || [])
    .filter(isFunDay)
    .filter(e => e.date >= todayISO && e.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** The days of a month, for the grid editor. */
export function monthDays(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return [];
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return [];
  const out = [];
  const last = new Date(year, month, 0).getDate();
  for (let d = 1; d <= last; d++) {
    const date = new Date(year, month - 1, d, 12);
    out.push({ date: `${m[1]}-${m[2]}-${pad(d)}`, day: d, weekday: date.getDay() });
  }
  return out;
}

/** "September 2026" from '2026-09'. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return String(ym || '');
  const i = Number(m[2]) - 1;
  return i >= 0 && i < 12 ? `${MONTHS[i]} ${m[1]}` : String(ym);
}

/** The month a date falls in, or this month. */
export function monthOf(iso) {
  return /^\d{4}-\d{2}/.test(String(iso || '')) ? String(iso).slice(0, 7) : toISO(new Date()).slice(0, 7);
}

/** Step a YYYY-MM by n months. */
export function stepMonth(ym, n) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return ym;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * What the grid editor has to save.
 *
 * Returns only what CHANGED, so pressing save on an untouched month writes
 * nothing. Three kinds: new activities, edits, and days that were cleared.
 */
export function diffMonth(existing, draft, ym) {
  const was = new Map(funDaysInMonth(existing, ym).map(e => [e.date, e]));
  const adds = [];
  const edits = [];
  const removes = [];
  for (const [date, rawTitle] of Object.entries(draft || {})) {
    const title = String(rawTitle || '').trim();
    const before = was.get(date);
    if (!before && title) adds.push({ date, title });
    else if (before && !title) removes.push(before);
    else if (before && title && title !== String(before.title || '').trim()) {
      edits.push({ id: before.id, date, title });
    }
  }
  return { adds, edits, removes };
}
