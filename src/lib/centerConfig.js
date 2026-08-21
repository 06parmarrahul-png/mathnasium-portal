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

  // Date-bounded INSTRUCTIONAL HOURS OVERRIDE. Targeted at Langley's
  // summer 2026 schedule change (Tue/Thu shift from 3-7pm to 10am-2pm
  // for July + August). Auto-expires September 1 — no manual revert.
  //
  // Shape (all fields optional; null disables the override entirely):
  //   { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', byDay: { Tuesday: {start,end}, ... } }
  //
  // Days NOT listed in byDay fall through to the weekly default above.
  // Use resolveInstructionalHours(config, date) below — never read this
  // field directly from a consumer. That helper handles the date math
  // and is the single source of truth for "what hours apply on date X."
  //
  // This is intentionally NOT a generic recurring-override system —
  // we'll build one of those if we need it again next year. For now
  // YAGNI applies: one summer, one override slot.
  summerHours2026: null,

  // ─── Analytics ─────────────────────────────────────────────────────────
  // Manually-entered active student count for the Analytics dashboard.
  // Owners update this from Admin → Analytics. A future phase can replace
  // the manual value with an automated Radius enrollment import.
  activeStudentCount: 0,
  studentCountUpdatedAt: null,

  // ─── Operating days ────────────────────────────────────────────────────
  // The weekdays this center is actually open. Drives which columns show on
  // the admin weekly grid, which days are clickable on the Schedule
  // calendar, and which days the auto-scheduler fills. Editable from
  // Super Admin → Operating Days. Every center is closed at least one day.
  operatingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],

  // ─── Holidays ──────────────────────────────────────────────────────────
  // One-off closures (statutory holidays, centre-specific closures, etc.).
  // Each entry is { date: 'YYYY-MM-DD', name: 'Christmas Day' }. Editable
  // from Super Admin → Holidays. Holiday dates are dropped from the admin
  // weekly grid, greyed out on the Schedule calendar, and skipped by the
  // auto-scheduler — same treatment as a closed weekday.
  holidays: [],

  // ─── Auto-scheduler defaults ───────────────────────────────────────────
  defaultMinPerDay: 8,
  defaultMaxPerDay: 11,
  defaultMaxDaysPerWeek: 5,

  // ─── Staff lists ───────────────────────────────────────────────────────
  // Full names excluded from hourly payroll summaries (salaried staff).
  salaryStaff: [],
  // Fixed staff with hardcoded weekly schedules — keyed by display name.
  // {
  //   'Staff Name': {
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
  // Per-center STATE / FLEX colors (hex) — the non-assignment fills used on
  // the admin grid, coverage grid and staffing views: STEAM, Summer Camp,
  // Volunteer, Sick Pay, No-Show. Editable from the same Appearance panel.
  // Anything not listed falls back to DEFAULT_STATE_COLORS.
  stateColors: {},
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
  'Highschool Instructor': '#06b6d4', // cyan
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

// ─── State / flex colors ─────────────────────────────────────────────────
// These are NOT assignments — they're the override fills a shift can take:
// flex roles (STEAM / Summer Camp) and shift states (Volunteer, Sick Pay,
// No-Show). They win over the assignment color on the admin grid, coverage
// grid and staffing views, and are edited from the same Appearance panel so
// an owner can control every colour in one place.
//
// STEAM defaults to a darker yellow than Manager (#ca8a04) so the two are
// distinguishable out of the box; owners can still repaint either.
export const DEFAULT_STATE_COLORS = {
  'STEAM':       '#a16207', // yellow-700 — dark yellow, distinct from Manager gold
  'Summer Camp': '#f97316', // orange-500
  'Volunteer':   '#0284c7', // sky-600
  'Training':    '#9333ea', // purple-600 — paid, present, not counted
  'Sick Pay':    '#7f1d1d', // red-900 — deep burgundy
  'No-Show':     '#374151', // gray-700 — slate
};

export const STATE_COLOR_KEYS = Object.keys(DEFAULT_STATE_COLORS);

/**
 * Resolve a state/flex color: center override first, then the built-in
 * default, then a neutral slate for anything unrecognized.
 */
export function stateColorHex(name, centerConfig) {
  const custom = centerConfig?.stateColors?.[name];
  if (custom) return custom;
  return DEFAULT_STATE_COLORS[name] || '#64748b';
}

// Compact labels for the admin weekly grid, where column space is tight.
// The full assignment name still shows on hover.
export const ASSIGNMENT_SHORT = {
  'Elementary Instructor': 'Elem',
  'Highschool Instructor': 'HS',
  'Online Instructor':     'Online',
  'Lead Instructor':       'Lead',
  'Host':                  'Host',
  'Admin':                 'Admin',
  'Manager':               'Mgr',
  'Centre Director':       'Ctr Dir',
  'Director of Education': 'Dir. of Ed',
};

/** Short label for an assignment; falls back to the full name if unknown. */
export function assignmentShort(assignment) {
  return ASSIGNMENT_SHORT[assignment] || assignment;
}

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
  // Guaranteed-shift list removed. Auto-scheduler now ranks purely on
  // priority + sub-role + fairness — no name-based override. If you
  // want someone scheduled first, set their priority to 1 in Manage
  // Staff (per-user, transferable across centres).
  // Salaried staff — excluded from hourly payroll summaries. Sabrina
  // is hourly (NOT in this list); Vinod is the new Center Director,
  // promoted from hourly to salary.
  salaryStaff:     ['Vinod Bandla', 'Neeru Gill'],
  fixedStaff: {
    'Vinod Bandla': {
      // Promoted from instructor → Center Director. Salary, doesn't
      // count toward in-centre staffing ratio (same as Neeru's CD pattern).
      // Schedule mirrors Neeru's structure but inverted Mon/Fri — Vinod
      // opens Friday (10:30 start), Neeru opens Monday (her existing 11:00).
      role: 'Center Director',
      countsTowardRatio: false,
      Monday:    'Off',
      Tuesday:   '11:00 AM - 7:30 PM',
      Wednesday: '11:00 AM - 7:30 PM',
      Thursday:  '11:00 AM - 7:30 PM',
      Friday:    '10:30 AM - 7:00 PM',
      Saturday:  '9:00 AM - 3:00 PM',
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
      // Manager counts toward the in-centre staffing ratio — she's on
      // the floor running sessions, not off-floor admin. Per-role
      // inference in getFixedStaffForDay defaults Manager → true; the
      // explicit value here is just to be unambiguous for future eyes.
      countsTowardRatio: true,
      Monday:    '11:00 AM - 7:00 PM',
      Tuesday:   '11:00 AM - 7:00 PM',
      Wednesday: '11:00 AM - 7:00 PM',
      Thursday:  '11:00 AM - 7:00 PM',
      Friday:    '11:00 AM - 7:00 PM',
      Saturday:  'Off',
    },
    // Rachel Rozelle removed — was pinned here with every day 'Off',
    // which had the unintended effect of filtering her out of the
    // form-instructor pool (anyone named in fixedStaff is excluded at
    // the top of generateSchedule). She submits availability like
    // everyone else, so the scheduler should treat her as a normal
    // instructor.
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
    salaryStaff: Array.isArray(serverConfig.salaryStaff)
      ? serverConfig.salaryStaff
      : DEFAULT_CENTER_CONFIG.salaryStaff,
    // Keep operatingDays only if it's a non-empty array; otherwise fall back
    // to the default so a center can never end up "open zero days".
    operatingDays: (Array.isArray(serverConfig.operatingDays) && serverConfig.operatingDays.length > 0)
      ? serverConfig.operatingDays
      : DEFAULT_CENTER_CONFIG.operatingDays,
    // Holidays default to an empty list — anyone can leave the field unset.
    holidays: Array.isArray(serverConfig.holidays)
      ? serverConfig.holidays
      : DEFAULT_CENTER_CONFIG.holidays,
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

/**
 * Convert a Date or 'YYYY-MM-DD' string to the canonical date-string key
 * used for holiday matching. Returns '' for unknowns.
 */
function dateKey(date) {
  if (!date) return '';
  if (date instanceof Date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(date);
}

/**
 * If `date` is one of the center's configured holidays, returns the
 * matching entry ({ date, name }); otherwise null. `date` may be a Date
 * or a 'YYYY-MM-DD' string.
 */
export function holidayFor(date, centerConfig) {
  const list = Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [];
  if (list.length === 0) return null;
  const ds = dateKey(date);
  if (!ds) return null;
  return list.find(h => h?.date === ds) || null;
}

/**
 * Single check: is the center closed on this date (either a non-operating
 * weekday or a configured holiday)? Returns true when closed.
 */
export function isCenterClosedOn(date, centerConfig) {
  if (!isOperatingDay(date, centerConfig)) return true;
  return !!holidayFor(date, centerConfig);
}

/**
 * Human-readable closure reason for a date (e.g. "Sunday", "Christmas Day"),
 * or null when the center is open. Useful for grey-out labels.
 */
export function closureReason(date, centerConfig) {
  if (!isOperatingDay(date, centerConfig)) {
    if (date instanceof Date)         return ALL_WEEKDAYS[date.getDay()];
    if (typeof date === 'number')     return ALL_WEEKDAYS[date];
    return 'Closed';
  }
  const h = holidayFor(date, centerConfig);
  return h ? (h.name || 'Holiday') : null;
}

// ── Date-aware instructional hours ─────────────────────────────────────
//
// The single source of truth for "what are the teaching windows on date X?"
// Returns a full weekly map (Monday … Saturday → {start, end}) with any
// active override merged on top. Always returns an object — never null —
// so callers can do `resolveInstructionalHours(cfg, date)[dayName]` safely.
//
// Used in place of `centerConfig.instructionalHours[dayName]` everywhere
// the answer depends on the date. Cheap to call — pure function, no I/O.

export function toYmd(date) {
  if (!date) return '';
  if (typeof date === 'string') {
    // Already a YYYY-MM-DD prefix? Return as-is.
    return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : '';
  }
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function resolveInstructionalHours(centerConfig, date) {
  const base = centerConfig?.instructionalHours
            || DEFAULT_CENTER_CONFIG.instructionalHours;
  const override = centerConfig?.summerHours2026;
  if (!override || !override.from || !override.to || !override.byDay) {
    return base;
  }
  const ymd = toYmd(date);
  if (!ymd) return base;
  if (ymd < override.from || ymd > override.to) return base;
  // Apply per-day overrides on top of the weekly default. Days not in
  // byDay fall through unchanged.
  return { ...base, ...override.byDay };
}

// True if the date sits inside a currently-active summer override
// window. Lets the UI render a "summer hours active" badge in Settings.
export function isSummerOverrideActive(centerConfig, date) {
  const o = centerConfig?.summerHours2026;
  if (!o || !o.from || !o.to) return false;
  const ymd = toYmd(date);
  return !!ymd && ymd >= o.from && ymd <= o.to;
}
