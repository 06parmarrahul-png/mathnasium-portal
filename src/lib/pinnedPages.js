/**
 * pinnedPages.js — the handful of pages somebody actually uses.
 *
 * WHY PINS AND NOT A REARRANGEABLE SIDEBAR
 *   A Centre Director's sidebar carries fifty links; an instructor's
 *   carries seven, and the instructor's is the part of Ratio people like.
 *   The obvious fix is to let everyone drag their own into shape — and it
 *   is the wrong one, for a reason that only shows up later: today the
 *   sidebar is a pure function of role, so "where is Manage Payroll?" has
 *   exactly one answer and `Layout.render.test.jsx` can assert what all
 *   ten roles see. Once everybody's is different, every support question
 *   starts with "what does yours look like?", and a page somebody hid
 *   becomes a bug report about a working feature.
 *
 *   So pins are ADDITIVE AND ONLY ADDITIVE. They copy a link to a strip at
 *   the top. Nothing moves, nothing is hidden, and the role's own sidebar
 *   sits underneath exactly where it has always been — which means the
 *   answer to "where is it?" is still the same for everyone.
 *
 * FIVE, AND THE OLDEST DOES NOT FALL OFF
 *   A cap keeps the strip a shortcut rather than a second sidebar. When it
 *   is full the next pin is REFUSED rather than silently pushing one out:
 *   a shortcut that quietly disappears is worse than one you had to make
 *   room for, because you only notice at the moment you reached for it.
 *
 * PINS ARE PATHS, and they are checked against the sidebar this person
 * actually has. A pin to a page they can no longer open — role changed,
 * centre switched — is dropped from the strip on sight rather than
 * rendering a link into a wall. It stays in storage, so it comes back if
 * their access does.
 *
 * PURE MODULE — no React, no Firebase.
 */

export const MAX_PINS = 5;

/** Stored value → the pins to show, in the order they were pinned. */
export function resolvePins(stored, availablePaths = []) {
  if (!Array.isArray(stored)) return [];
  const available = new Set(availablePaths);
  const out = [];
  for (const path of stored) {
    if (typeof path !== 'string' || !path) continue;
    if (!available.has(path)) continue;          // not on this sidebar today
    if (out.includes(path)) continue;            // never twice
    out.push(path);
    if (out.length >= MAX_PINS) break;
  }
  return out;
}

export function isPinned(pins, path) {
  return Array.isArray(pins) && pins.includes(path);
}

/** Room for another, or already on the strip and so always toggleable. */
export function canPin(pins, path) {
  return isPinned(pins, path) || (pins || []).length < MAX_PINS;
}

/**
 * Pin or unpin, returning a new list.
 *
 * Returns the list UNCHANGED when it is full and this is a new pin — the
 * caller can compare identity to know nothing happened and say so.
 */
export function togglePin(pins, path) {
  const list = Array.isArray(pins) ? pins : [];
  if (!path) return list;
  if (list.includes(path)) return list.filter(p => p !== path);
  if (list.length >= MAX_PINS) return list;
  return [...list, path];
}

/**
 * The sidebar items behind the pins, in pin order.
 *
 * Takes the items the sidebar already built, so a pinned link keeps its
 * icon, its label and — the part that matters — its BADGE. A pinned Job
 * Board that doesn't show the three open shifts is a worse shortcut than
 * no shortcut.
 */
export function pinnedItems(pins, items = []) {
  const byPath = new Map();
  for (const item of items) if (item?.to && !byPath.has(item.to)) byPath.set(item.to, item);
  return (pins || []).map(path => byPath.get(path)).filter(Boolean);
}

/** What to say when somebody reaches for a sixth. */
export function fullMessage() {
  return `Five pins is the most. Unpin one to make room.`;
}
