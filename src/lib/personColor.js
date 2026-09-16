/**
 * personColor.js — one stable colour per person.
 *
 * WHAT IT IS FOR
 *   The Management Desk's question is "who is this for?", and a name in
 *   bold text does not answer it at a glance down a list of 121. A colour
 *   does — provided it is the SAME colour every time, everywhere, without
 *   anybody having to configure it.
 *
 * DERIVED, NOT STORED. The colour comes from a hash of the person's uid,
 * so it needs no field on the user, no admin screen and no migration, and
 * it cannot drift between two surfaces that both ask for it. The cost is
 * that it is arbitrary — nobody chose teal for Sabrina — and that two
 * people can collide on a busy desk. Both are fine here: the chip always
 * carries their initials and name as well, so the colour is a shortcut to
 * recognition rather than the thing being read.
 *
 * WHY THESE COLOURS
 *   Solid and saturated, because the desk's other chips are PALE and mean
 *   a state: amber is Open, indigo In progress, emerald Settled, red
 *   Overdue. Keeping people solid and states pale stops one being mistaken
 *   for the other.
 *
 *   RED IS RESERVED and deliberately absent below. It means "this one is
 *   yours" — the left rail on a card already uses it, and YOU_COLOR here
 *   is the same red, so the two reinforce each other instead of competing.
 *   Handing red to some other colleague at random would break that.
 */

/** Everybody else. Each is dark enough to carry white text. */
export const PERSON_COLORS = [
  '#0d9488', // teal
  '#2563eb', // blue
  '#7c3aed', // violet
  '#c026d3', // fuchsia
  '#c2410c', // burnt orange
  '#15803d', // green
  '#0e7490', // cyan
  '#4338ca', // indigo
  '#be185d', // pink
  '#475569', // slate
  '#b45309', // amber
  '#4d7c0f', // olive
];

/** Yours. The same red as the "this one is yours" rail on a note. */
export const YOU_COLOR = '#dc2626';

/** Addressed to the whole team — not a person, so not a person's colour. */
export const EVERYONE_COLOR = '#6d28d9';

/** Somebody who has no account here: the imported initials of people who left. */
export const UNKNOWN_COLOR = '#9ca3af';

/**
 * A stable index from any string. FNV-1a — small, and spreads short
 * similar strings (uids differ in a few characters) better than adding
 * char codes, which would give "AY" and "YA" the same colour.
 */
export function hashOf(text) {
  let h = 2166136261;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * This person's colour. Pass their uid where there is one — it is stable
 * across a rename, which a name is not.
 */
export function personColor(key) {
  if (!key) return UNKNOWN_COLOR;
  return PERSON_COLORS[hashOf(key) % PERSON_COLORS.length];
}
