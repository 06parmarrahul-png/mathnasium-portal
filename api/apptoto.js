// Apptoto integration endpoint — merged into a single Vercel function
// to stay under the Hobby plan's 12-function limit.
//
//   GET  /api/apptoto?centerId=…&start=ISO&end=ISO
//        → paginated upstream proxy + server-side window filter.
//          Returns { events, count, upstreamCount, windowStart, windowEnd }.
//
//   POST /api/apptoto
//        Body: { action: 'test-connection', centerId, email, apiKey }
//        → live-tests the credentials before save. Returns
//          { ok, sampleEventCount } or { ok: false, error }.
//
// Both halves share the same Basic-auth signature against Apptoto and
// the same membership check.

import { Buffer } from 'node:buffer';
import { getFirestore, authenticateRequest } from './_lib/firebase-admin.js';

const APPTOTO_BASE = process.env.APPTOTO_API_BASE || 'https://api.apptoto.com/v1';

// Owners + admin assistants + super-admin of the active centre can use
// the integration; plain admins (front-desk) are out.
function canUseIntegration(profile, centerId) {
  if (!profile) return false;
  if (profile.role === 'super_admin') return true;
  const ids = Array.isArray(profile.centerIds)
    ? profile.centerIds
    : (profile.centerId ? [profile.centerId] : []);
  if (!ids.includes(centerId)) return false;
  return profile.role === 'owner' || profile.role === 'admin_assistant';
}

// ── GET: paginated, filtered upstream proxy ───────────────────────────
async function handleEvents(req, res, auth) {
  const { centerId, start, end } = req.query;
  if (!centerId) return res.status(400).json({ error: 'centerId required' });
  if (!canUseIntegration(auth.profile, centerId)) {
    return res.status(403).json({ error: 'Not authorized for this centre' });
  }

  const fs = getFirestore();
  const credsSnap = await fs.doc(`centerIntegrations/${centerId}__apptoto`).get();
  if (!credsSnap.exists) {
    return res.status(400).json({ error: 'Apptoto not configured for this centre. Open Centre Settings → Connections to add an API key.' });
  }
  const creds = credsSnap.data();
  if (!creds.email || !creds.apiKey) {
    return res.status(400).json({ error: 'Apptoto credentials incomplete (missing email or apiKey).' });
  }

  const startISO = start || new Date().toISOString();
  const endISO   = end   || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const startDate = startISO.slice(0, 10);
  const endDate   = endISO.slice(0, 10);
  const startMs = Date.parse(startISO);
  const endMs   = Date.parse(endISO);

  const url = new URL(`${APPTOTO_BASE}/events`);
  url.searchParams.set('start_date',    startDate);
  url.searchParams.set('end_date',      endDate);
  url.searchParams.set('start_at_min',  startISO);
  url.searchParams.set('start_at_max',  endISO);
  url.searchParams.set('start_at_gte',  startISO);
  url.searchParams.set('start_at_lte',  endISO);
  url.searchParams.set('from',          startISO);
  url.searchParams.set('to',            endISO);
  url.searchParams.set('q',             `start_at:[${startDate} TO ${endDate}]`);
  url.searchParams.set('page_size',     '200');
  url.searchParams.set('per_page',      '200');
  url.searchParams.set('sort',          '-start_time');
  url.searchParams.set('order',         'desc');

  const basic = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64');

  const MAX_PAGES = 12;
  const all = [];
  let body = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = new URL(url.toString());
    pageUrl.searchParams.set('page', String(page));
    let upstream;
    try {
      upstream = await fetch(pageUrl.toString(), {
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
      });
    } catch (e) {
      return res.status(502).json({ error: `Apptoto request failed (page ${page}): ${e.message}` });
    }
    const text = await upstream.text();
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: body?.error || body?.message || `Apptoto returned ${upstream.status}`,
        detail: body, page,
      });
    }
    const pageEvents = Array.isArray(body)         ? body
                     : Array.isArray(body.events)  ? body.events
                     : Array.isArray(body.data)    ? body.data
                     : [];
    if (pageEvents.length === 0) break;
    all.push(...pageEvents);
    if (pageEvents.length < 30) break;
    const lastMs = Math.max(...pageEvents
      .map(e => Date.parse(e?.start_time || e?.start_date || e?.start || '') || 0));
    if (lastMs && lastMs > endMs + 7 * 24 * 3600 * 1000) break;
  }

  const START_KEYS = [
    'start_time', 'start_date', 'start', 'startTime', 'starts_at', 'startsAt',
    'dt_start', 'dtstart', 'event_start', 'calendar_event_start', 'time_start',
    'datetime', 'at', 'when',
  ];
  const pickStartMs = (ev) => {
    if (!ev || typeof ev !== 'object') return NaN;
    const containers = [ev, ev.calendar_event, ev.time];
    for (const c of containers) {
      if (!c) continue;
      for (const k of START_KEYS) {
        if (c[k]) {
          const ms = Date.parse(c[k]);
          if (!isNaN(ms)) return ms;
        }
      }
    }
    return NaN;
  };

  const events = all.filter(ev => {
    const ms = pickStartMs(ev);
    if (isNaN(ms)) return false;
    return ms >= startMs && ms <= endMs;
  });

  const debugInfo = req.query.debug
    ? {
        sampleRaw: all.slice(0, 2),
        upstreamKeys: all[0] ? Object.keys(all[0]) : [],
        pagination: {
          total: body?.total ?? body?.total_count ?? null,
          page:  body?.page  ?? body?.current_page ?? null,
          pages: body?.pages ?? body?.total_pages ?? null,
          links: body?.links ?? null,
        },
      }
    : undefined;

  res.status(200).json({
    events,
    count: events.length,
    upstreamCount: all.length,
    windowStart: startISO,
    windowEnd:   endISO,
    ...(debugInfo ? { debug: debugInfo } : {}),
  });
}

// ── POST: action-routed (currently just 'test-connection') ────────────
async function handlePost(req, res, auth) {
  const { action } = req.body || {};
  if (action === 'test-connection') return handleTestConnection(req, res, auth);
  return res.status(400).json({ ok: false, error: `Unknown action: ${action || '(none)'}` });
}

async function handleTestConnection(req, res, auth) {
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

// ── Method router ────────────────────────────────────────────────────
export default async function handler(req, res) {
  let auth;
  try {
    auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  } catch (e) {
    return res.status(401).json({ error: e.message });
  }

  try {
    if (req.method === 'GET')  return await handleEvents(req, res, auth);
    if (req.method === 'POST') return await handlePost(req, res, auth);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('apptoto endpoint error:', e); // eslint-disable-line no-console
    return res.status(500).json({ error: e?.message || 'Internal error' });
  }
}
