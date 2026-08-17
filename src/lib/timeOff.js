/**
 * Time off vs availability — one precedence rule, used everywhere.
 *
 * THE PROBLEM
 *   An instructor sets availability for a month, then realises they need
 *   some of those days off and files a time-off request. Both records now
 *   exist and both are true statements about the same day, so the weekly
 *   grid drew a green "available" flag AND a red "time off" flag on the
 *   same cell. The tool was arguing with itself, and an admin building a
 *   schedule had to guess which one to believe.
 *
 * THE RULE
 *   The time-off request WINS. It is the later, more specific statement:
 *   "I said I could work these days, and now I'm telling you I can't work
 *   this one." Availability isn't deleted — it's still the right value if
 *   the request gets denied — it just stops being the thing the day is
 *   displayed as.
 *
 *   Precedence, highest first:
 *     approved   → OFF.       Definitely not working. Do not schedule.
 *     pending    → REQUESTED. Undecided, and an admin needs to settle it,
 *                             so it must not read as a plain green day.
 *     available  → AVAILABLE.
 *     (nothing)  → NONE.
 *
 *   Denied requests are ignored entirely: the answer was no, so the
 *   original availability stands unchanged.
 *
 * WHERE THE INFORMATION GOES
 *   Suppressing the green flag must not lose the underlying hours — an
 *   admin still wants to know "they had 9–5 in before they asked for the
 *   day". Every surface that hides availability behind a time-off state
 *   shows the original window inside the tooltip instead.
 *
 * ALREADY CORRECT ELSEWHERE
 *   The auto-scheduler has always stripped approved time off before
 *   generating (see withoutApprovedTimeOff, which now backs it), and the
 *   day-detail staff picker already applied this precedence by hand. This
 *   module is that same rule, written once.
 */

export const TIME_OFF_STATUS = {
  PENDING:  'pending',
  APPROVED: 'approved',
  DENIED:   'denied',
};

/** Day states, in precedence order. */
export const DAY_STATE = {
  OFF:       'off',        // approved time off
  REQUESTED: 'requested',  // pending time off
  AVAILABLE: 'available',
  NONE:      'none',
};

function key(userId, date) {
  return `${userId}|${date}`;
}

/**
 * Expand a request's date span into YYYY-MM-DD strings.
 *
 * Parsed at NOON local rather than midnight: a midnight Date crossing a
 * DST boundary can land on the previous day once formatted back, which
 * would silently drop a day of someone's time off.
 */
function datesBetween(startDate, endDate) {
  const out = [];
  if (!startDate || !endDate) return out;
  const d = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) return out;
  // Guard against a reversed or absurd range producing a runaway loop.
  let guard = 0;
  while (d <= end && guard < 400) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
    d.setDate(d.getDate() + 1);
    guard += 1;
  }
  return out;
}

/**
 * Index every non-denied request by (user, date) for O(1) lookup.
 *
 * Approved beats pending when both cover the same day — rare, but if
 * someone files twice we must not show the day as merely "requested"
 * when one of them has already been granted.
 */
export function buildTimeOffIndex(requests) {
  const m = new Map();
  for (const r of requests || []) {
    if (!r?.userId) continue;
    if (r.status !== TIME_OFF_STATUS.PENDING && r.status !== TIME_OFF_STATUS.APPROVED) continue;
    for (const date of datesBetween(r.startDate, r.endDate)) {
      const k = key(r.userId, date);
      const existing = m.get(k);
      if (!existing || (existing.status !== TIME_OFF_STATUS.APPROVED
                        && r.status === TIME_OFF_STATUS.APPROVED)) {
        m.set(k, r);
      }
    }
  }
  return m;
}

/** The request covering this person on this day, or null. */
export function timeOffOn(index, userId, date) {
  if (!index || !userId || !date) return null;
  return index.get(key(userId, date)) || null;
}

/** True only for APPROVED time off — the "definitely not working" test. */
export function isOffOn(index, userId, date) {
  return timeOffOn(index, userId, date)?.status === TIME_OFF_STATUS.APPROVED;
}

/**
 * The single state a day should be displayed as. Pass whether the person
 * submitted availability; this applies the precedence.
 */
export function dayStateFor(index, userId, date, hasAvailability) {
  const off = timeOffOn(index, userId, date);
  if (off?.status === TIME_OFF_STATUS.APPROVED) return DAY_STATE.OFF;
  if (off?.status === TIME_OFF_STATUS.PENDING)   return DAY_STATE.REQUESTED;
  return hasAvailability ? DAY_STATE.AVAILABLE : DAY_STATE.NONE;
}

/**
 * Drop availability rows that approved time off has overridden. Used by
 * the auto-scheduler so a granted day off can never be filled.
 *
 * PENDING requests are deliberately left in — an undecided request must
 * not quietly remove someone from the schedule. Approve it first.
 */
export function withoutApprovedTimeOff(availability, index) {
  return (availability || []).filter(a => !isOffOn(index, a.userId, a.date));
}

/** Human label for a state. */
export const DAY_STATE_LABEL = {
  off:       'Time off · Approved',
  requested: 'Time off · Pending',
  available: 'Available',
  none:      'Nothing submitted',
};
