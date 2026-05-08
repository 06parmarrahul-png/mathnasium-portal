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
 *   Highschool — teal
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
    pillBg:       'bg-teal-100',
    pillText:     'text-teal-800',
    pillBorder:   'border-teal-200',
    dot:          'bg-teal-500',
    blockBg:      'bg-teal-500',
    blockText:    'text-white',
    blockSubText: 'text-teal-100',
    stripe:       'bg-teal-500',
    hex:          '#14b8a6',
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
