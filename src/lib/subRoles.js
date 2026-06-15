/**
 * Sub-role colors and styles, defined ONCE for the whole app.
 *
 * Each sub-role has multiple style variants because shifts appear in
 * different shapes across the app — small pills on cards, full colored
 * blocks in calendar cells, side stripes in the admin weekly grid, etc.
 *
 * If you want to tweak a color, change it here and every shift, pill,
 * legend, and chip in the app updates automatically.
 *
 * Color choices (per Mathnasium Langley convention):
 *   Elementary — lime / yellow-green
 *   Highschool — cyan
 *   Online     — dark indigo (deep blue)
 */

export const SUB_ROLES = ['Elementary', 'Highschool', 'Online'];

export const SUB_ROLE_STYLES = {
  Elementary: {
    label:        'Elementary',
    pillBg:       'bg-lime-100',
    pillText:     'text-lime-800',
    pillBorder:   'border-lime-200',
    dot:          'bg-lime-500',
    // Used when the *whole shift block* takes the sub-role color
    blockBg:      'bg-lime-500',
    blockText:    'text-white',
    blockSubText: 'text-lime-100',
    // Used for the side-stripe indicator in the admin grid
    stripe:       'bg-lime-500',
    // Hex for inline-style situations (e.g., the admin role colors map)
    hex:          '#84cc16',
  },
  Highschool: {
    label:        'Highschool',
    pillBg:       'bg-cyan-100',
    pillText:     'text-cyan-800',
    pillBorder:   'border-cyan-200',
    dot:          'bg-cyan-500',
    blockBg:      'bg-cyan-500',
    blockText:    'text-white',
    blockSubText: 'text-cyan-100',
    stripe:       'bg-cyan-500',
    hex:          '#06b6d4',
  },
  Online: {
    label:        'Online',
    pillBg:       'bg-indigo-100',
    pillText:     'text-indigo-800',
    pillBorder:   'border-indigo-200',
    dot:          'bg-indigo-700',
    blockBg:      'bg-indigo-700',
    blockText:    'text-white',
    blockSubText: 'text-indigo-200',
    stripe:       'bg-indigo-700',
    hex:          '#4338ca',
  },
};

/**
 * Look up a sub-role style by name. Returns null for unknown values
 * (legacy shifts without a subRole field, etc.).
 */
export function styleFor(subRole) {
  if (!subRole) return null;
  return SUB_ROLE_STYLES[subRole] || null;
}

/**
 * Sick Pay override style. A shift with sickPay === true displays in
 * deep burgundy across every surface — schedule calendar, admin weekly
 * grid, coverage bars, day modal, home upcoming-shift card. Defined in
 * one place so the colour can be tweaked without hunting through pages.
 */
export const SICK_PAY_STYLE = {
  label:        'Sick Pay',
  pillBg:       'bg-red-100',
  pillText:     'text-red-900',
  pillBorder:   'border-red-200',
  dot:          'bg-red-900',
  blockBg:      'bg-red-900',
  blockText:    'text-white',
  blockSubText: 'text-red-200',
  stripe:       'bg-red-900',
  hex:          '#7f1d1d', // Tailwind red-900 — deep burgundy
};

/** Convenience: returns SICK_PAY_STYLE if the shift is sick, else null. */
export function sickStyleFor(shift) {
  return shift?.sickPay ? SICK_PAY_STYLE : null;
}
