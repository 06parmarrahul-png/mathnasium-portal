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

const TYPE_KEYWORDS = /\b(tutoring|assessment|session|lesson|coaching|class|consult(ation)?|trial|sit[\s-]?in|workout|appointment|test|review|prep|sat|act|math|reading)\b/i;
function splitNameFromSummary(summary) {
  if (!summary) return { type: '', firstName: '', lastName: '' };
  const chunks = summary.split(/\s+[-–—]\s+|\s*:\s+/).map(s => s.trim()).filter(Boolean);
  let nameStr, typeStr;
  if (chunks.length === 1) { nameStr = chunks[0]; typeStr = ''; }
  else {
    const score = (s) => {
      let n = 0;
      if (TYPE_KEYWORDS.test(s)) n += 10;
      if (/\d/.test(s)) n += 5;
      const caps = s.match(/\b[A-Z][a-zA-Z'-]+/g) || [];
      n -= caps.length;
      return n;
    };
    const ranked = chunks.map(s => ({ s, n: score(s) })).sort((a,b) => a.n - b.n);
    nameStr = ranked[0].s;
    typeStr = ranked.slice(1).map(x => x.s).join(' - ');
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

function nameKey(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function categorizeOne(appt, studentsByKey, aliasesByKey, aliasCounts) {
  const fullName = `${appt.firstName} ${appt.lastName}`.trim();
  const haystack = `${appt.type || ''}`;
  // 0. Powerplay always = HS
  if (POWERPLAY_RE.test(haystack)) {
    appt.isPowerplay = true; appt.displayName = fullName;
    return 'HS';
  }
  // 1. Alias (multi-student supported)
  const alias = aliasesByKey.get(nameKey(fullName));
  if (alias && Array.isArray(alias.replacements) && alias.replacements.length) {
    const k = nameKey(fullName);
    const i = aliasCounts.get(k) || 0;
    const studentName = alias.replacements[i % alias.replacements.length];
    aliasCounts.set(k, i + 1);
    appt.displayName = studentName;
    appt.aliasedFrom = fullName;
    const s = studentsByKey.get(nameKey(studentName));
    if (s) { appt.grade = s.grade; appt.matchedStudent = s.name; return s.category; }
    return 'Unknown';
  }
  // 2. Student tracker
  const s = studentsByKey.get(nameKey(fullName));
  if (s) {
    appt.matchedStudent = s.name; appt.grade = s.grade; appt.displayName = fullName;
    return s.category;
  }
  // 3. Keyword fallback
  if (ONLINE_RE.test(haystack)) return 'Online';
  if (HS_RE.test(haystack)) return 'HS';
  if (EM_RE.test(haystack)) return 'EM';
  return 'Unknown';
}

function categorizeAll(appts, students, aliases) {
  const studentsByKey = new Map(students.map(s => [nameKey(s.name), s]));
  const aliasesByKey = new Map(aliases.map(a => [nameKey(a.parentName), a]));
  const aliasCounts = new Map();
  appts.sort((a, b) => a.datetime.localeCompare(b.datetime));
  for (const a of appts) a.category = categorizeOne(a, studentsByKey, aliasesByKey, aliasCounts);
  return appts;
}

// ───── Grouping into half-hour rows ─────────────────────────────────────
const SLOT_MIN = 30;
function floorToSlot(d) { const x = new Date(d); x.setSeconds(0,0); x.setMinutes(x.getMinutes() - (x.getMinutes() % SLOT_MIN)); return x; }
function addMin(d, n) { return new Date(d.getTime() + n*60000); }
function slotKey(d) { return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function nextSlot(k) { let [h,m] = k.split(':').map(Number); m += SLOT_MIN; if (m >= 60) { m -= 60; h++; } return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }
function formatHM(k) { let [h,m] = k.split(':').map(Number); const ampm = h>=12?'pm':'am'; const h12 = ((h+11)%12)+1; return m===0?`${h12}:00${ampm}`:`${h12}:${String(m).padStart(2,'0')}${ampm}`; }

function toCard(a) {
  const raw = `${a.firstName} ${a.lastName}`.trim() || '(no name)';
  const display = a.displayName || raw;
  return {
    id: `${a.datetime}|${display}`.replace(/\s+/g, '_'),
    name: display,
    aliasedFrom: a.aliasedFrom || null,
    type: a.type || '',
    duration: a.duration,
    start: a.datetime,
    isAssessment: /assess/i.test(a.type || ''),
    isPowerplay: !!a.isPowerplay,
  };
}

function groupSchedule(appts, day) {
  const todays = appts.filter(a => !a.canceled).filter(a => {
    const d = new Date(a.datetime);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` === day;
  });
  if (todays.length === 0) return { day, slots: [], totals: { HS:0,EM:0,Online:0,Unknown:0,all:0 }, unknownList: [] };
  let minStart = null, maxEnd = null;
  for (const a of todays) {
    const s = new Date(a.datetime); const e = addMin(s, a.duration);
    if (!minStart || s < minStart) minStart = s;
    if (!maxEnd || e > maxEnd) maxEnd = e;
  }
  const slotStart = floorToSlot(minStart);
  const empty = () => ({ HS:{onHour:[],halfHour:[]}, EM:{onHour:[],halfHour:[]}, Online:{onHour:[],halfHour:[]}, Unknown:{onHour:[],halfHour:[]} });
  const rows = [];
  for (let t = slotStart; t < maxEnd; t = addMin(t, SLOT_MIN)) {
    const k = slotKey(t);
    rows.push({ slot: k, label: `${formatHM(k)}–${formatHM(nextSlot(k))}`,
      students: empty(), counts: { HS:0,EM:0,Online:0,Unknown:0 } });
  }
  const byKey = new Map(rows.map((r, i) => [r.slot, i]));
  for (const a of todays) {
    const start = new Date(a.datetime);
    const onHour = start.getMinutes() === 0;
    const cat = a.category || 'Unknown';
    const first = floorToSlot(start);
    const end = addMin(start, a.duration);
    for (let t = first; t < end; t = addMin(t, SLOT_MIN)) {
      const idx = byKey.get(slotKey(t)); if (idx == null) continue;
      const row = rows[idx];
      (onHour ? row.students[cat].onHour : row.students[cat].halfHour).push(toCard(a));
      row.counts[cat]++;
    }
  }
  return {
    day, slots: rows,
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

  const allAppts = [];
  for (const body of feeds) {
    for (const ev of parseEvents(body)) {
      const a = toAppointment(ev); if (!a) continue;
      const d = new Date(a.datetime);
      const ld = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (ld === day) allAppts.push(a);
    }
  }

  const categorized = categorizeAll(allAppts, students, aliases);
  const grouped = groupSchedule(categorized, day);

  res.status(200).json(grouped);
}
