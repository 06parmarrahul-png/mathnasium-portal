/**
 * scheduler-highlights.js — the four highlighter colours on the Student
 * Scheduler, and the legend that says what they mean.
 *
 * WHY THE COLOURS ARE FIXED AND THE LABELS AREN'T
 *   Every centre runs its floor differently, so what "pink" means is the
 *   centre's business — that's the editable legend. But the colours
 *   themselves are fixed and shared, because the schedule gets PRINTED and
 *   carried around: a sheet that means one thing on Monday's printout and
 *   another on Tuesday's is worse than no highlighting at all.
 *
 * WHY THESE FOUR
 *   Yellow, pink, orange and blue are the physical highlighter colours the
 *   centre already uses on paper, which is the whole point — the digital
 *   sheet should look like the one staff are used to marking up.
 *
 * PRINTING
 *   Browsers strip background colours when printing unless told not to.
 *   `printStyle()` carries `print-color-adjust: exact`, without which every
 *   highlight would silently vanish on paper — the one surface this
 *   feature exists for.
 */

export const HIGHLIGHTS = [
  { key: 'yellow', label: 'Yellow', bg: '#fef08a', text: '#713f12', ring: '#eab308' },
  { key: 'pink',   label: 'Pink',   bg: '#fbcfe8', text: '#831843', ring: '#ec4899' },
  { key: 'orange', label: 'Orange', bg: '#fed7aa', text: '#7c2d12', ring: '#f97316' },
  { key: 'blue',   label: 'Blue',   bg: '#bfdbfe', text: '#1e3a8a', ring: '#3b82f6' },
];

export const HIGHLIGHT_KEYS = HIGHLIGHTS.map(h => h.key);

/** Look up one highlight, or null for '' / unknown values. */
export function highlightFor(key) {
  if (!key) return null;
  return HIGHLIGHTS.find(h => h.key === key) || null;
}

/**
 * Inline style for a highlighted student row. Returns undefined when
 * there's no highlight, so callers can spread it unconditionally without
 * painting an empty background over the row's normal styling.
 *
 * `printColorAdjust` (and the WebKit prefix) is what makes the colour
 * survive printing. Chrome and Safari both need the prefixed form.
 */
export function highlightStyle(key) {
  const h = highlightFor(key);
  if (!h) return undefined;
  return {
    backgroundColor: h.bg,
    color: h.text,
    printColorAdjust: 'exact',
    WebkitPrintColorAdjust: 'exact',
  };
}

/**
 * The legend to render: every colour the centre has actually named, plus
 * any colour currently in use on the day even if it has no label yet —
 * otherwise a mark on the sheet would have nothing explaining it.
 *
 * @param {Object} legend   { yellow: 'Needs review', ... } from settings
 * @param {Set|Array} inUse colour keys used on the day being shown
 */
export function legendEntries(legend, inUse = []) {
  const used = inUse instanceof Set ? inUse : new Set(inUse || []);
  return HIGHLIGHTS
    .map(h => ({ ...h, meaning: String(legend?.[h.key] ?? '').trim() }))
    .filter(h => h.meaning.length > 0 || used.has(h.key));
}

/** Normalise a legend for saving: known keys only, trimmed, length-capped. */
export function serializeLegend(legend) {
  const out = {};
  for (const h of HIGHLIGHTS) out[h.key] = String(legend?.[h.key] ?? '').trim().slice(0, 40);
  return out;
}

/** Every highlight colour in use across a day's check-in entries. */
export function highlightsInUse(checkIns) {
  const used = new Set();
  for (const entry of Object.values(checkIns || {})) {
    const k = entry?.highlight;
    if (k && HIGHLIGHT_KEYS.includes(k)) used.add(k);
  }
  return used;
}
