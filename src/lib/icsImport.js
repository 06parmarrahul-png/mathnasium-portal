/**
 * Bringing a Google Calendar into Ratio.
 *
 * WHERE AN IMPORTED ASSESSMENT HAS TO LAND, AND WHY IT IS NOT HERE
 *   An assessment is NOT a calendar entry. It is a `centerIntakes`
 *   document, and the difference is load-bearing:
 *
 *     - api/intakes.js builds `bookedSlots` from centerIntakes ALONE.
 *       An assessment filed as a calendar entry does not occupy its slot,
 *       so the public booking page would cheerfully sell the same hour to
 *       a second family.
 *     - The per-day cap ("three a day, two on Fridays") counts intakes.
 *     - The Intakes page and the Leads funnel both read centerIntakes.
 *
 *   So this module routes an assessment to centerIntakes and everything
 *   else to the calendar. The Calendar page already READS centerIntakes
 *   and draws them green, so writing to the right collection puts them on
 *   the calendar for free — and keeps the booking page honest.
 *
 * WHY A FILE RATHER THAN THE GOOGLE API
 *   A real two-way sync needs OAuth, refresh tokens and a webhook, which
 *   is two or three serverless routes — and `api/` is at exactly 12, the
 *   Vercel cap. An exported .ics is parsed here, in the browser, and costs
 *   nothing. Google Calendar → Settings → Import & export → Export.
 *
 * NOTHING IS WRITTEN WITHOUT BEING READ FIRST
 *   Guardian and child names are not structured fields in a calendar
 *   event; they are prose somebody's booking tool wrote into SUMMARY and
 *   DESCRIPTION. Every extraction here is a guess, so every row goes to a
 *   review table where the fields are editable before a single document
 *   is written. Silently attaching a wrong parent's name to a real child
 *   is the kind of confidently-wrong this portal has deleted features over.
 *
 * RE-RUNNING IS SAFE. Each event carries a UID, which is stored as
 * `sourceUid` on whatever gets created; a second import skips anything
 * already brought in.
 */

/* ── iCalendar parsing ────────────────────────────────────────────────── */
//
// Same shape as the Acuity parser in api/scheduler/appointments.js, which
// has been run against a 6.8 MB, 16,000-event feed. Kept separate rather
// than shared because that one is a serverless function and may not import
// from src/ — the standing rule in api/_lib.

/** RFC 5545 folds long lines with a leading space. Put them back. */
export function unfold(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else out.push(line);
  }
  return out;
}

export function unescapeIcal(v) {
  return String(v || '')
    .replace(/\\n/gi, '\n').replace(/\\,/g, ',')
    .replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseProp(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.split(';');
  const params = {};
  for (let j = 1; j < parts.length; j += 1) {
    const eq = parts[j].indexOf('=');
    if (eq > 0) params[parts[j].slice(0, eq).toUpperCase()] = parts[j].slice(eq + 1);
  }
  return { name: parts[0].toUpperCase(), params, value };
}

/* ── Timezones ────────────────────────────────────────────────────────── */
//
// A shift, an intake slot and a calendar entry are all stored as the
// CENTRE'S OWN WALL CLOCK. A Google event is a UTC instant, or a wall
// clock plus a TZID. Storing "19:00" for an event that reads 19:00Z would
// put a noon assessment at seven in the evening, so both forms are
// converted properly, DST included.

function tzOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - (date.getTime() - date.getMilliseconds());
}

/** A wall clock in `timeZone` → the true UTC instant, DST included. */
export function zonedToUtc(y, mo, d, h, mi, timeZone) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const off1 = tzOffsetMs(timeZone, guess);
  let out = new Date(guess.getTime() - off1);
  const off2 = tzOffsetMs(timeZone, out);
  if (off2 !== off1) out = new Date(guess.getTime() - off2);
  return out;
}

/** A UTC instant → the centre's own wall clock, as `{ date, time }`. */
export function toCentreLocal(instant, timeZone) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null;
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * One DTSTART / DTEND value plus its params → a UTC instant.
 *
 * Three forms appear in the wild and all three turn up in a Google export:
 *   20260923T190000Z                     a UTC instant
 *   TZID=America/Vancouver:20260923T120000   a wall clock somewhere
 *   VALUE=DATE:20260923                  an all-day event
 */
export function parseIcsDate(value, params = {}, fallbackTz = 'UTC') {
  const v = String(value || '').trim();
  if (/^\d{8}$/.test(v)) {
    return {
      allDay: true,
      instant: new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8))),
      ymd: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`,
    };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, z] = m;
  if (z === 'Z') {
    return { allDay: false, instant: new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S)) };
  }
  const tz = params.TZID || fallbackTz;
  let instant;
  try {
    instant = zonedToUtc(+Y, +Mo, +D, +H, +Mi, tz);
  } catch {
    // An unknown TZID would otherwise throw and lose the whole file.
    instant = zonedToUtc(+Y, +Mo, +D, +H, +Mi, fallbackTz);
  }
  return { allDay: false, instant };
}

/** Every VEVENT in the file, unparsed values kept alongside the parsed ones. */
export function parseIcs(text, { timeZone = 'America/Vancouver' } = {}) {
  const out = [];
  let cur = null;
  let depth = 0;
  for (const line of unfold(text)) {
    const t = line.trim();
    if (t === 'BEGIN:VEVENT') { cur = { props: new Map(), params: new Map() }; depth = 1; continue; }
    if (t === 'END:VEVENT') {
      if (cur) out.push(finishEvent(cur, timeZone));
      cur = null; depth = 0; continue;
    }
    // A VALARM inside the event has its own TRIGGER/DESCRIPTION; taking
    // those would overwrite the event's own description with "Reminder".
    if (cur && t === 'BEGIN:VALARM') { depth += 1; continue; }
    if (cur && t === 'END:VALARM') { depth -= 1; continue; }
    if (!cur || depth !== 1) continue;
    const p = parseProp(line);
    if (!p) continue;
    cur.props.set(p.name, p.value);
    cur.params.set(p.name, p.params);
  }
  return out.filter(Boolean);
}

function finishEvent(cur, timeZone) {
  const get = (k) => cur.props.get(k) || '';
  const start = parseIcsDate(get('DTSTART'), cur.params.get('DTSTART') || {}, timeZone);
  if (!start) return null;
  const end = get('DTEND')
    ? parseIcsDate(get('DTEND'), cur.params.get('DTEND') || {}, timeZone)
    : null;

  const local = start.allDay ? { date: start.ymd, time: null } : toCentreLocal(start.instant, timeZone);
  const localEnd = end && !end.allDay ? toCentreLocal(end.instant, timeZone) : null;

  const durationMin = (end && !start.allDay && !end.allDay)
    ? Math.max(5, Math.round((end.instant - start.instant) / 60000))
    : 60;

  return {
    uid: unescapeIcal(get('UID')) || null,
    summary: unescapeIcal(get('SUMMARY')).trim(),
    description: unescapeIcal(get('DESCRIPTION')).trim(),
    location: unescapeIcal(get('LOCATION')).trim(),
    cancelled: (get('STATUS') || '').toUpperCase() === 'CANCELLED',
    // A recurring master would import once and lose every later instance,
    // so it is flagged and shown rather than quietly half-imported.
    recurring: !!get('RRULE'),
    allDay: !!start.allDay,
    date: local?.date || null,
    startTime: start.allDay ? null : (local?.time || null),
    endTime: start.allDay ? null : (localEnd?.time || null),
    durationMin,
  };
}

/* ── What kind of thing is it ─────────────────────────────────────────── */

const PATTERNS = [
  ['assessment', /\b(assessment|assessments|consultation|consult|intake|evaluation|eval|screening|skills? check)\b/i],
  ['interview',  /\b(interview|hiring|candidate)\b/i],
  ['training',   /\b(training|onboarding|pd day|workshop)\b/i],
  ['meeting',    /\b(meeting|huddle|sync|stand[- ]?up|1:1|one[- ]on[- ]one|review)\b/i],
  ['call',       /\b(call|phone|check[- ]?in|follow[- ]?up)\b/i],
];

/** The kind an event looks like. Falls back to a task, never to nothing. */
export function classify(ev) {
  const hay = `${ev?.summary || ''} ${ev?.description || ''}`;
  for (const [kind, re] of PATTERNS) if (re.test(hay)) return kind;
  return 'task';
}

/* ── Pulling names out of prose ───────────────────────────────────────── */
//
// None of this is structured data. Every rule below is a guess at what a
// booking tool wrote, which is exactly why the result is shown for review
// rather than saved.

const LABELS = {
  guardianName: /^\s*(?:parent|guardian|parent\/guardian|contact|booked by)\s*(?:name)?\s*[:-]\s*(.+)$/im,
  childName:    /^\s*(?:child|student|client|kid)\s*(?:name)?\s*[:-]\s*(.+)$/im,
  childGrade:   /^\s*(?:grade|gr|year|level)\s*[:-]\s*(.+)$/im,
  childSchool:  /^\s*(?:school)\s*[:-]\s*(.+)$/im,
  phone:        /^\s*(?:phone|mobile|cell|tel)\s*[:-]\s*(.+)$/im,
  email:        /^\s*(?:e-?mail)\s*[:-]\s*(.+)$/im,
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const GRADE_RE = /\b(?:grade|gr\.?|year)\s*([k0-9]{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\s+grade\b|\b(kindergarten|pre-?k)\b/i;

/** The words that describe the appointment rather than name anybody. */
const NOISE_RE = new RegExp(
  '\\b(free|new|initial|math|mathnasium|assessment|assessments|consultation|consult|intake|'
  + 'evaluation|eval|screening|appointment|appt|session|booking|in[\\s-]?cent(?:re|er)|'
  + 'online|virtual|zoom|langley|with|for|w/|'
  // Booking STATES. A live calendar is full of them, and without these
  // every imported assessment came back named "Booked".
  + 'booked|confirmed|scheduled|rescheduled|pending|tentative|cancell?ed|'
  + 'no[\\s-]?show|not[\\s-]?coming|available|open|slot|hold|held|tbd|tba)\\b', 'gi');

/** "Free Math Assessment - Jane Doe (Grade 5)" → "Jane Doe". */
export function nameFromSummary(summary) {
  let s = String(summary || '');
  s = s.replace(/\([^)]*\)/g, ' ');           // drop parenthetical asides
  s = s.split(/\s[-–—|]\s|:\s+|\s{2,}/).map(part => part.replace(NOISE_RE, ' ').trim())
    .filter(part => /[A-Za-z]/.test(part))
    .sort((a, b) => b.length - a.length)[0] || '';
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').trim();
  return looksLikeAName(s) ? s : '';
}

/**
 * Is this plausibly a person, or is it a note somebody left in a title?
 *
 * The live import produced "Book Your Skills Today!" and "might have 2nd
 * student" as children's names. A name is one to three words and does not
 * shout. Returning '' puts the row in the "needs a name" count, which is
 * the right place for it — better a blank somebody fills than a sentence
 * sitting in the Intakes list where a child's name goes.
 */
export function looksLikeAName(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/[!?]/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 3) return false;
  if (/\d/.test(t)) return false;              // "2nd student", "Room 3"
  return /^[\p{L}][\p{L}'’.-]*$/u.test(words[0]);
}

/** Normalise whatever they wrote as a grade: "5th", "Gr 5", "K". */
export function normaliseGrade(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^k$/i.test(s) || /(kindergarten|pre-?\bk\b)/i.test(s)) return 'K';
  const n = /(\d{1,2})/.exec(s);
  return n ? n[1] : s.slice(0, 24);
}

/**
 * Everything this event seems to say about a family.
 *
 * Labelled lines in the description win, because a tool that wrote
 * "Parent: …" meant it. The summary is only asked when nothing labelled
 * turned up, and what it returns is a guess.
 */
export function extractDetails(ev) {
  const desc = ev?.description || '';
  const both = `${ev?.summary || ''}\n${desc}`;
  const grab = (key) => {
    const m = LABELS[key].exec(desc);
    return m ? m[1].trim() : '';
  };

  const out = {
    guardianName: grab('guardianName'),
    childName: grab('childName'),
    childGrade: normaliseGrade(grab('childGrade')),
    childSchool: grab('childSchool'),
    email: grab('email') || (EMAIL_RE.exec(both)?.[0] || ''),
    phone: grab('phone') || (PHONE_RE.exec(both)?.[0] || ''),
  };
  if (out.email) out.email = (EMAIL_RE.exec(out.email)?.[0] || out.email).toLowerCase();
  if (out.phone) out.phone = PHONE_RE.exec(out.phone)?.[0] || out.phone;

  if (!out.childGrade) {
    const g = GRADE_RE.exec(both);
    if (g) out.childGrade = normaliseGrade(g[1] || g[2] || g[3]);
  }
  // Last resort: whatever in the title is not describing the appointment.
  if (!out.childName) out.childName = nameFromSummary(ev?.summary);
  // A guardian is never guessed from the title — the name in there is
  // the child's far more often than not, and putting a child's name in
  // the parent field is worse than leaving it blank for someone to fill.
  return out;
}

/* ── Narrowing the file down ──────────────────────────────────────────── */
//
// A real Google Calendar export is the WHOLE calendar — Langley's first
// run came back with about 2,110 events, most of them years old. Two
// problems, one fix: nobody can check 2,110 rows, and nobody wants to
// import a calendar's entire history into a live centre.
//
// The range is applied BEFORE the rows are built, not as another skip
// reason, because a skipped row still renders and 2,110 of them is what
// made the table unusable in the first place.

/** Is this event inside the window? Dates are plain YYYY-MM-DD strings. */
export function inDateRange(ev, { from = null, to = null } = {}) {
  const d = ev?.date;
  if (!d) return true;              // unreadable dates are reported, not hidden
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

export function filterEvents(events, range = {}) {
  return (events || []).filter(ev => inDateRange(ev, range));
}

/** The span the file actually covers, so someone can see what they have. */
export function eventDateSpan(events) {
  const dates = (events || []).map(e => e?.date).filter(Boolean).sort();
  return dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null;
}

/**
 * The default window: the first of LAST month.
 *
 * Recent history plus everything ahead, which is what someone moving off
 * another calendar actually wants. Not "today", because the assessments
 * that ran last week are still worth having in the Intakes list.
 */
export function defaultImportFrom(todayISO) {
  const m = /^(\d{4})-(\d{2})/.exec(String(todayISO || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1, 12, 0, 0);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Above this the table is a wall of rows nobody will really check. */
export const REVIEW_COMFORTABLE = 400;

/* ── The review rows ──────────────────────────────────────────────────── */

export const SKIP_REASONS = {
  duplicate: 'Already imported',
  cancelled: 'Cancelled in Google',
  recurring: 'Repeats — import the series in Ratio instead',
  unusable: 'No date on it',
};

/**
 * Events turned into rows someone can read, correct and confirm.
 *
 * `existingUids` are the events already brought in, so a second run of the
 * same file changes nothing. Skipped rows are KEPT in the list with their
 * reason rather than dropped — "it imported 31 of 40" needs to be able to
 * say which nine and why.
 */
export function buildRows(events, {
  existingUids = new Set(), defaultDurationMin = 60, from = null, to = null,
} = {}) {
  const uids = existingUids instanceof Set ? existingUids : new Set(existingUids || []);
  events = filterEvents(events, { from, to });
  const seen = new Set();
  return (events || []).map((ev, i) => {
    const kind = classify(ev);
    const details = extractDetails(ev);
    const dur = ev.durationMin || defaultDurationMin;
    const endTime = ev.endTime || (ev.startTime ? addMinutes(ev.startTime, dur) : null);

    let skip = null;
    if (!ev.date) skip = 'unusable';
    else if (ev.cancelled) skip = 'cancelled';
    else if (ev.recurring) skip = 'recurring';
    else if (ev.uid && (uids.has(ev.uid) || seen.has(ev.uid))) skip = 'duplicate';
    if (ev.uid) seen.add(ev.uid);

    return {
      id: ev.uid || `row-${i}`,
      uid: ev.uid,
      target: kind === 'assessment' ? 'intake' : 'entry',
      kind,
      title: ev.summary || '(no title)',
      date: ev.date,
      allDay: ev.allDay,
      startTime: ev.startTime,
      endTime,
      durationMin: dur,
      ...details,
      note: ev.location ? `Google Calendar · ${ev.location}` : 'Imported from Google Calendar',
      // What it was actually looking at. Shown in the review table, and
      // stamped on the assessment, so a title that produced nothing can
      // be seen rather than guessed at afterwards.
      rawSummary: ev.summary || '',
      rawDescription: ev.description || '',
      skip,
      include: !skip,
    };
  });
}

const addMinutes = (hhmm, mins) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const t = Math.min(23 * 60 + 59, Number(m[1]) * 60 + Number(m[2]) + mins);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** What the confirm button is about to do, in numbers. */
export function importSummary(rows) {
  const live = (rows || []).filter(r => r.include && !r.skip);
  const skipped = {};
  for (const r of rows || []) if (r.skip) skipped[r.skip] = (skipped[r.skip] || 0) + 1;
  return {
    total: (rows || []).length,
    assessments: live.filter(r => r.target === 'intake').length,
    entries: live.filter(r => r.target === 'entry').length,
    importing: live.length,
    skipped,
    // An assessment with nobody's name on it is a row in the Intakes list
    // that reads as blank, so it is counted and shown before the write.
    missingNames: live.filter(r => r.target === 'intake' && !String(r.childName || '').trim()).length,
  };
}
