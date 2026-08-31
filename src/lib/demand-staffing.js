/**
 * demand-staffing.js — turn REAL bookings into per-date staffing numbers.
 *
 * WHY THIS EXISTS
 *   generateSchedule() decides *who* works, but it's told *how many* people a
 *   day needs by config.minPerDay/maxPerDay, or by config.perDay keyed on
 *   weekday name. Both are human guesses, and a weekday key can't say "this
 *   particular Thursday has 21 students booked and next Thursday has 8."
 *
 *   demand-snapshots.js already offers `recommendedStaffFromTypical`, but that
 *   averages MANUALLY SAVED Supply & Demand snapshots by weekday. It needs
 *   someone to have saved days first, and it still can't speak about a
 *   specific date.
 *
 *   This module closes that gap: given the grouped appointment data the
 *   /api/scheduler/appointments endpoint already returns, it produces a
 *   per-DATE { min, max } that generateSchedule consumes via config.perDate.
 *
 * PURE MODULE — no Firebase, no React, no fetch. Same discipline as
 * scheduler.js so it stays unit-testable.
 *
 * WHAT COUNTS AS DEMAND
 *   In-centre students only (EM + HS). Online is excluded because online
 *   instructors are not counted in the in-centre min/max ratio — see the
 *   header of scheduler.js. Uncategorized ("Unknown") students ARE counted by
 *   default: they're real people standing in the room, and dropping them
 *   silently understaffs the floor. They're reported separately so the owner
 *   can go fix the categorization.
 *
 *   We read each slot's `counts`, not the `students` cards. The API increments
 *   `counts[cat]` for EVERY 30-minute slot an appointment occupies (a 60-min
 *   booking hits 2 slots, a 90-min hits 3), while a student's card is pushed
 *   only into their FIRST slot. Counts are therefore the correct occupancy
 *   signal. (SupplyDemand.jsx re-derives the same numbers client-side because
 *   it additionally needs per-student identity to subtract no-shows and add
 *   walk-ins — same-day realities that don't exist for a future date.)
 */

const SLOT_MIN = 30;

/** In-centre categories. 'Online' is deliberately absent. */
export const IN_CENTRE_CATEGORIES = ['EM', 'HS'];

/**
 * Students-per-instructor to instructors-needed, for one slot.
 * Always rounds UP: half an instructor can't cover a student.
 */
export function requiredForSlot(students, targetRatio) {
  const r = Number(targetRatio);
  if (!(r > 0)) return 0;
  return Math.ceil((Number(students) || 0) / r);
}

/**
 * Per-slot in-centre student counts for one day's grouped API payload.
 *
 * @param {Object} grouped        - { slots: [{ slot, counts: {EM,HS,Online,Unknown} }] }
 * @param {boolean} includeUnknown - count uncategorized students (default true)
 * @returns {Array<{slot, students, unknown, breakdown}>}
 */
export function inCentreDemandBySlot(grouped, includeUnknown = true) {
  const rows = Array.isArray(grouped?.slots) ? grouped.slots : [];
  return rows.map(row => {
    const c = row?.counts || {};
    let students = 0;
    const breakdown = {};
    for (const cat of IN_CENTRE_CATEGORIES) {
      const n = Number(c[cat]) || 0;
      breakdown[cat] = n;
      students += n;
    }
    const unknown = Number(c.Unknown) || 0;
    if (includeUnknown) students += unknown;
    return { slot: row.slot, label: row.label || row.slot, students, unknown, breakdown };
  });
}

/**
 * Close short valleys in a requirement curve.
 *
 * You don't send an instructor home because demand dips for one 30-minute
 * slot and comes straight back. This raises any dip NARROWER than `window`
 * slots to the level around it, while leaving a genuine sustained drop alone.
 *
 * Implemented as a grayscale morphological closing (dilate, then erode) with a
 * flat structuring element — the standard way to fill notches without moving
 * real edges. Guaranteed never to lower a value below its original.
 */
export function closeValleys(values, window) {
  const n = values.length;
  if (!(window > 1) || n === 0) return values.slice();
  const half = Math.floor(window / 2);

  const dilated = new Array(n);
  for (let i = 0; i < n; i++) {
    let max = -Infinity;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      if (values[j] > max) max = values[j];
    }
    dilated[i] = max;
  }

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let min = Infinity;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      if (dilated[j] < min) min = dilated[j];
    }
    out[i] = Math.max(values[i], min);
  }
  return out;
}

/**
 * The highest staffing level worth putting on a real shift.
 *
 * Returns the largest L such that at least `minSlots` slots need >= L people.
 * A single 30-minute spike shouldn't set the day's floor — you can't hire
 * someone for half an hour, and the 2-hour legal minimum means any body you
 * bring in is there for a block. The true peak is still reported separately
 * and drives `max`.
 */
export function sustainedLevel(required, minSlots) {
  if (required.length === 0) return 0;
  const peak = Math.max(...required);
  const need = Math.max(1, minSlots);
  for (let level = peak; level >= 1; level--) {
    const slotsAtLevel = required.filter(v => v >= level).length;
    if (slotsAtLevel >= need) return level;
  }
  return 0;
}

/**
 * Staffing recommendation for ONE date.
 *
 * min = the PEAK requirement — enough that the ratio never breaks.
 * max = peak plus a cushion.
 *
 * WHY MIN IS THE PEAK, NOT THE SUSTAINED LEVEL
 *   generateSchedule assigns whole-day shifts (clamped to instructional
 *   hours). It cannot staff six people for the busy first hour and three for
 *   the rest — whoever it schedules is there for the session. So the headcount
 *   has to clear the busiest moment, or the ratio quietly breaks exactly when
 *   the centre is fullest.
 *
 *   Concretely, a real Thursday: 13, 20, 11, 6, 7, 9, 6, 2 students across the
 *   afternoon. The level you could sustain for a 2-hour block is 3 instructors,
 *   but 3 against the 20-student peak is 1:6.7 — a breach. min must be 6.
 *
 *   `sustainedRequired` is still computed and reported, because it's the right
 *   number for judging how much of the day is genuinely busy, and an engine
 *   that builds partial shifts would want it. It just doesn't set the floor.
 *
 *   Over-staffing is cheap here by design — an idle instructor does training
 *   modules — so erring high is the correct direction to err.
 *
 * TWO RATIOS, NOT ONE
 *   The centre aims for 1:3.5 and accepts 1:4 when the numbers don't divide
 *   neatly. Those are genuinely different questions, and generateSchedule
 *   already takes both:
 *
 *     min = ceil(peak / acceptableRatio)  — the fewest people that still
 *           keeps you at or under 1:4. Drop below this and you're breaching;
 *           it's what triggers warnings and open-shift postings.
 *     max = ceil(peak / targetRatio) + cushion — staffing to the 1:3.5 aim,
 *           plus slack. generateSchedule fills UP TO max whenever people are
 *           available, so this is what you actually get on a normal day.
 *
 *   When the peak divides evenly both agree. 14 students → 4 either way.
 *   Where they differ, you get a floor and an aim instead of one brittle
 *   number: 20 students → floor 5 (1:4), aim 6 (1:3.5), max 7.
 *
 * @param {Object} grouped  one day's /api/scheduler/appointments payload
 * @param {Object} opts
 * @param {number} opts.targetRatio     what you aim for (default 3.5)
 * @param {number} opts.acceptableRatio the worst you'll accept (default 4)
 * @param {number} opts.minShiftHours   legal minimum shift (default 2)
 * @param {number} opts.cushion         extra bodies above the aim (default 1)
 * @param {boolean} opts.includeUnknown count uncategorized students (default true)
 */
export function staffingForDate(grouped, opts = {}) {
  const {
    targetRatio = 3.5,
    acceptableRatio = 4,
    minShiftHours = 2,
    cushion = 1,
    includeUnknown = true,
  } = opts;

  const date = grouped?.day || null;
  const demand = inCentreDemandBySlot(grouped, includeUnknown);

  if (demand.length === 0) {
    return {
      date, hasBookings: false, min: 0, max: 0,
      peakStudents: 0, peakRequired: 0, floorRequired: 0, sustainedRequired: 0,
      totalStudentSlots: 0, unknownStudents: 0, slots: [],
      window: null,
    };
  }

  const minSlots = Math.max(1, Math.round((minShiftHours * 60) / SLOT_MIN));
  const rawRequired = demand.map(d => requiredForSlot(d.students, targetRatio));
  const smoothed = closeValleys(rawRequired, minSlots);

  const peakRequired = Math.max(...smoothed);
  const sustained = sustainedLevel(smoothed, minSlots);
  const peakStudents = Math.max(...demand.map(d => d.students));
  const unknownStudents = Math.max(...demand.map(d => d.unknown));

  // The floor: fewest people that still holds the acceptable ratio at the
  // busiest moment. Guarded with min() in case someone configures an
  // "acceptable" ratio tighter than the target, which would otherwise put the
  // floor above the aim.
  const floorRequired = Math.min(
    peakRequired,
    requiredForSlot(peakStudents, acceptableRatio || targetRatio)
  );

  const slots = demand.map((d, i) => ({
    slot: d.slot,
    label: d.label,
    students: d.students,
    breakdown: d.breakdown,
    unknown: d.unknown,
    required: rawRequired[i],
    smoothed: smoothed[i],
    // True when smoothing lifted this slot — i.e. we're keeping someone on
    // the floor through a dip rather than sending them home.
    heldThroughDip: smoothed[i] > rawRequired[i],
  }));

  return {
    date,
    hasBookings: true,
    min: floorRequired,
    max: peakRequired + Math.max(0, cushion),
    peakStudents,
    peakRequired,   // what the 1:targetRatio aim calls for
    floorRequired,  // what the 1:acceptableRatio floor calls for
    sustainedRequired: sustained,
    unknownStudents,
    totalStudentSlots: demand.reduce((a, d) => a + d.students, 0),
    window: { start: demand[0].slot, end: demand[demand.length - 1].slot },
    slots,
  };
}

/**
 * Build the `config.perDate` map generateSchedule consumes.
 *
 * @param {Array<Object>} groupedDays  one payload per date
 * @param {Object} opts                passed through to staffingForDate
 * @returns {{ perDate: Object, details: Array, warnings: Array<string> }}
 */
export function buildPerDateStaffing(groupedDays, opts = {}) {
  const perDate = {};
  const details = [];
  const warnings = [];

  for (const grouped of groupedDays || []) {
    const rec = staffingForDate(grouped, opts);
    details.push(rec);

    if (!rec.date) continue;
    if (!rec.hasBookings) {
      // No bookings is a real signal (closed, or a genuinely empty day) —
      // don't write a rule, let the centre's normal defaults apply.
      warnings.push(`${rec.date}: no bookings found — left on the default staffing rule.`);
      continue;
    }

    perDate[rec.date] = { min: rec.min, max: rec.max };

    if (rec.unknownStudents > 0) {
      warnings.push(
        `${rec.date}: ${rec.unknownStudents} student${rec.unknownStudents === 1 ? '' : 's'} ` +
        `could not be categorized and ${opts.includeUnknown === false ? 'were EXCLUDED from' : 'were counted in'} demand. ` +
        `Fix them on the Student Scheduler so the ratio is accurate.`
      );
    }
  }

  return { perDate, details, warnings };
}

/**
 * Human-readable one-liner for a date's recommendation. Used in the UI so the
 * owner can see the reasoning rather than a bare number.
 */
export function explainStaffing(rec, targetRatio = 3.5, acceptableRatio = 4) {
  if (!rec?.hasBookings) return 'No bookings — using the default rule.';
  // Only mention the floor when it actually differs from the aim; on a day
  // whose peak divides evenly, saying "5 at 1:4, 5 at 1:3.5" is noise.
  const floor = rec.floorRequired < rec.peakRequired
    ? ` ${rec.floorRequired} would still hold 1:${acceptableRatio}.`
    : '';
  const peaky = rec.peakRequired > rec.sustainedRequired
    ? ` Only ${rec.sustainedRequired} needed for most of the session, but whole-day shifts have to cover the peak.`
    : '';
  return (
    `${rec.peakStudents} students at the busiest point — at 1:${targetRatio} that's ` +
    `${rec.peakRequired} instructor${rec.peakRequired === 1 ? '' : 's'}.${floor}${peaky}`
  );
}
