/**
 * timeFormat.js — every clock time Ratio shows a person, in one place.
 *
 * WHY THIS EXISTS
 *   Twelve near-identical `fmtTime` helpers had grown across the app, and
 *   a handful of surfaces skipped them and printed the stored "15:30"
 *   straight out of Firestore. So the same shift read "3:30 PM" on the
 *   schedule, "3:30PM" on the supply chart, "3:30pm" on the staffing
 *   board and "15:30" in Manage Availability. This module is the only
 *   thing that turns a stored time into a shown one.
 *
 * TWELVE-HOUR IS THE DEFAULT
 *   It is what the centre says out loud — "come in at 3:30" — and what
 *   everyone signed up already reads everywhere else. Anyone who prefers
 *   a 24-hour clock sets it once on Account Details and every page
 *   follows; see `useTimeFormat`.
 *
 * WHAT IT DOES NOT TOUCH
 *   STORAGE AND INPUT ARE ALWAYS 24-HOUR. Shift times, slot keys and
 *   `<input type="time">` all stay "HH:MM", because that string sorts,
 *   compares and round-trips. This is a display layer and nothing else —
 *   never feed a formatted time back into Firestore.
 *
 *   Emails keep their own formatter. They are read by whoever receives
 *   them, not by the person whose preference we know, so a viewer
 *   setting has no say over what lands in someone else's inbox.
 */

export const TIME_FORMATS = ['12h', '24h'];

/**
 * Twelve-hour unless a person has said otherwise — see the note above.
 */
export const DEFAULT_TIME_FORMAT = '12h';

/**
 * Whatever is stored on the user doc → a format this module understands.
 *
 * Anything unrecognised (absent, null, an old value, a typo) falls back
 * to the default rather than throwing: a preference that can't be read
 * should cost someone a clock style, never a page.
 */
export function resolveTimeFormat(value) {
  return TIME_FORMATS.includes(value) ? value : DEFAULT_TIME_FORMAT;
}

/** Human name for the setting, for the one screen that offers the choice. */
export function timeFormatLabel(value) {
  return resolveTimeFormat(value) === '24h' ? '24-hour' : '12-hour';
}

// ─── Parsing what we're given ───────────────────────────────────────────
// Callers hand us three shapes and shouldn't have to care which:
// "HH:MM" (how shifts and slots are stored), minutes past midnight (how
// the staffing maths carries them around), and a Date / Firestore
// timestamp (how message and audit stamps arrive).

/** "15:30" | "9:05" | 930 → minutes past midnight, or null. */
export function minutesOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (!value) return null;
  const [hStr, mStr = '0'] = String(value).split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** A Date, a millisecond stamp, an ISO string, or a Firestore Timestamp. */
function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === 'function') { try { return value.toDate(); } catch { return null; } }
  if (typeof value?.seconds === 'number') return new Date(value.seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Formatting ─────────────────────────────────────────────────────────

/**
 * Three widths, because the app genuinely needs three and inventing a
 * fourth per page is how the drift started:
 *
 *   long    "3:30 PM"   prose, cards, anywhere there is room
 *   compact "3:30PM"    chart axes and grid headers, where a space costs
 *                       a column
 *   short   "3pm"       dense boards, dropping ":00" on the hour
 *   tick    "3p"        an hour mark on a chart axis, where the labels
 *                       are one hour apart and the letter is only there
 *                       to say which half of the day
 *
 * In 24-hour mode they all give "15:30" — that IS the compact form, and
 * abbreviating it further only makes it harder to read. The one exception
 * is `tick`, which drops a whole hour's ":00" the same way.
 */
const STYLES = ['long', 'compact', 'short', 'tick'];

/**
 * A stored time → what a person reads.
 *
 * @param {string|number} value   "HH:MM", or minutes past midnight
 * @param {string} format         '12h' | '24h' — from `useTimeFormat()`
 * @param {string} style          'long' | 'compact' | 'short'
 * @returns {string} the formatted time, or '' when there is nothing to show
 *
 * Unparseable input comes back as the caller gave it. A stray value on an
 * old document should look odd on the page, not disappear from it.
 */
export function formatTime(value, format = DEFAULT_TIME_FORMAT, style = 'long') {
  const mins = minutesOf(value);
  if (mins == null) return value == null || value === '' ? '' : String(value);

  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const width = STYLES.includes(style) ? style : 'long';

  const hh = String(h24).padStart(2, '0');
  if (resolveTimeFormat(format) === '24h') {
    if (width === 'tick') return m === 0 ? hh : `${hh}:${String(m).padStart(2, '0')}`;
    return `${hh}:${String(m).padStart(2, '0')}`;
  }

  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(m).padStart(2, '0');
  if (width === 'tick') {
    const letter = h24 >= 12 ? 'p' : 'a';
    return m === 0 ? `${h12}${letter}` : `${h12}:${mm}${letter}`;
  }
  if (width === 'short') {
    const suffix = h24 >= 12 ? 'pm' : 'am';
    return m === 0 ? `${h12}${suffix}` : `${h12}:${mm}${suffix}`;
  }
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  return width === 'compact' ? `${h12}:${mm}${suffix}` : `${h12}:${mm} ${suffix}`;
}

/**
 * "3:00 PM – 7:00 PM". An en dash with spaces, everywhere, so a shift
 * looks the same on the board as it does on the schedule.
 *
 * Returns '' unless both ends are there — half a range reads as a start
 * time somebody forgot to finish.
 */
export function formatRange(start, end, format = DEFAULT_TIME_FORMAT, style = 'long') {
  const from = formatTime(start, format, style);
  const to = formatTime(end, format, style);
  if (!from || !to) return '';
  return style === 'long' ? `${from} – ${to}` : `${from}–${to}`;
}

/**
 * A timestamp's clock face: "3:04 PM" or "15:04".
 *
 * Goes through `toLocaleTimeString` rather than our own maths because
 * these are real instants, and the browser is the one that knows the
 * viewer's zone.
 */
export function formatClock(value, format = DEFAULT_TIME_FORMAT, options = {}) {
  const d = asDate(value);
  if (!d) return '';
  // 'en-US' rather than the Canadian locale we use for dates: en-CA
  // renders the suffix as "p.m.", which would not match the "PM" the
  // rest of this module prints. The numbers are identical either way.
  return d.toLocaleTimeString('en-US', {
    hour: resolveTimeFormat(format) === '24h' ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: resolveTimeFormat(format) === '12h',
    ...options,
  });
}

/**
 * A timestamp with the day on it: "Sep 20, 3:04 PM" / "Sep 20, 15:04".
 *
 * For message and log stamps, where "3:04 PM" alone leaves you wondering
 * which day it was.
 */
export function formatStamp(value, format = DEFAULT_TIME_FORMAT, options = {}) {
  const d = asDate(value);
  if (!d) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: resolveTimeFormat(format) === '24h' ? '2-digit' : 'numeric',
    minute: '2-digit',
    hour12: resolveTimeFormat(format) === '12h',
    ...options,
  });
}

// ─── One formatter, carried around ──────────────────────────────────────

/**
 * The viewer's preference, bound into a formatter they can just call.
 *
 * Returns a FUNCTION with methods hung off it, which is unusual enough to
 * explain: almost every call site in the app already read `fmtTime(t)`,
 * and the ones that need a narrower width or a timestamp are the
 * minority. Binding the format once at the top of a component means the
 * preference is threaded through without every line of JSX growing a
 * second argument it can get wrong.
 *
 *   const fmtTime = useTimeFormat();
 *   fmtTime('15:30')               → "3:30 PM"
 *   fmtTime.compact('15:30')       → "3:30PM"
 *   fmtTime.short('15:00')         → "3pm"
 *   fmtTime.range('15:00','19:00') → "3:00 PM – 7:00 PM"
 *   fmtTime.clock(ts)              → "3:04 PM"
 *   fmtTime.stamp(ts)              → "Sep 20, 3:04 PM"
 *
 * Pure, so it can be tested and used outside React — `useTimeFormat` is
 * only this plus the preference.
 */
export function makeTimeFormatter(format) {
  const f = resolveTimeFormat(format);
  const fmt = (value, style) => formatTime(value, f, style);
  fmt.format = f;
  fmt.is24h = f === '24h';
  fmt.compact = (value) => formatTime(value, f, 'compact');
  fmt.short = (value) => formatTime(value, f, 'short');
  fmt.tick = (value) => formatTime(value, f, 'tick');
  fmt.range = (start, end, style) => formatRange(start, end, f, style);
  fmt.clock = (value, options) => formatClock(value, f, options);
  fmt.stamp = (value, options) => formatStamp(value, f, options);
  return fmt;
}
