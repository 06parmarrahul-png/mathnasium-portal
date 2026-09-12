/**
 * deskTrackers.js — the four trackers that sit beside the notes.
 *
 * Gift cards, receipts, the referral rally, and student of the month.
 * Each was a tab in the same workbook, each is a list of rows with a
 * handful of "has this been done yet" flags, and each has exactly one
 * question worth answering at a glance:
 *
 *   Gift cards   — which are bought but not yet handed over?
 *   Receipts     — what has been ordered and not yet arrived?
 *   Referrals    — who is owed an email or a prize?
 *   Student of…  — whose write-up is still missing?
 *
 * DERIVED, NOT TYPED
 *   The spreadsheet carried a hand-typed Status column NEXT TO the date
 *   that decided it — so a card could say "Pending" with a completion
 *   date filled in, and two of them did. Status is derived here. There is
 *   nothing to keep in sync because there is only one field.
 */

// ─── Shared ──────────────────────────────────────────────────────────────

/**
 * "March 10th, 2026" and friends → '2026-03-10'.
 *
 * The old sheets mixed real dates with typed-out ones in at least four
 * shapes. Import runs through here; anything it cannot read comes back
 * null and keeps its original text in a `*Text` field rather than being
 * guessed at.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const pad = (n) => String(n).padStart(2, '0');

export function parseLooseDate(v) {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi >= 0) return `${m[3]}-${pad(mi + 1)}-${pad(Number(m[2]))}`;
  }
  return null;
}

/** A number from a cell that might be '$15.00', 15, or 'Two $5 cards'. */
export function parseAmount(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v ?? '').replace(/[$,]/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** $1,712.02. Negative amounts are refunds and keep their sign. */
export function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
  const s = Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}$${s}`;
}

/** Every word of the query has to appear somewhere in the row. */
export function rowMatches(fields, q) {
  const needle = String(q ?? '').trim().toLowerCase();
  if (!needle) return true;
  const blob = fields.filter(Boolean).join(' • ').toLowerCase();
  return needle.split(/\s+/).every(w => blob.includes(w));
}

// ─── Gift cards ──────────────────────────────────────────────────────────

/**
 * A card is done when it has been handed over. Not when a column says so.
 *
 * The sheet had both, and they disagreed: two rows read "Pending" with a
 * handover date sitting next to them.
 */
export function giftCardDone(card) {
  return !!card?.handedOverOn;
}

export function giftCardsOutstanding(rows) {
  return (rows || []).filter(c => !giftCardDone(c));
}

export function giftCardSearchFields(c) {
  return [c?.studentName, c?.type, c?.notes, c?.initials, money(c?.amount), c?.amountText];
}

export function validateGiftCard(d) {
  if (!String(d?.studentName || '').trim()) return 'Whose card is it?';
  if (!String(d?.type || '').trim()) return 'What kind of card? Roblox, Starbucks, Amazon…';
  if (d?.amount == null && !String(d?.amountText || '').trim()) return 'How much is it for?';
  if (!d?.purchasedOn) return 'When was it bought?';
  return null;
}

/** The types already in use, most-used first. Offered as suggestions. */
export const GIFT_CARD_TYPES = [
  'Roblox', 'Starbucks', 'Amazon', 'Tim Hortons', 'Visa', 'McDonalds',
  'Apple', 'PlayStation', 'Other',
];

// ─── Receipts ────────────────────────────────────────────────────────────

/**
 * Two separate questions the old sheet blurred into free text:
 * has it ARRIVED, and has it been PAID. "received july 11, 2025" and
 * "CC PAYMENT COMPLETE" were both typed into columns that then could not
 * be counted or filtered.
 */
export function receiptOutstanding(r) {
  return !r?.received;
}

export function receiptsTotal(rows) {
  return (rows || []).reduce((sum, r) => sum + (Number(r?.amount) || 0), 0);
}

export function receiptSearchFields(r) {
  return [r?.supplier, r?.reference, r?.description, r?.paymentMethod, r?.notes, money(r?.amount)];
}

export function validateReceipt(d) {
  if (!String(d?.supplier || '').trim()) return 'Who was it bought from?';
  if (!String(d?.description || '').trim()) return 'What was bought?';
  if (d?.amount == null || !Number.isFinite(Number(d.amount))) return 'How much was it?';
  if (!d?.orderedOn) return 'When was it ordered?';
  return null;
}

/**
 * Receipts grouped by month, newest first, with a total for each.
 *
 * The spreadsheet could not answer "what did we spend in June" without
 * somebody selecting a range by hand.
 */
export function receiptsByMonth(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const key = String(r?.orderedOn || '').slice(0, 7) || 'undated';
    if (!groups.has(key)) groups.set(key, { month: key, rows: [], total: 0 });
    const g = groups.get(key);
    g.rows.push(r);
    g.total += Number(r?.amount) || 0;
  }
  return [...groups.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

// ─── Referral rally ──────────────────────────────────────────────────────

/** Still owed something — the email, the prize, or the 25 cards. */
export function referralOutstanding(r) {
  return !(r?.emailSent && r?.prizeCollected && r?.cardsGiven);
}

export function referralSearchFields(r) {
  return [r?.studentName, r?.referredName, r?.collectedFrom];
}

export function validateReferral(d) {
  if (!String(d?.studentName || '').trim()) return 'Who made the referral?';
  if (!String(d?.referredName || '').trim()) return 'Who did they refer?';
  return null;
}

// ─── Student of the month ────────────────────────────────────────────────

export const SIDES = { E: 'Elementary', HS: 'High School' };

export function sideLabel(side) {
  return SIDES[String(side || '').trim().toUpperCase()] || 'Unassigned';
}

/** Still to do before it can go up: the write-up, the prize, the TV. */
export function sotmOutstanding(r) {
  return !(r?.writeUp && r?.prizeCollected && r?.onTv);
}

export function sotmSearchFields(r) {
  return [r?.studentName, r?.month, sideLabel(r?.side)];
}

export function validateSotm(d) {
  if (!/^\d{4}-\d{2}$/.test(String(d?.month || ''))) return 'Which month?';
  if (!String(d?.studentName || '').trim()) return 'Who is it?';
  if (!SIDES[String(d?.side || '').toUpperCase()]) return 'Elementary or High School?';
  return null;
}

/** "September 2026" from '2026-09'. */
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return String(ym || '');
  const i = Number(m[2]) - 1;
  if (i < 0 || i > 11) return String(ym);
  return `${MONTHS[i][0].toUpperCase()}${MONTHS[i].slice(1)} ${m[1]}`;
}
