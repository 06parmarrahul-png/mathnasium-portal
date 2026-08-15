/**
 * Centre Inventory — data layer.
 *
 * WHAT THIS IS
 *   Every Mathnasium centre runs on consumables: whiteboard markers for the
 *   STEAM table, prize-box trinkets, Halloween decorations, camp t-shirts,
 *   printer toner, disinfectant wipes. Today that lives in someone's head
 *   and gets discovered at 4:55pm on a Friday. This is the ledger that
 *   replaces the head.
 *
 * WHO SEES IT
 *   Admin-and-above ONLY — owner, admin_assistant, director, admin,
 *   super_admin. Same gate as the Admin Panel (`canSeeAdminPanel` in
 *   AuthContext, `requireOwner` on the route, and an explicit rules block
 *   in firestore.rules). Instructors never see supply counts or costs.
 *
 * CENTRE SCOPING
 *   Everything hangs off the centre, exactly like leads / demandSnapshots:
 *
 *     centers/{centerId}/inventory/{itemId}      ← the items
 *     centers/{centerId}/inventory/__settings    ← alert config (see below)
 *     centers/{centerId}/inventoryLog/{entryId}  ← every count change
 *
 *   Langley's marker count is invisible to Burnaby and vice-versa. The
 *   settings doc lives INSIDE the inventory collection on purpose so it
 *   inherits the same admin-only security rule instead of needing its own.
 *   Every read filters it out by id (see `isItemDoc`).
 *
 * THE REORDER LOOP (the point of the whole thing)
 *   Each item carries `par` — the count at or below which we need to
 *   order more — and `orderUrl`, the link an admin set up once (Amazon
 *   saved cart, Staples list, the franchise supply portal, whatever).
 *   When qty <= par the item turns Low; at 0 it turns Out. The weekly
 *   cron (api/cron/check-inventory.js) emails the admin team the list of
 *   Low/Out items with those links attached, so "we're running low on X"
 *   arrives before the shelf is empty and ordering is one click, not a
 *   scavenger hunt for last year's invoice.
 *
 * DATES
 *   ISO strings via toISOString(), matching the rest of the codebase
 *   (shifts, audit log, notification prefs). Not Firestore Timestamps —
 *   mixing the two has bitten us before.
 */

import {
  collection, doc, onSnapshot, setDoc, addDoc, deleteDoc,
  query, orderBy, limit, getDocs, writeBatch,
} from 'firebase/firestore';
import { db, auth } from '../firebase';

// ─── Categories ────────────────────────────────────────────────────────
//
// Fixed list, defined once here. Adding a category = one entry in this
// array and it flows to the filter chips, the add/edit form, the CSV
// export, the KPI grouping and the reorder email automatically.
//
// Colours are deliberately far apart so a glance at the table tells you
// what kind of supply you're looking at. STEAM (dark gold) and Summer
// Camp (orange) reuse the exact hexes from lib/subRoles.js FLEX_ROLE_STYLES
// so a STEAM *shift* and a STEAM *supply* read as the same thing.
//
// Tailwind class names are written out in full rather than built by
// string concatenation — the JIT compiler only keeps classes it can see
// literally in the source, so `bg-${color}-100` silently produces
// unstyled chips in a production build.

export const INVENTORY_CATEGORIES = [
  {
    key: 'steam',
    label: 'STEAM',
    sublabel: 'STEM + Art',
    hex: '#a16207',
    chip: 'bg-yellow-100 text-yellow-900 border-yellow-300',
    icon: 'FlaskConical',
  },
  {
    key: 'events',
    label: 'Events',
    sublabel: 'Open houses, parent nights',
    hex: '#db2777',
    chip: 'bg-pink-100 text-pink-800 border-pink-200',
    icon: 'PartyPopper',
  },
  {
    key: 'games',
    label: 'Games',
    sublabel: 'Board games, card decks, dice',
    hex: '#7c3aed',
    chip: 'bg-violet-100 text-violet-800 border-violet-200',
    icon: 'Gamepad2',
  },
  {
    key: 'holidays',
    label: 'Holidays',
    sublabel: 'Seasonal decor and giveaways',
    hex: '#dc2626',
    chip: 'bg-red-100 text-red-800 border-red-200',
    icon: 'Gift',
  },
  {
    key: 'summer_camp',
    label: 'Summer Camp',
    sublabel: 'Camp kits, shirts, handouts',
    hex: '#f97316',
    chip: 'bg-orange-100 text-orange-900 border-orange-300',
    icon: 'Sun',
  },
  {
    key: 'crafts',
    label: 'Crafts',
    sublabel: 'Paper, glue, scissors, paint',
    hex: '#0d9488',
    chip: 'bg-teal-100 text-teal-800 border-teal-200',
    icon: 'Scissors',
  },
  {
    key: 'fun_days',
    label: 'Fun Days',
    sublabel: 'Pizza days, movie days, themed days',
    hex: '#0891b2',
    chip: 'bg-cyan-100 text-cyan-800 border-cyan-200',
    icon: 'Smile',
  },
  {
    key: 'administrative',
    label: 'Administrative',
    sublabel: 'Office, printing, front desk',
    hex: '#475569',
    chip: 'bg-slate-100 text-slate-800 border-slate-300',
    icon: 'ClipboardList',
  },
  {
    key: 'cleaning',
    label: 'Cleaning',
    sublabel: 'Wipes, spray, paper towel',
    hex: '#16a34a',
    chip: 'bg-green-100 text-green-800 border-green-200',
    icon: 'SprayCan',
  },
  {
    key: 'rewards',
    label: 'Rewards',
    sublabel: 'Prize box, punch cards, certificates',
    hex: '#4f46e5',
    chip: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    icon: 'Trophy',
  },
];

export const CATEGORY_KEYS = INVENTORY_CATEGORIES.map(c => c.key);

const CATEGORY_BY_KEY = Object.fromEntries(
  INVENTORY_CATEGORIES.map(c => [c.key, c]),
);

/**
 * Look up a category by key. Never returns undefined — an item saved with
 * a category we later removed still renders as a neutral grey chip rather
 * than crashing the table.
 */
export function categoryFor(key) {
  return CATEGORY_BY_KEY[key] || {
    key: key || 'uncategorised',
    label: key || 'Uncategorised',
    sublabel: '',
    hex: '#9ca3af',
    chip: 'bg-gray-100 text-gray-700 border-gray-200',
    icon: 'Package',
  };
}

// ─── Units ─────────────────────────────────────────────────────────────
// Free text is allowed, but offering a short list stops the same thing
// being counted in "boxes" on one row and "box" on the next.
export const INVENTORY_UNITS = [
  'each', 'pack', 'box', 'case', 'set', 'roll', 'bottle', 'bag', 'ream', 'kit',
];

// ─── Stock status ──────────────────────────────────────────────────────

export const STATUS = {
  OUT:  'out',
  LOW:  'low',
  OK:   'ok',
};

/**
 * Where an item sits against its reorder point.
 *
 *   qty <= 0            → OUT  (we have none; this is now urgent)
 *   qty <= par          → LOW  (order before it becomes urgent)
 *   otherwise           → OK
 *
 * An item with par = 0 never goes Low — that's the escape hatch for
 * things you genuinely don't restock (a donated chess set), and it's why
 * par defaults to a real number on new items rather than 0.
 */
export function itemStatus(item) {
  const qty = Number(item?.qty) || 0;
  const par = Number(item?.par) || 0;
  if (qty <= 0) return STATUS.OUT;
  if (par > 0 && qty <= par) return STATUS.LOW;
  return STATUS.OK;
}

export const STATUS_STYLE = {
  out: { label: 'Out',      chip: 'bg-red-100 text-red-800 border-red-200',          dot: 'bg-red-600'    },
  low: { label: 'Low',      chip: 'bg-amber-100 text-amber-900 border-amber-300',    dot: 'bg-amber-500'  },
  ok:  { label: 'In stock', chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: 'bg-emerald-500' },
};

/** Items that belong in the reorder email / order list, worst first. */
export function needsOrdering(items) {
  return (items || [])
    .filter(i => !i.archived && itemStatus(i) !== STATUS.OK)
    .sort((a, b) => {
      const sa = itemStatus(a) === STATUS.OUT ? 0 : 1;
      const sb = itemStatus(b) === STATUS.OUT ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return (a.name || '').localeCompare(b.name || '');
    });
}

// ─── Firestore paths ───────────────────────────────────────────────────

const SETTINGS_ID = '__settings';

export function inventoryCol(centerId) {
  return collection(db, 'centers', centerId, 'inventory');
}
export function inventoryDoc(centerId, itemId) {
  return doc(db, 'centers', centerId, 'inventory', itemId);
}
export function settingsDoc(centerId) {
  return doc(db, 'centers', centerId, 'inventory', SETTINGS_ID);
}
export function logCol(centerId) {
  return collection(db, 'centers', centerId, 'inventoryLog');
}

/** The settings doc shares the items collection — filter it out of lists. */
function isItemDoc(id) {
  return id !== SETTINGS_ID && !id.startsWith('__');
}

export const DEFAULT_ITEM = {
  name:        '',
  category:    'administrative',
  unit:        'each',
  qty:         0,
  par:         5,
  reorderQty:  10,
  location:    '',
  vendor:      '',
  orderUrl:    '',
  sku:         '',
  costPerUnit: '',
  notes:       '',
  archived:    false,
};

export const DEFAULT_SETTINGS = {
  alertsEnabled: true,
  // Who gets the weekly low-stock email. Empty = fall back to every
  // admin-and-above account at this centre (see the cron).
  alertEmails:   [],
  // Guard so re-running the cron doesn't re-send the same list.
  lastAlertSentAt: null,
  lastAlertKey:    null,
};

// ─── Subscriptions ─────────────────────────────────────────────────────

/**
 * Live item list for a centre, alphabetical.
 *
 * orderBy('name') also quietly excludes the __settings doc (Firestore
 * drops documents missing the ordered field), but we filter by id too so
 * a settings doc that somehow gains a `name` can't leak into the table.
 */
export function subscribeInventory(centerId, onItems, onError) {
  return onSnapshot(
    query(inventoryCol(centerId), orderBy('name')),
    snap => onItems(
      snap.docs
        .filter(d => isItemDoc(d.id))
        .map(d => ({ id: d.id, ...d.data() })),
    ),
    err => { if (onError) onError(err); },
  );
}

export function subscribeSettings(centerId, onSettings) {
  return onSnapshot(
    settingsDoc(centerId),
    snap => onSettings({ ...DEFAULT_SETTINGS, ...(snap.exists() ? snap.data() : {}) }),
    () => onSettings({ ...DEFAULT_SETTINGS }),
  );
}

export function subscribeLog(centerId, onEntries, max = 40) {
  return onSnapshot(
    query(logCol(centerId), orderBy('at', 'desc'), limit(max)),
    snap => onEntries(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    () => onEntries([]),
  );
}

// ─── Writes ────────────────────────────────────────────────────────────

function stamp(profile) {
  return {
    updatedAt:     new Date().toISOString(),
    updatedBy:     profile?.uid || null,
    updatedByName: profile?.displayName || profile?.email || 'Unknown',
  };
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalise whatever the form produced into the stored shape. */
export function normalizeItem(draft) {
  return {
    name:        String(draft.name || '').trim(),
    category:    CATEGORY_KEYS.includes(draft.category) ? draft.category : 'administrative',
    unit:        String(draft.unit || 'each').trim(),
    qty:         Math.max(0, toNumber(draft.qty, 0)),
    par:         Math.max(0, toNumber(draft.par, 0)),
    reorderQty:  Math.max(0, toNumber(draft.reorderQty, 0)),
    location:    String(draft.location || '').trim(),
    vendor:      String(draft.vendor || '').trim(),
    orderUrl:    String(draft.orderUrl || '').trim(),
    sku:         String(draft.sku || '').trim(),
    costPerUnit: draft.costPerUnit === '' || draft.costPerUnit == null
      ? null
      : Math.max(0, toNumber(draft.costPerUnit, 0)),
    notes:       String(draft.notes || '').trim(),
    archived:    !!draft.archived,
  };
}

/**
 * Create or update an item. `itemId` null → create.
 * Returns the item id so the caller can keep the row selected.
 */
export async function saveItem(centerId, itemId, draft, profile) {
  const clean = normalizeItem(draft);
  if (!clean.name) throw new Error('Item name is required.');

  if (itemId) {
    await setDoc(inventoryDoc(centerId, itemId), { ...clean, ...stamp(profile) }, { merge: true });
    await writeLog(centerId, {
      itemId, itemName: clean.name, action: 'edit',
      note: 'Item details updated',
    }, profile);
    return itemId;
  }

  const ref = await addDoc(inventoryCol(centerId), {
    ...clean,
    centerId,
    createdAt:     new Date().toISOString(),
    createdBy:     profile?.uid || null,
    createdByName: profile?.displayName || profile?.email || 'Unknown',
    ...stamp(profile),
  });
  await writeLog(centerId, {
    itemId: ref.id, itemName: clean.name, action: 'create',
    to: clean.qty, note: `Added to inventory (${clean.qty} ${clean.unit})`,
  }, profile);
  return ref.id;
}

/**
 * Change the count. `delta` is signed (+2 received, -1 used up); pass
 * `absolute` instead when someone has physically recounted the shelf.
 *
 * Every change writes a log row — that's what makes "who used all the
 * glue sticks" answerable a month later, and it's cheap: one small doc.
 */
export async function adjustQty(centerId, item, { delta = 0, absolute = null, reason = '' }, profile) {
  const from = toNumber(item.qty, 0);
  const to = absolute != null
    ? Math.max(0, toNumber(absolute, from))
    : Math.max(0, from + toNumber(delta, 0));
  if (to === from) return from;

  await setDoc(inventoryDoc(centerId, item.id), {
    qty: to,
    lastCountedAt: absolute != null ? new Date().toISOString() : (item.lastCountedAt || null),
    ...stamp(profile),
  }, { merge: true });

  await writeLog(centerId, {
    itemId:   item.id,
    itemName: item.name,
    action:   absolute != null ? 'count' : (to > from ? 'received' : 'used'),
    from, to,
    note: reason || '',
  }, profile);

  return to;
}

/** Stamp an item as ordered so the reorder list stops nagging about it. */
export async function markOrdered(centerId, item, profile) {
  await setDoc(inventoryDoc(centerId, item.id), {
    lastOrderedAt: new Date().toISOString(),
    ...stamp(profile),
  }, { merge: true });
  await writeLog(centerId, {
    itemId: item.id, itemName: item.name, action: 'ordered',
    note: item.reorderQty ? `Ordered ${item.reorderQty} ${item.unit}` : 'Marked as ordered',
  }, profile);
}

export async function removeItem(centerId, item, profile) {
  await deleteDoc(inventoryDoc(centerId, item.id));
  await writeLog(centerId, {
    itemId: item.id, itemName: item.name, action: 'delete',
    note: 'Item deleted',
  }, profile);
}

export async function saveSettings(centerId, patch, profile) {
  await setDoc(settingsDoc(centerId), {
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: profile?.uid || null,
  }, { merge: true });
}

/**
 * Append to the change log. Deliberately fire-and-forget-ish: a failed
 * log write must never block the count itself, so callers await it but
 * we swallow errors rather than throw.
 */
async function writeLog(centerId, entry, profile) {
  try {
    await addDoc(logCol(centerId), {
      ...entry,
      centerId,
      at:     new Date().toISOString(),
      by:     profile?.uid || null,
      byName: profile?.displayName || profile?.email || 'Unknown',
    });
  } catch (err) {
    console.warn('[inventory] log write skipped:', err?.message || err);
  }
}

// ─── Starter catalogue ─────────────────────────────────────────────────
//
// A brand-new centre opening this page to an empty table has to invent
// 60 rows before it's useful, which is exactly when a tool gets
// abandoned. One button seeds a realistic Mathnasium starting list —
// every row is editable or deletable afterwards. Counts start at 0 on
// purpose: the first thing you do is walk the shelves and count.

export const STARTER_ITEMS = [
  // STEAM
  { name: 'Base-ten blocks set',        category: 'steam',          unit: 'set',    par: 2,  reorderQty: 2  },
  { name: 'Geometry solids kit',        category: 'steam',          unit: 'kit',    par: 1,  reorderQty: 1  },
  { name: 'Building bricks tub',        category: 'steam',          unit: 'box',    par: 2,  reorderQty: 2  },
  { name: 'Graph paper pads',           category: 'steam',          unit: 'pack',   par: 4,  reorderQty: 10 },
  { name: 'Coloured pencils',           category: 'steam',          unit: 'pack',   par: 6,  reorderQty: 12 },
  // Events
  { name: 'Name tag stickers',          category: 'events',         unit: 'pack',   par: 2,  reorderQty: 5  },
  { name: 'Table cloths',               category: 'events',         unit: 'each',   par: 3,  reorderQty: 6  },
  { name: 'Open house flyers',          category: 'events',         unit: 'pack',   par: 2,  reorderQty: 5  },
  { name: 'Balloons',                   category: 'events',         unit: 'bag',    par: 2,  reorderQty: 4  },
  // Games
  { name: 'Playing card decks',         category: 'games',          unit: 'each',   par: 4,  reorderQty: 10 },
  { name: 'Dice (assorted)',            category: 'games',          unit: 'set',    par: 3,  reorderQty: 5  },
  { name: 'Connect Four',               category: 'games',          unit: 'each',   par: 1,  reorderQty: 1  },
  { name: 'Uno decks',                  category: 'games',          unit: 'each',   par: 2,  reorderQty: 4  },
  // Holidays
  { name: 'Halloween decorations',      category: 'holidays',       unit: 'box',    par: 1,  reorderQty: 1  },
  { name: 'Winter holiday decorations', category: 'holidays',       unit: 'box',    par: 1,  reorderQty: 1  },
  { name: 'Seasonal candy',             category: 'holidays',       unit: 'bag',    par: 2,  reorderQty: 6  },
  // Summer camp
  { name: 'Camp workbooks',             category: 'summer_camp',    unit: 'pack',   par: 3,  reorderQty: 10 },
  { name: 'Camp t-shirts',              category: 'summer_camp',    unit: 'each',   par: 10, reorderQty: 30 },
  { name: 'Water bottles',              category: 'summer_camp',    unit: 'each',   par: 6,  reorderQty: 24 },
  { name: 'Sunscreen',                  category: 'summer_camp',    unit: 'bottle', par: 2,  reorderQty: 4  },
  // Crafts
  { name: 'Construction paper',         category: 'crafts',         unit: 'pack',   par: 3,  reorderQty: 6  },
  { name: 'Glue sticks',                category: 'crafts',         unit: 'pack',   par: 3,  reorderQty: 6  },
  { name: 'Safety scissors',            category: 'crafts',         unit: 'each',   par: 8,  reorderQty: 12 },
  { name: 'Washable markers',           category: 'crafts',         unit: 'pack',   par: 4,  reorderQty: 8  },
  { name: 'Googly eyes',                category: 'crafts',         unit: 'bag',    par: 1,  reorderQty: 2  },
  // Fun days
  { name: 'Paper plates',               category: 'fun_days',       unit: 'pack',   par: 2,  reorderQty: 6  },
  { name: 'Napkins',                    category: 'fun_days',       unit: 'pack',   par: 2,  reorderQty: 6  },
  { name: 'Popcorn kernels',            category: 'fun_days',       unit: 'bag',    par: 1,  reorderQty: 3  },
  { name: 'Juice boxes',                category: 'fun_days',       unit: 'case',   par: 1,  reorderQty: 3  },
  // Administrative
  { name: 'Printer paper',              category: 'administrative', unit: 'ream',   par: 4,  reorderQty: 10 },
  { name: 'Printer toner',              category: 'administrative', unit: 'each',   par: 1,  reorderQty: 2  },
  { name: 'Dry erase markers',          category: 'administrative', unit: 'pack',   par: 4,  reorderQty: 10 },
  { name: 'Pencils',                    category: 'administrative', unit: 'box',    par: 3,  reorderQty: 6  },
  { name: 'Erasers',                    category: 'administrative', unit: 'pack',   par: 2,  reorderQty: 4  },
  { name: 'Student folders',            category: 'administrative', unit: 'pack',   par: 2,  reorderQty: 5  },
  { name: 'Sticky notes',               category: 'administrative', unit: 'pack',   par: 2,  reorderQty: 6  },
  { name: 'Staples',                    category: 'administrative', unit: 'box',    par: 1,  reorderQty: 2  },
  // Cleaning
  { name: 'Disinfectant wipes',         category: 'cleaning',       unit: 'each',   par: 4,  reorderQty: 12 },
  { name: 'Hand sanitizer',             category: 'cleaning',       unit: 'bottle', par: 3,  reorderQty: 6  },
  { name: 'Paper towel',                category: 'cleaning',       unit: 'roll',   par: 6,  reorderQty: 12 },
  { name: 'Garbage bags',               category: 'cleaning',       unit: 'box',    par: 1,  reorderQty: 2  },
  { name: 'Whiteboard cleaner',         category: 'cleaning',       unit: 'bottle', par: 1,  reorderQty: 2  },
  { name: 'Vacuum bags',                category: 'cleaning',       unit: 'pack',   par: 1,  reorderQty: 2  },
  // Rewards
  { name: 'Prize box toys',             category: 'rewards',        unit: 'bag',    par: 2,  reorderQty: 4  },
  { name: 'Punch cards',                category: 'rewards',        unit: 'pack',   par: 2,  reorderQty: 5  },
  { name: 'Achievement certificates',   category: 'rewards',        unit: 'pack',   par: 2,  reorderQty: 5  },
  { name: 'Stickers',                   category: 'rewards',        unit: 'roll',   par: 3,  reorderQty: 6  },
  { name: 'Pencil toppers',             category: 'rewards',        unit: 'bag',    par: 1,  reorderQty: 3  },
];

/**
 * Write the starter catalogue. Skips any name that already exists so
 * pressing the button twice can't duplicate the list.
 */
export async function seedStarterCatalog(centerId, profile) {
  const snap = await getDocs(inventoryCol(centerId));
  const existing = new Set(
    snap.docs
      .filter(d => isItemDoc(d.id))
      .map(d => String(d.data().name || '').trim().toLowerCase()),
  );

  const toAdd = STARTER_ITEMS.filter(i => !existing.has(i.name.toLowerCase()));
  if (toAdd.length === 0) return 0;

  // writeBatch caps at 500 ops; the starter list is ~48 so one batch is
  // plenty, but chunk anyway in case the list grows.
  const CHUNK = 400;
  for (let i = 0; i < toAdd.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const item of toAdd.slice(i, i + CHUNK)) {
      batch.set(doc(inventoryCol(centerId)), {
        ...DEFAULT_ITEM,
        ...item,
        qty: 0,
        centerId,
        createdAt:     new Date().toISOString(),
        createdBy:     profile?.uid || null,
        createdByName: profile?.displayName || 'Starter catalogue',
        ...stamp(profile),
      });
    }
    await batch.commit();
  }
  return toAdd.length;
}

// ─── Export / share ────────────────────────────────────────────────────

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function itemsToCsv(items) {
  const header = [
    'Item', 'Category', 'On hand', 'Unit', 'Reorder at', 'Order qty',
    'Status', 'Location', 'Vendor', 'SKU', 'Cost per unit', 'Order link',
    'Last ordered', 'Last updated', 'Updated by', 'Notes',
  ];
  const rows = items.map(i => [
    i.name,
    categoryFor(i.category).label,
    i.qty,
    i.unit,
    i.par,
    i.reorderQty,
    STATUS_STYLE[itemStatus(i)].label,
    i.location,
    i.vendor,
    i.sku,
    i.costPerUnit == null ? '' : i.costPerUnit,
    i.orderUrl,
    i.lastOrderedAt ? i.lastOrderedAt.slice(0, 10) : '',
    i.updatedAt ? i.updatedAt.slice(0, 10) : '',
    i.updatedByName || '',
    i.notes,
  ]);
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');
}

/** Plain-text reorder list — the thing you paste into a supplier email. */
export function buildOrderListText(items, centerName) {
  const lines = [`Supply order list — ${centerName || 'Centre'}`, ''];
  const byCat = new Map();
  for (const i of items) {
    const label = categoryFor(i.category).label;
    if (!byCat.has(label)) byCat.set(label, []);
    byCat.get(label).push(i);
  }
  for (const [label, group] of byCat) {
    lines.push(`${label.toUpperCase()}`);
    for (const i of group) {
      const want = i.reorderQty || i.par || 1;
      const status = itemStatus(i) === STATUS.OUT ? 'OUT OF STOCK' : 'low';
      lines.push(`  • ${i.name} — order ${want} ${i.unit} (have ${i.qty}, ${status})`);
      if (i.orderUrl) lines.push(`      ${i.orderUrl}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Send the reorder email on demand ──────────────────────────────────
//
// Same /api/send-email endpoint the rest of the app uses (Bearer ID
// token + { emails: [{ to, to_name, subject, body, cta_text, cta_link }] }).
// The weekly automated version lives in api/cron/check-inventory.js; this
// is the "don't wait until Monday, send it now" button.

export async function sendOrderListEmail({ recipients, items, centerName }) {
  const to = (recipients || []).map(r => String(r).trim()).filter(Boolean);
  if (to.length === 0) throw new Error('No recipients set. Add them under Alert settings.');
  if (!items || items.length === 0) throw new Error('Nothing is low or out of stock.');

  let idToken = null;
  try {
    idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  } catch {
    idToken = null;
  }
  if (!idToken) throw new Error('Not signed in.');

  const outCount = items.filter(i => itemStatus(i) === STATUS.OUT).length;
  const subject = outCount > 0
    ? `${centerName || 'Centre'}: ${outCount} supply item${outCount === 1 ? '' : 's'} OUT, ${items.length} to reorder`
    : `${centerName || 'Centre'}: ${items.length} supply item${items.length === 1 ? '' : 's'} running low`;

  const body = [
    'Here is the current supply reorder list.',
    '',
    buildOrderListText(items, centerName),
    'Order links are attached to each item where one has been set up.',
  ].join('\n');

  const emails = to.map(addr => ({
    to:       addr,
    to_name:  'Team',
    subject,
    body,
    cta_text: 'Open Inventory',
    cta_link: `${typeof window !== 'undefined' ? window.location.origin : ''}/inventory`,
  }));

  const r = await fetch('/api/send-email', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ emails }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `Send failed (${r.status})`);
  }
  return to.length;
}
