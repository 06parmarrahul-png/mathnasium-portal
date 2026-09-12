/**
 * shiftSwaps.js — the rules about a shift posted for swap.
 *
 * A swap request is a `chat` document with `type: 'shift_swap'`. It carries
 * the shift it refers to (`shiftId`), who posted it (`userId`) and whether
 * it is still up for grabs (`swapStatus`). Three screens read those fields —
 * the day modal on Schedule, the Shift Board, and the sidebar badge — and
 * each of them was deciding for itself what "already posted" and "mine to
 * take back" meant. Now they ask here.
 *
 * WHY THIS EXISTS AT ALL
 *   Posting the same shift twice was possible: nothing checked, and the
 *   Schedule page never read chat, so it could not have checked. The board
 *   then showed the same shift twice and two people could each take "it".
 */

export const SWAP_TYPE = 'shift_swap';

/** Still up for grabs — not taken, not withdrawn. */
export function isOpenSwap(m) {
  return !!m && m.type === SWAP_TYPE && m.swapStatus === 'open';
}

/**
 * The open request already posted for a shift, or null.
 *
 * Takes the whole list rather than a boolean because every caller needs the
 * document itself: to offer to take it back, or to say who posted it.
 */
export function openSwapFor(swaps, shiftId) {
  if (!shiftId) return null;
  return (swaps || []).find(s => isOpenSwap(s) && s.shiftId === shiftId) || null;
}

/**
 * Can this person take their own request back?
 *
 * Only while it is OPEN. Once somebody has taken it the shift has already
 * changed hands, and un-posting it then would leave the taker holding a
 * shift the schedule no longer says is theirs.
 */
export function canRetract(swap, uid) {
  return !!uid && isOpenSwap(swap) && swap.userId === uid;
}

/**
 * Everything already on the board for a shift, newest first.
 *
 * Used by the pre-post check, which has to cope with the duplicates that
 * the old code already created: taking one down should leave the other
 * visible rather than silently doing nothing.
 */
export function openSwapsFor(swaps, shiftId) {
  if (!shiftId) return [];
  return (swaps || []).filter(s => isOpenSwap(s) && s.shiftId === shiftId);
}
