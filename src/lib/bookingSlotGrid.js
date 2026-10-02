/**
 * bookingSlotGrid.js — the week of times staff open and close by hand.
 *
 * Centre Settings now shows the same week a parent sees on /book, and a
 * tap on a time closes it or opens it again. This module is the part that
 * is not React: which times make up the rows, what state each cell is in,
 * and what a tap writes.
 *
 * IT DOES NOT COMPUTE AVAILABILITY. The grid asks the public booking
 * endpoint for the week and draws what comes back, so staff are looking
 * at the actual parent-facing answer rather than a second opinion
 * assembled on the client. The one thing drawn from local state instead
 * is whether a slot is closed BY HAND, because an unsaved tap has to show
 * immediately and the server has not been told yet.
 *
 * PURE MODULE — no React, no fetch, no clock of its own.
 */

// A whole date, checked as a SHAPE rather than by parsing. `Number('')`
// is 0, not NaN, so a "is the year a number" guard let the empty string
// through and built an Invalid Date that threw on toISOString().
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcOf(ymd) {
  const m = YMD.exec(String(ymd));
  if (!m) return null;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The Sunday on or before `ymd`. The booking grid's weeks start there. */
export function weekStartOf(ymd) {
  const at = utcOf(ymd);
  if (!at) return null;
  at.setUTCDate(at.getUTCDate() - at.getUTCDay());
  return at.toISOString().slice(0, 10);
}

/** `delta` weeks from a week start. */
export function shiftWeek(weekStart, delta) {
  const at = utcOf(weekStart);
  if (!at) return weekStart;
  at.setUTCDate(at.getUTCDate() + delta * 7);
  return at.toISOString().slice(0, 10);
}

/** The Saturday that closes a week, for the range label. */
export function weekEndOf(weekStart) {
  const at = utcOf(weekStart);
  if (!at) return weekStart;
  at.setUTCDate(at.getUTCDate() + 6);
  return at.toISOString().slice(0, 10);
}

/** '2026-10-07T15:30:00' → '15:30', the key a rule is stored under. */
export function timeOf(startISO) {
  return String(startISO || '').slice(11, 16);
}

/**
 * What one cell is, and whether a tap does anything.
 *
 * ORDER MATTERS, and it is the order a person would say it in. A booked
 * slot is booked whatever else is true of it — offering to "open" an hour
 * a family is already coming to would be the worst button on the page.
 * Staff-closed comes next, because that is the state this grid exists to
 * show; past and too-far come after, since a slot can be both shut and
 * gone and "shut" is the one somebody can undo.
 */
export function cellState(slot, closedByHand) {
  if (!slot) return { kind: 'none', tappable: false };
  if (slot.taken)   return { kind: 'booked', tappable: false };
  if (slot.held)    return { kind: 'held', tappable: false };
  if (closedByHand) return { kind: 'closed', tappable: true };
  if (slot.inPast)    return { kind: 'past', tappable: false };
  if (slot.tooFuture) return { kind: 'far', tappable: false };
  // A full day still draws its open times as open: the cap is a separate
  // thing somebody can raise, and painting them shut here would say the
  // times had been closed by hand when they had not.
  return { kind: 'open', tappable: true };
}

/**
 * The grid: one row per time anywhere in the week, one column per day.
 *
 * Rows are the UNION across the week, not one day's, because the days
 * differ — Saturday opens at ten and Friday shuts at six — and a column
 * that starts its own rows at its own first slot would put 10:00 Saturday
 * level with 15:00 Monday. A day with no slot at a given time gets an
 * empty cell, which is the honest drawing of "not then".
 */
export function gridFrom(days, rules = {}) {
  const times = [...new Set(
    (days || []).flatMap(d => (d.slots || []).map(sl => timeOf(sl.startISO))),
  )].sort();

  const columns = (days || []).map(day => {
    const byTime = new Map((day.slots || []).map(sl => [timeOf(sl.startISO), sl]));
    const dayRules = (rules || {})[day.date] || {};
    return {
      date: day.date,
      weekday: day.weekday,
      closed: Boolean(day.closed),
      closureName: day.closureName || null,
      dayFull: Boolean(day.dayFull),
      cells: times.map(t => {
        const slot = byTime.get(t) || null;
        const state = cellState(slot, dayRules[t] === false);
        return { time: t, slot, ...state };
      }),
    };
  });

  return { times, columns };
}

/**
 * A tap.
 *
 * Writes an explicit boolean either way and NEVER deletes the key. The
 * settings panel saves with a merge write, and a merge write deep-merges
 * maps — a key removed here would survive in Firestore and the slot would
 * stay shut while the grid showed it open.
 */
export function toggleRule(rules, date, time, open) {
  const dayRules = { ...((rules || {})[date] || {}) };
  dayRules[time] = Boolean(open);
  return { ...(rules || {}), [date]: dayRules };
}

/**
 * A tap on the column head: shut the whole day, or give it all back.
 *
 * Only the times that are THERE to shut — a booked hour keeps its
 * booking, and a held one keeps its hold, because neither is this
 * grid's to overrule. So "close the day" means "close everything a
 * family could still take", which is what somebody pressing it means.
 */
export function toggleDay(rules, column, open) {
  const dayRules = { ...((rules || {})[column.date] || {}) };
  for (const cell of column.cells) {
    if (!cell.tappable) continue;
    dayRules[cell.time] = Boolean(open);
  }
  return { ...(rules || {}), [column.date]: dayRules };
}

/** Is every time this day could offer shut by hand? */
export function dayIsClosed(column) {
  const live = column.cells.filter(c => c.kind === 'open' || c.kind === 'closed');
  return live.length > 0 && live.every(c => c.kind === 'closed');
}

/**
 * Rules worth keeping: today's and later.
 *
 * A date in the past can never be offered again, so its rules are dead
 * weight in a config document every page load reads. Pruned on save.
 */
export function pruneRules(rules, todayYmd) {
  const out = {};
  for (const [date, day] of Object.entries(rules || {})) {
    if (typeof date !== 'string' || date < todayYmd) continue;
    if (day && typeof day === 'object' && Object.keys(day).length > 0) out[date] = day;
  }
  return out;
}

/** How many times are shut by hand from today on — for the summary line. */
export function closedCount(rules, todayYmd) {
  let n = 0;
  for (const [date, day] of Object.entries(pruneRules(rules, todayYmd))) {
    void date;
    for (const v of Object.values(day)) if (v === false) n += 1;
  }
  return n;
}
