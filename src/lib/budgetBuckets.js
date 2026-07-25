// Staffing-budget WORK-TYPE buckets.
//
// The budget is NOT by role — it's by what the WORK was, and one person can
// span several buckets in the same shift. The key insight (from the owner):
// admin hours are simply time we're NOT open for instruction. So a floor
// shift is split by the clock:
//   - the part INSIDE the centre's instructional window → Instructional
//   - the part OUTSIDE it (setup / prep / cleanup / office) → Admin Hours
//
// A person like Sabrina (Manager who teaches) or Dev / Bri (lead instructors
// with office time) therefore land in BOTH pools automatically, with no
// manual tagging — their early/late minutes are Admin Hours, their in-window
// minutes are Instructional.
//
// The other buckets are whole-shift work types, independent of the clock:
//   Online, STEAM, Summer Camp, Host, and Administrative Assistant (the
//   dedicated Admin role, e.g. Rachel).

export const BUDGET_BUCKETS = [
  { key: 'instructional',  label: 'Instructional',            color: '#059669' },
  { key: 'online',         label: 'Online',                   color: '#4338ca' },
  { key: 'steam',          label: 'STEAM',                    color: '#ca8a04' },
  { key: 'summerCamp',     label: 'Summer Camp',              color: '#f97316' },
  { key: 'adminHours',     label: 'Admin Hours',              color: '#dc2626' },
  { key: 'adminAssistant', label: 'Administrative Assistant', color: '#0891b2' },
  { key: 'host',           label: 'Host',                     color: '#2563eb' },
];

export const BUCKET_KEYS = BUDGET_BUCKETS.map(b => b.key);

// ── What one operating day is worth, by category ────────────────────────
// The centre's day model. Two consumers:
//   • Staffing Budget — prices the 15th/16th day of a pay period, the days
//     the 14-day cycle of targets doesn't pay for.
//   • Manage Schedule — the denominator of each day header's hours ratio.
// Keep them reading this one object so the two pages can't drift apart.
//
// EVERY figure here is ONE DAY, not a fortnight. Worth stating plainly:
// the Instructional column was once supplied on a two-week basis for
// Mon–Thu, so if these ever need re-tuning, check the basis first.
//   Mon/Wed 52h · Tue/Thu 43h · Fri 39.5h · Sat 39.5h  →  538h per 14 days
export const WEEKDAY_DEFAULTS = {
  Monday:    { instructional: 31,   online: 4, steam: 4, host: 4, adminAssistant: 4, adminHours: 5 },
  Tuesday:   { instructional: 22,   online: 4, steam: 4, host: 4, adminAssistant: 4, adminHours: 5 },
  Wednesday: { instructional: 31,   online: 4, steam: 4, host: 4, adminAssistant: 4, adminHours: 5 },
  Thursday:  { instructional: 22,   online: 4, steam: 4, host: 4, adminAssistant: 4, adminHours: 5 },
  Friday:    { instructional: 21.5, online: 3, steam: 3, host: 3, adminAssistant: 4, adminHours: 5 },
  Saturday:  { instructional: 30,              steam: 4, host: 4,                    adminHours: 1.5 },
  Sunday:    {}, // closed
};

// Total budgeted hours for a weekday name ('Monday'). 0 for closed days.
export function weekdayBudgetTotal(weekday) {
  const day = WEEKDAY_DEFAULTS[weekday];
  if (!day) return 0;
  return BUCKET_KEYS.reduce((n, k) => n + (Number(day[k]) || 0), 0);
}

function toMin(t) {
  if (!t || typeof t !== 'string') return null;
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Work whose bucket is fixed regardless of clock time. Returns a bucket key,
// or null when the shift should be time-split (in-centre floor staff).
export function wholeShiftBucket(s) {
  if (s.flexRole === 'STEAM') return 'steam';
  if (s.flexRole === 'Summer Camp') return 'summerCamp';
  const role = s.role || 'Instructor';
  const sub = (s.subRole || '').toLowerCase();
  if (role === 'Online Instructor' || sub === 'online' || s.shiftType === 'Online') return 'online';
  if (role === 'Host') return 'host';
  if (role === 'Admin') return 'adminAssistant';
  // Instructor / Lead / Manager / (hourly) Directors → split by the clock.
  return null;
}

/**
 * How a shift's PAID hours break down across budget buckets.
 *
 * @param {Object} s          the shift ({ startTime, endTime, role, flexRole, ... })
 * @param {number} paidHrs    the paid hours (already computed; honours override / no-show)
 * @param {Object|null} instrWindow  { start:'HH:MM', end:'HH:MM' } for the shift's day, or null (closed)
 * @returns {Object} { bucketKey: hours }
 */
export function bucketHoursForShift(s, paidHrs, instrWindow) {
  if (!(paidHrs > 0)) return {};

  const whole = wholeShiftBucket(s);
  if (whole) return { [whole]: paidHrs };

  // Floor staff — split by the instructional window.
  const start = toMin(s.startTime);
  const end = toMin(s.endTime);
  if (start == null || end == null || end <= start) {
    // No usable clock times → treat it all as instructional (safe default).
    return { instructional: paidHrs };
  }
  const schedMin = end - start;
  let instrMin = 0;
  if (instrWindow) {
    const iS = toMin(instrWindow.start);
    const iE = toMin(instrWindow.end);
    if (iS != null && iE != null) instrMin = Math.max(0, Math.min(end, iE) - Math.max(start, iS));
  }
  const adminMin = Math.max(0, schedMin - instrMin);

  // Scale the minute split onto the actual paid hours so the buckets always
  // sum back to paidHrs (covers pay overrides / partial pay).
  const factor = paidHrs / (schedMin / 60);
  const out = {};
  const instrH = (instrMin / 60) * factor;
  const adminH = (adminMin / 60) * factor;
  if (instrH > 0.0001) out.instructional = instrH;
  if (adminH > 0.0001) out.adminHours = adminH;
  return out;
}
