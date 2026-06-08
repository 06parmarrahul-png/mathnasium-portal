// GET /api/scheduler/appointments?centerId=<id>&date=YYYY-MM-DD
//
// Server-side because:
//   1. Acuity's iCal URLs are private — we don't want them shipped to the browser
//   2. CORS on Acuity's endpoints would block a browser fetch anyway
//
// Reads per-centre settings + students + aliases from Firestore, fetches each
// configured iCal feed, parses VEVENT blocks, categorizes each appointment,
// then returns the same grouped shape the local Node scheduler uses so the
// React page can render the same dashboard.
//
// Auth: Firebase ID token in Authorization header. Caller must be a member of
// the centre (owner / admin_assistant / super_admin / admin / instructor are
// all OK — the UI gates visibility separately).

import { getFirestore, authenticateRequest } from '../_lib/firebase-admin.js';

// ───── iCal parser ──────────────────────────────────────────────────────
// Same logic as scheduler-app/src/ical.js, inlined here so this function
// has no extra dependencies beyond firebase-admin.

function unfold(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else out.push(line);
  }
  return out;
}
function unescapeIcal(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
function parseProp(line) {
  const i = line.indexOf(':'); if (i < 0) return null;
  const head = line.slice(0, i); const value = line.slice(i + 1);
  const parts = head.split(';'); const name = parts[0].toUpperCase();
  const params = {};
  for (let j = 1; j < parts.length; j++) {
    const eq = parts[j].indexOf('=');
    if (eq > 0) params[parts[j].slice(0, eq).toUpperCase()] = parts[j].slice(eq + 1);
  }
  return { name, params, value };
}
function parseDateTime(value) {
  const v = (value || '').trim();
  if (/^\d{8}$/.test(v)) {
    return new Date(Date.UTC(+v.slice(0,4), +v.slice(4,6)-1, +v.slice(6,8)));
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  return new Date(Date.UTC(+Y, +Mo-1, +D, +H, +Mi, +S));
}
function parseEvents(text) {
  const lines = unfold(text);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = new Map(); continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseProp(line); if (!p) continue;
    cur.set(p.name, p.value);
  }
  return events;
}

const TYPE_KEYWORDS = /\b(tutoring|assessment|session|lesson|coaching|class|consult(ation)?|trial|sit[\s-]?in|workout|appointment|test|review|prep|sat|act|math|reading|grades?|only|group|block|powerplay|in[\s-]?centre|in[\s-]?center|@home|virtual|langley|mathnasium)\b/i;

// Phrases that are definitely NOT a student's name — Acuity sometimes
// surfaces these as the SUMMARY (e.g. group blocks with no client info).
const NON_NAME_PHRASES = /(grades\s+only|in[\s-]?centre|in[\s-]?center|group\s+session|group\s+block|@home)/i;

// "60 min", "90 minute", "1 hour", "1.5 hr" — duration tokens that some
// Acuity SUMMARYs include between dashes. Never a person's name.
const DURATION_RE = /^\d+(\.\d+)?\s*(min|minute|hr|hour)s?$/i;
const NUMERIC_ONLY = /^[\d\s.()-]+$/;

function isNonName(s) {
  return TYPE_KEYWORDS.test(s) || NON_NAME_PHRASES.test(s) || DURATION_RE.test(s) || NUMERIC_ONLY.test(s);
}

function splitNameFromSummary(summary) {
  if (!summary) return { type: '', firstName: '', lastName: '' };
  const chunks = summary.split(/\s+[-–—]\s+|\s*:\s+/).map(s => s.trim()).filter(Boolean);

  // If every chunk is a type / block / duration / numeric, no real client
  // name is present — caller skips the event.
  if (chunks.every(isNonName)) {
    return { type: summary, firstName: '', lastName: '' };
  }

  let nameStr, typeStr;
  if (chunks.length === 1) { nameStr = chunks[0]; typeStr = ''; }
  else {
    const score = (s) => {
      let n = 0;
      if (isNonName(s)) n += 10;
      if (/\d/.test(s)) n += 5;
      const caps = s.match(/\b[A-Z][a-zA-Z'-]+/g) || [];
      n -= caps.length;
      return n;
    };
    const ranked = chunks.map(s => ({ s, n: score(s) })).sort((a,b) => a.n - b.n);
    nameStr = ranked[0].s;
    typeStr = ranked.slice(1).map(x => x.s).join(' - ');
  }

  if (isNonName(nameStr)) {
    return { type: summary, firstName: '', lastName: '' };
  }

  const tokens = nameStr.split(/\s+/);
  return { type: typeStr, firstName: tokens.shift() || '', lastName: tokens.join(' ') };
}

function toAppointment(eventMap) {
  const summary = unescapeIcal(eventMap.get('SUMMARY') || '');
  const status = (eventMap.get('STATUS') || '').toUpperCase();
  const dtstart = eventMap.get('DTSTART'); if (!dtstart) return null;
  const dtend = eventMap.get('DTEND');
  const start = parseDateTime(dtstart); if (!start) return null;
  const end = dtend ? parseDateTime(dtend) : null;
  const durationMin = end ? Math.max(30, Math.round((end - start) / 60000)) : 60;
  const { type, firstName, lastName } = splitNameFromSummary(summary);
  return {
    datetime: start.toISOString(), duration: durationMin,
    firstName, lastName, type: type || summary,
    canceled: status === 'CANCELLED',
  };
}

// ───── Categorization ───────────────────────────────────────────────────
const POWERPLAY_RE = /\bpower\s*play\b/i;
const HS_RE = /\b(hs|high\s*school|grade\s*(8|9|10|11|12))\b/i;
const EM_RE = /\b(em|elementary|grade\s*[1-7])\b/i;
const ONLINE_RE = /\b(online|@?home|virtual)\b/i;

// Must match src/lib/scheduler-data.js nameKey character-for-character so
// the in-memory lookup Maps line up with the Firestore doc IDs the
// website wrote with.
function nameKey(s) {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+$/, '_')
    .replace(/^__(.*)__$/, '_$1_');
}

// Resolve a multi-replacement alias to a specific student.
//
// Each replacement student is "consumable" — once we've assigned Jackson
// to a booking today, we don't assign Jackson to a second booking unless
// every replacement is already used. This handles the common cases:
//
//   - Only one kid in today: smart match by HS/EM hint picks the right one
//   - Both kids in today: 1st booking takes one, 2nd takes the other
//   - Third+ booking same parent: cycles + flags `uncertainAlias: true`
function resolveAliasReplacement(appt, alias, studentsByKey, dayState) {
  const reps = alias.replacements;
  const k = nameKey(`${appt.firstName} ${appt.lastName}`);
  let state = dayState.get(k);
  if (!state) { state = { used: new Set(), cycled: 0 }; dayState.set(k, state); }

  const hay = (appt.type || '').toLowerCase();
  const hint =
    ONLINE_RE.test(hay) ? 'Online' :
    HS_RE.test(hay)     ? 'HS' :
    EM_RE.test(hay)     ? 'EM' : null;

  // 1. Smart match: pick an UNUSED replacement whose category matches the hint.
  if (hint) {
    const match = reps.find(r => !state.used.has(r) && studentsByKey.get(nameKey(r))?.category === hint);
    if (match) { state.used.add(match); return { studentName: match, uncertain: false }; }
  }

  // 2. First unused replacement. If more than one unused candidate exists
  //    AND we have no hint, the pick is a guess — flag uncertain so the
  //    UI can show a "?" badge.
  const remaining = reps.filter(r => !state.used.has(r));
  if (remaining.length > 0) {
    const chosen = remaining[0];
    state.used.add(chosen);
    return { studentName: chosen, uncertain: remaining.length > 1 };
  }

  // 3. All replacements already used — extra booking. Cycle through and
  //    flag uncertain so the orange banner asks staff to verify.
  const i = state.cycled++;
  return { studentName: reps[i % reps.length], uncertain: true };
}

// Appointment type strings that mean the student is doing the session
// remotely, regardless of how they're classified in the tracker. Must
// match BEFORE the student lookup so a hybrid student who's in-centre
// most days but @home today doesn't accidentally appear on the centre
// dashboard.
const REMOTE_TYPE_RE = /@?home|online|virtual|remote/i;

function categorizeOne(appt, studentsByKey, aliasesByKey, dayState) {
  const fullName = `${appt.firstName} ${appt.lastName}`.trim();
  const haystack = `${appt.type || ''}`;

  // 0. Powerplay always = HS
  if (POWERPLAY_RE.test(haystack)) {
    appt.isPowerplay = true; appt.displayName = fullName;
    return 'HS';
  }

  // 0.5. Remote / @home appointment type → Online. This overrides the
  //      student's tracker section because the appointment itself is
  //      the source of truth for whether they're physically present.
  if (REMOTE_TYPE_RE.test(haystack)) {
    appt.displayName = fullName;
    return 'Online';
  }

  // 1. Alias (multi-student supported)
  const alias = aliasesByKey.get(nameKey(fullName));
  if (alias && Array.isArray(alias.replacements) && alias.replacements.length) {
    const { studentName, uncertain } = resolveAliasReplacement(appt, alias, studentsByKey, dayState);
    appt.displayName = studentName;
    appt.aliasedFrom = fullName;
    if (uncertain) appt.uncertainAlias = true;
    const s = studentsByKey.get(nameKey(studentName));
    if (s) {
      appt.grade = s.grade; appt.matchedStudent = s.name;
      if (s.hasAssessment) appt.hasAssessment = true;
      if (s.isHybrid) appt.isHybrid = true;
      return s.category;
    }
    return 'Unknown';
  }

  // 2. Student tracker
  const s = studentsByKey.get(nameKey(fullName));
  if (s) {
    appt.matchedStudent = s.name; appt.grade = s.grade; appt.displayName = fullName;
    if (s.hasAssessment) appt.hasAssessment = true;
    if (s.isHybrid) appt.isHybrid = true;
    return s.category;
  }

  // 3. Keyword fallback
  if (ONLINE_RE.test(haystack)) return 'Online';
  if (HS_RE.test(haystack)) return 'HS';
  if (EM_RE.test(haystack)) return 'EM';
  return 'Unknown';
}

// Categorize every appointment. CRITICAL: the alias counter is scoped to
// the centre-local calendar day so cross-day appearances don't shift the
// assignments inside any one day's view.
function categorizeAll(appts, students, aliases) {
  const studentsByKey = new Map(students.map(s => [nameKey(s.name), s]));
  const aliasesByKey = new Map(aliases.map(a => [nameKey(a.parentName), a]));

  // Group by centre-TZ day → chronological → per-day alias state map.
  appts.sort((a, b) => a.datetime.localeCompare(b.datetime));
  const stateByDay = new Map();
  for (const a of appts) {
    const day = tzYMD(new Date(a.datetime));
    if (!stateByDay.has(day)) stateByDay.set(day, new Map());
    a.category = categorizeOne(a, studentsByKey, aliasesByKey, stateByDay.get(day));
  }
  return appts;
}

// ───── Grouping into half-hour rows ─────────────────────────────────────
//
// CRITICAL: This function runs on Vercel servers, which are in UTC. We
// need every "hour of day", "what day is this" decision to be made in the
// centre's local timezone, not UTC. Otherwise a Saturday 8pm Pacific
// appointment becomes Sunday 3am UTC and either gets excluded from
// Saturday's view or labelled as "3:00am" on the schedule.
//
// TODO: read this from each centre's settings doc. Hardcoded to Vancouver
//       for now since Langley is the only live centre.
const CENTER_TZ = 'America/Vancouver';

// Decompose a UTC Date into its wall-clock parts in the centre's TZ.
function tzParts(utcDate, tz = CENTER_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(utcDate);
  const get = (t) => +parts.find(p => p.type === t).value;
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour') % 24,                     // Intl can emit "24" for midnight
    minute: get('minute'), second: get('second'),
  };
}
function tzYMD(utcDate) {
  const p = tzParts(utcDate);
  return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;
}
function tzSlotKey(utcDate) {
  // Floor to half-hour.
  const p = tzParts(utcDate);
  const m = p.minute - (p.minute % 30);
  return `${String(p.hour).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function tzStartsOnHour(utcDate) {
  return tzParts(utcDate).minute === 0;
}

const SLOT_MIN = 30;
function addMin(d, n) { return new Date(d.getTime() + n*60000); }
function nextSlot(k) { let [h,m] = k.split(':').map(Number); m += SLOT_MIN; if (m >= 60) { m -= 60; h++; } return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }
function formatHM(k) { let [h,m] = k.split(':').map(Number); const ampm = h>=12?'pm':'am'; const h12 = ((h+11)%12)+1; return m===0?`${h12}:00${ampm}`:`${h12}:${String(m).padStart(2,'0')}${ampm}`; }

function toCard(a) {
  const raw = `${a.firstName} ${a.lastName}`.trim() || '(no name)';
  const display = a.displayName || raw;
  return {
    id: `${a.datetime}|${display}`.replace(/\s+/g, '_'),
    name: display,
    aliasedFrom: a.aliasedFrom || null,
    uncertainAlias: !!a.uncertainAlias,
    type: a.type || '',
    duration: a.duration,
    start: a.datetime,
    // Assessment = either Acuity says so (appointment type contains "assess")
    // OR the student's tracker row has "binder" in it (set by CSV import).
    isAssessment: !!a.hasAssessment || /assess/i.test(a.type || ''),
    isPowerplay: !!a.isPowerplay,
    isHybrid: !!a.isHybrid,
  };
}

function groupSchedule(appts, day) {
  // Filter to the centre's local calendar day, not the server's UTC day.
  const todays = appts.filter(a => !a.canceled).filter(a => tzYMD(new Date(a.datetime)) === day);
  if (todays.length === 0) return { day, slots: [], totals: { HS:0,EM:0,Online:0,Unknown:0,all:0 }, unknownList: [] };

  // Range bounds: earliest start, latest end — all in UTC milliseconds.
  let minStart = null, maxEnd = null;
  for (const a of todays) {
    const s = new Date(a.datetime); const e = addMin(s, a.duration);
    if (!minStart || s < minStart) minStart = s;
    if (!maxEnd || e > maxEnd) maxEnd = e;
  }

  // Round the start down to the half-hour boundary in the centre's TZ.
  // We do this by walking forward from a safe earlier point in 30-min steps
  // until tzSlotKey changes — keeps the math TZ-correct without manual
  // offset calculation.
  const slotStart = (() => {
    // Subtract up to 30 min and find the boundary
    const startKey = tzSlotKey(minStart);
    let cur = new Date(minStart.getTime());
    // Step back in 1-min increments until the slot key would change going backward
    for (let i = 0; i < 30; i++) {
      const probe = new Date(cur.getTime() - 60 * 1000);
      if (tzSlotKey(probe) !== startKey) break;
      cur = probe;
    }
    cur.setSeconds(0, 0);
    return cur;
  })();

  const empty = () => ({ HS:{onHour:[],halfHour:[]}, EM:{onHour:[],halfHour:[]}, Online:{onHour:[],halfHour:[]}, Unknown:{onHour:[],halfHour:[]} });

  // Build rows by walking forward 30-min steps and reading the TZ-local key
  // at each step. Stops when we pass the last appointment's end.
  const rows = [];
  const seenKeys = new Set();
  for (let t = slotStart; t < maxEnd; t = addMin(t, SLOT_MIN)) {
    const k = tzSlotKey(t);
    if (seenKeys.has(k)) continue; // safety against DST repeats
    seenKeys.add(k);
    rows.push({
      slot: k,
      label: `${formatHM(k)}–${formatHM(nextSlot(k))}`,
      students: empty(),
      counts: { HS:0, EM:0, Online:0, Unknown:0 },
      _t: t.getTime(),                       // for stable sort
    });
  }
  rows.sort((a, b) => a._t - b._t);
  rows.forEach(r => delete r._t);

  // Walk every appointment. The NAME is added to the student's start slot
  // only (so a 90-min student starting at 10:00 isn't duplicated at 10:30
  // and 11:00). The COUNT for each occupied slot still increments — that's
  // what the staffing-needed calculation reads, and a student mid-lesson
  // still needs an instructor.
  const byKey = new Map(rows.map((r, i) => [r.slot, i]));
  for (const a of todays) {
    const start = new Date(a.datetime);
    const onHour = tzStartsOnHour(start);
    const cat = a.category || 'Unknown';
    const end = addMin(start, a.duration);
    let nameAdded = false;
    for (let t = start; t < end; t = addMin(t, SLOT_MIN)) {
      const idx = byKey.get(tzSlotKey(t)); if (idx == null) continue;
      const row = rows[idx];
      if (!nameAdded) {
        (onHour ? row.students[cat].onHour : row.students[cat].halfHour).push(toCard(a));
        nameAdded = true;
      }
      row.counts[cat]++;
    }
  }

  return {
    day, slots: rows, timezone: CENTER_TZ,
    totals: {
      HS: todays.filter(a => a.category==='HS').length,
      EM: todays.filter(a => a.category==='EM').length,
      Online: todays.filter(a => a.category==='Online').length,
      Unknown: todays.filter(a => a.category==='Unknown').length,
      all: todays.length,
    },
    unknownList: todays.filter(a => a.category==='Unknown').map(toCard),
  };
}

// ───── Handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  const { centerId, date } = req.query;
  if (!centerId) return res.status(400).json({ error: 'centerId required' });
  const day = date || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  })();

  const fs = getFirestore();

  // Load settings, students, aliases for this centre.
  const [settingsSnap, studentsSnap, aliasesSnap] = await Promise.all([
    fs.doc(`centers/${centerId}/schedulerSettings/main`).get(),
    fs.collection(`centers/${centerId}/schedulerStudents`).get(),
    fs.collection(`centers/${centerId}/schedulerAliases`).get(),
  ]);

  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const students = studentsSnap.docs.map(d => d.data());
  const aliases = aliasesSnap.docs.map(d => d.data());

  const icalUrls = (settings.icalUrls || []).filter(Boolean);
  if (icalUrls.length === 0) {
    return res.status(200).json({
      day, slots: [], totals: { HS:0,EM:0,Online:0,Unknown:0,all:0 }, unknownList: [],
      warning: 'No iCal URLs configured. Add one in the Setup tab.',
    });
  }

  // Fetch every feed in parallel.
  const feeds = await Promise.all(icalUrls.map(async (url) => {
    const r = await fetch(url, { headers: { Accept: 'text/calendar' } });
    if (!r.ok) throw new Error(`iCal fetch failed (${r.status})`);
    return r.text();
  }));

  // Don't filter to `day` here — let groupSchedule handle the filtering in
  // the centre's timezone. Filtering in UTC would drop e.g. a Saturday
  // evening appointment that's already Sunday in UTC.
  const allAppts = [];
  for (const body of feeds) {
    for (const ev of parseEvents(body)) {
      const a = toAppointment(ev); if (!a) continue;
      // Skip group-block events with no real client name (e.g. Acuity
      // appointment-type rows like "High School Grades Only" that surface
      // as standalone iCal events with no associated student).
      if (!a.firstName && !a.lastName) continue;
      allAppts.push(a);
    }
  }

  const categorized = categorizeAll(allAppts, students, aliases);
  const grouped = groupSchedule(categorized, day);

  res.status(200).json(grouped);
}
