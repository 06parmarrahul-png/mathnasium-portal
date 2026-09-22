/**
 * The Ratio Calendar — one date-shaped view of everything the centre has
 * already agreed to, plus the things management schedules for each other.
 *
 * WHY A NEW COLLECTION RATHER THAN REUSING centers/{id}/events
 *   A centre event is an announcement with a date on it: a staff meeting,
 *   a fun day, a training session, posted for everyone to read. It has no
 *   owner and nothing depends on it.
 *
 *   A calendar entry is a commitment. It is assigned to named people, and
 *   it can HOLD THE BOOKING PAGE — take real time out of the public grid
 *   so no family is offered a slot that runs into it. That is a different
 *   kind of object with a different blast radius, and giving it its own
 *   collection is what lets the Firestore rules say "a Host may add a fun
 *   day" and "a Host may not close Friday afternoon to bookings" without
 *   the two rules fighting over one document shape.
 *
 * NOTHING HERE IS TYPED TWICE. The calendar READS what already exists:
 *   stat holidays / closures  centerConfig.holidays
 *   fun days, meetings        centers/{centerId}/events
 *   time off                  timeOffRequests (approved only)
 *   assessments               centerIntakes
 *   shifts                    shifts
 * Only entries — the assignable things — are stored here.
 *
 * SHAPE — `centers/{centerId}/calendar/{id}`
 *   {
 *     title:        'Radius training',
 *     kind:         'meeting' | 'training' | 'call' | 'interview'
 *                   | 'assessment' | 'task' | 'hold',
 *     date:         '2026-09-25',        // required, centre-local
 *     startTime:    '15:00' | null,      // null on an all-day entry
 *     endTime:      '17:00' | null,
 *     allDay:       false,
 *     assignedTo:   ['uid1', 'uid2'],    // may be empty — unassigned is fine
 *     assignedNames:['Neeru Gill', …],   // denormalised for display
 *     holdsBooking: true,                // ← the one with teeth
 *     seriesId:     'abc123' | null,     // set on every entry in a series
 *     repeat:       'weekly' | null,     // the rule, copied onto each one
 *     repeatUntil:  '2027-06-30' | null,
 *     location:     '', note:  '',
 *     createdAt, createdBy, updatedAt, updatedBy
 *   }
 *
 * THE HOLD RULE, WHICH IS THE WHOLE POINT
 *   A held entry is handed to the booking engine as one more busy block,
 *   alongside the real bookings, and the collision check that already
 *   refuses a double-booking refuses these the same way.
 *
 *   It is NOT counted toward the centre's per-day assessment cap. Those
 *   two lists have to stay separate: api/_lib/intakeAvailability.js counts
 *   everything in `bookedSlots` against the cap, so folding holds in there
 *   would make one staff meeting eat one of Friday's two assessments.
 *   Only a real assessment counts against the cap. See holdBlocks() and
 *   the `holds` argument on computeWeekSlots.
 *
 * RECURRENCE IS MATERIALISED, NOT A RULE ON ONE DOCUMENT.
 *   A weekly meeting writes one document per occurrence, linked by
 *   `seriesId`. That costs more rows than an RRULE on a single doc, and it
 *   is the only shape that is CORRECT here: api/intakes.js finds holds with
 *   a `date >= … <= …` range query, and a rule-bearing document has exactly
 *   one `date`. Store the rule alone and a recurring hold would block the
 *   first week and then silently stop — the failure nobody notices until a
 *   family books over the management meeting. Every read path in the app
 *   and on the server already understands a dated row, so materialising
 *   needs no change anywhere else.
 */

/* ── Kinds ────────────────────────────────────────────────────────────── */

export const KINDS = {
  assessment: { key: 'assessment', label: 'Assessment', colorVar: '--nl-ok',   washVar: '--nl-okw'   },
  meeting:    { key: 'meeting',    label: 'Meeting',    colorVar: '--nl-note', washVar: '--nl-notew' },
  training:   { key: 'training',   label: 'Training',   colorVar: '--nl-note', washVar: '--nl-notew' },
  call:       { key: 'call',       label: 'Call',       colorVar: '--nl-warn', washVar: '--nl-warnw' },
  interview:  { key: 'interview',  label: 'Interview',  colorVar: '--nl-warn', washVar: '--nl-warnw' },
  task:       { key: 'task',       label: 'Task',       colorVar: '--nl-muted', washVar: '--nl-raised' },
  // "Just a hold" — no meeting, no attendee, only time taken off the
  // booking page. A director blocking Friday afternoon to catch up.
  hold:       { key: 'hold',       label: 'Just a hold', colorVar: '--nl-muted', washVar: '--nl-raised' },
};

export const KIND_LIST = Object.values(KINDS);

export function kindLabel(kind) {
  return KINDS[kind]?.label || KINDS.task.label;
}

/** CSS custom-property names, so a kind is coloured by the .nl tokens. */
export function kindTone(kind) {
  const k = KINDS[kind] || KINDS.task;
  return { color: `var(${k.colorVar})`, wash: `var(${k.washVar})` };
}

/* ── Recurrence ───────────────────────────────────────────────────────── */

export const REPEAT_RULES = {
  none:       { id: 'none',       label: 'Does not repeat', days: 0 },
  weekly:     { id: 'weekly',     label: 'Every week',      days: 7 },
  biweekly:   { id: 'biweekly',   label: 'Every 2 weeks',   days: 14 },
  fourweekly: { id: 'fourweekly', label: 'Every 4 weeks',   days: 28 },
  // Same weekday, same position in the month — "the third Wednesday",
  // which is what people mean by a monthly meeting. NOT the same date.
  monthly:    { id: 'monthly',    label: 'Every month',     days: 0 },
};

export const REPEAT_LIST = Object.values(REPEAT_RULES);
export const repeatLabel = (id) => REPEAT_RULES[id]?.label || REPEAT_RULES.none.label;
export const isRepeating = (id) => !!REPEAT_RULES[id] && id !== 'none';

/** How far ahead a series is written, and the hard ceiling on one. */
export const DEFAULT_HORIZON_MONTHS = 12;
export const MAX_OCCURRENCES = 200;

/** The date a series runs to when nobody picks one. */
export function defaultUntil(startISO, months = DEFAULT_HORIZON_MONTHS) {
  const d = asDate(startISO);
  if (!d) return startISO;
  return toISO(new Date(d.getFullYear(), d.getMonth() + months, d.getDate(), 12, 0, 0));
}

/** Which occurrence of its own weekday a date is in its month: 1–5. */
export function weekdayOrdinal(iso) {
  const d = asDate(iso);
  return d ? Math.floor((d.getDate() - 1) / 7) + 1 : null;
}

/**
 * The nth <weekday> of a month, or null when the month has no such day.
 *
 * A meeting on the fifth Wednesday simply does not happen in a month with
 * four. Returning null rather than falling back to the fourth is the
 * honest answer — sliding it would put a meeting in someone's calendar on
 * a day nobody agreed to.
 */
export function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
  const first = new Date(year, monthIndex, 1, 12, 0, 0);   // normalises overflow
  const y = first.getFullYear();
  const m = first.getMonth();
  const offset = (weekday - first.getDay() + 7) % 7;
  const probe = new Date(y, m, 1 + offset + (n - 1) * 7, 12, 0, 0);
  return probe.getMonth() === m ? probe : null;
}

/** The date after this one under the rule, or null if there isn't one. */
export function nextOccurrence(iso, freq, anchorISO = iso) {
  const rule = REPEAT_RULES[freq];
  if (!rule || freq === 'none') return null;
  if (rule.days) return addDays(iso, rule.days);
  const anchor = asDate(anchorISO);
  const cur = asDate(iso);
  if (!anchor || !cur) return null;
  const n = weekdayOrdinal(anchorISO);
  for (let ahead = 1; ahead <= 12; ahead += 1) {
    const hit = nthWeekdayOfMonth(cur.getFullYear(), cur.getMonth() + ahead, anchor.getDay(), n);
    if (hit) return toISO(hit);
  }
  return null;
}

/**
 * Every date a series lands on.
 *
 * `skip` is the centre's closures. A later occurrence falling on one is
 * dropped, not moved — a meeting does not happen on a day the centre is
 * shut, and sliding it to the Thursday would put it in diaries nobody
 * agreed to.
 *
 * THE START DATE IS ALWAYS KEPT, even if it is a closure. Somebody chose
 * that exact day; dropping it could return an empty series, and "I pressed
 * save and nothing appeared" is a worse answer than one meeting on an
 * unusual day that they can see and move.
 */
export function occurrenceDates({
  startISO, freq = 'none', untilISO = null, skip = [], max = MAX_OCCURRENCES,
} = {}) {
  if (!asDate(startISO)) return { dates: [], skipped: [], truncated: false };
  if (!isRepeating(freq)) return { dates: [startISO], skipped: [], truncated: false };

  const skipSet = skip instanceof Set ? skip : new Set(skip || []);
  const until = asDate(untilISO) ? untilISO : defaultUntil(startISO);
  if (until < startISO) return { dates: [startISO], skipped: [], truncated: false };

  const dates = [];
  const skipped = [];
  let cursor = startISO;
  let guard = 0;
  while (cursor && cursor <= until && guard < max * 2 + 120) {
    guard += 1;
    if (dates.length && skipSet.has(cursor)) {
      skipped.push(cursor);
    } else {
      if (dates.length >= max) return { dates, skipped, truncated: true };
      dates.push(cursor);
    }
    cursor = nextOccurrence(cursor, freq, startISO);
  }
  return { dates, skipped, truncated: false };
}

/** A plain-words summary of what pressing save will create. */
export function describeSeries({ dates, skipped, truncated }, freq, untilISO) {
  if (!dates?.length) return '';
  if (dates.length === 1) return 'Just the one.';
  const when = asDate(dates[dates.length - 1]);
  const last = when ? when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : untilISO;
  let out = `${dates.length} entries, ${repeatLabel(freq).toLowerCase()}, through ${last}.`;
  if (skipped?.length) out += ` ${skipped.length} skipped — the centre is closed.`;
  if (truncated) out += ` Stopped at ${MAX_OCCURRENCES}.`;
  return out;
}

/* ── Times ────────────────────────────────────────────────────────────── */

/** "15:30" → 930. Anything unparseable → null, and callers drop it. */
export function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 930 → "15:30". The inverse, for building an ISO the engine accepts. */
export function hhmm(mins) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(mins)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Local-noon parse. A bare YYYY-MM-DD is UTC midnight — the day before here. */
export function asDate(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0);
}

const pad = (n) => String(n).padStart(2, '0');
export function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Move a YYYY-MM-DD by whole days, staying on the local calendar. */
export function addDays(iso, n) {
  const d = asDate(iso);
  if (!d) return iso;
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** The Sunday on or before this date — the week the grids draw. */
export function weekStartOf(iso) {
  const d = asDate(iso);
  if (!d) return iso;
  return addDays(iso, -d.getDay());
}

/* ── Entries ──────────────────────────────────────────────────────────── */

/** An entry needs a title and a real date before it is worth drawing. */
export function isUsableEntry(e) {
  return !!(e && String(e.title || '').trim() && asDate(e.date));
}

/**
 * The minutes an entry occupies, or null for an all-day one.
 *
 * An entry missing either end is treated as all-day rather than guessed
 * at — a half-known time would draw a bar in the wrong place, and a bar
 * in the wrong place is worse than a band across the top.
 */
export function entrySpan(e) {
  if (!e || e.allDay) return null;
  const s = minutesOf(e.startTime);
  const t = minutesOf(e.endTime);
  if (s == null || t == null || t <= s) return null;
  return { start: s, end: t };
}

/** Validation for the composer. Returns an error string, or null. */
export function validateEntry(draft) {
  if (!String(draft?.title || '').trim()) return 'Give it a name.';
  if (!asDate(draft?.date)) return 'Pick a date.';
  if (draft?.allDay) return null;
  const s = minutesOf(draft?.startTime);
  const e = minutesOf(draft?.endTime);
  if (s == null) return 'Add a start time, or mark it all day.';
  if (e == null) return 'Add an end time, or mark it all day.';
  if (e <= s) return 'It has to end after it starts.';
  // A hold that covers no time holds nothing, which is the kind of
  // silent no-op someone only notices when a family books over it.
  if (draft?.holdsBooking && e - s < 5) return 'A hold needs to cover at least five minutes.';
  return null;
}

/** Date-then-time ordering. All-day sorts first — it frames the day. */
export function byWhen(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const am = entrySpan(a)?.start ?? null;
  const bm = entrySpan(b)?.start ?? null;
  if (am == null && bm == null) return 0;
  if (am == null) return -1;
  if (bm == null) return 1;
  return am - bm;
}

export function entriesBetween(entries, from, to) {
  return (entries || [])
    .filter(isUsableEntry)
    .filter(e => e.date >= from && e.date <= to)
    .sort(byWhen);
}

/* ── Holds → busy blocks ──────────────────────────────────────────────── */

/**
 * The entries that hold the booking page, as busy blocks the slot engine
 * understands: `{ startISO, durationMin }`, the same shape a real booking
 * takes. An all-day hold covers the whole day.
 *
 * DELIBERATELY the same output shape as `bookedSlots`, and DELIBERATELY a
 * separate list. See the hold rule at the top of this file: these collide
 * with candidate slots but never count against the per-day cap.
 *
 * The server computes this again in api/intakes.js rather than importing
 * it — a Vercel function with no cross-bundle imports is the standing rule
 * in api/_lib. intakeAvailability.test.js and this file's tests run the
 * same fixture so the two cannot drift quietly.
 */
export function holdBlocks(entries, { from = null, to = null } = {}) {
  const out = [];
  for (const e of entries || []) {
    if (!isUsableEntry(e) || !e.holdsBooking) continue;
    if (from && e.date < from) continue;
    if (to && e.date > to) continue;
    const span = entrySpan(e);
    if (span) {
      out.push({
        startISO: `${e.date}T${hhmm(span.start)}:00`,
        durationMin: span.end - span.start,
        source: 'calendar',
        title: e.title,
      });
    } else {
      out.push({
        startISO: `${e.date}T00:00:00`,
        durationMin: 24 * 60,
        source: 'calendar',
        title: e.title,
      });
    }
  }
  return out;
}

/**
 * Which slot start times a hold takes off the booking page, so the
 * composer can tell someone what they are about to do BEFORE they save it.
 *
 * `windows` is the day's booking windows ([{ start, end }] as "HH:MM"),
 * which is what resolveInstructionalHours gives for that date.
 *
 * Mirrors slotStartsForDay + isSlotTaken in api/_lib/intakeAvailability.js.
 * A slot is blocked when the assessment that would start there overlaps
 * the hold at all — so a 60-minute assessment at 4:30 is blocked by a
 * hold that ends at 5:00, which is the part people get wrong by hand.
 */
export function blockedStarts({
  windows = [], startTime, endTime, allDay = false,
  slotDurationMin = 60, slotIntervalMin = 30,
}) {
  const starts = [];
  for (const w of windows || []) {
    const ws = minutesOf(w?.start);
    const we = minutesOf(w?.end);
    if (ws == null || we == null) continue;
    for (let t = ws; t <= we - slotDurationMin; t += slotIntervalMin) starts.push(t);
  }
  if (allDay) return starts.map(hhmm);

  const hs = minutesOf(startTime);
  const he = minutesOf(endTime);
  if (hs == null || he == null || he <= hs) return [];
  return starts.filter(t => t < he && hs < t + slotDurationMin).map(hhmm);
}

/* ── Closures ─────────────────────────────────────────────────────────── */

/**
 * The centre's configured closures inside a window, as
 * `{ 'YYYY-MM-DD': { name, stat } }`.
 *
 * These already exist in Centre Settings · Holidays. Until now the public
 * booking page never read them, so a family could book an assessment on a
 * statutory holiday — the weekday had instructional hours and nothing said
 * the centre was shut. Feeding this to the slot engine is what closes it.
 */
export function closureMap(holidays, from = null, to = null) {
  const out = {};
  for (const h of holidays || []) {
    if (!h?.date) continue;
    if (from && h.date < from) continue;
    if (to && h.date > to) continue;
    out[h.date] = { name: h.name || 'Centre closed', stat: h.stat !== false };
  }
  return out;
}

/* ── The merged day ───────────────────────────────────────────────────── */

/**
 * Everything on one date as a single ordered list, each row tagged with
 * where it came from. The rows are read-only apart from `kind: 'entry'` —
 * a fun day is edited on Centre Events, a closure in Centre Settings, a
 * shift on the staff schedule. The calendar shows them; it does not own
 * them, and pretending otherwise is how the same thing ends up stored in
 * two places disagreeing with itself.
 */
export function rowsForDate({
  dateISO, entries = [], events = [], intakes = [], timeOff = [], holidays = [],
}) {
  const rows = [];

  const closure = closureMap(holidays)[dateISO];
  if (closure) {
    rows.push({
      source: 'closure', id: `closure-${dateISO}`, date: dateISO, allDay: true,
      title: closure.name,
      note: closure.stat ? 'Statutory — centre closed' : 'Centre closed',
      holdsBooking: true,
    });
  }

  for (const e of entriesBetween(entries, dateISO, dateISO)) {
    rows.push({ ...e, source: 'entry', allDay: !entrySpan(e) });
  }

  for (const ev of events || []) {
    if (!ev?.date || ev.date !== dateISO || !String(ev.title || '').trim()) continue;
    rows.push({
      source: 'event', id: ev.id, date: ev.date, title: ev.title,
      kind: ev.type === 'fun-day' ? 'fun-day' : (ev.type || 'other'),
      startTime: ev.startTime || null, endTime: ev.endTime || null,
      allDay: minutesOf(ev.startTime) == null,
      note: ev.note || '',
    });
  }

  for (const t of intakes || []) {
    const slot = String(t?.slot || '');
    if (slot.slice(0, 10) !== dateISO) continue;
    if (t.status === 'cancelled') continue;
    const start = slot.slice(11, 16);
    const s = minutesOf(start);
    rows.push({
      source: 'intake', id: t.id, date: dateISO, kind: 'assessment',
      title: t.childName ? `Assessment — ${t.childName}` : 'Assessment',
      startTime: start || null,
      endTime: s == null ? null : hhmm(s + (t.durationMin || 60)),
      allDay: s == null,
      note: t.guardianName || '',
    });
  }

  for (const r of timeOff || []) {
    if (r?.status !== 'approved') continue;
    const from = r.startDate || r.date;
    const to = r.endDate || r.date;
    if (!from || dateISO < from || dateISO > (to || from)) continue;
    rows.push({
      source: 'timeoff', id: `off-${r.id}-${dateISO}`, date: dateISO, allDay: true,
      title: `${r.userName || 'Someone'} — time off`,
      kind: 'timeoff',
    });
  }

  return rows.sort(byWhen);
}

/** The layers the rail can switch off. Order is the order they're listed. */
export const LAYERS = [
  { id: 'assessment', label: 'Assessments',        sources: ['intake'] },
  { id: 'entry',      label: 'Entries',            sources: ['entry'] },
  { id: 'event',      label: 'Centre events',      sources: ['event'] },
  { id: 'timeoff',    label: 'Time off',           sources: ['timeoff'] },
  { id: 'closure',    label: 'Closures & holidays', sources: ['closure'] },
];
