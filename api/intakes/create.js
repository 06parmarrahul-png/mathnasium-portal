// POST /api/intakes/create
//
// Public, NO AUTH. Creates a new intake booking and fires the parent
// confirmation email. The body is form data from the public booking
// page; we re-validate the slot server-side so a stale tab can't
// double-book and we collision-check against existing intakes again.
//
// Body:
//   { centerId, slot (ISO), email, phone, guardianName, childName,
//     childGrade, smsOptIn (bool), notes? }
//
// Response:
//   { ok: true, intakeId, slot, durationMin }  on success
//   { ok: false, error }                        on validation failure

import { Resend } from 'resend';
import { getFirestore } from '../_lib/firebase-admin.js';
import {
  DEFAULT_INTAKE_SETTINGS, validateSlot,
} from '../_lib/intakeAvailability.js';

// Lazy Resend client (warm-Lambda init).
let _resend = null;
function resendClient() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  _resend = new Resend(key);
  return _resend;
}

const FROM = process.env.RESEND_FROM || 'Ratio <onboarding@resend.dev>';

// Tiny field validators — we're lenient on phone formatting because
// Apptoto's flow accepts whatever the user types.
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const truthy  = (s) => typeof s === 'string' && s.trim().length > 0;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const {
    centerId, slot, email, phone, guardianName, childName, childGrade,
    smsOptIn, notes,
  } = req.body || {};

  if (!centerId)              return res.status(400).json({ ok: false, error: 'centerId required' });
  if (!truthy(slot))          return res.status(400).json({ ok: false, error: 'Pick a time slot.' });
  if (!isEmail(email))        return res.status(400).json({ ok: false, error: 'A valid email is required.' });
  if (!truthy(phone))         return res.status(400).json({ ok: false, error: 'A phone number is required.' });
  if (!truthy(guardianName))  return res.status(400).json({ ok: false, error: 'Guardian name is required.' });
  if (!truthy(childName))     return res.status(400).json({ ok: false, error: 'Child name is required.' });
  if (!truthy(childGrade))    return res.status(400).json({ ok: false, error: 'Child grade is required.' });

  const fs = getFirestore();

  // Pull centre + settings.
  const [centerSnap, configSnap] = await Promise.all([
    fs.doc(`centers/${centerId}`).get(),
    fs.doc(`centers/${centerId}/config/main`).get(),
  ]);
  if (!centerSnap.exists) return res.status(404).json({ ok: false, error: 'Centre not found' });
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
  if (!settings.enabled) {
    return res.status(403).json({ ok: false, error: 'Online booking is not enabled for this centre.' });
  }

  // Pull recent intakes for collision check (next 60 days).
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

  // Re-validate the chosen slot.
  const v = validateSlot({ slotISO: slot, settings, bookedSlots });
  if (!v.ok) return res.status(409).json({ ok: false, error: v.error });

  // Create the intake doc. Random token used for future cancel/reschedule
  // magic links — wired up in Phase 2.
  const cancelToken = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 24);
  const payload = {
    slot,
    durationMin: settings.slotDurationMin,
    email:        email.trim().toLowerCase(),
    phone:        phone.trim(),
    guardianName: guardianName.trim(),
    childName:    childName.trim(),
    childGrade:   String(childGrade).trim(),
    smsOptIn:     !!smsOptIn,
    notes:        truthy(notes) ? notes.trim() : '',
    status:       'scheduled',
    source:       'web',
    cancelToken,
    bookedAt:     new Date().toISOString(),
    centerId,
  };
  const ref = await fs.collection('centerIntakes').add(payload);

  // Confirmation email. We don't fail the whole booking if the email
  // fails to send — the parent still has a confirmed slot, and we want
  // to surface a softer error rather than ask them to rebook.
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
    // Swallow — the booking is still saved. The owner sees the new
    // intake on /intakes and can manually email if needed.
    console.error('Confirmation email failed:', e?.message || e); // eslint-disable-line no-console
  }

  return res.status(200).json({
    ok: true,
    intakeId: ref.id,
    slot,
    durationMin: settings.slotDurationMin,
  });
}
