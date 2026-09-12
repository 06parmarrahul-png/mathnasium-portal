import { describe, it, expect } from 'vitest';
import {
  parseLooseDate, parseAmount, money, rowMatches,
  giftCardDone, giftCardsOutstanding, validateGiftCard,
  receiptOutstanding, receiptsTotal, receiptsByMonth, validateReceipt,
  referralOutstanding, validateReferral,
  sideLabel, sotmOutstanding, validateSotm, monthLabel,
} from './deskTrackers';

/**
 * Fixtures are real rows out of the workbook, mess included: dates typed
 * four different ways, an amount that reads "Two $5 cards", and a refund
 * carrying a negative figure.
 */

describe('parseLooseDate', () => {
  it('reads the typed-out shape the sheets are full of', () => {
    expect(parseLooseDate('March 10th, 2026')).toBe('2026-03-10');
    expect(parseLooseDate('April 1st, 2026')).toBe('2026-04-01');
    expect(parseLooseDate('March 31st, 2026')).toBe('2026-03-31');
    expect(parseLooseDate('November 18th, 2025')).toBe('2025-11-18');
  });

  it('reads a real Date', () => {
    expect(parseLooseDate(new Date(2026, 3, 22))).toBe('2026-04-22');
  });

  it('passes an ISO date straight through', () => {
    expect(parseLooseDate('2026-09-10')).toBe('2026-09-10');
  });

  it('returns null rather than guessing at something unreadable', () => {
    // A guessed date on a payment record is worse than no date.
    expect(parseLooseDate('sometime in the spring')).toBeNull();
    expect(parseLooseDate('Smarch 3rd, 2026')).toBeNull();
    expect(parseLooseDate('')).toBeNull();
    expect(parseLooseDate(null)).toBeNull();
  });
});

describe('parseAmount', () => {
  it('reads numbers and dollar strings', () => {
    expect(parseAmount(15)).toBe(15);
    expect(parseAmount('$15.00')).toBe(15);
    expect(parseAmount('1,712.02')).toBe(1712.02);
    expect(parseAmount(-34.94)).toBe(-34.94);
  });

  it('gives null for a description rather than a wrong number', () => {
    // A real cell reads "Two $5 cards". Calling that 5 would be a lie
    // and calling it 0 would be worse.
    expect(parseAmount('Two $5 cards')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe('money', () => {
  it('formats to the cent', () => {
    expect(money(15)).toBe('$15.00');
    expect(money(1712.02)).toBe('$1,712.02');
  });

  it('keeps a refund negative', () => {
    expect(money(-34.94)).toBe('-$34.94');
  });

  it('says nothing when there is no figure', () => {
    expect(money(null)).toBe('');
    expect(money(undefined)).toBe('');
  });

  it('shows a genuine zero rather than hiding it', () => {
    expect(money(0)).toBe('$0.00');
  });
});

describe('rowMatches', () => {
  it('needs every word, in any order', () => {
    const f = ['One Source', '2 boxes of paper', 'CC (0562)'];
    expect(rowMatches(f, 'paper source')).toBe(true);
    expect(rowMatches(f, 'paper staples')).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(rowMatches(['x'], '')).toBe(true);
  });

  it('ignores empty fields instead of matching on them', () => {
    expect(rowMatches([null, undefined, 'Staples'], 'staples')).toBe(true);
  });
});

describe('gift cards', () => {
  const card = (over = {}) => ({
    studentName: 'Ananya B', type: 'Starbucks', amount: 15,
    purchasedOn: '2026-09-10', handedOverOn: null, initials: 'NG', ...over,
  });

  it('is done when it has been handed over, whatever a status column says', () => {
    // Two real rows read "Pending" with a handover date beside them.
    // Deriving it means there is nothing left to disagree.
    expect(giftCardDone(card({ handedOverOn: '2026-09-12' }))).toBe(true);
    expect(giftCardDone(card())).toBe(false);
  });

  it('lists the ones still owed', () => {
    const rows = [card({ studentName: 'A' }), card({ studentName: 'B', handedOverOn: '2026-09-12' })];
    expect(giftCardsOutstanding(rows).map(c => c.studentName)).toEqual(['A']);
  });

  it('insists on the four things a card cannot be tracked without', () => {
    expect(validateGiftCard(card())).toBeNull();
    expect(validateGiftCard(card({ studentName: '' }))).toMatch(/whose/i);
    expect(validateGiftCard(card({ type: '' }))).toMatch(/kind/i);
    expect(validateGiftCard(card({ amount: null }))).toMatch(/how much/i);
    expect(validateGiftCard(card({ purchasedOn: '' }))).toMatch(/bought/i);
  });

  it('accepts a written amount when there is no single number', () => {
    expect(validateGiftCard(card({ amount: null, amountText: 'Two $5 cards' }))).toBeNull();
  });
});

describe('receipts', () => {
  const r = (over = {}) => ({
    supplier: 'One Source', reference: '583301', orderedOn: '2025-06-16',
    description: '2 boxes of white paper', amount: 129.67,
    paymentMethod: 'CC (0562)', received: true, ...over,
  });

  it('flags what has not arrived', () => {
    expect(receiptOutstanding(r({ received: false }))).toBe(true);
    expect(receiptOutstanding(r())).toBe(false);
  });

  it('totals a list, refunds included', () => {
    expect(receiptsTotal([r({ amount: 100 }), r({ amount: -34.94 })])).toBeCloseTo(65.06, 2);
  });

  it('is zero for nothing', () => {
    expect(receiptsTotal([])).toBe(0);
    expect(receiptsTotal(null)).toBe(0);
  });

  it('groups by month, newest first, with a total each', () => {
    // "What did we spend in June" needed a manual selection before.
    const rows = [
      r({ orderedOn: '2025-06-16', amount: 129.67 }),
      r({ orderedOn: '2025-06-19', amount: 19.98 }),
      r({ orderedOn: '2025-05-07', amount: 333.75 }),
    ];
    const out = receiptsByMonth(rows);
    expect(out.map(g => g.month)).toEqual(['2025-06', '2025-05']);
    expect(out[0].total).toBeCloseTo(149.65, 2);
    expect(out[1].rows.length).toBe(1);
  });

  it('keeps undated rows rather than dropping them', () => {
    const out = receiptsByMonth([r({ orderedOn: null })]);
    expect(out.map(g => g.month)).toEqual(['undated']);
  });

  it('insists on supplier, description, amount and date', () => {
    expect(validateReceipt(r())).toBeNull();
    expect(validateReceipt(r({ supplier: '' }))).toMatch(/bought from/i);
    expect(validateReceipt(r({ description: '' }))).toMatch(/what was bought/i);
    expect(validateReceipt(r({ amount: null }))).toMatch(/how much/i);
    expect(validateReceipt(r({ orderedOn: '' }))).toMatch(/ordered/i);
  });

  it('accepts a refund, which is a negative amount and still valid', () => {
    expect(validateReceipt(r({ amount: -34.94 }))).toBeNull();
  });
});

describe('referral rally', () => {
  const row = (over = {}) => ({
    studentName: 'Mia Palliardi', referredName: 'Alexa Palliardi',
    emailSent: true, prizeCollected: true, cardsGiven: true, ...over,
  });

  it('is outstanding until all three are done', () => {
    expect(referralOutstanding(row())).toBe(false);
    expect(referralOutstanding(row({ emailSent: false }))).toBe(true);
    expect(referralOutstanding(row({ prizeCollected: false }))).toBe(true);
    expect(referralOutstanding(row({ cardsGiven: false }))).toBe(true);
  });

  it('needs both names', () => {
    expect(validateReferral(row())).toBeNull();
    expect(validateReferral(row({ studentName: '' }))).toMatch(/made the referral/i);
    expect(validateReferral(row({ referredName: '' }))).toMatch(/refer/i);
  });
});

describe('student of the month', () => {
  const row = (over = {}) => ({
    month: '2026-01', studentName: 'Huiseong Shin', side: 'E',
    writeUp: true, prizeCollected: true, onTv: false, ...over,
  });

  it('names the side, including the padded values in the sheet', () => {
    expect(sideLabel('E')).toBe('Elementary');
    expect(sideLabel('HS ')).toBe('High School');
    expect(sideLabel('')).toBe('Unassigned');
  });

  it('is outstanding until the write-up, prize and TV are all done', () => {
    expect(sotmOutstanding(row())).toBe(true);            // onTv false
    expect(sotmOutstanding(row({ onTv: true }))).toBe(false);
  });

  it('needs a month, a name and a side', () => {
    expect(validateSotm(row())).toBeNull();
    expect(validateSotm(row({ month: '2026' }))).toMatch(/month/i);
    expect(validateSotm(row({ studentName: '' }))).toMatch(/who/i);
    expect(validateSotm(row({ side: 'X' }))).toMatch(/elementary/i);
  });

  it('writes a month out in words', () => {
    expect(monthLabel('2026-01')).toBe('January 2026');
    expect(monthLabel('2026-09')).toBe('September 2026');
  });

  it('does not invent a month from nonsense', () => {
    expect(monthLabel('nope')).toBe('nope');
    expect(monthLabel('2026-13')).toBe('2026-13');
  });
});
