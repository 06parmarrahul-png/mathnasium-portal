/**
 * schedulerFeed.js — reading the Acuity day cache, fast and live.
 *
 * THE PROBLEM THIS SOLVES
 *   Acuity's iCal export is all-or-nothing. Measured 2026-09-15 for Langley:
 *   6.8 MB, 16,093 events, and 26-53 seconds to generate. It ignores
 *   minDate/maxDate/start/end/after and sends no ETag or Last-Modified, so it
 *   can be neither narrowed nor conditionally fetched. Every load of the
 *   Student Scheduler and Supply & Demand paid that, plus 449 Firestore reads.
 *
 * HOW IT'S BOTH FAST AND LIVE
 *   The server parses the feed into one small document per date. This module
 *   subscribes to the date you want, so:
 *     - the page paints from Firestore's local cache almost immediately;
 *     - if the data is older than the server's TTL, a refresh is asked for and
 *       NOT awaited;
 *     - when that refresh writes, the subscription fires and the screen
 *       updates itself.
 *   Nobody waits for Acuity, and the screen still catches up within seconds of
 *   a booking changing. Check-ins, walk-ins and instructor assignments were
 *   always separate live Firestore listeners and are untouched.
 */

import { doc, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../firebase';

/** Shape a page can render before anything has loaded. */
export function emptyDay(date) {
  return {
    day: date,
    slots: [],
    totals: { HS: 0, EM: 0, Online: 0, Unknown: 0, all: 0 },
    unknownList: [],
  };
}

/**
 * Ask the server to re-read Acuity. Fire-and-forget by design — it takes the
 * better part of a minute and no page should be blocked on it. The result
 * arrives through the subscription, not through this promise.
 */
export async function requestFeedRefresh(centerId) {
  if (!centerId) return null;
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return null;
    const res = await fetch(
      `/api/scheduler/appointments?action=refresh-feed&centerId=${encodeURIComponent(centerId)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    return res.ok ? await res.json() : null;
  } catch {
    // A failed refresh is not a failed page — whatever is cached still renders.
    return null;
  }
}

/**
 * Subscribe to one cached date.
 *
 * @param {string} centerId
 * @param {string} date        'YYYY-MM-DD'
 * @param {Function} onData    ({ grouped, refreshedAt, loading }) => void
 * @param {Object} [opts]
 * @param {number} [opts.ttlMs=60000]  older than this and a refresh is asked for
 * @returns {Function} unsubscribe
 */
export function watchFeedDay(centerId, date, onData, opts = {}) {
  if (!centerId || !date) return () => {};
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : 60 * 1000;
  let asked = false;

  return onSnapshot(
    doc(db, 'centers', centerId, 'schedulerDays', date),
    (snap) => {
      if (!snap.exists()) {
        // Nothing cached for this date. Either the centre has no bookings
        // then, or the cache has never been built. Ask once and show empty
        // meanwhile rather than an error.
        if (!asked) { asked = true; requestFeedRefresh(centerId); }
        onData({ grouped: emptyDay(date), refreshedAt: null, loading: !asked });
        return;
      }
      const { refreshedAt = null, ...grouped } = snap.data() || {};
      onData({ grouped, refreshedAt, loading: false });

      const age = refreshedAt ? Date.now() - new Date(refreshedAt).getTime() : Infinity;
      if (!asked && age > ttlMs) { asked = true; requestFeedRefresh(centerId); }
    },
    () => onData({ grouped: emptyDay(date), refreshedAt: null, loading: false }),
  );
}

/** "just now" / "4 min ago" — for the refreshed-at line on a page. */
export function describeAge(refreshedAt) {
  if (!refreshedAt) return 'never';
  const mins = Math.floor((Date.now() - new Date(refreshedAt).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
}
