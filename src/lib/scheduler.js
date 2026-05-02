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
 * - Jasper, Neeru: fixed, not counted.
 * - Sabrina, Vinod: fixed, not counted.
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

// Instructors who are guaranteed a shift if they submit availability
const GUARANTEED_NAMES = new Set(['Luke', 'Ainsley', 'Kaitlyn']);

// Fixed staff — not scheduled by engine, seeded separately
export const FIXED_SCHEDULES = {
  'Jasper Wu': {
    role: 'Center Director',
    Monday: '11:00 AM - 7:00 PM', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: '11:00 AM - 7:00 PM', Thursday: '11:00 AM - 7:00 PM',
    Friday: '11:00 AM - 7:00 PM', Saturday: 'Off',
  },
  'Neeru Gill': {
    role: 'Dir. of Education',
    Monday: '11:00 AM - 7:30 PM', Tuesday: '11:00 AM - 7:30 PM',
    Wednesday: '11:00 AM - 7:30 PM', Thursday: '11:00 AM - 7:30 PM',
    Friday: 'Off', Saturday: '9:00 AM - 3:00 PM',
  },
  'Sabrina Kedzior': {
    role: 'Manager',
    Monday: '11:00 AM - 7:00 PM', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: '11:00 AM - 7:00 PM', Thursday: '11:00 AM - 7:00 PM',
    Friday: '11:00 AM - 7:00 PM', Saturday: 'Off',
  },
  'Vinod Bandla': {
    role: 'Manager',
    Monday: '11:00 AM - 7:00 PM', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: '11:00 AM - 7:00 PM', Thursday: '11:00 AM - 7:00 PM',
    Friday: '11:00 AM - 7:00 PM', Saturday: 'Off',
  },
  'Dev Prasad': {
    role: 'Lead',
    countsTowardRatio: true,
    Monday: '2:00 PM - 7:00 PM', Tuesday: 'Off',
    Wednesday: '3:00 PM - 7:00 PM', Thursday: 'Off',
    Friday: '2:00 PM - 7:00 PM', Saturday: '9:30 AM - 3:00 PM',
  },
  'Bri MacDonald': {
    role: 'Lead',
    countsTowardRatio: true,
    Monday: 'Off', Tuesday: '11:00 AM - 7:00 PM',
    Wednesday: 'Off', Thursday: 'Off',
    Friday: '2:00 PM - 7:00 PM', Saturday: '9:30 AM - 3:00 PM',
    saturday_weeks: [1, 3, 5],
  },
  'Rahul Parmar': {
    role: 'Host',
    countsTowardRatio: false,
    Monday: 'Off', Tuesday: 'Off', Wednesday: 'Off',
    Thursday: 'Off', Friday: 'Off', Saturday: 'Off',
  },
  'Rachel Rozelle': {
    role: 'Admin',
    countsTowardRatio: false,
    Monday: 'Off', Tuesday: 'Off', Wednesday: 'Off',
    Thursday: 'Off', Friday: 'Off', Saturday: 'Off',
  },
};

export const ROLE_ASSIGNMENTS = {};
export const STAFFING_COUNT_ROLES = new Set(['Instructor', 'Lead']);

// ─── Date helpers ─────────────────────────────────────────────────────────────

function getWeekOfMonth(date) {
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
  const days = [];
  const date = new Date(year, monthNumber - 1, 1);
  while (date.getMonth() === monthNumber - 1) {
    const dayOfWeek = date.getDay();
    const pythonWeekday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Mon=0..Sat=5
    days.push({
      date: new Date(date),
      dateStr: date.toISOString().split('T')[0],
      dayNumber: date.getDate(),
      dayName: DAY_NAMES[pythonWeekday] ?? null,
      pythonWeekday,
      weekOfMonth: getWeekOfMonth(date),
      weekKey: getSunSatWeekKey(date),
    });
    date.setDate(date.getDate() + 1);
  }
  // Filter Mon–Sat only (pythonWeekday 0–5)
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

  // 1. Exact date match — highest priority
  const exact = userRecords.find(a => a.date === dateStr);
  if (exact) {
    return { available: true, startTime: exact.startTime, endTime: exact.endTime };
  }

  // 2. No exact match — look in previous months for same day name
  for (const monthRecords of previousMonthsAvail) {
    const userPrev = monthRecords.filter(a => a.userId === userId);
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

  return { available: false };
}

// ─── Fixed staff helpers ──────────────────────────────────────────────────────

function parseAMPMtoHHMM(timeStr) {
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

function getFixedStaffForDay(dayName, weekOfMonth) {
  const result = [];
  for (const [name, sched] of Object.entries(FIXED_SCHEDULES)) {
    const shift = sched[dayName];
    if (!shift || shift.toLowerCase() === 'off') continue;
    if (dayName === 'Saturday' && sched.saturday_weeks) {
      if (!sched.saturday_weeks.includes(weekOfMonth)) continue;
    }
    const parts = shift.split(' - ');
    result.push({
      name,
      role: sched.role,
      shift,
      startTime: parts.length === 2 ? parseAMPMtoHHMM(parts[0]) : null,
      endTime: parts.length === 2 ? parseAMPMtoHHMM(parts[1]) : null,
      countsTowardRatio: sched.countsTowardRatio ?? false,
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
function getSubRoleScore(instructor) {
  const subs = instructor.subRoles || [];
  const hasHS = subs.includes('Highschool');
  const hasEL = subs.includes('Elementary');
  const hasON = subs.includes('Online');
  if (hasHS) return 0; // Can float — most preferred
  if (hasEL) return 1; // Elementary only
  if (hasON) return 2; // Online only
  return 1; // Default to elementary treatment if no sub-role set
}

function isOnlineOnly(instructor) {
  const subs = instructor.subRoles || [];
  return subs.includes('Online') && !subs.includes('Highschool') && !subs.includes('Elementary');
}

function isGuaranteed(instructor) {
  const firstName = (instructor.displayName || '').split(' ')[0];
  return GUARANTEED_NAMES.has(firstName);
}

// ─── Main scheduling engine ───────────────────────────────────────────────────

/**
 * generateSchedule
 *
 * @param {Object} params
 * @param {Array}  params.instructors          - Approved non-owner users from Firestore
 * @param {Array}  params.availability         - Current month availability docs
 * @param {Array}  params.previousMonthsAvail  - Array of arrays, each being one prior month's availability docs
 * @param {string} params.month                - e.g. 'May'
 * @param {number} params.year                 - e.g. 2026
 * @param {Object} params.config               - { minPerDay, maxPerDay, maxDaysPerWeek }
 */
export function generateSchedule({
  instructors,
  availability,
  previousMonthsAvail = [],
  month,
  year,
  config = {},
}) {
  const {
    minPerDay = 8,
    maxPerDay = 11,
    maxDaysPerWeek = 5,
  } = config;

  const monthNumber = MONTH_NAME_TO_NUMBER[month.toLowerCase()];
  if (!monthNumber) throw new Error(`Invalid month: ${month}`);

  const workingDays = getDaysInMonth(year, monthNumber);
  const fixedStaffNames = new Set(Object.keys(FIXED_SCHEDULES));

  // Eligible form instructors: approved, not owner, not fixed staff
  const formInstructors = instructors.filter(
    u => u.approved && u.role !== 'owner' && !fixedStaffNames.has(u.displayName)
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

  for (const day of workingDays) {
    const { dateStr, dayName, dayNumber, weekOfMonth, weekKey } = day;

    // ── 1. Fixed staff for this day ──────────────────────────────────────────
    const fixedToday = getFixedStaffForDay(dayName, weekOfMonth);
    const assignedNames = [];
    const shiftTimes = {};
    const roles = {};

    let fixedRatioCount = 0;
    for (const f of fixedToday) {
      assignedNames.push(f.name);
      shiftTimes[f.name] = f.shift;
      roles[f.name] = f.role;
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
      });
    }

    // ── 3. Split into online-only vs in-centre ───────────────────────────────
    const onlineOnly = availableInstructors.filter(a => isOnlineOnly(a.inst));
    const inCentre   = availableInstructors.filter(a => !isOnlineOnly(a.inst));

    // ── 4. Sort in-centre instructors by scheduling priority ─────────────────
    // Order: guaranteed (Luke/Ainsley/Kaitlyn) → priority 1→2→3 → sub-role (HS first) → fairness (fewest shifts)
    inCentre.sort((a, b) => {
      // Guaranteed instructors always first
      const ga = isGuaranteed(a.inst) ? 0 : 1;
      const gb = isGuaranteed(b.inst) ? 0 : 1;
      if (ga !== gb) return ga - gb;

      // Then by priority
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

      // Soft balance: don't let elementary outnumber highschool by more than 2
      // unless we have no choice (guaranteed instructors bypass this)
      if (isEL && !isGuaranteed(candidate.inst)) {
        if (elCount - hsCount >= 2) continue; // Skip for now, may add later
      }

      assignedNames.push(candidate.inst.displayName);
      roles[candidate.inst.displayName] = candidate.inst.instructorType || 'Instructor';
      if (candidate.shiftStr) shiftTimes[candidate.inst.displayName] = candidate.shiftStr;

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
        if (candidate.shiftStr) shiftTimes[candidate.inst.displayName] = candidate.shiftStr;

        totalAssignments[candidate.inst.uid] = (totalAssignments[candidate.inst.uid] || 0) + 1;
        if (!weeklyAssignments[candidate.inst.uid]) weeklyAssignments[candidate.inst.uid] = {};
        weeklyAssignments[candidate.inst.uid][weekKey] = (weeklyAssignments[candidate.inst.uid][weekKey] || 0) + 1;

        assigned++;
      }
    }

    // ── 6. Assign online-only instructors (don't count toward ratio) ─────────
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
      if (candidate.shiftStr) shiftTimes[candidate.inst.displayName] = candidate.shiftStr;

      totalAssignments[candidate.inst.uid] = (totalAssignments[candidate.inst.uid] || 0) + 1;
      if (!weeklyAssignments[candidate.inst.uid]) weeklyAssignments[candidate.inst.uid] = {};
      weeklyAssignments[candidate.inst.uid][weekKey] = (weeklyAssignments[candidate.inst.uid][weekKey] || 0) + 1;
    }

    // ── 7. Warnings & open shift detection ───────────────────────────────────
    const inCentreTotal = fixedRatioCount + assigned;

    if (inCentreTotal < minPerDay) {
      const shortfall = minPerDay - inCentreTotal;
      warnings.push(
        `⚠ ${dayName} ${month} ${dayNumber}: Only ${inCentreTotal} in-centre staff (need ${minPerDay}). ${shortfall} open shift${shortfall > 1 ? 's' : ''} needed.`
      );
      for (let i = 0; i < shortfall; i++) {
        openShiftNeeded.push({ date: dateStr, dayName, dayNumber });
      }
    }

    if (inCentre.length === 0 && onlineOnly.length === 0 && fixedToday.length === 0) {
      warnings.push(`⚠ ${dayName} ${month} ${dayNumber}: No staff available at all.`);
    }

    scheduleDays.push({
      date: dateStr,
      dayOfWeek: dayName,
      dayNumber,
      assignedEmployees: assignedNames,
      availableEmployees: availableInstructors.map(a => a.inst.displayName),
      shiftTimes,
      roles,
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

  return {
    month,
    year,
    days: scheduleDays,
    employeeSummary,
    warnings,
    openShiftNeeded,
    status: 'draft',
  };
}
