/**
 * Per-center configuration — the knobs that USED to be hardcoded constants
 * inside scheduler.js / Schedule.jsx / Admin.jsx, now data-driven so each
 * Mathnasium location can have its own settings.
 *
 * Storage: `centers/{centerId}/config/main` — one doc per center.
 * If the doc is missing or partial, fields fall back to DEFAULT_CENTER_CONFIG
 * (which mirrors Langley's current behavior so nothing breaks pre-migration).
 *
 * Read via `useAuth().centerConfig`. Edit via Admin → Center Settings.
 */

export const DEFAULT_CENTER_CONFIG = {
  // ─── Basics ────────────────────────────────────────────────────────────
  name: 'Mathnasium',
  city: '',
  province: '',
  country: 'Canada',
  timezone: 'America/Vancouver',

  // ─── Hours ─────────────────────────────────────────────────────────────
  // INSTRUCTIONAL = teaching window (used to clamp scheduled instructor shifts)
  // OPERATING = full-day window for "I'm here for any work" availability + the
  //             coverage-grid x-axis range
  instructionalHours: {
    Monday:    { start: '15:00', end: '19:00' },
    Tuesday:   { start: '15:00', end: '19:00' },
    Wednesday: { start: '15:00', end: '19:00' },
    Thursday:  { start: '15:00', end: '19:00' },
    Friday:    { start: '15:00', end: '18:00' },
    Saturday:  { start: '10:00', end: '14:00' },
  },
  operatingHours: {
    Monday:    { start: '10:00', end: '20:00' },
    Tuesday:   { start: '10:00', end: '20:00' },
    Wednesday: { start: '10:00', end: '20:00' },
    Thursday:  { start: '10:00', end: '20:00' },
    Friday:    { start: '10:00', end: '19:00' },
    Saturday:  { start: '09:00', end: '15:00' },
  },

  // ─── Operating days ────────────────────────────────────────────────────
  // The weekdays this center is actually open. Drives which columns show on
  // the admin weekly grid, which days are clickable on the Schedule
  // calendar, and which days the auto-scheduler fills. Editable from
  // Super Admin → Operating Days. Every center is closed at least one day.
  operatingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],

  // ─── Auto-scheduler defaults ───────────────────────────────────────────
  defaultMinPerDay: 8,
  defaultMaxPerDay: 11,
  defaultMaxDaysPerWeek: 5,

  // ─── Staff lists ───────────────────────────────────────────────────────
  // First names that get a guaranteed shift when they submit availability.
  guaranteedNames: [],
  // Full names excluded from hourly payroll summaries (salaried staff).
  salaryStaff: [],
  // Fixed staff with hardcoded weekly schedules — keyed by display name.
  // {
  //   'Jasper Wu': {
  //     role: 'Center Director',
  //     countsTowardRatio: false,
  //     Monday: '11:00 AM - 7:00 PM',
  //     ...
  //     saturday_weeks: [1, 3]   // optional — only these weeks of month
  //   }
  // }
  fixedStaff: {},

  // ─── Appearance ────────────────────────────────────────────────────────
  // Per-center role colors (hex). Legacy — kept so older configs still
  // merge cleanly. Superseded by `assignmentColors` below.
  roleColors: {},
  // Per-center shift-assignment colors (hex), shown on the admin weekly
  // grid. Editable from Super Admin → Appearance. Any assignment not listed
  // falls back to the built-in DEFAULT_ASSIGNMENT_COLORS.
  assignmentColors: {},
};

// Built-in role colors — used as the fallback when a center hasn't
// customized them. Hex values; text is always white on these.
export const DEFAULT_ROLE_COLORS = {
  'Instructor':        '#16a34a', // green
  'Lead':              '#ea580c', // orange
  'Host':              '#2563eb', // blue
  'Admin':             '#dc2626', // red
  'Manager':           '#ca8a04', // yellow
  'Dir. of Education': '#db2777', // pink
  'Center Director':   '#92400e', // brown
};

// All editable role names (the keys shown in the Super Admin color editor).
export const ROLE_COLOR_KEYS = Object.keys(DEFAULT_ROLE_COLORS);

/**
 * Resolve a role's color: center override first, then the built-in default,
 * then a neutral green fallback for unknown roles.
 */
export function roleColorHex(role, centerConfig) {
  const custom = centerConfig?.roleColors?.[role];
  if (custom) return custom;
  return DEFAULT_ROLE_COLORS[role] || '#16a34a';
}

// ─── Shift assignments ───────────────────────────────────────────────────
// The single "what is this person doing on this shift" label shown on the
// admin weekly grid. Derived from a shift's role + teaching level via
// assignmentFor(), so the scheduler's internal role/subRole model never has
// to change. These nine are exactly the colors edited from Super Admin →
// Appearance, and every shift block is filled fully with its color.
export const SHIFT_ASSIGNMENTS = [
  'Elementary Instructor',
  'Highschool Instructor',
  'Online Instructor',
  'Lead Instructor',
  'Host',
  'Admin',
  'Manager',
  'Centre Director',
  'Director of Education',
];

// Built-in assignment colors — the fallback when a center hasn't customized.
export const DEFAULT_ASSIGNMENT_COLORS = {
  'Elementary Instructor': '#84cc16', // lime
  'Highschool Instructor': '#14b8a6', // teal
  'Online Instructor':     '#4338ca', // indigo
  'Lead Instructor':       '#9333ea', // purple
  'Host':                  '#2563eb', // blue
  'Admin':                 '#dc2626', // red
  'Manager':               '#ca8a04', // amber
  'Centre Director':       '#92400e', // brown
  'Director of Education': '#db2777', // pink
};

// Keys shown in the Super Admin color editor (same order as the list).
export const ASSIGNMENT_COLOR_KEYS = SHIFT_ASSIGNMENTS;

/**
 * Resolve an assignment's color: center override first, then the built-in
 * default, then a neutral slate for anything unrecognized.
 */
export function assignmentColorHex(assignment, centerConfig) {
  const custom = centerConfig?.assignmentColors?.[assignment];
  if (custom) return custom;
  return DEFAULT_ASSIGNMENT_COLORS[assignment] || '#64748b';
}

/**
 * Derive the single display "assignment" for a shift (or a person) from its
 * role + teaching level. Robust against messy legacy role strings like
 * 'High School', 'Elementary Instructor', 'Online Instructor', etc.
 *
 * Accepts either a shift  ({ role, subRole })
 *            or a person ({ role | instructorType, subRoles: [] }).
 */
export function assignmentFor(src) {
  if (!src) return 'Elementary Instructor';
  const role = String(src.role || src.instructorType || '').toLowerCase();
  // Teaching level — from a shift's subRole, or a person's subRoles[].
  let sub = String(src.subRole || '').toLowerCase();
  if (!sub && Array.isArray(src.subRoles)) {
    if (src.subRoles.includes('Online'))          sub = 'online';
    else if (src.subRoles.includes('Highschool')) sub = 'highschool';
    else if (src.subRoles.includes('Elementary')) sub = 'elementary';
  }

  if (role.includes('online') || sub === 'online')   return 'Online Instructor';
  if (role.includes('lead'))                         return 'Lead Instructor';
  if (role.includes('host'))                         return 'Host';
  if (role.includes('education'))                    return 'Director of Education';
  if (role.includes('director'))                     return 'Centre Director';
  if (role.includes('manager'))                      return 'Manager';
  if (role.includes('admin'))                        return 'Admin';
  if (sub === 'highschool' || role.includes('high')) return 'Highschool Instructor';
  return 'Elementary Instructor';
}

/**
 * Pick a readable text color (near-black or white) for a given hex
 * background, using perceived (WCAG) luminance. Keeps light assignment
 * colors like lime and amber legible instead of washed-out white text.
 */
export function contrastText(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return '#ffffff';
  const chan = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
  return L > 0.45 ? '#1f2937' : '#ffffff';
}

/**
 * Langley's existing values, used to seed the centers/langley/config/main
 * doc during the multi-center migration. Captures every Langley-specific
 * tunable that was hardcoded in scheduler.js before this phase.
 */
export const LANGLEY_DEFAULT_CONFIG = {
  ...DEFAULT_CENTER_CONFIG,
  name:     'Mathnasium Langley',
  city:     'Langley',
  province: 'BC',
  guaranteedNames: ['Luke', 'Ainsley', 'Kaitlyn'],
  salaryStaff:     ['Jasper Wu', 'Neeru Gill'],
  fixedStaff: {
    'Jasper Wu': {
      role: 'Center Director',
      countsTowardRatio: false,
      Monday:    '11:00 AM - 7:00 PM',
      Tuesday:   '11:00 AM - 7:00 PM',
      Wednesday: '11:00 AM - 7:00 PM',
      Thursday:  '11:00 AM - 7:00 PM',
      Friday:    '11:00 AM - 7:00 PM',
      Saturday:  'Off',
    },
    'Neeru Gill': {
      role: 'Dir. of Education',
      countsTowardRatio: false,
      Monday:    '11:00 AM - 7:30 PM',
      Tuesday:   '11:00 AM - 7:30 PM',
      Wednesday: '11:00 AM - 7:30 PM',
      Thursday:  '11:00 AM - 7:30 PM',
      Friday:    'Off',
      Saturday:  '9:00 AM - 3:00 PM',
    },
    'Sabrina Kedzior': {
      role: 'Manager',
      countsTowardRatio: false,
      Monday:    '11:00 AM - 7:00 PM',
      Tuesday:   '11:00 AM - 7:00 PM',
      Wednesday: '11:00 AM - 7:00 PM',
      Thursday:  '11:00 AM - 7:00 PM',
      Friday:    '11:00 AM - 7:00 PM',
      Saturday:  'Off',
    },
    'Rachel Rozelle': {
      role: 'Admin',
      countsTowardRatio: false,
      Monday:    'Off', Tuesday: 'Off', Wednesday: 'Off',
      Thursday:  'Off', Friday:  'Off', Saturday:  'Off',
    },
  },
};

/**
 * Merge a partial/incomplete server-stored config with the defaults so
 * downstream code can rely on every field being present.
 */
export function mergeCenterConfig(serverConfig) {
  if (!serverConfig) return DEFAULT_CENTER_CONFIG;
  const m = (key) => ({
    ...DEFAULT_CENTER_CONFIG[key],
    ...(serverConfig[key] || {}),
  });
  return {
    ...DEFAULT_CENTER_CONFIG,
    ...serverConfig,
    instructionalHours: m('instructionalHours'),
    operatingHours:     m('operatingHours'),
    fixedStaff:         { ...DEFAULT_CENTER_CONFIG.fixedStaff, ...(serverConfig.fixedStaff || {}) },
    guaranteedNames: Array.isArray(serverConfig.guaranteedNames)
      ? serverConfig.guaranteedNames
      : DEFAULT_CENTER_CONFIG.guaranteedNames,
    salaryStaff: Array.isArray(serverConfig.salaryStaff)
      ? serverConfig.salaryStaff
      : DEFAULT_CENTER_CONFIG.salaryStaff,
    // Keep operatingDays only if it's a non-empty array; otherwise fall back
    // to the default so a center can never end up "open zero days".
    operatingDays: (Array.isArray(serverConfig.operatingDays) && serverConfig.operatingDays.length > 0)
      ? serverConfig.operatingDays
      : DEFAULT_CENTER_CONFIG.operatingDays,
  };
}

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Full week in JS getDay() order (index 0 = Sunday … 6 = Saturday). Used by
// the Super Admin Operating Days editor and the day-of-week helpers below.
export const ALL_WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * Is the given day one this center operates on?
 * `day` may be a JS Date, a getDay() number (0=Sun…6=Sat), or a day-name
 * string ('Monday'). Falls back to the default Mon–Sat week when a center
 * has no operatingDays configured.
 */
export function isOperatingDay(day, centerConfig) {
  const list = (Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0)
    ? centerConfig.operatingDays
    : DEFAULT_CENTER_CONFIG.operatingDays;
  let name;
  if (day instanceof Date)            name = ALL_WEEKDAYS[day.getDay()];
  else if (typeof day === 'number')   name = ALL_WEEKDAYS[day];
  else                                name = day;
  return list.includes(name);
}
