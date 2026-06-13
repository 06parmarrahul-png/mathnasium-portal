// GET /api/intakes/availability?centerId=<id>&weekStart=YYYY-MM-DD
//
// Public, NO AUTH. Returns the slot grid for a 7-day window so the
// parent-facing booking page can render available / taken slots without
// requiring a login.
//
// Why server-side: the list of booked intakes lives in Firestore under
// /centers/{id}/intakes — those docs contain parent contact details so
// they MUST be private. The rules block unauth reads; this endpoint uses
// firebase-admin to read them, then strips PII and returns just the
// occupied datetimes.

import { getFirestore } from '../_lib/firebase-admin.js';
import { computeWeekSlots, DEFAULT_INTAKE_SETTINGS } from '../_lib/intakeAvailability.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const { centerId, weekStart } = req.query;
  if (!centerId)  return res.status(400).json({ error: 'centerId required' });
  if (!weekStart) return res.status(400).json({ error: 'weekStart (YYYY-MM-DD) required' });

  const fs = getFirestore();

  // Centre identity (for the page header) + intake settings live on the
  // public /centers/{id} doc and its config/main sub-doc.
  const [centerSnap, configSnap] = await Promise.all([
    fs.doc(`centers/${centerId}`).get(),
    fs.doc(`centers/${centerId}/config/main`).get(),
  ]);
  if (!centerSnap.exists) return res.status(404).json({ error: 'Centre not found' });

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
    return res.status(200).json({
      centre: { name: centre.name || centerId },
      settings: { enabled: false },
      days: [],
    });
  }

  // Existing bookings — only pull the 7-day window we care about, plus a
  // 24h buffer on either side so overlapping appointments at the edges
  // still block their slot. We DO NOT return any PII to the client.
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
    .catch(() => ({ docs: [] })); // index may not exist yet — fail soft

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
    centre: {
      name: centre.name || centerId,
      timezone: settings.timezone,
    },
    settings: {
      enabled: true,
      slotDurationMin: settings.slotDurationMin,
      headline: settings.headline,
      subheadline: settings.subheadline,
    },
    days,
  });
}
