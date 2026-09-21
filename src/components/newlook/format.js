/**
 * Formatting helpers for the new-look home pages.
 *
 * Split out of ui.jsx because a file that exports components must export
 * ONLY components — mixing helpers in breaks React Fast Refresh, and the
 * lint rule that says so is right.
 */

// Times are NOT here: they follow the reader's 12/24-hour preference,
// so they come from useTimeFormat() — see src/lib/timeFormat.js.

/** Local-noon parse. A bare YYYY-MM-DD is UTC midnight, i.e. yesterday here. */
export function asDate(iso) {
  return new Date(`${iso}T12:00:00`);
}

export function fmtDay(iso, opts = { weekday: 'long', month: 'short', day: 'numeric' }) {
  if (!iso) return '';
  return asDate(iso).toLocaleDateString('en-CA', opts);
}

export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Minutes past midnight for "HH:MM". Null when unreadable. */
export function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
