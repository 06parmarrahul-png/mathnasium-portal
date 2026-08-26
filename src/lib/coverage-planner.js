/**
 * coverage-planner.js — turn a required-coverage curve into shift shapes.
 *
 * THE PROBLEM
 *   Supply & Demand already gives us, for every 30-minute slot, how many
 *   instructors the bookings call for:  required = ceil(students / ratio).
 *   That's a step function over the day. What it does NOT tell us is what
 *   SHIFTS to roster — a person works one contiguous block, not a slot.
 *
 *   Worked example (a real Monday):
 *
 *      3:00  3:30  4:00  4:30  5:00  5:30  6:00  6:30
 *        3     3     7     7     6     6     7     7
 *
 *   Cover that literally and you get 8 shifts, one of which ends at 5:00
 *   while a different person starts at 6:00. No centre runs that.
 *
 * THE KEY INSIGHT
 *   You do NOT need a hand-tuned "how deep a dip is worth honouring"
 *   threshold. The legal minimum shift length derives it. Dropping one
 *   person at 5:00 means bringing someone back at 6:00, and a 6:00 start
 *   against a 7:00 close is a one-hour shift — not rosterable. So the dip
 *   cannot be honoured, and the answer is 7 shifts with nobody leaving
 *   mid-afternoon. Which is what an owner would have done by instinct.
 *
 *   Over-staffing is also genuinely cheap here: an instructor who isn't
 *   needed for half an hour works through an online training module. So
 *   when the choice is "fill the trough" vs "fragment the day", filling
 *   wins. The real limiter is the hours budget, not idle time — and that
 *   is checked elsewhere (Staffing Budget), against totalMinutes below.
 *
 * WHAT THIS MODULE IS NOT
 *   It assigns nobody. It emits anonymous skeletons — "someone, 4:00 to
 *   7:00" — and the existing scheduler's ranking (priority, fairness,
 *   sub-role balance) decides who fills them. Keeping the two apart means
 *   this can be reasoned about, and tested, on its own.
 */

/** 'HH:MM' → minutes since midnight. */
export function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** minutes since midnight → 'HH:MM'. */
export function toHHMM(mins) {
  const m = Math.max(0, Math.round(mins));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Students booked per slot → instructors required per slot.
 *
 * The same `ceil(demand / ratio)` Supply & Demand already uses for its
 * "Match Demand" button, lifted out so the planner and the page can't
 * drift apart, and so it can be tested. Ceil, not round: three students
 * at a 1:3.5 ratio still needs a whole instructor.
 */
export function requiredFromDemand(demand = [], ratio = 1) {
  const r = Number(ratio) || 1;
  return demand.map(d => Math.ceil((Number(d) || 0) / r));
}

/**
 * Fill dips too short to legally send anybody home.
 *
 * A trough is a maximal run of slots sitting below BOTH the level before
 * it and the level after it. Honouring one means ending a shift at its
 * start and beginning another at its end. If the trough is shorter than a
 * legal shift, that restart can't be rostered, so the trough gets raised
 * to the lower of its two shoulders.
 *
 * Troughs at the very start or end of the day are left alone: there's no
 * "shoulder" on the outside, so the curve simply begins or ends lower —
 * that's the day opening quietly, not a dip to paper over.
 */
export function smoothTroughs(required, { slotMinutes = 30, minShiftMinutes = 120 } = {}) {
  const out = [...required];
  const minSlots = Math.ceil(minShiftMinutes / slotMinutes);
  let i = 0;
  while (i < out.length) {
    // Find the start of a dip: a slot lower than the one before it.
    if (i === 0 || out[i] >= out[i - 1]) { i++; continue; }
    const before = out[i - 1];
    let j = i;
    while (j < out.length && out[j] < before) j++;
    // j is the first slot back at/above `before`, or past the end.
    if (j < out.length) {
      const after = out[j];
      const width = j - i;
      const shoulder = Math.min(before, after);
      // Only fill a dip too narrow to be worth a legal break.
      if (width < minSlots) {
        for (let k = i; k < j; k++) out[k] = Math.max(out[k], shoulder);
      }
    }
    i = j > i ? j : i + 1;
  }
  return out;
}

/**
 * Decompose a (smoothed) step function into contiguous shifts.
 *
 * Standard staircase decomposition: the minimum number of contiguous
 * blocks covering a step function is the sum of its upward steps. Each
 * rise opens that many shifts; each fall closes some.
 *
 * When closing, the LONGEST-RUNNING shift goes first. That gives the
 * person who started earliest the fullest shift and leaves later starters
 * running, which both maximises the chance every shift clears the legal
 * minimum and avoids stranding someone with a stub.
 */
function decompose(curve, slotStarts, slotMinutes) {
  const open = [];      // slot indexes where each running shift began
  const shifts = [];
  const endOf = (idx) => toMinutes(slotStarts[idx]) + slotMinutes;

  for (let t = 0; t < curve.length; t++) {
    const need = Math.max(0, curve[t]);
    while (open.length < need) open.push(t);
    while (open.length > need) {
      const startIdx = open.shift();          // longest-running first
      shifts.push({ startIdx, endIdx: t - 1 });
    }
  }
  // Anything still running closes when the day does.
  while (open.length > 0) {
    shifts.push({ startIdx: open.shift(), endIdx: curve.length - 1 });
  }

  return shifts.map(({ startIdx, endIdx }) => {
    const startMin = toMinutes(slotStarts[startIdx]);
    const endMin   = endOf(endIdx);
    return { startIdx, endIdx, startMin, endMin, minutes: endMin - startMin };
  });
}

/**
 * Plan the shifts needed to cover a required-coverage curve.
 *
 * @param {Object}   params
 * @param {number[]} params.required          - instructors needed per slot
 * @param {string[]} params.slotStarts        - 'HH:MM' per slot, same length
 * @param {number}   [params.slotMinutes=30]
 * @param {number}   [params.minShiftMinutes=120] - legal minimum (BC: 2h)
 * @param {string}   [params.capability]      - tag carried onto each shift
 * @returns {{ shifts: Array, smoothed: number[], totalMinutes: number,
 *             overstaffedSlots: number, warnings: string[] }}
 */
export function planCoverage({
  required = [],
  slotStarts = [],
  slotMinutes = 30,
  minShiftMinutes = 120,
  capability = null,
} = {}) {
  const warnings = [];
  if (required.length === 0 || required.length !== slotStarts.length) {
    return { shifts: [], smoothed: [], totalMinutes: 0, overstaffedSlots: 0,
             warnings: ['Coverage curve and slot list do not line up.'] };
  }

  const smoothed = smoothTroughs(required, { slotMinutes, minShiftMinutes });
  const raw = decompose(smoothed, slotStarts, slotMinutes);

  // A genuine short spike can still produce a sub-legal shift. Stretch it
  // backwards first (earlier starts are easier to staff than later ends,
  // and the extra coverage is cheap), then forwards, then give up and say
  // so rather than emitting something that can't be rostered.
  const dayStart = toMinutes(slotStarts[0]);
  const dayEnd   = toMinutes(slotStarts[slotStarts.length - 1]) + slotMinutes;

  const shifts = raw.map((s) => {
    if (s.minutes >= minShiftMinutes) return s;
    const short = minShiftMinutes - s.minutes;
    let startMin = Math.max(dayStart, s.startMin - short);
    let endMin   = s.endMin;
    if (endMin - startMin < minShiftMinutes) {
      endMin = Math.min(dayEnd, startMin + minShiftMinutes);
    }
    if (endMin - startMin < minShiftMinutes) {
      warnings.push(
        `A ${s.minutes}-minute block at ${toHHMM(s.startMin)} can't reach the ` +
        `${minShiftMinutes / 60}h minimum inside opening hours — shorten the day's ` +
        `coverage or accept the gap.`,
      );
    }
    return { ...s, startMin, endMin, minutes: endMin - startMin };
  });

  // How much slack the plan carries, so the budget page has a number and
  // the owner can see the cost of the smoothing rather than guessing.
  let overstaffedSlots = 0;
  for (let t = 0; t < required.length; t++) {
    const covered = shifts.filter(
      s => s.startMin <= toMinutes(slotStarts[t]) && s.endMin > toMinutes(slotStarts[t]),
    ).length;
    if (covered > required[t]) overstaffedSlots++;
  }

  return {
    shifts: shifts
      .map(s => ({
        capability,
        startTime: toHHMM(s.startMin),
        endTime:   toHHMM(s.endMin),
        minutes:   s.minutes,
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime)
                   || a.endTime.localeCompare(b.endTime)),
    smoothed,
    totalMinutes: shifts.reduce((n, s) => n + s.minutes, 0),
    overstaffedSlots,
    warnings,
  };
}

/**
 * Plan several capability curves at once (host / online / instructors),
 * which is how a real day is actually specified.
 *
 * @param {Array} requirements - [{ capability, required }]
 */
export function planDay({ requirements = [], slotStarts = [], ...opts }) {
  const plans = requirements.map(r =>
    planCoverage({ ...opts, slotStarts, required: r.required, capability: r.capability }));
  return {
    shifts:       plans.flatMap(p => p.shifts),
    totalMinutes: plans.reduce((n, p) => n + p.totalMinutes, 0),
    warnings:     plans.flatMap(p => p.warnings),
    byCapability: Object.fromEntries(
      requirements.map((r, i) => [r.capability, plans[i]]),
    ),
  };
}
