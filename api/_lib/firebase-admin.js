// Firebase Admin SDK initializer for Vercel serverless functions.
//
// Reads the service-account JSON from the FIREBASE_SERVICE_ACCOUNT env var
// (set this once in Vercel's project settings — Firebase Console →
// Project Settings → Service Accounts → Generate new private key, then
// paste the entire JSON blob into Vercel as a single env var value).
//
// Cached across invocations in the same warm Lambda so we only pay the
// initialization cost on cold starts.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore as adminGetFirestore } from 'firebase-admin/firestore';
import { getAuth as adminGetAuth } from 'firebase-admin/auth';

let cachedApp = null;

function getApp() {
  if (cachedApp) return cachedApp;
  if (getApps().length > 0) {
    cachedApp = getApps()[0];
    return cachedApp;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT env var is not set. Generate a service ' +
      'account key in the Firebase Console and paste its JSON content as ' +
      'the value of this variable in Vercel.',
    );
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + err.message);
  }
  cachedApp = initializeApp({ credential: cert(serviceAccount) });
  return cachedApp;
}

export function getFirestore() {
  getApp();
  return adminGetFirestore();
}

/**
 * Verify a Firebase ID token. Used by the Checkout / Portal API routes to
 * confirm the caller is who they say they are before doing privileged work.
 * Throws on invalid tokens — callers should wrap in try / catch.
 */
export async function verifyIdToken(token) {
  getApp();
  return adminGetAuth().verifyIdToken(token);
}

/**
 * Convenience: verify an Authorization: Bearer <token> header and return
 * the decoded token + the user's Firestore profile doc. Returns null if
 * the header is missing or the token is invalid.
 */
export async function authenticateRequest(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  try {
    const decoded = await verifyIdToken(token);
    const db = getFirestore();
    const snap = await db.collection('users').doc(decoded.uid).get();
    if (!snap.exists) return { decoded, profile: null };
    return { decoded, profile: { id: snap.id, ...snap.data() } };
  } catch {
    return null;
  }
}
