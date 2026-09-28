/**
 * deskReset.js — taking the imported spreadsheet back out.
 *
 * WHY THIS EXISTS
 *   The spreadsheet has no id to match rows on, so a second import adds a
 *   second copy of everything — DeskImport says so in those words. That
 *   left one way to bring an updated sheet across: clear what the last
 *   import wrote, then import again.
 *
 * IT IS NOT "DELETE EVERYTHING", AND THAT DISTINCTION IS THE POINT.
 *   Every row an import writes is stamped `imported: true`. Notes the team
 *   has typed in Ratio since — and gift cards, receipts and referrals
 *   added on the tracker tabs — carry no such stamp. They are not in the
 *   spreadsheet, so a re-import would not put them back, and a blanket
 *   wipe would quietly destroy the desk's real work to solve a duplicate
 *   problem that only concerns the imported half.
 *
 *   So this removes exactly what an import put there, and the panel says
 *   how many rows it is keeping before anybody presses anything.
 *
 * WHAT IS STILL LOST, and the panel says this too: anything done in Ratio
 * TO an imported note — settling it, a reply, a due date — goes with the
 * note, because the note itself is going. The re-imported copy is the
 * spreadsheet's version of it.
 *
 * PURE MODULE — no React, no Firebase.
 */

/** The five collections an import writes, in the order it writes them. */
export const DESK_COLLECTIONS = [
  { key: 'notes',          one: 'note',                 many: 'notes' },
  { key: 'giftCards',      one: 'gift card',            many: 'gift cards' },
  { key: 'receipts',       one: 'receipt',              many: 'receipts' },
  { key: 'referrals',      one: 'referral row',         many: 'referral rows' },
  { key: 'studentOfMonth', one: 'student of the month row', many: 'student of the month rows' },
];

/**
 * Did an import write this row?
 *
 * Strict `=== true` rather than truthy: the stamp is written as a boolean
 * and nothing else should be read as one. A row with no stamp is somebody's
 * own work and stays.
 */
export function isImported(row) {
  return row?.imported === true;
}

/** "1 note" / "12 notes", from the labels above. */
export function countLabel(collectionKey, count) {
  const spec = DESK_COLLECTIONS.find(c => c.key === collectionKey);
  if (!spec) return `${count}`;
  return `${count} ${count === 1 ? spec.one : spec.many}`;
}

/**
 * What a reset would do, from per-collection counts of what is there.
 *
 * @param {Object} counts  { notes: { imported, kept }, giftCards: {…}, … }
 * @returns {{ total, kept, lines, keptLines, isEmpty }}
 *
 * `lines` is what goes, `keptLines` what stays — both already worded, and
 * both leaving out the collections with nothing to say. A reset panel that
 * lists five zeroes reads as five problems.
 */
export function resetPlan(counts = {}) {
  const lines = [];
  const keptLines = [];
  let total = 0;
  let kept = 0;

  for (const spec of DESK_COLLECTIONS) {
    const imported = Math.max(0, Number(counts[spec.key]?.imported) || 0);
    const own = Math.max(0, Number(counts[spec.key]?.kept) || 0);
    total += imported;
    kept += own;
    if (imported > 0) lines.push({ key: spec.key, count: imported, label: countLabel(spec.key, imported) });
    if (own > 0) keptLines.push({ key: spec.key, count: own, label: countLabel(spec.key, own) });
  }

  return { total, kept, lines, keptLines, isEmpty: total === 0 };
}

/**
 * The word somebody has to type to arm the button.
 *
 * Not "DELETE" on its own. This is a per-centre action and the app can
 * switch centres under you, so the confirmation names the centre it is
 * about — the one keystroke that makes "wrong centre" impossible to do by
 * muscle memory.
 */
export function confirmWordFor(centerId) {
  return `DELETE ${String(centerId || '').toUpperCase()}`.trim();
}
