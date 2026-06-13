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

  // Window bounds. Default = today → +30d. We forward these to Apptoto
  // via every common param name (their docs aren't crystal clear which
  // the /events endpoint honours, and an unrecognised param is harmless),
  // THEN filter again on the server side using parsed start times. The
  // double-pass guarantees we never return 2025 data when the caller asked
  // for next-month — even if Apptoto ignores the upstream filter and just
  // returns the default first page.
  const startISO = start || new Date().toISOString();
  const endISO   = end   || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const startDate = startISO.slice(0, 10);
  const endDate   = endISO.slice(0, 10);
  const startMs = Date.parse(startISO);
  const endMs   = Date.parse(endISO);

  const url = new URL(`${APPTOTO_BASE}/events`);
  // Try every commonly-used param name. Apptoto will use the ones it
  // recognises and ignore the rest. Page size cranked up so the
  // server-side filter has something to filter against. Lucene-style q
  // mirrors Apptoto's documented appointment search syntax.
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

  // Walk up to MAX_PAGES of results so we can find the requested window
  // even when Apptoto serves events oldest-first in pages of 30 and
  // ignores our date filter. Stop early when a page comes back empty or
  // when EVERY event on a page is past the requested window (asc order).
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
    if (pageEvents.length === 0) break;            // no more pages
    all.push(...pageEvents);
    if (pageEvents.length < 30) break;             // last (partial) page
    // Early-exit: if the latest event on this page is already after our
    // window end (i.e. results are asc-sorted and we've cleared the
    // requested range), stop paginating.
    const lastMs = Math.max(...pageEvents
      .map(e => Date.parse(e?.start_time || e?.start_date || e?.start || '') || 0));
    if (lastMs && lastMs > endMs + 7 * 24 * 3600 * 1000) break;
  }

  // ── Server-side window filter ───────────────────────────────────────
  // Same field-name fallbacks we use on the client, applied here so a
  // mis-configured upstream filter can't sneak unrelated dates through.
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
    if (isNaN(ms)) return false;     // events whose start we can't parse get dropped
    return ms >= startMs && ms <= endMs;
  });

  // Debug pass-through: callers can append &debug=1 to get a peek at the
  // first 2 raw events + any pagination cues Apptoto returned. Used when
  // the date filter isn't working as expected.
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
    upstreamCount: all.length,       // how many Apptoto returned before our filter
    windowStart: startISO,
    windowEnd: endISO,
    ...(debugInfo ? { debug: debugInfo } : {}),
  });
}
