// Shared helpers for the native intake booking flow. Used by:
//   - api/intakes/availability.js  (public slot grid)
//   - api/intakes/create.js        (server-side double-check before save)
//
// Pure functions, no Firestore reads — caller passes settings + booked
// intakes and we return a slot list.

export const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// Default settings. By default we DO NOT carry a per-day availability
// map — we inherit from centerConfig.instructionalHours so the booking
// hours stay in sync with the centre's teaching window. Owners can flip
// useCustomAvailability=true and supply their own map to override.
export const DEFAULT_INTAKE_SETTINGS = {
  enabled: false,
  slotDurationMin: 60,
  slotIntervalMin: 30,
  advanceNoticeHrs: 24,   // can't book < 24h out
  maxAdvanceDays: 60,
  timezone: 'America/Vancouver',
  // If false (default), booking hours follow centerConfig.instructionalHours.
  // If true, `availability` below takes over. Lets centres with separate
  // intake hours from teaching hours opt out.
  useCustomAvailability: false,
  availability: {
    Sunday: [], Monday: [], Tuesday: [], Wednesday: [],
    Thursday: [], Friday: [], Saturday: [],
  },
  // How many assessments the centre will take in one day. null = as many
  // as the hours allow, which is how every centre behaved before this
  // existed — so an untouched config keeps its old behaviour.
  //
  // Two fields rather than one, because the ask is "three a day, but two
  // on Fridays": the first is the everyday number, the second overrides
  // it on named days only. A weekday left null follows the everyday one.
  maxIntakesPerDay: null,
  maxIntakesPerWeekday: {
    Sunday: null, Monday: null, Tuesday: null, Wednesday: null,
    Thursday: null, Friday: null, Saturday: null,
  },
  // Marketing copy on the public booking page. Centre-overridable.
  headline:    'Book Your Free Math Skills Assessment Today!',
  subheadline: 'Book a 60-minute consultation to see how we can support your child. We\'ll assess their math skills, spot any gaps, and create a personalized learning plan!',
};

/**
 * How many assessments this weekday will take. null means no limit.
 *
 * A per-weekday entry wins over the everyday number; blank, null or
 * undefined there means "no opinion, use the everyday one". 0 is a real
 * answer and means the day is closed to booking — which is why this
 * cannot just test for falsiness.
 */
export function intakeCapFor(settings, weekday) {
  const s = settings || {};
  const override = (s.maxIntakesPerWeekday || {})[weekday];
  const blank = (v) => v === null || v === undefined || v === '';
  const raw = blank(override) ? s.maxIntakesPerDay : override;
  // Checked BEFORE Number(), because Number(null) is 0 and 0 is a real
  // cap here — "no cap set" would have closed booking at every centre.
  if (blank(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Assessments already booked on one local date.
 *
 * `startISO` is a wall-clock string in the centre's own day ("2026-09-26
 * T11:00:00", no zone) — that is what the grid builds and what the create
 * path stores — so the first ten characters ARE the centre's date. Going
 * through Date here would reinterpret it in the server's zone and push
 * evening bookings onto the next day.
 */
export function countIntakesOn(bookedSlots, ymd) {
  let n = 0;
  for (const b of (bookedSlots || [])) {
    if (!b || b.status === 'cancelled') continue;
    if (typeof b.startISO === 'string' && b.startISO.slice(0, 10) === ymd) n += 1;
  }
  return n;
}

// Translate centerConfig.instructionalHours ({ Monday: { start, end }, ... })
// into the per-day windows shape this module uses (each day → array of
// { start, end } windows). One window per day = the instructional window.
export function instructionalHoursToWindows(instructionalHours) {
  const out = { Sunday: [], Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [] };
  if (!instructionalHours || typeof instructionalHours !== 'object') return out;
  for (const day of WEEKDAYS) {
    const h = instructionalHours[day];
    if (h && h.start && h.end) out[day] = [{ start: h.start, end: h.end }];
  }
  return out;
}

// Server-side mirror of src/lib/centerConfig.js resolveInstructionalHours.
// Returns the EFFECTIVE per-day instructional hours map for a specific
// date, applying any active summer override. Kept here (rather than
// imported from the frontend) so this serverless function has no
// cross-bundle imports.
export function effectiveInstructionalHoursForDate(instructionalHours, summerOverride, ymd) {
  const base = instructionalHours || {};
  if (!summerOverride || !summerOverride.from || !summerOverride.to || !summerOverride.byDay) {
    return base;
  }
  if (!ymd || ymd < summerOverride.from || ymd > summerOverride.to) return base;
  return { ...base, ...summerOverride.byDay };
}

// Build the effective availability the slot engine should use, given
// owner settings + centre instructional hours. Either inherits from
// instructional hours (default) or uses the custom override.
export function effectiveAvailability(settings, instructionalHours) {
  const s = settings || {};
  if (s.useCustomAvailability && s.availability) {
    return {
      Sunday: [], Monday: [], Tuesday: [], Wednesday: [],
      Thursday: [], Friday: [], Saturday: [],
      ...s.availability,
    };
  }
  return instructionalHoursToWindows(instructionalHours);
}

// Convert "HH:MM" → minutes since midnight.
const hmToMin = (hm) => {
  const [h, m] = (hm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

// YYYY-MM-DD → Date at midnight UTC (we treat ISO strings as wall-clock
// for the centre's TZ; this is "good enough" for week-grid display —
// we're not crossing DST boundaries within a single booking flow).
const ymdToDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
};

// Format a Date as YYYY-MM-DD using UTC components.
const dateToYmd = (d) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

// Build ISO datetime from YYYY-MM-DD + minutes-since-midnight. We emit
// without a TZ suffix because the consumer (the front-end grid) only
// uses the local wall-clock — the actual confirmed booking re-derives
// a TZ-aware moment when it lands in Firestore.
const buildISO = (ymd, minutes) => {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${ymd}T${h}:${m}:00`;
};

// Enumerate all candidate slot start times for one day given the centre's
// windows. Returns minute-since-midnight integers.
function slotStartsForDay(windows, slotDurationMin, slotIntervalMin) {
  const starts = [];
  for (const w of (windows || [])) {
    const startMin = hmToMin(w.start);
    const endMin   = hmToMin(w.end);
    // Last allowed start time = window end - slot duration.
    const last = endMin - slotDurationMin;
    for (let t = startMin; t <= last; t += slotIntervalMin) starts.push(t);
  }
  return starts;
}

// Decide whether a candidate slot collides with any existing booked
// intake. `bookedSlots` is an array of { startISO, durationMin }.
function isSlotTaken(candidateISO, slotDurationMin, bookedSlots) {
  const candStart = Date.parse(candidateISO);
  const candEnd   = candStart + slotDurationMin * 60 * 1000;
  for (const b of bookedSlots) {
    const bStart = Date.parse(b.startISO);
    const bEnd   = bStart + (b.durationMin || slotDurationMin) * 60 * 1000;
    if (candStart < bEnd && bStart < candEnd) return true; // overlap
  }
  return false;
}

/**
 * Compute the slot grid for a 7-day window starting at `weekStartYMD`.
 *
 * @param {string} weekStartYMD          - YYYY-MM-DD (Sunday)
 * @param {object} settings              - intake settings (see DEFAULT_INTAKE_SETTINGS)
 * @param {Array}  bookedSlots           - [{ startISO, durationMin, status }]
 * @param {object} instructionalHours    - centerConfig.instructionalHours (fallback source for availability)
 * @param {object} summerOverride        - centerConfig.summerHours2026 (applied per-date when in window)
 * @returns {Array} day rows
 */
export function computeWeekSlots(weekStartYMD, settings, bookedSlots = [], instructionalHours = null, summerOverride = null) {
  const s = { ...DEFAULT_INTAKE_SETTINGS, ...(settings || {}) };
  const slotDur  = s.slotDurationMin  || 60;
  const slotInt  = s.slotIntervalMin  || 30;
  const noticeMs = (s.advanceNoticeHrs || 0) * 3600 * 1000;
  const maxFuture = Date.now() + (s.maxAdvanceDays || 60) * 24 * 3600 * 1000;
  const nowMs    = Date.now() + noticeMs;

  // Ignore cancelled bookings so the slot reopens.
  const active = bookedSlots.filter(b => b.status !== 'cancelled');

  const out = [];
  const start = ymdToDate(weekStartYMD);
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const ymd = dateToYmd(d);
    const weekday = WEEKDAYS[d.getUTCDay()];
    // Resolve the day's windows per-date. When the owner uses a custom
    // availability override (useCustomAvailability=true), it takes
    // precedence as before. Otherwise we apply the summer override to
    // instructional hours on a per-date basis — so Tuesday July 7 reads
    // 10–14 while Tuesday September 8 reads 15–19.
    let windows;
    if (s.useCustomAvailability && s.availability) {
      windows = (s.availability[weekday] || []);
    } else {
      const hoursForDate = effectiveInstructionalHoursForDate(instructionalHours, summerOverride, ymd);
      windows = instructionalHoursToWindows(hoursForDate)[weekday] || [];
    }
    // A day at its cap closes entirely, even though the hours are open
    // and the individual times are free.
    const cap = intakeCapFor(s, weekday);
    const dayFull = cap !== null && countIntakesOn(active, ymd) >= cap;

    const slots = [];
    for (const minutes of slotStartsForDay(windows, slotDur, slotInt)) {
      const iso = buildISO(ymd, minutes);
      const tMs = Date.parse(iso);
      const inPast    = tMs < nowMs;
      const tooFuture = tMs > maxFuture;
      const taken     = isSlotTaken(iso, slotDur, active);
      slots.push({
        startISO: iso,
        label:    formatTimeLabel(minutes),
        taken,
        inPast,
        tooFuture,
        dayFull,
        available: !taken && !inPast && !tooFuture && !dayFull,
      });
    }
    out.push({ date: ymd, weekday, dayFull, slots });
  }
  return out;
}

function formatTimeLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}:00${ampm}` : `${h12}:${String(m).padStart(2,'0')}${ampm}`;
}

// Validate that a candidate slot the parent picked is still bookable —
// runs server-side before we insert the doc so a stale browser tab can't
// race to double-book.
export function validateSlot({ slotISO, settings, bookedSlots, instructionalHours, summerOverride = null }) {
  const s = { ...DEFAULT_INTAKE_SETTINGS, ...(settings || {}) };
  const slotDur  = s.slotDurationMin  || 60;
  const noticeMs = (s.advanceNoticeHrs || 0) * 3600 * 1000;
  const maxFuture = Date.now() + (s.maxAdvanceDays || 60) * 24 * 3600 * 1000;

  const tMs = Date.parse(slotISO);
  if (isNaN(tMs))          return { ok: false, error: 'Invalid slot time.' };
  if (tMs < Date.now() + noticeMs) return { ok: false, error: 'Slot is too close to now (less than the centre\'s advance-notice window).' };
  if (tMs > maxFuture)     return { ok: false, error: 'Slot is too far in the future.' };

  // Day-of-week window check, resolved per-date so a summer-window
  // booking is validated against the override (not the year-round hours).
  //
  // The date, weekday and time are read STRAIGHT OFF THE STRING rather
  // than through Date. A slot is a wall-clock time in the centre's own
  // day with no zone on it ("2026-09-25T17:00:00"), so Date parses it in
  // the server's zone — and the UTC getters below then shifted the day,
  // the weekday and the hour by that offset. It matched only because
  // Vercel runs in UTC; on any other runtime a Friday evening booking
  // validated as Saturday. Off the string it is right on both.
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(slotISO));
  if (!parts) return { ok: false, error: 'Invalid slot time.' };
  const ymd     = `${parts[1]}-${parts[2]}-${parts[3]}`;
  const weekday = WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
  let windows;
  if (s.useCustomAvailability && s.availability) {
    windows = (s.availability[weekday] || []);
  } else {
    const hoursForDate = effectiveInstructionalHoursForDate(instructionalHours, summerOverride, ymd);
    windows = instructionalHoursToWindows(hoursForDate)[weekday] || [];
  }
  if (windows.length === 0) return { ok: false, error: 'The centre is closed that day.' };
  const minutes = Number(parts[4]) * 60 + Number(parts[5]);
  const inAnyWindow = windows.some(w => {
    const ws = hmToMin(w.start); const we = hmToMin(w.end);
    return minutes >= ws && minutes + slotDur <= we;
  });
  if (!inAnyWindow) return { ok: false, error: 'Slot is outside the centre\'s booking window.' };

  const active = (bookedSlots || []).filter(b => b.status !== 'cancelled');

  // Day cap, checked BEFORE the collision below: when a day is full every
  // time on it is unbookable, and "that day is full" sends a parent to
  // another day, where "that time was taken" would send them to another
  // time on the same full day.
  const cap = intakeCapFor(s, weekday);
  if (cap !== null && countIntakesOn(active, ymd) >= cap) {
    return { ok: false, error: 'That day is fully booked. Please pick another day.' };
  }

  // Collision check.
  if (isSlotTaken(slotISO, slotDur, active)) {
    return { ok: false, error: 'That slot was just booked by someone else. Please pick another time.' };
  }

  return { ok: true };
}
