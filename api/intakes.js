// Public intake booking endpoint — merged into a single Vercel function
// to stay under the Hobby plan's 12-function limit. Method routing:
//
//   GET  /api/intakes?centerId=…&weekStart=YYYY-MM-DD
//        → public slot grid (no auth). Strips PII from existing bookings.
//
//   POST /api/intakes
//        → public booking create (no auth). Validates the chosen slot
//          server-side, writes the doc, fires the confirmation email.
//
// Both halves share centre + settings fetch, so consolidating saves a
// non-trivial amount of cold-start cost too.

import { Resend } from 'resend';
import { getFirestore } from './_lib/firebase-admin.js';
import {
  DEFAULT_INTAKE_SETTINGS, computeWeekSlots, validateSlot,
} from './_lib/intakeAvailability.js';

const FROM = process.env.RESEND_FROM || 'Ratio <onboarding@resend.dev>';
let _resend = null;
function resendClient() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  _resend = new Resend(key);
  return _resend;
}

const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const truthy  = (s) => typeof s === 'string' && s.trim().length > 0;

// Shared loader — pulls centre identity + intake settings in one round.
async function loadCentreContext(fs, centerId) {
  const [centerSnap, configSnap] = await Promise.all([
    fs.doc(`centers/${centerId}`).get(),
    fs.doc(`centers/${centerId}/config/main`).get(),
  ]);
  if (!centerSnap.exists) return null;
  const centre = centerSnap.data();
  const config = configSnap.exists ? configSnap.data() : {};
  const settings = {
    ...DEFAULT_INTAKE_SETTINGS,
    ...(config.intakeSettings || {}),
    availability: {
      ...DEFAULT_INTAKE_SETTINGS.availability,
      ...((config.intakeSettings || {}).availability || {}),
    },
  };
  // Surface instructional hours so the slot engine can default to them
  // when the owner hasn't opted into a custom availability override.
  // Also surface any date-bound override (summerHours2026) — the slot
  // engine applies it per-date so July/August Tue/Thu slots respect the
  // 10–14 summer window while the rest of the year stays 15–19.
  const instructionalHours = config.instructionalHours || null;
  const summerOverride     = config.summerHours2026   || null;
  // Statutory holidays and centre closures. Already configured in Centre
  // Settings, and until now never read on this path — so a family could
  // book an assessment on a stat holiday, because the weekday had
  // instructional hours and nothing said the centre was shut.
  const holidays = Array.isArray(config.holidays) ? config.holidays : [];
  return { centre, settings, instructionalHours, summerOverride, holidays };
}

/**
 * Ratio Calendar entries that hold the booking page, as busy blocks.
 *
 * Mirrors holdBlocks() in src/lib/ratioCalendar.js. It is written out
 * again rather than imported because a Vercel function may not reach into
 * the front-end bundle (see the note in api/_lib/intakeAvailability.js);
 * both sides are pinned against the same fixture in their own tests.
 *
 * `holdsBooking` is filtered in JS rather than in the query, so this needs
 * no composite index — the date range alone is a single-field range.
 */
async function loadHolds(fs, centerId, fromYmd, toYmd) {
  const snap = await fs
    .collection(`centers/${centerId}/calendar`)
    .where('date', '>=', fromYmd)
    .where('date', '<=', toYmd)
    .get()
    .catch(() => ({ docs: [] }));

  const hm = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m) return null;
    const h = Number(m[1]); const min = Number(m[2]);
    return (h > 23 || min > 59) ? null : h * 60 + min;
  };

  const out = [];
  for (const d of snap.docs) {
    const e = d.data();
    if (!e || e.holdsBooking !== true || !e.date) continue;
    const s = e.allDay ? null : hm(e.startTime);
    const t = e.allDay ? null : hm(e.endTime);
    if (s != null && t != null && t > s) {
      out.push({ startISO: `${e.date}T${e.startTime}:00`, durationMin: t - s });
    } else {
      // All-day, or missing either end — covered as the whole day rather
      // than guessed at. A half-known hold that blocks nothing is worse
      // than one that blocks too much: nobody notices the first.
      out.push({ startISO: `${e.date}T00:00:00`, durationMin: 24 * 60 });
    }
  }
  return out;
}

/** centerConfig.holidays → { 'YYYY-MM-DD': { name, stat } } for the engine. */
function closuresFrom(holidays, fromYmd, toYmd) {
  const out = {};
  for (const h of holidays || []) {
    if (!h || !h.date) continue;
    if (fromYmd && h.date < fromYmd) continue;
    if (toYmd && h.date > toYmd) continue;
    out[h.date] = { name: h.name || 'Centre closed', stat: h.stat !== false };
  }
  return out;
}

// ── GET: availability grid ─────────────────────────────────────────────
async function handleAvailability(req, res) {
  const { centerId, weekStart } = req.query;
  if (!centerId)  return res.status(400).json({ error: 'centerId required' });
  if (!weekStart) return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) required' });

  const fs = getFirestore();
  const ctx = await loadCentreContext(fs, centerId);
  if (!ctx) return res.status(404).json({ error: 'Centre not found' });
  const { centre, settings, instructionalHours, summerOverride, holidays } = ctx;

  if (!settings.enabled) {
    return res.status(200).json({
      centre: { name: centre.name || centerId },
      settings: { enabled: false },
      days: [],
    });
  }

  const start = new Date(`${weekStart}T00:00:00Z`);
  const end   = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
  const bufStart = new Date(start.getTime() - 24 * 3600 * 1000);
  const bufEnd   = new Date(end.getTime()   + 24 * 3600 * 1000);

  const intakeSnap = await fs
    .collection('centerIntakes')
    .where('centerId', '==', centerId)
    .where('slot', '>=', bufStart.toISOString())
    .where('slot', '<=', bufEnd.toISOString())
    .get()
    .catch(() => ({ docs: [] }));

  const bookedSlots = intakeSnap.docs.map(d => {
    const v = d.data();
    return {
      startISO:    v.slot,
      durationMin: v.durationMin || settings.slotDurationMin,
      status:      v.status || 'scheduled',
    };
  });

  // The week the grid is drawing, as centre-local dates — which is the
  // key both the calendar entries and the holiday list are stored under.
  const weekEnd = new Date(start.getTime() + 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const holds = await loadHolds(fs, centerId, weekStart, weekEnd);

  const days = computeWeekSlots(weekStart, settings, bookedSlots, instructionalHours, summerOverride, {
    holds,
    closures: closuresFrom(holidays, weekStart, weekEnd),
  });
  res.status(200).json({
    centre:   { name: centre.name || centerId, timezone: settings.timezone },
    settings: {
      enabled: true,
      slotDurationMin: settings.slotDurationMin,
      headline:    settings.headline,
      subheadline: settings.subheadline,
      address:     settings.address || '',
    },
    days,
  });
}

// ── POST: create booking ───────────────────────────────────────────────
async function handleCreate(req, res) {
  const {
    centerId, slot, email, phone, guardianName, childName, childGrade,
    childSchool, smsOptIn, notes,
  } = req.body || {};

  if (!centerId)              return res.status(400).json({ ok: false, error: 'centerId required' });
  if (!truthy(slot))          return res.status(400).json({ ok: false, error: 'Pick a time slot.' });
  if (!isEmail(email))        return res.status(400).json({ ok: false, error: 'A valid email is required.' });
  if (!truthy(phone))         return res.status(400).json({ ok: false, error: 'A phone number is required.' });
  if (!truthy(guardianName))  return res.status(400).json({ ok: false, error: 'Guardian name is required.' });
  if (!truthy(childName))     return res.status(400).json({ ok: false, error: 'Child name is required.' });
  if (!truthy(childGrade))    return res.status(400).json({ ok: false, error: 'Child grade is required.' });

  const fs = getFirestore();
  const ctx = await loadCentreContext(fs, centerId);
  if (!ctx) return res.status(404).json({ ok: false, error: 'Centre not found' });
  const { centre, settings, instructionalHours, summerOverride, holidays } = ctx;
  if (!settings.enabled) {
    return res.status(403).json({ ok: false, error: 'Online booking is not enabled for this centre.' });
  }

  const horizonEnd = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
  const horizonStart = new Date().toISOString();
  const existingSnap = await fs
    .collection('centerIntakes')
    .where('centerId', '==', centerId)
    .where('slot', '>=', horizonStart)
    .where('slot', '<=', horizonEnd)
    .get()
    .catch(() => ({ docs: [] }));
  const bookedSlots = existingSnap.docs.map(d => {
    const v = d.data();
    return {
      startISO:    v.slot,
      durationMin: v.durationMin || settings.slotDurationMin,
      status:      v.status || 'scheduled',
    };
  });

  // Only the chosen day matters here — this is the last check before the
  // write, not a grid. Read off the string for the same reason
  // validateSlot does: a zoneless wall clock through Date() shifts the
  // day by the server's offset.
  const slotYmd = String(slot).slice(0, 10);
  const holds = await loadHolds(fs, centerId, slotYmd, slotYmd);

  const v = validateSlot({
    slotISO: slot, settings, bookedSlots, instructionalHours, summerOverride,
    holds, closures: closuresFrom(holidays, slotYmd, slotYmd),
  });
  if (!v.ok) return res.status(409).json({ ok: false, error: v.error });

  const cancelToken = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 24);
  const payload = {
    slot,
    durationMin: settings.slotDurationMin,
    email:        email.trim().toLowerCase(),
    phone:        phone.trim(),
    guardianName: guardianName.trim(),
    childName:    childName.trim(),
    childGrade:   String(childGrade).trim(),
    childSchool:  truthy(childSchool) ? childSchool.trim() : '',
    smsOptIn:     !!smsOptIn,
    notes:        truthy(notes) ? notes.trim() : '',
    status:       'scheduled',
    source:       'web',
    cancelToken,
    bookedAt:     new Date().toISOString(),
    centerId,
  };
  const ref = await fs.collection('centerIntakes').add(payload);

  // Mirror the booking into the Leads funnel so the owner sees every
  // new family in one place. Status starts as "new" — staff moves it
  // forward as they contact/run the assessment/enroll. A failed lead
  // write does NOT block the booking; the intake itself succeeded and
  // that's the user-visible promise.
  try {
    const now = new Date().toISOString();
    await fs.collection(`centers/${centerId}/leads`).add({
      parentName:   payload.guardianName,
      parentEmail:  payload.email,
      parentPhone:  payload.phone,
      childName:    payload.childName,
      childGrade:   payload.childGrade,
      childSchool:  payload.childSchool,
      status:       'new',
      source:       'intake-form',
      sourceDetail: `Booked assessment for ${new Date(payload.slot).toLocaleString()}`,
      notes:        payload.notes || '',
      assignedTo:   '',
      // Same shape as src/lib/leads.js createLead() writes. Timestamps
      // use FieldValue.serverTimestamp() so they sort consistently with
      // leads created from the website UI.
      history: [{ at: now, by: 'system', text: 'Created from intake booking' }],
      intakeId:  ref.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (e) {
    console.error('Lead mirror failed:', e?.message || e);
  }

  try {
    const r = resendClient();
    const niceTime = new Date(slot).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: settings.timezone,
    });
    const centreName = centre.name || 'Mathnasium';
    await r.emails.send({
      from: FROM,
      to: payload.email,
      subject: `Your free math assessment is booked — ${centreName}`,
      text: [
        `Hi ${payload.guardianName.split(' ')[0]},`,
        '',
        `You're booked! We're looking forward to seeing ${payload.childName} for a free math skills assessment at ${centreName}.`,
        '',
        `🗓  ${niceTime}`,
        `⏱  ${settings.slotDurationMin} minutes`,
        '',
        'Please arrive a few minutes early. If you need to reschedule, just reply to this email and we\'ll sort it out.',
        '',
        'See you soon,',
        centreName,
      ].join('\n'),
    });
  } catch (e) {
    console.error('Confirmation email failed:', e?.message || e);
  }

  res.status(200).json({
    ok: true,
    intakeId: ref.id,
    slot,
    durationMin: settings.slotDurationMin,
  });
}

// ── Method router ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    if (req.method === 'GET')  return await handleAvailability(req, res);
    if (req.method === 'POST') return await handleCreate(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('intakes endpoint error:', e);
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
