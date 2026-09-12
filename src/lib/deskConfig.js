/**
 * deskConfig.js — the four trackers, described as data.
 *
 * Gift cards, receipts, referrals and student of the month are the same
 * shape of thing: a list of rows, a few "has this been done" flags, and
 * one question worth answering at a glance. Writing four nearly-identical
 * tables by hand is how three of them slowly drift out of step with the
 * fourth — so they are described here and rendered once.
 *
 * A `field` is what the add/edit form shows. A `column` is what the table
 * shows. They are separate on purpose: a receipt is EDITED with a note
 * field, but that note is not worth a column of its own on a table you
 * scan for money and dates.
 */

import {
  giftCardDone, giftCardsOutstanding, giftCardSearchFields, validateGiftCard,
  GIFT_CARD_TYPES,
  receiptOutstanding, receiptSearchFields, validateReceipt,
  referralOutstanding, referralSearchFields, validateReferral,
  sotmOutstanding, sotmSearchFields, validateSotm, sideLabel, monthLabel,
  money,
} from './deskTrackers';

export const TRACKERS = {
  giftCards: {
    key: 'giftCards',
    collection: 'giftCards',
    title: 'Gift cards',
    // The question the tab exists to answer, asked in the filter chips.
    outstandingLabel: 'Not handed over',
    doneLabel: 'Handed over',
    isOutstanding: (r) => !giftCardDone(r),
    outstanding: giftCardsOutstanding,
    searchFields: giftCardSearchFields,
    validate: validateGiftCard,
    sortKey: (r) => r.purchasedOn || '',
    blank: {
      studentName: '', type: 'Roblox', amount: null, amountText: '',
      purchasedOn: '', handedOverOn: '', initials: '', notes: '',
      prepurchased: true,
    },
    fields: [
      { id: 'studentName', label: 'Student', type: 'text', autoFocus: true, span: 2 },
      { id: 'type', label: 'Card', type: 'select', options: GIFT_CARD_TYPES },
      { id: 'amount', label: 'Amount', type: 'money' },
      { id: 'purchasedOn', label: 'Bought on', type: 'date' },
      { id: 'handedOverOn', label: 'Handed over on', type: 'date', hint: 'leave blank until it is' },
      { id: 'prepurchased', label: 'Prepurchased', type: 'bool' },
      { id: 'initials', label: 'Who bought it', type: 'text' },
      { id: 'notes', label: 'Notes', type: 'text', span: 2 },
    ],
    columns: [
      { id: 'studentName', label: 'Student', strong: true },
      { id: 'type', label: 'Card' },
      { id: 'amount', label: 'Amount', render: (r) => r.amountText || money(r.amount), numeric: true },
      { id: 'purchasedOn', label: 'Bought', type: 'date' },
      { id: 'handedOverOn', label: 'Handed over', type: 'date', empty: 'Not yet' },
      { id: 'initials', label: 'By' },
    ],
  },

  receipts: {
    key: 'receipts',
    collection: 'receipts',
    title: 'Receipts',
    outstandingLabel: 'Not arrived',
    doneLabel: 'Arrived',
    isOutstanding: receiptOutstanding,
    outstanding: (rows) => (rows || []).filter(receiptOutstanding),
    searchFields: receiptSearchFields,
    validate: validateReceipt,
    sortKey: (r) => r.orderedOn || '',
    blank: {
      supplier: '', reference: '', orderedOn: '', description: '',
      amount: null, paymentMethod: 'CC (0562)', received: false, notes: '',
    },
    fields: [
      { id: 'supplier', label: 'Supplier', type: 'text', autoFocus: true },
      { id: 'reference', label: 'Invoice / order no.', type: 'text' },
      { id: 'description', label: 'What was bought', type: 'text', span: 2 },
      { id: 'amount', label: 'Amount', type: 'money' },
      { id: 'orderedOn', label: 'Ordered on', type: 'date' },
      { id: 'paymentMethod', label: 'Paid with', type: 'text' },
      { id: 'received', label: 'Arrived', type: 'bool' },
      { id: 'notes', label: 'Notes', type: 'text', span: 2 },
    ],
    columns: [
      { id: 'supplier', label: 'Supplier', strong: true },
      { id: 'description', label: 'What', wide: true },
      { id: 'amount', label: 'Amount', render: (r) => money(r.amount), numeric: true },
      { id: 'orderedOn', label: 'Ordered', type: 'date' },
      { id: 'paymentMethod', label: 'Paid with' },
      { id: 'received', label: 'Arrived', type: 'bool' },
    ],
  },

  referrals: {
    key: 'referrals',
    collection: 'referrals',
    title: 'Referral rally',
    outstandingLabel: 'Still owed',
    doneLabel: 'All done',
    isOutstanding: referralOutstanding,
    outstanding: (rows) => (rows || []).filter(referralOutstanding),
    searchFields: referralSearchFields,
    validate: validateReferral,
    sortKey: (r) => r.collectedOn || '',
    blank: {
      studentName: '', referredName: '', emailSent: false,
      prizeCollected: false, cardsGiven: false, collectedOn: '', collectedFrom: '',
    },
    fields: [
      { id: 'studentName', label: 'Who referred', type: 'text', autoFocus: true },
      { id: 'referredName', label: 'Who they referred', type: 'text' },
      { id: 'emailSent', label: 'Email sent', type: 'bool' },
      { id: 'prizeCollected', label: 'Prize collected', type: 'bool' },
      { id: 'cardsGiven', label: '25 cards given', type: 'bool' },
      { id: 'collectedOn', label: 'Collected on', type: 'date' },
      { id: 'collectedFrom', label: 'Collected from', type: 'text', span: 2 },
    ],
    columns: [
      { id: 'studentName', label: 'Who referred', strong: true },
      { id: 'referredName', label: 'They referred' },
      { id: 'emailSent', label: 'Email', type: 'bool' },
      { id: 'prizeCollected', label: 'Prize', type: 'bool' },
      { id: 'cardsGiven', label: '25 cards', type: 'bool' },
      { id: 'collectedOn', label: 'Collected', type: 'date' },
      { id: 'collectedFrom', label: 'From' },
    ],
  },

  studentOfMonth: {
    key: 'studentOfMonth',
    collection: 'studentOfMonth',
    title: 'Student of the month',
    outstandingLabel: 'Still to do',
    doneLabel: 'Done',
    isOutstanding: sotmOutstanding,
    outstanding: (rows) => (rows || []).filter(sotmOutstanding),
    searchFields: sotmSearchFields,
    validate: validateSotm,
    sortKey: (r) => r.month || '',
    blank: {
      month: '', studentName: '', side: 'E',
      writeUp: false, prizeCollected: false, onTv: false,
    },
    fields: [
      { id: 'month', label: 'Month', type: 'month', autoFocus: true },
      { id: 'side', label: 'Side', type: 'select', options: ['E', 'HS'], render: sideLabel },
      { id: 'studentName', label: 'Student', type: 'text', span: 2 },
      { id: 'writeUp', label: 'Write-up done', type: 'bool' },
      { id: 'prizeCollected', label: 'Prize collected', type: 'bool' },
      { id: 'onTv', label: 'On the TV', type: 'bool' },
    ],
    columns: [
      { id: 'month', label: 'Month', render: (r) => monthLabel(r.month), strong: true },
      { id: 'side', label: 'Side', render: (r) => sideLabel(r.side) },
      { id: 'studentName', label: 'Student' },
      { id: 'writeUp', label: 'Write-up', type: 'bool' },
      { id: 'prizeCollected', label: 'Prize', type: 'bool' },
      { id: 'onTv', label: 'On TV', type: 'bool' },
    ],
  },
};

export const TRACKER_LIST = Object.values(TRACKERS);
