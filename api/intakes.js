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
  return { centre, settings };
}

// ── GET: availability grid ─────────────────────────────────────────────
async function handleAvailability(req, res) {
  const { centerId, weekStart } = req.query;
  if (!centerId)  return res.status(400).json({ error: 'centerId required' });
  if (!weekStart) return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) required' });

  const fs = getFirestore();
  const ctx = await loadCentreContext(fs, centerId);
  if (!ctx) return res.status(404).json({ error: 'Centre not found' });
  const { centre, settings } = ctx;

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

  const days = computeWeekSlots(weekStart, settings, bookedSlots);
  res.status(200).json({
    centre:   { name: centre.name || centerId, timezone: settings.timezone },
    settings: {
      enabled: true,
      slotDurationMin: settings.slotDurationMin,
      headline:    settings.headline,
      subheadline: settings.subheadline,
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
  const { centre, settings } = ctx;
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

  const v = validateSlot({ slotISO: slot, settings, bookedSlots });
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
    console.error('Confirmation email failed:', e?.message || e); // eslint-disable-line no-console
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
    console.error('intakes endpoint error:', e); // eslint-disable-line no-console
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
