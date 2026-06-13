// Client-side helpers for the Apptoto integration.
//
// Secrets (email + API key) are stored in a private top-level Firestore
// collection (centerIntegrations/{centerId}__apptoto) so the recursive
// "any signed-in user can read /centers/**" rule doesn't expose them.
// The Vercel API routes (/api/apptoto/*) read those secrets via
// firebase-admin and proxy the upstream call.

import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../../firebase';

const docKey = (centerId) => `${centerId}__apptoto`;

// Read the metadata for the current centre's Apptoto config.
// Returns { configured: bool, email?: string, configuredAt?: Timestamp }.
// The API key itself is included on the client read because the rules
// only allow owner-like roles to access this collection — still, callers
// should never display it.
export async function getApptotoStatus(centerId) {
  if (!centerId) return { configured: false };
  const snap = await getDoc(doc(db, 'centerIntegrations', docKey(centerId)));
  if (!snap.exists()) return { configured: false };
  const d = snap.data();
  return {
    configured: !!(d.email && d.apiKey),
    email: d.email || '',
    configuredAt: d.configuredAt || null,
  };
}

// Save credentials after a successful test.
export async function saveApptotoCredentials(centerId, { email, apiKey }) {
  await setDoc(
    doc(db, 'centerIntegrations', docKey(centerId)),
    {
      email: email.trim(),
      apiKey: apiKey.trim(),
      vendor: 'apptoto',
      centerId,
      configuredAt: serverTimestamp(),
    },
    { merge: true },
  );
}

// Disconnect: wipe the saved credentials.
export async function clearApptotoCredentials(centerId) {
  await deleteDoc(doc(db, 'centerIntegrations', docKey(centerId)));
}

// Verify creds against Apptoto without saving anything. Returns
// { ok: true, sampleEventCount } or { ok: false, error }.
export async function testApptotoConnection({ centerId, email, apiKey }) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) return { ok: false, error: 'Not signed in.' };
  const r = await fetch('/api/apptoto/test-connection', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ centerId, email, apiKey }),
  });
  try {
    return await r.json();
  } catch {
    return { ok: false, error: `Server returned ${r.status}.` };
  }
}

// Fetch upcoming events for a centre. `start` / `end` default to the next
// 30 days. Returns the normalised { events, count } shape from the API.
export async function fetchApptotoEvents(centerId, { start, end } = {}) {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Not signed in.');
  const url = new URL('/api/apptoto/events', window.location.origin);
  url.searchParams.set('centerId', centerId);
  if (start) url.searchParams.set('start', start);
  if (end)   url.searchParams.set('end',   end);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `Request failed (${r.status})`);
  return body;
}
