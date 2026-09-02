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

// `retired: true` means the centre no longer budgets for this work — the
// bucket is not offered in the budget editor and is 0 in the day model.
// The key survives because past pay periods have real hours saved against
// it (204h STEAM, 127h Summer Camp across July-August 2026), and dropping
// the key would make those periods read as unexplained under-spend.
export const BUDGET_BUCKETS = [
  { key: 'instructional',  label: 'Instructional',            color: '#059669' },
  { key: 'online',         label: 'Online',                   color: '#4338ca' },
  { key: 'steam',          label: 'STEAM',                    color: '#ca8a04', retired: true },
  { key: 'summerCamp',     label: 'Summer Camp',              color: '#f97316', retired: true },
  { key: 'adminHours',     label: 'Admin Hours',              color: '#dc2626' },
  { key: 'adminAssistant', label: 'Administrative Assistant', color: '#0891b2' },
  { key: 'host',           label: 'Host',                     color: '#2563eb' },
];

export const BUCKET_KEYS = BUDGET_BUCKETS.map(b => b.key);

/** Buckets the budget editor offers. Retired ones are read-only history. */
export const ACTIVE_BUCKETS = BUDGET_BUCKETS.filter(b => !b.retired);
export const ACTIVE_BUCKET_KEYS = ACTIVE_BUCKETS.map(b => b.key);

/** True when a bucket is retired but still carries hours worth showing. */
export function isRetiredBucket(key) {
  return !!BUDGET_BUCKETS.find(b => b.key === key)?.retired;
}

// ── What one operating day is worth, by category ────────────────────────
//
// THE DAY MODEL IS THE SOURCE OF TRUTH FOR THE WHOLE BUDGET.
//
// Everything else is derived from it:
//   • Manage Staff Schedule — each day header's denominator is that
//     weekday's total.
//   • Staffing Board — the same, per day, plus which desks are budgeted.
//   • Staffing Budget — a pay period's target is the SUM of the real days
//     in that period, holidays and the 15th/16th day included. It is not
//     a separately-typed number any more.
//
// That last point is the fix for a real bug: the day model used to be this
// hardcoded constant, while the pay-period targets were editable and saved
// on the centre config. Editing the budget by pay period therefore changed
// the Staffing Budget headline and nothing else, and Manage Staff Schedule
// kept showing a figure nobody could change. The two had drifted to 538h
// vs 688h for the same fortnight.
//
// EVERY figure here is ONE DAY, not a fortnight. Worth stating plainly:
// the Instructional column was once supplied on a two-week basis for
// Mon–Thu, so if these ever need re-tuning, check the basis first.
//
// STEAM and Summer Camp are absent: that work stopped, so the default
// model no longer budgets for it. The BUCKETS still exist for history.
//   Mon/Wed 48h · Tue/Thu 39h · Fri 36.5h · Sat 35.5h  →  492h per 14 days
export const WEEKDAY_DEFAULTS = {
  Monday:    { instructional: 31,   online: 4, host: 4, adminAssistant: 4, adminHours: 5 },
  Tuesday:   { instructional: 22,   online: 4, host: 4, adminAssistant: 4, adminHours: 5 },
  Wednesday: { instructional: 31,   online: 4, host: 4, adminAssistant: 4, adminHours: 5 },
  Thursday:  { instructional: 22,   online: 4, host: 4, adminAssistant: 4, adminHours: 5 },
  Friday:    { instructional: 21.5, online: 3, host: 3, adminAssistant: 4, adminHours: 5 },
  Saturday:  { instructional: 30,             host: 4,                    adminHours: 1.5 },
  Sunday:    {}, // closed
};

export const WEEKDAY_ORDER = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
];

/** Indexed by Date#getDay(). */
export const DOW_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * The centre's day model — its own if it has saved one, otherwise the
 * default above. Stored at `centerConfig.staffingBudget.weekdayModel`.
 *
 * Fallback is PER WEEKDAY, not per bucket: a centre that has only saved
 * Monday still gets the default Tuesday, but a saved Monday is taken
 * exactly as written. That distinction matters — merging bucket by bucket
 * would make it impossible to remove a bucket from a day, because every
 * key the centre deleted would be refilled from the default. Zeroing
 * Saturday's Online line has to mean zero.
 */
export function resolveWeekdayModel(centerConfig) {
  const saved = centerConfig?.staffingBudget?.weekdayModel;
  const out = {};
  for (const wd of WEEKDAY_ORDER) {
    const over = saved && typeof saved[wd] === 'object' && saved[wd] !== null ? saved[wd] : null;
    if (!over) { out[wd] = { ...(WEEKDAY_DEFAULTS[wd] || {}) }; continue; }
    const day = {};
    for (const k of BUCKET_KEYS) {
      const v = Number(over[k]);
      if (Number.isFinite(v) && v > 0) day[k] = v;
    }
    out[wd] = day;
  }
  return out;
}

/**
 * Total budgeted hours for one weekday. 0 for closed days.
 *
 * `model` is the resolved day model. It is optional ONLY so a caller
 * without centre config still gets the default rather than a crash —
 * always pass it when you have it, or the page will show the wrong
 * denominator, which is precisely the bug this replaced.
 */
export function weekdayBudgetTotal(weekday, model) {
  const day = (model || WEEKDAY_DEFAULTS)[weekday];
  if (!day) return 0;
  return BUCKET_KEYS.reduce((n, k) => n + (Number(day[k]) || 0), 0);
}

/** Per-bucket hours for one weekday, as a complete bucket map. */
export function weekdayBudgetBuckets(weekday, model) {
  const day = (model || WEEKDAY_DEFAULTS)[weekday] || {};
  const out = {};
  for (const k of BUCKET_KEYS) out[k] = Number(day[k]) || 0;
  return out;
}

/**
 * What a stretch of dates is budgeted, straight from the day model.
 *
 * This is what makes a pay period's target agree with the day headers on
 * Manage Staff Schedule by construction: it is literally the sum of the
 * same per-day numbers, over the actual dates in the period. A 15- or
 * 16-day period is handled because the days are counted, not assumed, and
 * closures drop out because a holiday contributes nothing.
 *
 * @param {string[]} dates    'YYYY-MM-DD', the days in the period
 * @param {Object}   model    resolved day model
 * @param {Object}   [opts]
 * @param {(d:string)=>boolean} [opts.isClosed]  true when the centre is shut
 * @returns {{ byCat: Object, total: number, openDays: number, closedDays: number }}
 */
export function budgetForDates(dates, model, opts = {}) {
  const isClosed = typeof opts.isClosed === 'function' ? opts.isClosed : () => false;
  const byCat = {};
  for (const k of BUCKET_KEYS) byCat[k] = 0;
  let total = 0, openDays = 0, closedDays = 0;
  for (const date of dates || []) {
    const wd = DOW_NAMES[new Date(`${date}T12:00:00`).getDay()];
    const dayTotal = weekdayBudgetTotal(wd, model);
    if (dayTotal <= 0) { continue; }          // a day the centre never opens
    if (isClosed(date)) { closedDays += 1; continue; }
    const buckets = weekdayBudgetBuckets(wd, model);
    for (const k of BUCKET_KEYS) byCat[k] += buckets[k];
    total += dayTotal;
    openDays += 1;
  }
  return { byCat, total, openDays, closedDays };
}

/** Every date from `from` to `to` inclusive, as 'YYYY-MM-DD'. */
export function datesBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (d <= end) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Strip a day model down to what gets stored on the centre config. */
export function serializeWeekdayModel(model) {
  const out = {};
  for (const wd of WEEKDAY_ORDER) {
    const day = model?.[wd] || {};
    const clean = {};
    for (const k of BUCKET_KEYS) {
      const v = Number(day[k]);
      if (Number.isFinite(v) && v > 0) clean[k] = v;
    }
    out[wd] = clean;
  }
  return out;
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
  // LEGACY. The STEAM / Summer Camp shift tag was removed — nothing writes
  // `flexRole` any more — but the 58 summer-2026 shifts that carry it must
  // still bucket the same way, or the August budget and payroll would
  // change retroactively. The `steam` / `summerCamp` ALLOCATIONS below are
  // a separate question (planned hours, not shift tagging) and are left
  // alone deliberately: changing them moves every day's budget total.
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
