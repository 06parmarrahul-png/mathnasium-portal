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
  // Per-center role colors (hex), shown on the admin weekly spreadsheet.
  // Editable from Super Admin → Appearance. Any role not listed falls back
  // to the built-in DEFAULT_ROLE_COLORS.
  roleColors: {},
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
  };
}

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
