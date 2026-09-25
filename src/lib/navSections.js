/**
 * navSections.js — which parts of the sidebar are open.
 *
 * THE PROBLEM: an owner's sidebar carries fifty links. Every one of them
 * earns its place on some day of the month, and all fifty being on screen
 * at once is what makes the portal feel like a filing cabinet rather than
 * a tool. The instructor sidebar is seven links and it is the part of
 * Ratio people like.
 *
 * SO: the sections collapse, and it remembers. What it must never do is
 * hide something that needed attention — see rollUpBadge().
 */

const KEY_PREFIX = 'ratio-nav:';

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function navKey(uid) {
  return `${KEY_PREFIX}${uid || 'anon'}`;
}

/**
 * The sections this person has collapsed, as a Set of labels.
 *
 * Stored as the CLOSED ones rather than the open ones, so a section added
 * to the sidebar in a later release arrives open. The other way round, a
 * new section would be invisible to everybody who had ever saved a
 * preference — which is the sort of bug nobody reports, they just never
 * find the feature.
 */
export function readCollapsed(uid) {
  const raw = read(navKey(uid));
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsed(uid, set) {
  write(navKey(uid), JSON.stringify([...(set || [])]));
  return set;
}

export function toggleCollapsed(uid, label) {
  const next = readCollapsed(uid);
  if (next.has(label)) next.delete(label); else next.add(label);
  writeCollapsed(uid, next);
  return next;
}

/**
 * Is this section open right now?
 *
 * Three rules, and the last two beat the stored preference:
 *   1. Collapsed if the person collapsed it.
 *   2. ALWAYS open if it holds the page you are on. Collapsing the section
 *      you are standing in leaves the sidebar with nothing highlighted and
 *      no clue where you are.
 *   3. Always open if it is the first one. General is Home and the two or
 *      three things everybody opens; a sidebar whose top section is shut
 *      looks broken.
 */
export function isSectionOpen({ label, index, collapsed, hasActive }) {
  if (index === 0) return true;
  if (hasActive) return true;
  return !(collapsed || new Set()).has(label);
}

/**
 * What a collapsed section is still shouting about.
 *
 * COLLAPSING MUST NOT SILENCE A BADGE. Open shifts and the Management Desk
 * both carry counts that are the entire reason somebody would look, and a
 * tidier sidebar that loses them is a worse sidebar. The count rolls up to
 * the header instead.
 */
export function rollUpBadge(items) {
  return (items || []).reduce((n, item) => n + (Number(item?.badge) > 0 ? Number(item.badge) : 0), 0);
}

/** Does this section hold the page currently open? */
export function sectionHasActive(items, isActive) {
  return (items || []).some(item => {
    try { return !!isActive(item); } catch { return false; }
  });
}
