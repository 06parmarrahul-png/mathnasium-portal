// Scheduler analytics — supply / demand math for the Today tab.
//
// Mission statement: tutoring centres run on the ratio of staff hours
// (supply) to students-in-the-room (demand). Everything else is noise.
// This module turns raw check-in data + instructor assignments into the
// numbers an owner can actually act on.
//
// Status classification (the single most important decision in this file):
//
//   'present'         → student checked in ('in' or 'late')
//   'absent'          → explicitly marked 'noshow' or 'cancel'
//   'presumed-absent' → unset AND the slot has ended (best guess, not gospel)
//   'pending'         → unset AND the slot is current or future (no signal yet)
//
// "Presumed absent" exists so the system can compute attendance
// retrospectively WITHOUT requiring staff to mark every no-show by hand.
// The trade-off: if staff forgets to check a real attendee in, that
// student gets classified as absent and the metric over-counts no-shows.
// We mitigate that two ways:
//   1. Staff can always click the student row to flip status to 'in' —
//      no special "fix presumed absences" workflow needed.
//   2. The UI dims presumed-absent students rather than slashing through
//      them in red, so the visual reads as "best guess" not "verdict."
//
// All functions in this file are PURE — no Firestore, no React, no
// side-effects. The page calls them, passes the result to render.
//
// Timezones: we read centre-local time from a passed-in IANA tz string.
// Slot keys are HH:MM in centre local time, dates are YYYY-MM-DD in the
// centre's local calendar day. Comparing against "now in centre TZ" is
// what tells us whether a slot has ended.

const PRESENT_STATUSES   = new Set(['in', 'late']);
const ABSENT_STATUSES    = new Set(['noshow', 'cancel']);
const SLOT_DURATION_MIN  = 30;

// ─── Time helpers ──────────────────────────────────────────────────────

// "YYYY-MM-DD" for the given Date in the centre's TZ.
function ymdInTZ(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const get = (t) => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    // Fallback to local time if the TZ isn't recognised. Better than crashing.
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

// Minutes since midnight in the centre's TZ.
function minutesInTZ(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (t) => parts.find(p => p.type === t).value;
    return (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

function slotEndMinutes(slotKey) {
  const [h, m] = (slotKey || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0) + SLOT_DURATION_MIN;
}

/**
 * Has the given slot's window ended (in the centre's local TZ)?
 *
 * For past dates: always true.
 * For future dates: always false.
 * For today: true once we're past the slot's end minute.
 *
 * Pass a `now` Date for deterministic testing; defaults to current time.
 */
export function hasSlotEnded(dateStr, slotKey, timezone, now = new Date()) {
  const today = ymdInTZ(now, timezone);
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return minutesInTZ(now, timezone) >= slotEndMinutes(slotKey);
}

// ─── Student status classification ─────────────────────────────────────

/**
 * @param {Object|undefined} entry — checkIns[studentId] (may be undefined)
 * @param {boolean} slotEnded
 * @returns {'present'|'absent'|'presumed-absent'|'pending'}
 */
export function classifyStudent(entry, slotEnded) {
  const status = entry?.status || '';
  if (PRESENT_STATUSES.has(status)) return 'present';
  if (ABSENT_STATUSES.has(status))  return 'absent';
  return slotEnded ? 'presumed-absent' : 'pending';
}

// ─── Per-slot efficiency ───────────────────────────────────────────────

/**
 * Given a slot row (from the server's grouped schedule) and the current
 * assignment / check-in state, compute the supply-vs-demand picture.
 *
 * `slotEnded` controls whether absent inferences fire — when the slot
 * is still in progress we don't infer no-shows.
 *
 * Returns an object suitable for direct UI rendering:
 *   {
 *     scheduled:   number,     // total students booked into this slot
 *     present:     number,     // checked in
 *     presumedAbsent: number,  // unset AND slot ended
 *     confirmedAbsent: number, // 'noshow' / 'cancel'
 *     pending:     number,     // unset AND slot not ended yet
 *     instructors: number,     // staff assigned to the slot
 *     targetInstructors: number, // ceil(realised demand / ratio)
 *     effectiveRatio: number|null, // realised demand / instructors
 *     slack: number,           // instructors - targetInstructors  (positive = over)
 *     state: 'pending'|'on-target'|'overstaffed'|'understaffed'|'idle',
 *     slotEnded: boolean,
 *   }
 *
 * Demand metric used:
 *   - While slot is in progress: scheduled (capacity-planning view).
 *   - After slot ended: present + pending (realised attendance — pending
 *     in a past slot is impossible, so this collapses to present).
 */
export function computeSlotEfficiency({ scheduledStudents, instructors, checkIns, ratio, slotEnded }) {
  let present = 0, presumedAbsent = 0, confirmedAbsent = 0, pending = 0;
  for (const s of scheduledStudents) {
    const klass = classifyStudent(checkIns[s.id], slotEnded);
    if      (klass === 'present')         present++;
    else if (klass === 'presumed-absent') presumedAbsent++;
    else if (klass === 'absent')          confirmedAbsent++;
    else                                   pending++;
  }
  const scheduled = scheduledStudents.length;
  // Realised demand AFTER the slot ended; planned demand while in progress.
  const realisedDemand = slotEnded ? present : scheduled;
  const instructorCount = instructors.length;
  const targetInstructors = Math.max(1, Math.ceil(realisedDemand / Math.max(1, ratio)));
  const effectiveRatio = instructorCount > 0
    ? realisedDemand / instructorCount
    : null;
  const slack = instructorCount - targetInstructors;

  let state;
  if (!slotEnded) {
    state = 'pending';
  } else if (scheduled === 0) {
    state = 'idle';
  } else if (slack > 0 && realisedDemand < scheduled) {
    // Real demand came in lower than planned → real overstaffing signal.
    state = 'overstaffed';
  } else if (slack < 0) {
    state = 'understaffed';
  } else {
    state = 'on-target';
  }

  return {
    scheduled, present, presumedAbsent, confirmedAbsent, pending,
    instructors: instructorCount, targetInstructors,
    effectiveRatio, slack, state, slotEnded,
  };
}

// ─── Day-level rollup ──────────────────────────────────────────────────

/**
 * Aggregate per-slot efficiency into a one-screen summary for the day.
 *
 * Takes the same shape the page already has in memory:
 *   - data: server response (data.slots[] + data.timezone)
 *   - assignments: { "<side>|<HH:MM>": [name, …] }
 *   - checkIns: { studentId: { status, ... } }
 *   - ratio, dateStr
 *
 * Output is shaped for the day-summary tile.
 */
export function computeDayAnalytics({ data, assignments, checkIns, ratio, dateStr, now = new Date() }) {
  if (!data || !data.slots || data.slots.length === 0) {
    return { hasData: false };
  }
  const tz = data.timezone || 'America/Vancouver';

  const sides = ['EM', 'HS'];
  let totalScheduled = 0;
  let totalPresent = 0;
  let totalAbsent = 0;          // confirmed + presumed
  let totalPending = 0;
  let totalInstructorSlots = 0;     // instructor × slot count
  let utilisedInstructorSlots = 0;  // slots where at least one student attended
  let overstaffedSlots = 0;
  let understaffedSlots = 0;
  let onTargetSlots = 0;
  let totalSlackUnits = 0;          // sum of positive slack across ended slots

  for (const row of data.slots) {
    const slotEnded = hasSlotEnded(dateStr, row.slot, tz, now);
    for (const side of sides) {
      const rawOnHour = row.students[side]?.onHour || [];
      const rawHalfHour = row.students[side]?.halfHour || [];
      const onHour = side === 'HS' ? rawOnHour.filter(s => s.duration === 60) : rawOnHour;
      const halfHour = side === 'HS' ? rawHalfHour.filter(s => s.duration === 60) : rawHalfHour;
      const longHour = side === 'HS'
        ? [...rawOnHour, ...rawHalfHour].filter(s => s.duration !== 60)
        : [];
      const scheduledStudents = [...onHour, ...halfHour, ...longHour];

      const instructors = assignments[`${side}|${row.slot}`] || [];
      const eff = computeSlotEfficiency({
        scheduledStudents, instructors, checkIns, ratio, slotEnded,
      });

      totalScheduled         += eff.scheduled;
      totalPresent           += eff.present;
      totalAbsent            += eff.presumedAbsent + eff.confirmedAbsent;
      totalPending           += eff.pending;
      totalInstructorSlots   += eff.instructors;
      if (eff.instructors > 0 && eff.present > 0) utilisedInstructorSlots += eff.instructors;
      if (eff.state === 'overstaffed')   overstaffedSlots++;
      if (eff.state === 'understaffed')  understaffedSlots++;
      if (eff.state === 'on-target')     onTargetSlots++;
      if (eff.slotEnded && eff.slack > 0) totalSlackUnits += eff.slack;
    }
  }

  const attendanceRate = totalScheduled > 0
    ? (totalPresent / (totalPresent + totalAbsent + totalPending || 1))
    : null;

  // Capacity utilisation = how much of staffed time had at least one
  // student to teach. NULL when nothing was staffed (avoids 0/0 = NaN).
  const utilisation = totalInstructorSlots > 0
    ? utilisedInstructorSlots / totalInstructorSlots
    : null;

  return {
    hasData: true,
    totalScheduled, totalPresent, totalAbsent, totalPending,
    totalInstructorSlots, utilisedInstructorSlots,
    onTargetSlots, overstaffedSlots, understaffedSlots,
    attendanceRate,
    utilisation,
    excessInstructorSlots: totalSlackUnits,
  };
}

/**
 * Produce ONE actionable sentence — the entire point of the day-summary
 * tile. We rank candidate insights by severity and return the strongest.
 *
 * Returns { kind, text } where kind in
 *   'understaffed' | 'overstaffed' | 'low-attendance' | 'on-target' | null
 *
 * NULL means we don't have a confident enough recommendation yet — the
 * UI should hide the insight rather than show wishy-washy text.
 */
export function recommendationFor(analytics) {
  if (!analytics?.hasData) return null;
  const { totalScheduled, totalPresent, totalAbsent,
          understaffedSlots, overstaffedSlots, excessInstructorSlots,
          attendanceRate } = analytics;

  // Severity 1 — understaffing is the most painful failure (parents
  // notice immediately). Always lead with it when present.
  if (understaffedSlots > 0) {
    return {
      kind: 'understaffed',
      text: `${understaffedSlots} slot${understaffedSlots === 1 ? ' was' : 's were'} understaffed today. Effective ratio worse than target — students likely felt the squeeze. Consider adding coverage to recurring shifts that match.`,
    };
  }

  // Severity 2 — sustained overstaffing is the lever to pull on
  // cost. Only fires when (a) total scheduled was meaningful (>=10)
  // and (b) at least 3 slots ended with extra capacity.
  if (overstaffedSlots >= 3 && excessInstructorSlots >= 4 && totalScheduled >= 10) {
    return {
      kind: 'overstaffed',
      text: `${overstaffedSlots} slots had more instructors than the realised demand needed (≈ ${excessInstructorSlots} extra instructor-slot${excessInstructorSlots === 1 ? '' : 's'}). Recurring? Consider tightening the schedule for this weekday.`,
    };
  }

  // Severity 3 — low attendance is a demand-side signal, not staffing.
  // Surface when >= 20% of booked students didn't arrive.
  if (totalScheduled >= 10 && (totalAbsent / Math.max(1, totalPresent + totalAbsent)) >= 0.2) {
    const pct = Math.round(100 * totalAbsent / (totalPresent + totalAbsent));
    return {
      kind: 'low-attendance',
      text: `${pct}% no-show rate today (${totalAbsent} of ${totalPresent + totalAbsent} booked students didn't arrive). Worth a parent-comms review if this is a pattern.`,
    };
  }

  // Severity 4 — clean day. Only call it out late in the day so the
  // owner doesn't see a premature "all good" message at 11am.
  if (attendanceRate != null && attendanceRate >= 0.9 && totalPresent >= 10) {
    return {
      kind: 'on-target',
      text: `Supply met demand cleanly today — ${Math.round(attendanceRate * 100)}% attendance, no over/understaffing flags. Replicate this staffing pattern.`,
    };
  }

  return null;
}

// ─── Formatters ────────────────────────────────────────────────────────

export function fmtRatio(effectiveRatio) {
  if (effectiveRatio == null || !isFinite(effectiveRatio)) return '—';
  // Effective = students per instructor (matches centre target convention).
  // "1:3" reads as one instructor to three students. Round to one decimal,
  // strip trailing .0 so "1:4.0" displays as "1:4".
  const v = (Math.round(effectiveRatio * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `1:${v}`;
}

export function fmtPct(x) {
  if (x == null || isNaN(x)) return '—';
  return `${Math.round(x * 100)}%`;
}
