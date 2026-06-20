/**
 * scheduler.js — Mathnasium Langley Auto-Scheduler v2
 *
 * Rules:
 * - Purely availability-driven. No availability = no shift (their responsibility).
 * - If no availability this month, look back month by month until found.
 * - Priority 1 > 2 > 3. Lower number = higher priority = more likely to get shift.
 * - Luke, Ainsley, Kaitlyn: guaranteed shift if available (treated as priority 0).
 * - Sub-roles: Elementary, Highschool, Online.
 *   - Online instructors are NOT counted in the in-centre min/max ratio.
 *   - Prefer Highschool-capable instructors (can float) but respect priority.
 *   - Balance elementary vs highschool count across the day.
 * - Min/max counts only Leads + Instructors (in-centre).
 * - Dev Prasad and Bri MacDonald (Leads) DO count toward min/max.
 * - Neeru: fixed, not counted.
 * - Sabrina: fixed, not counted. Vinod: manual scheduling (variable hours).
 * - Max shifts per week = Sun–Sat calendar week.
 * - If not enough staff to hit min, leave slots open (admin posts open shifts).
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTH_NAME_TO_NUMBER = {
  january: 1, february: 2, march: 3, april: 4,
  may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

export const ROLE_DISPLAY_ORDER = {
  'Center Director': 0, 'Dir. of Education': 1, 'Manager': 2,
  'Lead': 3, 'Host': 4, 'Admin': 5, 'Instructor': 6,
};

export const ROLE_ASSIGNMENTS = {};
export const STAFFING_COUNT_ROLES = new Set(['Instructor', 'Lead']);

// LEGACY default hours / fixed staff — kept for back-compat with code that
// imports `FIXED_SCHEDULES` directly (Admin.jsx still references it for the
// "Sync Fixed Staff This Week" / "Fix Duplicates" buttons). New code should
// pull these from the per-center config instead.
//
// When a center config doc exists, the scheduler uses that. When it doesn't
// (pre-migration), it falls back to these.
export const FIXED_SCHEDULES = {
  'Vinod Bandla': {
    // Promoted to Center Director — salary, doesn't count toward
    // in-centre staffing ratio. Mirrors Neeru's pattern but Mon/Fri
    // are swapped (Vinod opens Friday at 10:30, Neeru opens Monday).
    role: 'Center Director',
    countsTowardRatio: false,
    Monday: 'Off',
    Tuesday: '11:00 AM - 7:30 PM',
    Wednesday: '11:00 AM - 7:30 PM',
    Thursday: '11:00 AM - 7:30 PM',
    Friday: '10:30 AM - 7:00 PM',
    Saturday: '9:00 AM - 3:00 PM',
  },
  'Neeru Gill': {
    role: 'Dir. of Education',
    countsTowardRatio: false,
    Monday: '11:00 AM - 7:30 PM', Tuesday: '11:00 AM - 7:30 PM',
    Wednesday: '11:00 AM - 7:30 PM', Thursday: '11:00 AM - 7:30 PM',
    Friday: 'Off', Saturday: '9:00 AM - 3:00 PM',
  },
  'Sabrina Kedzior': {
    role: 'Manager',
    // Manager counts toward in-centre staffing ratio — she's on the
    // floor every day running sessions, not off-floor admin.
    countsTowardRatio: true,
    Monday: '11:00 AM - 7:00 PM', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: '11:00 AM - 7:00 PM', Thursday: '11:00 AM - 7:00 PM',
    Friday: '11:00 AM - 7:00 PM', Saturday: 'Off',
  },
  'Rachel Rozelle': {
    role: 'Admin',
    countsTowardRatio: false,
    Monday: 'Off', Tuesday: 'Off', Wednesday: 'Off',
    Thursday: 'Off', Friday: 'Off', Saturday: 'Off',
  },
};

const DEFAULT_INSTRUCTIONAL_HOURS = {
  Monday:    { start: '15:00', end: '19:00' },
  Tuesday:   { start: '15:00', end: '19:00' },
  Wednesday: { start: '15:00', end: '19:00' },
  Thursday:  { start: '15:00', end: '19:00' },
  Friday:    { start: '15:00', end: '18:00' },
  Saturday:  { start: '10:00', end: '14:00' },
};

// (Removed) DEFAULT_GUARANTEED_NAMES — guaranteed-shift feature was
// removed in favour of pure priority-based scheduling. The
// auto-scheduler now ranks instructors by priority + sub-role + fairness
// only; no name-based pin. Owners use Manage Staff → priority to
// promote/demote individuals instead.

/**
 * Intersect a user's availability window with the day's instructional
 * window. Returns { start, end } in HH:MM, or null if there is no overlap.
 *
 * The instructional-hours map is now per-center (passed in from the
 * caller via centerConfig); we accept it as a param so this helper stays
 * pure.
 */
export function clampToInstructionalHours(startTime, endTime, dayName, instructionalHours) {
  const map = instructionalHours || DEFAULT_INSTRUCTIONAL_HOURS;
  const w = map[dayName];
  if (!w || !startTime || !endTime) return null;
  const s = startTime > w.start ? startTime : w.start;
  const e = endTime   < w.end   ? endTime   : w.end;
  if (s >= e) return null;
  return { start: s, end: e };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function getWeekOfMonth(date) {
  return Math.floor((date.getDate() - 1) / 7) + 1;
}

function getSunSatWeekKey(date) {
  // Returns a string key for the Sun–Sat week containing this date
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - day);
  return sunday.toISOString().split('T')[0];
}

function getDaysInMonth(year, monthNumber) {
  const date = new Date(year, monthNumber - 1, 1);
  const endDate = new Date(year, monthNumber, 0); // last day of month
  return getDaysInRange(date, endDate);
}

/**
 * Build the day descriptor list for any start..end date range (inclusive).
 * Mirrors getDaysInMonth's shape so the rest of the engine doesn't care
 * whether the caller asked for a month, a week, a single day, or anything
 * in between. Filters Mon–Sat by default; the operatingDays clause inside
 * generateSchedule narrows further per centre.
 *
 * `startDate` and `endDate` may be Date objects or 'YYYY-MM-DD' strings.
 */
function getDaysInRange(startDate, endDate) {
  const toDate = (v) => v instanceof Date
    ? new Date(v.getFullYear(), v.getMonth(), v.getDate())
    : new Date(`${v}T00:00:00`);
  const cursor = toDate(startDate);
  const end    = toDate(endDate);
  const days = [];
  while (cursor <= end) {
    const dayOfWeek = cursor.getDay();
    const pythonWeekday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Mon=0..Sat=5
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    days.push({
      date: new Date(cursor),
      dateStr: `${y}-${m}-${d}`,
      dayNumber: cursor.getDate(),
      dayName: DAY_NAMES[pythonWeekday] ?? null,
      pythonWeekday,
      weekOfMonth: getWeekOfMonth(cursor),
      weekKey: getSunSatWeekKey(cursor),
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days.filter(d => d.pythonWeekday >= 0 && d.pythonWeekday <= 5);
}

// ─── Availability resolver ────────────────────────────────────────────────────

/**
 * Find availability for a user on a specific date.
 * Looks for an exact date match in availabilityRecords.
 * If none found, checks previousMonthsAvailability for the same dayName.
 */
function resolveAvailability(availabilityRecords, previousMonthsAvail, userId, dateStr, dayName) {
  const userRecords = availabilityRecords.filter(a => a.userId === userId);

  // 1. Exact date match in current month — highest priority.
  // `preferredAssignment` lets a normally-centre instructor opt into the
  // online pass for that day (or vice versa). Fallback chains down through
  // previous months do NOT carry a preference forward — those are stale
  // recurring availability, not a fresh-this-week decision.
  const exact = userRecords.find(a => a.date === dateStr);
  if (exact) {
    return {
      available: true,
      startTime: exact.startTime,
      endTime: exact.endTime,
      preferredAssignment: exact.preferredAssignment || 'either',
    };
  }

  // 2. No current month record for this date.
  // Only use previous months as fallback if the instructor has submitted
  // ZERO availability for the current month entirely (not just this date).
  // If they submitted for some days this month but not this one, they are NOT available today.
  const hasAnyCurrentMonth = userRecords.length > 0;
  if (hasAnyCurrentMonth) {
    // They submitted availability this month but not for this specific date — skip them
    return { available: false };
  }

  // 3. No current month availability at all — look back month by month
  for (const monthRecords of previousMonthsAvail) {
    const userPrev = monthRecords.filter(a => a.userId === userId);
    if (userPrev.length === 0) continue;
    // Find a record for this day name
    const dayMatch = userPrev.find(a => {
      if (!a.date) return false;
      const d = new Date(a.date + 'T00:00:00');
      const jsDay = d.getDay();
      const pw = jsDay === 0 ? 6 : jsDay - 1;
      return DAY_NAMES[pw] === dayName;
    });
    if (dayMatch) {
      return { available: true, startTime: dayMatch.startTime, endTime: dayMatch.endTime, fromPreviousMonth: true };
    }
  }

  // 4. Never submitted anything anywhere — not available
  return { available: false };
}

// ─── Fixed staff helpers ──────────────────────────────────────────────────────

export function parseAMPMtoHHMM(timeStr) {
  if (!timeStr || timeStr.toLowerCase() === 'off') return null;
  const m = timeStr.trim().match(/^(\d+):(\d+)\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Build the per-day fixed staff roster from the center's fixedStaff map.
 * Falls back to the legacy FIXED_SCHEDULES export when no map is provided
 * (lets older callers keep working).
 */
// Default whether a fixed-staff role counts toward the in-centre
// instructor ratio when the config doesn't say otherwise. Manager,
// Lead, and Instructor are floor staff who actively run sessions —
// they count. Director and Admin are off-floor support — they don't.
//
// An EXPLICIT `countsTowardRatio: false` on the fixed-staff entry still
// wins (e.g. a Manager who genuinely doesn't teach), so existing config
// docs that opted Sabrina out can still do so deliberately.
const COUNTS_TOWARD_RATIO_BY_ROLE = new Set(['Manager', 'Lead', 'Instructor']);

function getFixedStaffForDay(dayName, weekOfMonth, fixedStaffMap) {
  const map = fixedStaffMap && Object.keys(fixedStaffMap).length > 0
    ? fixedStaffMap
    : FIXED_SCHEDULES;
  const result = [];
  for (const [name, sched] of Object.entries(map)) {
    const shift = sched[dayName];
    if (!shift || shift.toLowerCase() === 'off') continue;
    if (dayName === 'Saturday' && sched.saturday_weeks) {
      if (!sched.saturday_weeks.includes(weekOfMonth)) continue;
    }
    const parts = shift.split(' - ');
    // Explicit setting wins; otherwise infer from the role. Previously
    // the fallback was `false`, which meant Sabrina (Manager) was never
    // counted even though she's on the floor every day.
    const ctr = (typeof sched.countsTowardRatio === 'boolean')
      ? sched.countsTowardRatio
      : COUNTS_TOWARD_RATIO_BY_ROLE.has(sched.role);
    result.push({
      name,
      role: sched.role,
      shift,
      startTime: parts.length === 2 ? parseAMPMtoHHMM(parts[0]) : null,
      endTime: parts.length === 2 ? parseAMPMtoHHMM(parts[1]) : null,
      countsTowardRatio: ctr,
    });
  }
  result.sort((a, b) => (ROLE_DISPLAY_ORDER[a.role] ?? 99) - (ROLE_DISPLAY_ORDER[b.role] ?? 99));
  return result;
}

// ─── Sub-role helpers ─────────────────────────────────────────────────────────

/**
 * Returns instructor's sub-role capability score for sorting:
 * Highschool = 0 (most flexible, preferred)
 * Both Highschool+Elementary = 0 (same as Highschool)
 * Elementary only = 1
 * Online only = 2 (not counted in ratio, handled separately)
 */
export function getSubRoleScore(instructor) {
  const subs = instructor.subRoles || [];
  const hasHS = subs.includes('Highschool');
  const hasEL = subs.includes('Elementary');
  const hasON = subs.includes('Online');
  if (hasHS) return 0; // Can float — most preferred
  if (hasEL) return 1; // Elementary only
  if (hasON) return 2; // Online only
  return 1; // Default to elementary treatment if no sub-role set
}

/**
 * Online is its own platform — it's a separate track from in-centre
 * teaching. Any instructor tagged 'Online' is an online instructor, full
 * stop. They are scheduled in their own pass, never compete for in-centre
 * Elementary/Highschool slots, and don't count toward the in-centre ratio.
 *
 * The Manage Users sub-role picker enforces that 'Online' is mutually
 * exclusive with Elementary/Highschool, so in clean data a user has EITHER
 * ['Online'] OR some combination of ['Elementary','Highschool']. This
 * function stays robust even against legacy data that has both — anyone
 * with 'Online' is treated as online.
 */
export function isOnlineOnly(instructor) {
  return (instructor.subRoles || []).includes('Online');
}

/**
 * Pick the sub-role to tag an auto-scheduled shift with.
 *
 * @param {Object} instructor
 * @param {'centre'|'online'} [track]
 *   Optional EFFECTIVE track for this day's shift (from effectiveTrack()).
 *   When provided, it wins — so a normally-Online instructor who opted
 *   into centre for today gets tagged 'Highschool'/'Elementary' (not
 *   'Online'), and vice versa. When not provided, falls back to the old
 *   profile-only behaviour for backwards compatibility.
 */
export function shiftSubRoleFor(instructor, track) {
  const subs = instructor.subRoles || [];
  if (track === 'online') return 'Online';
  if (track === 'centre') {
    return subs.includes('Highschool') ? 'Highschool' : 'Elementary';
  }
  // Legacy path: no explicit track → derive from profile.
  //   - Online instructors → 'Online' (separate platform)
  //   - Highschool-capable → 'Highschool' (higher-skill in-centre bucket)
  //   - everyone else      → 'Elementary'
  if (subs.includes('Online')) return 'Online';
  if (subs.includes('Highschool')) return 'Highschool';
  return 'Elementary';
}

// (Removed) isGuaranteed — guaranteed-shift feature was removed.
// Kept as a no-op stub for backwards compatibility with any external
// caller still importing the symbol; always returns false now so old
// per-user `guaranteed: true` flags don't accidentally re-enable the
// pinning behaviour. Schedule order is now purely priority + sub-role
// + fairness, set per-user via Manage Staff.
// eslint-disable-next-line no-unused-vars
export function isGuaranteed(_instructor, _guaranteedNames) {
  return false;
}

/**
 * True if this instructor is configured as a Host. Hosts get guaranteed
 * shifts when they submit availability, default to role='Host' (so they
 * don't count toward the in-centre instructor minimum), and on days where
 * the day's instructor count is short of minPerDay they get auto-promoted
 * to role='Instructor' so they fill the gap.
 */
export function isHostRole(instructor) {
  return (instructor.instructorType || '').toLowerCase() === 'host';
}

/**
 * Per-day track resolution. Combines an instructor's permanent subRoles
 * (their CAPABILITY) with an optional per-day preferredAssignment from
 * the availability doc (their PREFERENCE for that specific day).
 *
 * Returns 'online' or 'centre' — the bucket the scheduler should put
 * them in for this day's pass. Rules:
 *   - preferredAssignment in {'centre', 'online'} → honoured outright.
 *     A centre-tagged instructor wanting Online today, or vice versa,
 *     gets routed to the requested pass.
 *   - 'either' or unset → fall back to the profile default:
 *       isOnlineOnly(inst) ? 'online' : 'centre'
 *
 * This is the only place the per-day override interacts with routing —
 * everywhere else in the scheduler keeps using the same isOnlineOnly /
 * isHostRole filters, just driven by the result of this helper.
 */
export function effectiveTrack(instructor, preferredAssignment) {
  if (preferredAssignment === 'online') return 'online';
  if (preferredAssignment === 'centre') return 'centre';
  return isOnlineOnly(instructor) ? 'online' : 'centre';
}

// ─── Main scheduling engine ───────────────────────────────────────────────────

/**
 * generateSchedule
 *
 * Range can be specified in one of two ways:
 *   1. `month` + `year` (legacy) — generates the whole month
 *   2. `startDate` + `endDate` — generates any inclusive date range
 *      ('YYYY-MM-DD' strings or Date objects). Useful for one-day or
 *      one-week fills without disturbing the rest of the schedule.
 *
 * @param {Object} params
 * @param {Array}  params.instructors          - Approved non-owner users from Firestore
 * @param {Array}  params.availability         - Availability docs covering the range
 * @param {Array}  params.previousMonthsAvail  - Optional fallback availability from prior months
 * @param {string} [params.month]              - e.g. 'May' (used when no startDate/endDate)
 * @param {number} [params.year]               - e.g. 2026 (used when no startDate/endDate)
 * @param {string|Date} [params.startDate]     - Inclusive range start
 * @param {string|Date} [params.endDate]       - Inclusive range end
 * @param {Object} params.config               - { minPerDay, maxPerDay, maxDaysPerWeek }
 * @param {Object} params.centerConfig         - per-center settings (instructionalHours, fixedStaff,
 *                                                guaranteedNames). Falls back to legacy hardcoded values
 *                                                when missing or empty.
 */
export function generateSchedule({
  instructors,
  availability,
  previousMonthsAvail = [],
  month,
  year,
  startDate,
  endDate,
  config = {},
  centerConfig = {},
}) {
  const {
    minPerDay = 8,
    maxPerDay = 11,
    maxDaysPerWeek = 5,
  } = config;

  // Center-specific tunables (with defaults that match legacy Langley behavior)
  const instructionalHours = centerConfig.instructionalHours || DEFAULT_INSTRUCTIONAL_HOURS;
  const fixedStaffMap      = (centerConfig.fixedStaff && Object.keys(centerConfig.fixedStaff).length > 0)
                                ? centerConfig.fixedStaff
                                : FIXED_SCHEDULES;
  // Guaranteed-name list removed. Scheduling order is now pure
  // priority + sub-role + fairness — see the sort below.
  // Days this center is open. Defaults to the full Mon–Sat week so any
  // caller that doesn't pass a centerConfig keeps its old behavior.
  const operatingDays      = (Array.isArray(centerConfig.operatingDays) && centerConfig.operatingDays.length > 0)
                                ? centerConfig.operatingDays
                                : DAY_NAMES;
  // Holiday dates ('YYYY-MM-DD') the centre is closed for — skipped entirely
  // by the auto-scheduler so nobody gets booked on Christmas / a stat day.
  const holidayDates = new Set(
    (Array.isArray(centerConfig.holidays) ? centerConfig.holidays : [])
      .map(h => h?.date)
      .filter(Boolean),
  );

  // Two range modes:
  //  - startDate + endDate (preferred for day/week fills)
  //  - month + year (legacy — whole month)
  // If both are passed, the explicit range wins.
  let workingDays;
  let rangeLabel; // Human-friendly label for warnings / summaries
  if (startDate && endDate) {
    workingDays = getDaysInRange(startDate, endDate);
    rangeLabel = '';
  } else {
    if (!month) throw new Error('generateSchedule: pass startDate/endDate or month+year');
    const monthNumber = MONTH_NAME_TO_NUMBER[month.toLowerCase()];
    if (!monthNumber) throw new Error(`Invalid month: ${month}`);
    workingDays = getDaysInMonth(year, monthNumber);
    rangeLabel = `${month} ${year}`;
  }
  const fixedStaffNames = new Set(Object.keys(fixedStaffMap));

  // Eligible form instructors: approved, not owner, not Enterprise, not
  // fixed staff. Enterprise (super_admin) accounts have global platform
  // access but aren't centre staff — if one ever submits availability
  // by accident we still don't want them on the assignment grid.
  // Owners and super-admins never appear on the schedule (they run the
  // centre, they don't take shifts). Admin Assistants DO appear — they're
  // owner-equivalent for permissions but operate as staff for scheduling.
  const formInstructors = instructors.filter(
    u => u.approved
      && u.role !== 'owner'
      && u.role !== 'super_admin'
      && !fixedStaffNames.has(u.displayName)
  );

  // Tracking
  const totalAssignments = {};   // uid -> total shifts assigned
  const weeklyAssignments = {};  // uid -> { weekKey -> count }

  for (const inst of formInstructors) {
    totalAssignments[inst.uid] = 0;
    weeklyAssignments[inst.uid] = {};
  }

  const scheduleDays = [];
  const warnings = [];
  const openShiftNeeded = []; // Days that need open shift postings

  // Use each day's own month name in warnings so a multi-month range
  // (or a stray week that straddles two months) labels correctly.
  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];

  for (const day of workingDays) {
    const { dateStr, dayName, dayNumber, weekOfMonth, weekKey } = day;
    const dayMonth = monthNames[day.date.getMonth()];

    // Skip days this center is closed (configured in Super Admin → Operating
    // Days or → Holidays). getDaysInMonth already drops Sundays; this also
    // drops any other weekday the centre doesn't operate on, plus any
    // specific holiday date.
    if (!operatingDays.includes(dayName)) continue;
    if (holidayDates.has(dateStr)) continue;

    // ── 1. Fixed staff for this day ──────────────────────────────────────────
    const fixedToday = getFixedStaffForDay(dayName, weekOfMonth, fixedStaffMap);
    const assignedNames = [];
    const shiftTimes = {};
    const roles = {};
    const subRoles = {}; // displayName -> 'Elementary' | 'Highschool' | 'Online'

    let fixedRatioCount = 0;
    for (const f of fixedToday) {
      assignedNames.push(f.name);
      shiftTimes[f.name] = f.shift;
      roles[f.name] = f.role;
      // Fixed staff don't run lessons in the same way, but tag a sub-role so
      // their shift docs match the rest of the schema. Default to Elementary.
      subRoles[f.name] = 'Elementary';
      if (f.countsTowardRatio) fixedRatioCount++;
    }

    // ── 2. Resolve availability for all form instructors ────────────────────
    const availableInstructors = [];
    for (const inst of formInstructors) {
      const avail = resolveAvailability(availability, previousMonthsAvail, inst.uid, dateStr, dayName);
      if (!avail.available) continue;

      // Check weekly limit
      const weekCount = (weeklyAssignments[inst.uid] || {})[weekKey] || 0;
      if (weekCount >= maxDaysPerWeek) continue;

      availableInstructors.push({
        inst,
        startTime: avail.startTime,
        endTime: avail.endTime,
        shiftStr: avail.startTime && avail.endTime ? `${avail.startTime} - ${avail.endTime}` : '',
        fromPreviousMonth: avail.fromPreviousMonth || false,
        preferredAssignment: avail.preferredAssignment || 'either',
      });
    }

    // ── 3. Split into online-only / hosts / in-centre instructors ────────────
    // Hosts are scheduled in their own pass below — they don't go through the
    // priority/fairness ranking and they don't compete for Instructor slots.
    //
    // effectiveTrack() honours the per-day preferredAssignment from the
    // availability doc, so an instructor whose profile is Centre-only can
    // opt into the online pass for one specific day (and vice versa).
    // When the preference is 'either' or unset, the profile default wins.
    const onlineOnly = availableInstructors.filter(a => effectiveTrack(a.inst, a.preferredAssignment) === 'online');
    const hosts      = availableInstructors.filter(a => effectiveTrack(a.inst, a.preferredAssignment) === 'centre' && isHostRole(a.inst));
    const inCentre   = availableInstructors.filter(a => effectiveTrack(a.inst, a.preferredAssignment) === 'centre' && !isHostRole(a.inst));

    // ── 4. Sort in-centre instructors by scheduling priority ─────────────────
    // Order: guaranteed (Luke/Ainsley/Kaitlyn) → priority 1→2→3 → sub-role (HS first) → fairness (fewest shifts)
    inCentre.sort((a, b) => {
      // Priority first (1=high, 2=medium, 3=low — set per-user in Manage
      // Staff). The previous "guaranteed names always pinned first"
      // pass is gone; if you want someone to schedule before everyone
      // else, set their priority to 1.
      const pa = a.inst.priority ?? 2;
      const pb = b.inst.priority ?? 2;
      if (pa !== pb) return pa - pb;

      // Then prefer Highschool-capable (sub-role score 0 beats 1)
      const sa = getSubRoleScore(a.inst);
      const sb = getSubRoleScore(b.inst);
      if (sa !== sb) return sa - sb;

      // Finally fairness — fewest total assignments first
      return (totalAssignments[a.inst.uid] || 0) - (totalAssignments[b.inst.uid] || 0);
    });

    // ── 5. Assign in-centre instructors up to maxPerDay ──────────────────────
    const remainingSlots = Math.max(0, maxPerDay - fixedRatioCount);
    let assigned = 0;

    // Track HS/EL balance for this day
    let hsCount = 0;
    let elCount = 0;

    for (const candidate of inCentre) {
      if (assigned >= remainingSlots) break;

      const subScore = getSubRoleScore(candidate.inst);
      const isHS = subScore === 0;
      const isEL = subScore === 1;

      // Soft balance: don't let elementary outnumber highschool by more
      // than 2 unless we have no choice. Priority-1 instructors bypass
      // this throttle so they still get scheduled when imbalance hits.
      if (isEL && (candidate.inst.priority ?? 2) > 1) {
        if (elCount - hsCount >= 2) continue; // Skip for now, may add later
      }

      assignedNames.push(candidate.inst.displayName);
      roles[candidate.inst.displayName] = candidate.inst.instructorType || 'Instructor';
      subRoles[candidate.inst.displayName] = shiftSubRoleFor(candidate.inst, 'centre');
      // Instructors get clamped to instructional hours so a "Full Day"
      // availability doesn't accidentally schedule them 10am–8pm.
      const c = clampToInstructionalHours(candidate.startTime, candidate.endTime, dayName, instructionalHours);
      if (c) shiftTimes[candidate.inst.displayName] = `${c.start} - ${c.end}`;
      else if (candidate.shiftStr) shiftTimes[candidate.inst.displayName] = candidate.shiftStr;

      totalAssignments[candidate.inst.uid] = (totalAssignments[candidate.inst.uid] || 0) + 1;
      if (!weeklyAssignments[candidate.inst.uid]) weeklyAssignments[candidate.inst.uid] = {};
      weeklyAssignments[candidate.inst.uid][weekKey] = (weeklyAssignments[candidate.inst.uid][weekKey] || 0) + 1;

      assigned++;
      if (isHS) hsCount++;
      if (isEL) elCount++;
    }

    // Second pass: fill remaining slots with skipped elementary if still under max
    if (assigned < remainingSlots) {
      for (const candidate of inCentre) {
        if (assigned >= remainingSlots) break;
        if (assignedNames.includes(candidate.inst.displayName)) continue; // already assigned

        assignedNames.push(candidate.inst.displayName);
        roles[candidate.inst.displayName] = candidate.inst.instructorType || 'Instructor';
        subRoles[candidate.inst.displayName] = shiftSubRoleFor(candidate.inst, 'centre');
        const c = clampToInstructionalHours(candidate.startTime, candidate.endTime, dayName, instructionalHours);
        if (c) shiftTimes[candidate.inst.displayName] = `${c.start} - ${c.end}`;
        else if (candidate.shiftStr) shiftTimes[candidate.inst.displayName] = candidate.shiftStr;

        totalAssignments[candidate.inst.uid] = (totalAssignments[candidate.inst.uid] || 0) + 1;
        if (!weeklyAssignments[candidate.inst.uid]) weeklyAssignments[candidate.inst.uid] = {};
        weeklyAssignments[candidate.inst.uid][weekKey] = (weeklyAssignments[candidate.inst.uid][weekKey] || 0) + 1;

        assigned++;
      }
    }

    // ── 6a. Host pass — auto-promote on shortage, otherwise assign as Host ──
    // Hosts always get a shift when available. By default they don't count
    // toward the per-day instructor minimum (their role tags as 'Host').
    // BUT: if the day is short on instructors AND the host can teach
    // Elementary, we promote their role to 'Instructor' for that day so they
    // fill the gap and count toward the staffing ratio.
    let promotedFromHost = 0;
    if (hosts.length > 0) {
      // Sort hosts by priority then fairness, same as online-only
      hosts.sort((a, b) => {
        const pa = a.inst.priority ?? 2;
        const pb = b.inst.priority ?? 2;
        if (pa !== pb) return pa - pb;
        return (totalAssignments[a.inst.uid] || 0) - (totalAssignments[b.inst.uid] || 0);
      });

      const stillNeeded = () => Math.max(0, minPerDay - (fixedRatioCount + assigned + promotedFromHost));

      for (const candidate of hosts) {
        const weekCount = (weeklyAssignments[candidate.inst.uid] || {})[weekKey] || 0;
        if (weekCount >= maxDaysPerWeek) continue;
        if (assignedNames.includes(candidate.inst.displayName)) continue;

        const subs = candidate.inst.subRoles || [];
        const canTeachElementary = subs.includes('Elementary');
        const promote = stillNeeded() > 0 && canTeachElementary;

        assignedNames.push(candidate.inst.displayName);
        if (promote) {
          // Tag this shift as Instructor for the day so it counts toward staffing,
          // and CLAMP the time to instructional hours — they're teaching, not
          // covering admin time on this day.
          roles[candidate.inst.displayName] = 'Instructor';
          subRoles[candidate.inst.displayName] = 'Elementary';
          promotedFromHost++;
          const c = clampToInstructionalHours(candidate.startTime, candidate.endTime, dayName, instructionalHours);
          if (c) shiftTimes[candidate.inst.displayName] = `${c.start} - ${c.end}`;
          else if (candidate.shiftStr) shiftTimes[candidate.inst.displayName] = candidate.shiftStr;
          warnings.push(
            `ℹ ${dayName} ${dayMonth} ${dayNumber}: ${candidate.inst.displayName} (Host) promoted to Instructor to cover staffing shortfall.`
          );
        } else {
          // Regular Host shift — clamped to instructional hours so a
          // "Full Day" availability submission doesn't auto-create a
          // 10-hour shift. Admins add admin/prep time manually after
          // the schedule is generated.
          roles[candidate.inst.displayName] = 'Host';
          subRoles[candidate.inst.displayName] = shiftSubRoleFor(candidate.inst, 'centre');
          const c = clampToInstructionalHours(candidate.startTime, candidate.endTime, dayName, instructionalHours);
          if (c) shiftTimes[candidate.inst.displayName] = `${c.start} - ${c.end}`;
          else if (candidate.shiftStr) shiftTimes[candidate.inst.displayName] = candidate.shiftStr;
        }

        totalAssignments[candidate.inst.uid] = (totalAssignments[candidate.inst.uid] || 0) + 1;
        if (!weeklyAssignments[candidate.inst.uid]) weeklyAssignments[candidate.inst.uid] = {};
        weeklyAssignments[candidate.inst.uid][weekKey] = (weeklyAssignments[candidate.inst.uid][weekKey] || 0) + 1;
      }
    }

    // ── 6b. Assign online-only instructors (don't count toward ratio) ────────
    // Sort by priority + fairness
    onlineOnly.sort((a, b) => {
      const pa = a.inst.priority ?? 2;
      const pb = b.inst.priority ?? 2;
      if (pa !== pb) return pa - pb;
      return (totalAssignments[a.inst.uid] || 0) - (totalAssignments[b.inst.uid] || 0);
    });

    for (const candidate of onlineOnly) {
      const weekCount = (weeklyAssignments[candidate.inst.uid] || {})[weekKey] || 0;
      if (weekCount >= maxDaysPerWeek) continue;

      assignedNames.push(candidate.inst.displayName);
      roles[candidate.inst.displayName] = 'Online Instructor';
      subRoles[candidate.inst.displayName] = 'Online';
      // Clamp Online instructors to instructional hours too — a "Full Day"
      // availability shouldn't become a 24-hour online shift. Admin can
      // extend manually for flex hours after the fact.
      const c = clampToInstructionalHours(candidate.startTime, candidate.endTime, dayName, instructionalHours);
      if (c) shiftTimes[candidate.inst.displayName] = `${c.start} - ${c.end}`;
      else if (candidate.shiftStr) shiftTimes[candidate.inst.displayName] = candidate.shiftStr;

      totalAssignments[candidate.inst.uid] = (totalAssignments[candidate.inst.uid] || 0) + 1;
      if (!weeklyAssignments[candidate.inst.uid]) weeklyAssignments[candidate.inst.uid] = {};
      weeklyAssignments[candidate.inst.uid][weekKey] = (weeklyAssignments[candidate.inst.uid][weekKey] || 0) + 1;
    }

    // ── 7. Warnings & open shift detection ───────────────────────────────────
    // Promoted Hosts count toward the staffing total (because they're tagged
    // as Instructor). Non-promoted Hosts do not.
    const inCentreTotal = fixedRatioCount + assigned + promotedFromHost;

    if (inCentreTotal < minPerDay) {
      const shortfall = minPerDay - inCentreTotal;
      warnings.push(
        `⚠ ${dayName} ${dayMonth} ${dayNumber}: Only ${inCentreTotal} in-centre staff (need ${minPerDay}). ${shortfall} open shift${shortfall > 1 ? 's' : ''} needed.`
      );
      for (let i = 0; i < shortfall; i++) {
        openShiftNeeded.push({ date: dateStr, dayName, dayNumber });
      }
    }

    if (inCentre.length === 0 && hosts.length === 0 && onlineOnly.length === 0 && fixedToday.length === 0) {
      warnings.push(`⚠ ${dayName} ${dayMonth} ${dayNumber}: No staff available at all.`);
    }

    scheduleDays.push({
      date: dateStr,
      dayOfWeek: dayName,
      dayNumber,
      assignedEmployees: assignedNames,
      availableEmployees: availableInstructors.map(a => a.inst.displayName),
      shiftTimes,
      roles,
      subRoles,
      countingStaffCount: inCentreTotal,
      openSlotsNeeded: Math.max(0, minPerDay - inCentreTotal),
    });
  }

  // ── Employee summary ────────────────────────────────────────────────────────
  const employeeSummary = {};
  for (const inst of formInstructors) {
    employeeSummary[inst.displayName] = totalAssignments[inst.uid] || 0;
  }
  for (const name of Object.keys(FIXED_SCHEDULES)) {
    const count = scheduleDays.reduce(
      (sum, d) => sum + (d.assignedEmployees.includes(name) ? 1 : 0), 0
    );
    employeeSummary[name] = count;
  }

  // Derive a friendly summary label for the range (used by callers that
  // were built around month/year). For a true date range, fall back to
  // a "Jun 16 – Jun 22" style label.
  let summaryMonth = month;
  let summaryYear  = year;
  if ((!month || !year) && workingDays.length > 0) {
    const first = workingDays[0].date;
    const last  = workingDays[workingDays.length - 1].date;
    summaryMonth = monthNames[first.getMonth()];
    summaryYear  = first.getFullYear();
    if (first.getMonth() !== last.getMonth() || first.getFullYear() !== last.getFullYear()) {
      summaryMonth = `${monthNames[first.getMonth()].slice(0, 3)} ${first.getDate()} – ${monthNames[last.getMonth()].slice(0, 3)} ${last.getDate()}`;
    }
  }

  return {
    month: summaryMonth,
    year:  summaryYear,
    rangeLabel,
    startDate: workingDays[0]?.dateStr || null,
    endDate:   workingDays[workingDays.length - 1]?.dateStr || null,
    days: scheduleDays,
    employeeSummary,
    warnings,
    openShiftNeeded,
    status: 'draft',
  };
}
