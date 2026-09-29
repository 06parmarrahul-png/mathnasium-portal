/**
 * consentStore.js — where a family's yes and no are kept.
 *
 * Storage: centers/{centreId}/contactConsent/{contactKey}
 *
 *   { channel, address, state, updatedAt, history: [ …entries ] }
 *
 * PER CENTRE, because consent is given to a sender, not to software. A
 * family who tells Langley to stop has not told Burnaby anything, and
 * silently applying it across a district would be inventing a decision
 * they did not make.
 *
 * KEYED BY NORMALISED ADDRESS, not by lead or intake. The same family
 * books three times over two years and is one person with one phone; a
 * stop has to outlive every document it arrived on.
 *
 * HISTORY IS APPEND-ONLY and keeps the wording each time — the text they
 * were shown, or the text they sent. "They consented" is worth very
 * little; "here is what they were shown, on this date, and the reply they
 * sent eight months later" is the version that answers a complaint.
 */

import {
  contactKey, consentEntry, normaliseAddress, maySend,
} from '../../src/lib/consent.js';

export { contactKey, normaliseAddress, maySend };

const refFor = (fs, centreId, key) =>
  fs.doc(`centers/${centreId}/contactConsent/${key}`);

/** What we know about this address, or null if we have never heard. */
export async function readConsent(fs, centreId, channel, address) {
  const key = contactKey(channel, address);
  if (!key) return null;
  const snap = await refFor(fs, centreId, key).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Record a change of mind, keeping every previous one.
 *
 * Returns the entry written, so the caller can log what it did rather
 * than guess. A no-op (same state, same source) still appends: knowing
 * somebody said STOP twice is worth more than de-duplicating it away.
 */
export async function recordConsent(fs, centreId, { channel, address, state, source, wording, actor }) {
  const key = contactKey(channel, address);
  if (!key) throw new Error(`Unusable ${channel} address`);
  const entry = consentEntry({ channel, address, state, source, wording, actor });
  const ref = refFor(fs, centreId, key);

  await fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : null;
    const history = Array.isArray(prev?.history) ? prev.history : [];
    tx.set(ref, {
      channel,
      address: entry.address,
      state,
      updatedAt: entry.at,
      // Capped so one person replying STOP fifty times cannot grow a
      // document past Firestore's limit and start failing writes.
      history: [...history, entry].slice(-100),
    }, { merge: true });
  });

  return entry;
}

/**
 * The one question every send path asks.
 *
 * `hasTransactionalBasis` is the caller saying "this person booked with
 * us" — it is what separates a reminder they are expecting from a
 * promotion they did not ask for.
 */
export async function checkBeforeSend(fs, centreId, { channel, address, kind, hasTransactionalBasis }) {
  const norm = normaliseAddress(channel, address);
  if (!norm) return { allowed: false, reason: 'unusable-address', address: null };
  const record = await readConsent(fs, centreId, channel, norm);
  const verdict = maySend({ record, kind, hasTransactionalBasis });
  return { ...verdict, address: norm, state: record?.state || 'unknown' };
}
