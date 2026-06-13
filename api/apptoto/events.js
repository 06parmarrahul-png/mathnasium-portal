// GET /api/apptoto/events?centerId=<id>&start=<ISO>&end=<ISO>
//
// Server-side proxy to the Apptoto API. The owner stores their Apptoto
// email + API key in a private Firestore doc (see ApptotoSetupModal); we
// read those creds via firebase-admin and forward the call. The key
// never touches the browser and CORS issues are sidestepped.
//
// Apptoto auth: HTTP Basic with email:api_key, base64-encoded.
// API key lives at Apptoto → Settings → Integrations → API.
//
// Auth (this endpoint): Firebase ID token in Authorization: Bearer ...
// Caller must be owner / admin assistant / super_admin of the centre.
//
// Response: { events: [...], count: N } where each event is whatever
// Apptoto returned — we pass it through so the dashboard can pick out
// fields like title, datetime, attendees as it sees fit.

import { getFirestore, authenticateRequest } from '../_lib/firebase-admin.js';

const APPTOTO_BASE = process.env.APPTOTO_API_BASE || 'https://api.apptoto.com/v1';

// Determine whether the caller can use this centre's integration. Mirrors
// canSeeCenterSettings on the client — owners, admin assistants, and
// super-admins. Plain admins (front-desk) are out.
function canUseIntegration(profile, centerId) {
  if (!profile) return false;
  if (profile.role === 'super_admin') return true;
  const ids = Array.isArray(profile.centerIds)
    ? profile.centerIds
    : (profile.centerId ? [profile.centerId] : []);
  if (!ids.includes(centerId)) return false;
  return profile.role === 'owner' || profile.role === 'admin_assistant';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  let auth;
  try {
    auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  const { centerId, start, end } = req.query;
  if (!centerId) return res.status(400).json({ error: 'centerId required' });

  if (!canUseIntegration(auth.profile, centerId)) {
    return res.status(403).json({ error: 'Not authorized for this centre' });
  }

  // Pull creds from the dedicated centerIntegrations doc.
  const fs = getFirestore();
  const credsSnap = await fs.doc(`centerIntegrations/${centerId}__apptoto`).get();
  if (!credsSnap.exists) {
    return res.status(400).json({ error: 'Apptoto not configured for this centre. Open Centre Settings → Connections to add an API key.' });
  }
  const creds = credsSnap.data();
  if (!creds.email || !creds.apiKey) {
    return res.status(400).json({ error: 'Apptoto credentials incomplete (missing email or apiKey).' });
  }

  // Build the upstream URL. Apptoto's /events accepts ISO start/end
  // filters; we forward whatever the caller passed (default = next 30 d).
  const startISO = start || new Date().toISOString();
  const endISO   = end   || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  const url = new URL(`${APPTOTO_BASE}/events`);
  url.searchParams.set('start_date', startISO);
  url.searchParams.set('end_date',   endISO);

  const basic = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64');
  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    return res.status(502).json({ error: `Apptoto request failed: ${e.message}` });
  }

  const text = await upstream.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!upstream.ok) {
    return res.status(upstream.status).json({
      error: body?.error || body?.message || `Apptoto returned ${upstream.status}`,
      detail: body,
    });
  }

  // Apptoto's response shape isn't documented uniformly across endpoints —
  // some versions return { events: [...] }, others a bare array. Normalise.
  const events = Array.isArray(body)         ? body
               : Array.isArray(body.events)  ? body.events
               : Array.isArray(body.data)    ? body.data
               : [];

  res.status(200).json({ events, count: events.length, raw: body });
}
