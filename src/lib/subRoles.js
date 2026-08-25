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

// Students per instructor the centre staffs to. Only the starting value for
// the Supply vs Demand picker — a day that has been saved keeps whatever
// ratio was saved with it.
export const DEFAULT_TARGET_RATIO = 3.5;

// ─── Capability matching ────────────────────────────────────────────────
// Sub-role strings are not consistent in stored data: 'Highschool' is the
// canonical form, but 'High School' (with a space) exists on older shifts
// and imports, and 'HS' / 'Elem' turn up as shorthand. Comparing them with
// a plain === meant a genuinely qualified instructor could be told they
// lacked a sub-role they visibly had.
//
// Everything that gates on capability should go through hasCapability()
// rather than Array.includes(), so a stray space can't lock someone out.
const CAPABILITY_ALIASES = {
  highschool: 'highschool',
  hs: 'highschool',
  high: 'highschool',
  elementary: 'elementary',
  elem: 'elementary',
  em: 'elementary',
  online: 'online',
  host: 'host',
};

/** Fold any spelling of a capability down to a single comparable token. */
export function normalizeCapability(value) {
  if (!value || typeof value !== 'string') return '';
  const key = value.toLowerCase().replace(/[^a-z]/g, '');
  return CAPABILITY_ALIASES[key] || key;
}

/**
 * Can someone holding `userSubRoles` work a shift requiring `required`?
 *
 * - no requirement (legacy shift with no subRole) → anyone can take it
 * - no sub-roles recorded at all → locked out, as before
 */
export function hasCapability(userSubRoles, required) {
  const subs = Array.isArray(userSubRoles) ? userSubRoles : [];
  if (subs.length === 0) return false;
  const want = normalizeCapability(required);
  if (!want) return true;
  return subs.some(s => normalizeCapability(s) === want);
}

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
  // Host is a CAPABILITY (front-of-house), not a teaching level — but it
  // gets a style here so capability pills and swap-eligibility tags render.
  // Blue, matching the Host assignment colour used on the grid.
  Host: {
    label:        'Host',
    pillBg:       'bg-blue-100',
    pillText:     'text-blue-800',
    pillBorder:   'border-blue-200',
    dot:          'bg-blue-500',
    blockBg:      'bg-blue-600',
    blockText:    'text-white',
    blockSubText: 'text-blue-100',
    stripe:       'bg-blue-600',
    hex:          '#2563eb',
  },
};

/**
 * Compact pill labels. Deliberately NOT first-initial: 'Highschool' and
 * 'Host' both start with H, so a one-letter pill made a highschool
 * instructor and a front-of-house host visually identical in the staff
 * list — the exact pair you most need to tell apart when staffing.
 *
 * Anything not listed (stale values from before the current capability
 * set) returns unchanged, so it reads as its full self rather than an
 * unexplained initial.
 */
export const SUB_ROLE_SHORT = {
  Elementary: 'Elem',
  Highschool: 'HS',
  Online:     'Online',
  Host:       'Host',
};

export function subRoleShort(subRole) {
  return SUB_ROLE_SHORT[subRole] || subRole;
}

// What a STAFF MEMBER can be assigned for swap / open-shift eligibility:
// the three teaching sub-roles PLUS Host. Kept separate from SUB_ROLES
// (which is only the teaching LEVEL a shift can carry — Host is a role, not
// a level, so it must never appear in a shift's "Teaching Level" dropdown).
export const STAFF_CAPABILITIES = [...SUB_ROLES, 'Host'];

/**
 * The capability someone must have to work a given shift — used to gate
 * shift swaps and open-shift claims. A Host shift requires the 'Host'
 * capability; every other shift requires its teaching sub-role. Returns
 * null when the shift has neither (legacy → no restriction).
 */
export function requiredCapabilityForShift(shift) {
  if (!shift) return null;
  if (shift.role === 'Host') return 'Host';
  return shift.subRole || null;
}

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

/**
 * Flex roles — a shift where the person is NOT working as a floor
 * instructor. Over the summer we run STEAM sessions and Summer Camp
 * alongside regular tutoring; whoever is running those is present and
 * PAID, but must NOT be counted as teaching supply (Supply & Demand,
 * Student Scheduler, coverage/instructor tiles). They still appear on
 * the schedule so everyone can see who's doing what — hence the loud,
 * distinct colours.
 *
 * Stored on the shift as `flexRole: 'STEAM' | 'Summer Camp'` (unset =
 * a normal counted shift). Mutually exclusive — a shift is one or the
 * other, never both.
 *
 * Colours: STEAM = dark yellow (gold), Summer Camp = orange. Chosen to
 * be obviously different from each other and from the teaching sub-role
 * colours (lime / cyan / indigo) and Sick Pay (burgundy).
 */
export const FLEX_ROLES = ['STEAM', 'Summer Camp'];

export const FLEX_ROLE_STYLES = {
  'STEAM': {
    label:        'STEAM',
    pillBg:       'bg-yellow-100',
    pillText:     'text-yellow-900',
    pillBorder:   'border-yellow-300',
    dot:          'bg-yellow-700',
    blockBg:      'bg-yellow-700',
    blockText:    'text-white',
    blockSubText: 'text-yellow-100',
    stripe:       'bg-yellow-700',
    hex:          '#a16207', // Tailwind yellow-700 — dark yellow, distinct from Manager gold
  },
  'Summer Camp': {
    label:        'Summer Camp',
    pillBg:       'bg-orange-100',
    pillText:     'text-orange-900',
    pillBorder:   'border-orange-300',
    dot:          'bg-orange-500',
    blockBg:      'bg-orange-500',
    blockText:    'text-white',
    blockSubText: 'text-orange-100',
    stripe:       'bg-orange-500',
    hex:          '#f97316', // Tailwind orange-500
  },
};

/** True when the shift is a flex (STEAM / Summer Camp) assignment. */
export function isFlexRole(shift) {
  return !!shift && FLEX_ROLES.includes(shift.flexRole);
}

/** Convenience: returns the flex style for a shift, else null. */
export function flexStyleFor(shift) {
  if (!shift?.flexRole) return null;
  return FLEX_ROLE_STYLES[shift.flexRole] || null;
}
