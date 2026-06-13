// POST /api/apptoto/test-connection
//
// Verifies an Apptoto email + API key are valid by hitting the /events
// endpoint with a 1-day window and checking for HTTP 200. Used by the
// "Test & save" button in the Apptoto setup modal — we want the user to
// know the key works BEFORE we write it to Firestore.
//
// Auth: Firebase ID token in Authorization: Bearer ...
//       Caller must be owner / admin assistant / super_admin of the centre.
//
// Body: { centerId, email, apiKey }
// Response: { ok: true, sampleEventCount }  on success
//           { ok: false, error: '...' }     on auth / network failure

import { authenticateRequest } from '../_lib/firebase-admin.js';

const APPTOTO_BASE = process.env.APPTOTO_API_BASE || 'https://api.apptoto.com/v1';

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
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let auth;
  try {
    auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  } catch (e) {
    return res.status(401).json({ ok: false, error: e.message });
  }

  const { centerId, email, apiKey } = req.body || {};
  if (!centerId || !email || !apiKey) {
    return res.status(400).json({ ok: false, error: 'centerId, email, and apiKey are required.' });
  }
  if (!canUseIntegration(auth.profile, centerId)) {
    return res.status(403).json({ ok: false, error: 'Not authorized for this centre' });
  }

  const url = new URL(`${APPTOTO_BASE}/events`);
  url.searchParams.set('start_date', new Date().toISOString());
  url.searchParams.set('end_date',   new Date(Date.now() + 24 * 3600 * 1000).toISOString());

  const basic = Buffer.from(`${email}:${apiKey}`).toString('base64');
  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: `Network error: ${e.message}` });
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return res.status(200).json({ ok: false, error: 'Apptoto rejected the credentials. Double-check the email and API key.' });
  }
  if (!upstream.ok) {
    const t = await upstream.text();
    return res.status(200).json({ ok: false, error: `Apptoto returned ${upstream.status}: ${t.slice(0, 200)}` });
  }

  let body;
  try { body = await upstream.json(); } catch { body = {}; }
  const arr = Array.isArray(body) ? body
            : Array.isArray(body.events) ? body.events
            : Array.isArray(body.data) ? body.data
            : [];

  return res.status(200).json({ ok: true, sampleEventCount: arr.length });
}
