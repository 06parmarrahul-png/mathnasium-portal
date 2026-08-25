import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { toast, confirmDialog } from '../lib/notify';
import {
  INVENTORY_CATEGORIES, INVENTORY_UNITS, DEFAULT_ITEM, DEFAULT_SETTINGS,
  STATUS, STATUS_STYLE, categoryFor, itemStatus, needsOrdering,
  unitLabel, unitText, normalizeUnit,
  subscribeInventory, subscribeSettings, subscribeLog,
  saveItem, adjustQty, markOrdered, removeItem, saveSettings,
  seedStarterCatalog, itemsToCsv, buildOrderListText, sendOrderListEmail,
  DEFAULT_PLATFORM_NOTIFY, subscribePlatformNotify,
  subscribeMyInventoryNotify, setMyInventoryNotify, applyOptOuts,
} from '../lib/inventory';
import {
  Package, Plus, Search, X, Pencil, Trash2, Minus, Download, Mail,
  Settings, AlertTriangle, ShoppingCart, ExternalLink, Copy, History,
  Archive, ArchiveRestore, Check, Loader2, Boxes, PackageX, BellOff, ShieldOff,
  FlaskConical, PartyPopper, Gamepad2, Gift, Sun, Scissors, Smile,
  ClipboardList, SprayCan, Trophy, Shirt,
} from 'lucide-react';

/**
 * Centre Inventory — admin-and-above supply tracker.
 *
 * The job this page does, in order of how often it happens:
 *   1. "How many do we have?"        → the table, searchable, one glance
 *   2. "We just used three."         → −/+ stepper, no modal, no save button
 *   3. "What do we need to order?"   → Order list, grouped, with links
 *   4. "Tell the team to order it."  → email now, or wait for the weekly cron
 *   5. "Add a new thing we stock."   → Add item
 *
 * Everything else (history, CSV, alert recipients) is deliberately one
 * level down so the four daily actions stay in reach.
 */

// Category icon lookup. Keys match INVENTORY_CATEGORIES[].icon.
const CATEGORY_ICONS = {
  FlaskConical, PartyPopper, Gamepad2, Gift, Sun, Scissors, Smile,
  ClipboardList, SprayCan, Trophy, Shirt, Package,
};

function CategoryIcon({ name, size = 14, className = '', style }) {
  const Cmp = CATEGORY_ICONS[name] || Package;
  return <Cmp size={size} className={className} style={style} />;
}

function NotAuthorized() {
  return (
    <div className="mx-auto max-w-md rounded-xl bg-white p-8 text-center shadow-sm">
      <h2 className="mb-2 text-xl font-bold text-gray-900">Not authorized</h2>
      <p className="text-sm text-gray-500">
        Inventory is available to admins, admin assistants, directors, owners, managers and hosts.
      </p>
    </div>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return '—'; }
}

function fmtWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return ''; }
}

function money(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '—';
  return `$${Number(n).toFixed(2)}`;
}

// ─── Small building blocks ─────────────────────────────────────────────

function StatTile({ icon, label, value, sub, tone = 'gray' }) {
  // Assigned to a local rather than destructured as `icon: Icon` — core
  // no-unused-vars doesn't treat a JSX element name as a use, and the
  // repo's varsIgnorePattern ('^[A-Z_]') covers vars but not args.
  const Icon = icon;
  const tones = {
    gray:   'bg-white border-gray-200 text-gray-900',
    amber:  'bg-amber-50 border-amber-200 text-amber-900',
    red:    'bg-red-50 border-red-200 text-red-900',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-900',
  };
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide opacity-70">
        <Icon size={14} /> {label}
      </div>
      <p className="mt-1 text-2xl font-bold leading-tight">{value}</p>
      {sub && <p className="mt-0.5 text-xs opacity-70">{sub}</p>}
    </div>
  );
}

function StatusChip({ item }) {
  const s = STATUS_STYLE[itemStatus(item)];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold ${s.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function CategoryChip({ categoryKey }) {
  const cat = categoryFor(categoryKey);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${cat.chip}`}>
      <CategoryIcon name={cat.icon} size={12} />
      {cat.label}
    </span>
  );
}

/**
 * The count cell. A −/+ stepper for the common case (used two, received
 * six) and a click-to-type field for a physical recount. Writes go
 * straight to Firestore — there is no Save button because there is no
 * draft state worth losing.
 */
function QtyCell({ item, onDelta, onSet, disabled }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const n = Number(draft);
    setEditing(false);
    if (!Number.isFinite(n) || n === Number(item.qty)) return;
    onSet(Math.max(0, n));
  };

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        min="0"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="w-20 rounded-lg border border-red-300 px-2 py-1 text-center text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
      />
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={disabled || Number(item.qty) <= 0}
        onClick={() => onDelta(-1)}
        title="Used one"
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 text-gray-600 transition hover:bg-gray-100 disabled:opacity-30"
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        onClick={() => { setDraft(String(item.qty ?? 0)); setEditing(true); }}
        title="Click to enter an exact count"
        className="min-w-[3rem] rounded-lg px-2 py-1 text-center text-sm font-bold text-gray-900 transition hover:bg-gray-100"
      >
        {item.qty ?? 0}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onDelta(1)}
        title="Received one"
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-gray-200 text-gray-600 transition hover:bg-gray-100 disabled:opacity-30"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

function Modal({ title, subtitle, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center">
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl bg-white shadow-xl`}>
        <div className="flex items-start justify-between border-b px-5 py-4">
          <div>
            <h3 className="text-lg font-bold text-gray-900">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700">
            <X size={20} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500';

// ─── Item add / edit ───────────────────────────────────────────────────

function ItemModal({ item, onClose, onSave, saving }) {
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_ITEM, ...(item || {}) }));
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  return (
    <Modal
      title={item ? 'Edit item' : 'Add item'}
      subtitle={item ? item.name : 'Anything the centre stocks and runs out of'}
      onClose={onClose}
      wide
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Item name">
            <input
              autoFocus
              className={inputCls}
              value={draft.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Dry erase markers (black)"
            />
          </Field>
        </div>

        <Field label="Category">
          <select className={inputCls} value={draft.category} onChange={e => set('category', e.target.value)}>
            {INVENTORY_CATEGORIES.map(c => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Unit" hint="What one of these is, when you count them">
          <select className={inputCls} value={normalizeUnit(draft.unit)} onChange={e => set('unit', e.target.value)}>
            {INVENTORY_UNITS.map(u => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
        </Field>

        <Field label="On hand" hint="Count what's on the shelf right now">
          <input type="number" min="0" className={inputCls} value={draft.qty} onChange={e => set('qty', e.target.value)} />
        </Field>

        <Field label="Reorder at" hint="Goes Low at or below this number. 0 = never alert.">
          <input type="number" min="0" className={inputCls} value={draft.par} onChange={e => set('par', e.target.value)} />
        </Field>

        <Field label="Order quantity" hint="How many we buy when we reorder">
          <input type="number" min="0" className={inputCls} value={draft.reorderQty} onChange={e => set('reorderQty', e.target.value)} />
        </Field>

        <Field label="Cost per unit" hint="Optional — powers the reorder estimate">
          <input type="number" min="0" step="0.01" className={inputCls} value={draft.costPerUnit ?? ''} onChange={e => set('costPerUnit', e.target.value)} />
        </Field>

        <Field label="Stored at" hint="Where in the centre it lives">
          <input className={inputCls} value={draft.location} onChange={e => set('location', e.target.value)} placeholder="e.g. Back closet, shelf 2" />
        </Field>

        <Field label="Vendor">
          <input className={inputCls} value={draft.vendor} onChange={e => set('vendor', e.target.value)} placeholder="e.g. Staples, Amazon, Mathnasium HQ" />
        </Field>

        <div className="sm:col-span-2">
          <Field label="Order link" hint="Paste the exact page or saved cart. This is the link that lands in the low-stock email.">
            <input className={inputCls} value={draft.orderUrl} onChange={e => set('orderUrl', e.target.value)} placeholder="https://..." />
          </Field>
        </div>

        <Field label="SKU / item code">
          <input className={inputCls} value={draft.sku} onChange={e => set('sku', e.target.value)} />
        </Field>

        <Field label="Archived">
          <button
            type="button"
            onClick={() => set('archived', !draft.archived)}
            className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
              draft.archived
                ? 'border-gray-300 bg-gray-100 text-gray-700'
                : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
            }`}
          >
            {draft.archived ? <><Archive size={14} /> Archived</> : <><ArchiveRestore size={14} /> Active</>}
          </button>
        </Field>

        <div className="sm:col-span-2">
          <Field label="Notes">
            <textarea rows={2} className={inputCls} value={draft.notes} onChange={e => set('notes', e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2 border-t pt-4">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
        <button
          disabled={saving || !draft.name.trim()}
          onClick={() => onSave(draft)}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {item ? 'Save changes' : 'Add item'}
        </button>
      </div>
    </Modal>
  );
}

// ─── Order list ────────────────────────────────────────────────────────

function OrderModal({ items, centerName, recipients, onClose, onMarkOrdered, onEmail, emailing, platformOn = true }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const i of items) {
      const key = i.vendor?.trim() || 'No vendor set';
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(i);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const estCost = items.reduce((sum, i) => {
    const c = Number(i.costPerUnit);
    const q = Number(i.reorderQty) || 0;
    return Number.isFinite(c) ? sum + c * q : sum;
  }, 0);

  const copyList = async () => {
    try {
      await navigator.clipboard.writeText(buildOrderListText(items, centerName));
      toast.success('Order list copied to clipboard.');
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  };

  return (
    <Modal
      title="Order list"
      subtitle={`${items.length} item${items.length === 1 ? '' : 's'} at or below their reorder point`}
      onClose={onClose}
      wide
    >
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">Nothing needs ordering. Nice.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <button onClick={copyList} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
              <Copy size={14} /> Copy list
            </button>
            <button
              onClick={onEmail}
              disabled={emailing || !platformOn}
              title={
                !platformOn
                  ? 'Enterprise has inventory emails switched off platform-wide'
                  : recipients.length
                    ? `Sends to ${recipients.join(', ')}`
                    : 'Set recipients under Alert settings first'
              }
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {emailing ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
              Email the admin team now
            </button>
            {estCost > 0 && (
              <span className="ml-auto self-center text-sm text-gray-500">
                Estimated cost <strong className="text-gray-900">${estCost.toFixed(2)}</strong>
              </span>
            )}
          </div>

          <div className="space-y-5">
            {groups.map(([vendor, group]) => (
              <div key={vendor}>
                <p className="mb-2 text-xs font-bold uppercase tracking-widest text-gray-400">{vendor}</p>
                <div className="divide-y rounded-lg border">
                  {group.map(i => (
                    <div key={i.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-gray-900">{i.name}</p>
                        <p className="text-xs text-gray-500">
                          Have {unitText(i.unit, i.qty)} · reorder at {i.par} · order {unitText(i.unit, i.reorderQty || i.par || 1)}
                        </p>
                      </div>
                      <StatusChip item={i} />
                      {i.orderUrl ? (
                        <a
                          href={i.orderUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        >
                          <ExternalLink size={12} /> Order
                        </a>
                      ) : (
                        <span className="text-xs italic text-gray-400">no link set</span>
                      )}
                      <button
                        onClick={() => onMarkOrdered(i)}
                        className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-800"
                      >
                        <Check size={12} /> Ordered
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

// ─── Alert settings ────────────────────────────────────────────────────

/**
 * Alert settings — shows all three layers of the notification cascade in
 * one place, so an admin can see exactly why they are (or aren't) getting
 * emails instead of guessing:
 *
 *   Enterprise master switch → centre switch → their own opt-out
 *
 * Only the middle one is editable here by a centre admin; the top is
 * read-only (Enterprise owns it) and the bottom writes to their personal
 * notification preferences.
 */
function SettingsModal({
  settings, onClose, onSave, saving,
  platformOn, myNotify, onToggleMine, togglingMine,
}) {
  const [enabled, setEnabled] = useState(settings.alertsEnabled !== false);
  const [emails, setEmails] = useState((settings.alertEmails || []).join(', '));

  return (
    <Modal
      title="Low-stock alerts"
      subtitle="Who Ratio emails when supplies run low"
      onClose={onClose}
    >
      <div className="space-y-4">
        {!platformOn && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <ShieldOff size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-semibold text-amber-900">Turned off platform-wide</p>
              <p className="mt-0.5 text-amber-800">
                Enterprise has inventory email notifications switched off for every centre,
                so nothing will send regardless of the settings below. Your settings are
                still saved and take effect the moment it's switched back on.
              </p>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setEnabled(v => !v)}
          className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition ${
            enabled ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-gray-50'
          }`}
        >
          <span>
            <span className="block text-sm font-semibold text-gray-900">Weekly low-stock email</span>
            <span className="block text-xs text-gray-500">
              Monday mornings, listing every item at or below its reorder point with its order link.
            </span>
          </span>
          <span className={`ml-3 h-6 w-11 shrink-0 rounded-full p-0.5 transition ${enabled ? 'bg-emerald-500' : 'bg-gray-300'}`}>
            <span className={`block h-5 w-5 rounded-full bg-white transition ${enabled ? 'translate-x-5' : ''}`} />
          </span>
        </button>

        <Field
          label="Recipients"
          hint="Comma separated. Leave blank to email every admin, admin assistant, director and owner at this centre."
        >
          <textarea
            rows={3}
            className={inputCls}
            value={emails}
            onChange={e => setEmails(e.target.value)}
            placeholder="owner@centre.com, admin@centre.com"
          />
        </Field>

        <div className="rounded-lg border border-gray-200 p-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Just for you
          </p>
          <button
            type="button"
            disabled={togglingMine}
            onClick={() => onToggleMine(!myNotify)}
            className="flex w-full items-center justify-between gap-3 text-left disabled:opacity-60"
          >
            <span>
              <span className="block text-sm font-medium text-gray-900">
                Email me these alerts
              </span>
              <span className="block text-xs text-gray-500">
                Turns inventory emails off for your account only — everyone else on the
                list keeps getting them. Saved with your other notification preferences.
              </span>
            </span>
            <span className={`ml-1 h-6 w-11 shrink-0 rounded-full p-0.5 transition ${myNotify ? 'bg-emerald-500' : 'bg-gray-300'}`}>
              <span className={`block h-5 w-5 rounded-full bg-white transition ${myNotify ? 'translate-x-5' : ''}`} />
            </span>
          </button>
        </div>

        {settings.lastAlertSentAt && (
          <p className="text-xs text-gray-500">Last alert sent {fmtWhen(settings.lastAlertSentAt)}.</p>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2 border-t pt-4">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
        <button
          disabled={saving}
          onClick={() => onSave({
            alertsEnabled: enabled,
            alertEmails: emails.split(',').map(s => s.trim()).filter(Boolean),
          })}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          Save
        </button>
      </div>
    </Modal>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────

export default function Inventory() {
  const { profile, activeCenterId, canManageOperations, centerConfig } = useAuth();
  // Managers and Hosts get full inventory access too — they're the ones
  // ordering supplies day to day.
  const canSeeInventory = canManageOperations;

  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [logEntries, setLogEntries] = useState([]);
  // Which centre the current `items` belong to. Deriving `loading` from
  // this (rather than calling setLoading inside the effect) keeps the
  // spinner correct across centre switches without tripping the
  // react-hooks set-state-in-effect rule.
  const [loadedCenter, setLoadedCenter] = useState(null);

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const [editing, setEditing] = useState(null);   // { item } | { item: null } | null
  const [showOrder, setShowOrder] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [seeding, setSeeding] = useState(false);
  // Notification cascade: Enterprise master switch → centre switch →
  // this person's own opt-out. All three must be on for an email to send.
  const [platformNotify, setPlatformNotify] = useState(DEFAULT_PLATFORM_NOTIFY);
  const [myNotify, setMyNotify] = useState(true);
  const [togglingMine, setTogglingMine] = useState(false);

  // centers/{id}/config/main carries `name` (e.g. "Mathnasium Langley").
  const centerName = centerConfig?.name || centerConfig?.centerName || activeCenterId;
  const loading = loadedCenter !== activeCenterId;

  // Live data. Re-subscribes on centre switch so the Langley → Burnaby
  // toggle in the sidebar swaps the whole table.
  useEffect(() => {
    if (!canSeeInventory || !activeCenterId) return;
    const unsub = subscribeInventory(
      activeCenterId,
      list => { setItems(list); setLoadedCenter(activeCenterId); },
      err => {
        console.error('[inventory] subscribe failed:', err);
        setLoadedCenter(activeCenterId);
        toast.error('Could not load inventory.');
      },
    );
    return unsub;
  }, [activeCenterId, canSeeInventory]);

  useEffect(() => {
    if (!canSeeInventory || !activeCenterId) return;
    return subscribeSettings(activeCenterId, setSettings);
  }, [activeCenterId, canSeeInventory]);

  useEffect(() => {
    if (!canSeeInventory || !activeCenterId || !showHistory) return;
    return subscribeLog(activeCenterId, setLogEntries);
  }, [activeCenterId, canSeeInventory, showHistory]);

  // Enterprise master switch. Readable by any signed-in user (one
  // permissive rule on this single doc) so the page can say WHY alerts
  // are off instead of quietly doing nothing.
  useEffect(() => {
    if (!canSeeInventory) return;
    return subscribePlatformNotify(setPlatformNotify);
  }, [canSeeInventory]);

  useEffect(() => {
    if (!profile?.uid) return;
    return subscribeMyInventoryNotify(profile.uid, setMyNotify);
  }, [profile?.uid]);

  const visible = useMemo(
    () => items.filter(i => (showArchived ? true : !i.archived)),
    [items, showArchived],
  );

  const lowItems = useMemo(() => needsOrdering(items), [items]);
  const outCount = lowItems.filter(i => itemStatus(i) === STATUS.OUT).length;

  const estReorderCost = useMemo(() => lowItems.reduce((sum, i) => {
    const c = Number(i.costPerUnit);
    const q = Number(i.reorderQty) || 0;
    return Number.isFinite(c) ? sum + c * q : sum;
  }, 0), [lowItems]);

  const countsByCategory = useMemo(() => {
    const m = {};
    for (const i of visible) m[i.category] = (m[i.category] || 0) + 1;
    return m;
  }, [visible]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visible.filter(i => {
      if (catFilter !== 'all' && i.category !== catFilter) return false;
      if (statusFilter !== 'all' && itemStatus(i) !== statusFilter) return false;
      if (!q) return true;
      return [i.name, i.vendor, i.location, i.sku, i.notes]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [visible, catFilter, statusFilter, search]);

  // ─── Actions ─────────────────────────────────────────────────────────

  const handleSave = useCallback(async (draft) => {
    setBusy(true);
    try {
      await saveItem(activeCenterId, editing?.item?.id || null, draft, profile);
      toast.success(editing?.item ? 'Item updated.' : 'Item added.');
      setEditing(null);
    } catch (err) {
      toast.error(err.message || 'Could not save the item.');
    } finally {
      setBusy(false);
    }
  }, [activeCenterId, editing, profile]);

  const handleDelta = useCallback(async (item, delta) => {
    try {
      await adjustQty(activeCenterId, item, { delta }, profile);
    } catch (err) {
      toast.error(err.message || 'Could not update the count.');
    }
  }, [activeCenterId, profile]);

  const handleSet = useCallback(async (item, absolute) => {
    try {
      await adjustQty(activeCenterId, item, { absolute, reason: 'Physical count' }, profile);
    } catch (err) {
      toast.error(err.message || 'Could not update the count.');
    }
  }, [activeCenterId, profile]);

  const handleDelete = useCallback(async (item) => {
    const ok = await confirmDialog({
      title: `Delete "${item.name}"?`,
      message: 'This removes the item and its current count. Archive it instead if you might stock it again.',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeItem(activeCenterId, item, profile);
      toast.success('Item deleted.');
    } catch (err) {
      toast.error(err.message || 'Could not delete the item.');
    }
  }, [activeCenterId, profile]);

  const handleMarkOrdered = useCallback(async (item) => {
    try {
      await markOrdered(activeCenterId, item, profile);
      toast.success(`${item.name} marked as ordered.`);
    } catch (err) {
      toast.error(err.message || 'Could not mark as ordered.');
    }
  }, [activeCenterId, profile]);

  const handleSaveSettings = useCallback(async (patch) => {
    setBusy(true);
    try {
      await saveSettings(activeCenterId, patch, profile);
      toast.success('Alert settings saved.');
      setShowSettings(false);
    } catch (err) {
      toast.error(err.message || 'Could not save settings.');
    } finally {
      setBusy(false);
    }
  }, [activeCenterId, profile]);

  const platformOn = platformNotify.inventoryAlertsEnabled !== false;

  const recipients = useMemo(() => {
    const set = settings.alertEmails || [];
    const base = set.length > 0 ? set : (profile?.email ? [profile.email] : []);
    return applyOptOuts(base, settings);
  }, [settings, profile]);

  const handleToggleMine = useCallback(async (next) => {
    setTogglingMine(true);
    try {
      await setMyInventoryNotify(profile, activeCenterId, next);
      toast.success(next
        ? 'You will get inventory alerts again.'
        : 'Inventory alerts turned off for your account.');
    } catch (err) {
      toast.error(err.message || 'Could not update your preference.');
    } finally {
      setTogglingMine(false);
    }
  }, [profile, activeCenterId]);

  const handleEmailNow = useCallback(async () => {
    setEmailing(true);
    try {
      const n = await sendOrderListEmail({
        recipients, items: lowItems, centerName, settings, platformOn,
      });
      toast.success(`Order list sent to ${n} recipient${n === 1 ? '' : 's'}.`);
    } catch (err) {
      toast.error(err.message || 'Could not send the email.');
    } finally {
      setEmailing(false);
    }
  }, [recipients, lowItems, centerName, settings, platformOn]);

  const handleSeed = useCallback(async () => {
    const ok = await confirmDialog({
      title: 'Add the starter catalogue?',
      message: 'Adds ~48 common Mathnasium supplies across all ten categories, each starting at zero so you can count the shelves. Existing items are left alone.',
      confirmText: 'Add them',
    });
    if (!ok) return;
    setSeeding(true);
    try {
      const n = await seedStarterCatalog(activeCenterId, profile);
      toast.success(n > 0 ? `Added ${n} starter items.` : 'Everything in the starter list is already here.');
    } catch (err) {
      toast.error(err.message || 'Could not add the starter catalogue.');
    } finally {
      setSeeding(false);
    }
  }, [activeCenterId, profile]);

  const handleExport = useCallback(() => {
    const csv = itemsToCsv(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-${activeCenterId}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, activeCenterId]);

  if (!canSeeInventory) return <NotAuthorized />;

  return (
    <div className="space-y-6">
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Package size={24} className="text-red-600" /> Inventory
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Supplies for {centerName}. Visible to admins, admin assistants, directors and owners only.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowSettings(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Settings size={16} /> Alerts
          </button>
          <button
            onClick={handleExport}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Download size={16} /> Export
          </button>
          <button
            onClick={() => setShowOrder(true)}
            className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${
              lowItems.length > 0
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            <ShoppingCart size={16} /> Order list
            {lowItems.length > 0 && (
              <span className="rounded-full bg-white/25 px-1.5 text-xs font-bold">{lowItems.length}</span>
            )}
          </button>
          <button
            onClick={() => setEditing({ item: null })}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            <Plus size={16} /> Add item
          </button>
        </div>
      </div>

      {/* Why-you're-not-getting-emails banners. Two distinct causes, so
          two distinct messages — "notifications are off" with no reason
          is the kind of thing people file a bug about. */}
      {!platformOn && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <ShieldOff size={18} className="mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-900">
            <strong>Inventory emails are off platform-wide.</strong>{' '}
            Enterprise has switched them off for every centre, so no low-stock alerts
            will send. Tracking and the order list still work normally.
          </p>
        </div>
      )}
      {platformOn && !myNotify && (
        <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
          <BellOff size={18} className="mt-0.5 shrink-0 text-gray-400" />
          <p className="text-sm text-gray-600">
            You've turned inventory alerts off for your own account. The rest of the
            team still gets them.{' '}
            <button onClick={() => setShowSettings(true)} className="font-semibold text-red-600 hover:underline">
              Change this
            </button>
          </p>
        </div>
      )}

      {/* ─── Stats ──────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile icon={Boxes} label="Tracked items" value={visible.length} sub={`${items.filter(i => i.archived).length} archived`} />
        <StatTile icon={AlertTriangle} label="Running low" value={lowItems.length - outCount} sub="At or below reorder point" tone={lowItems.length - outCount > 0 ? 'amber' : 'gray'} />
        <StatTile icon={PackageX} label="Out of stock" value={outCount} sub="Order today" tone={outCount > 0 ? 'red' : 'gray'} />
        <StatTile icon={ShoppingCart} label="Reorder estimate" value={estReorderCost > 0 ? money(estReorderCost) : '—'} sub="Where unit cost is set" tone="indigo" />
      </div>

      {/* ─── Filters ────────────────────────────────────────────────── */}
      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search items, vendors, locations…"
              className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500"
          >
            <option value="all">All statuses</option>
            <option value={STATUS.OUT}>Out of stock</option>
            <option value={STATUS.LOW}>Running low</option>
            <option value={STATUS.OK}>In stock</option>
          </select>
          <button
            onClick={() => setShowArchived(v => !v)}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ${
              showArchived ? 'border-gray-400 bg-gray-100 text-gray-800' : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Archive size={14} /> Archived
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setCatFilter('all')}
            className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
              catFilter === 'all' ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            All ({visible.length})
          </button>
          {INVENTORY_CATEGORIES.map(c => {
            const active = catFilter === c.key;
            const n = countsByCategory[c.key] || 0;
            return (
              <button
                key={c.key}
                onClick={() => setCatFilter(active ? 'all' : c.key)}
                title={c.sublabel}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  active ? 'text-white' : `${c.chip} hover:brightness-95`
                }`}
                style={active ? { backgroundColor: c.hex, borderColor: c.hex } : undefined}
              >
                <CategoryIcon name={c.icon} size={12} />
                {c.label} ({n})
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Table ──────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
            <Loader2 size={16} className="animate-spin" /> Loading inventory…
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Package size={40} className="mx-auto mb-3 text-gray-300" />
            <p className="text-base font-semibold text-gray-900">Nothing tracked yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
              Start from a ready-made list of common Mathnasium supplies across all ten categories,
              then walk the shelves and enter counts. Or add items one at a time.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                onClick={handleSeed}
                disabled={seeding}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {seeding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Add starter catalogue
              </button>
              <button
                onClick={() => setEditing({ item: null })}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Add one item
              </button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-sm text-gray-500">No items match those filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">On hand</th>
                  <th className="px-4 py-3">Reorder at</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(item => {
                  const status = itemStatus(item);
                  return (
                    <tr
                      key={item.id}
                      className={`transition hover:bg-gray-50 ${
                        status === STATUS.OUT ? 'bg-red-50/40' : status === STATUS.LOW ? 'bg-amber-50/40' : ''
                      } ${item.archived ? 'opacity-50' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-900">{item.name}</p>
                        <p className="text-xs text-gray-500">
                          {item.location || 'No location set'}
                          {item.sku ? ` · ${item.sku}` : ''}
                          {item.costPerUnit != null ? ` · ${money(item.costPerUnit)} per ${unitLabel(item.unit).toLowerCase()}` : ''}
                        </p>
                      </td>
                      <td className="px-4 py-3"><CategoryChip categoryKey={item.category} /></td>
                      <td className="px-4 py-3">
                        <QtyCell
                          item={item}
                          disabled={item.archived}
                          onDelta={d => handleDelta(item, d)}
                          onSet={n => handleSet(item, n)}
                        />
                        <p className="mt-0.5 text-xs text-gray-400">{unitLabel(item.unit).toLowerCase()}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{item.par || <span className="text-gray-400">—</span>}</td>
                      <td className="px-4 py-3"><StatusChip item={item} /></td>
                      <td className="px-4 py-3">
                        <p className="text-gray-700">{item.vendor || <span className="text-gray-400">—</span>}</p>
                        {item.orderUrl && (
                          <a
                            href={item.orderUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:underline"
                          >
                            <ExternalLink size={11} /> Order link
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-gray-500">{fmtDate(item.updatedAt)}</p>
                        <p className="text-xs text-gray-400">{item.updatedByName || ''}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => setEditing({ item })}
                            title="Edit"
                            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => handleDelete(item)}
                            title="Delete"
                            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── History ────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <button
          onClick={() => setShowHistory(v => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-gray-700"
        >
          <History size={16} className="text-gray-400" />
          Recent activity
          <span className="ml-auto text-xs font-normal text-gray-400">{showHistory ? 'Hide' : 'Show'}</span>
        </button>
        {showHistory && (
          <div className="border-t px-4 py-3">
            {logEntries.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-500">No activity recorded yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {logEntries.map(e => (
                  <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 py-2 text-sm">
                    <span className="font-medium text-gray-900">{e.itemName}</span>
                    <span className="text-gray-500">
                      {e.action === 'used'     && `used ${Math.abs((e.to ?? 0) - (e.from ?? 0))} (${e.from} → ${e.to})`}
                      {e.action === 'received' && `received ${(e.to ?? 0) - (e.from ?? 0)} (${e.from} → ${e.to})`}
                      {e.action === 'count'    && `recounted (${e.from} → ${e.to})`}
                      {e.action === 'ordered'  && (e.note || 'marked as ordered')}
                      {e.action === 'create'   && (e.note || 'added')}
                      {e.action === 'edit'     && 'details updated'}
                      {e.action === 'delete'   && 'deleted'}
                    </span>
                    <span className="ml-auto text-xs text-gray-400">{e.byName} · {fmtWhen(e.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ─── Modals ─────────────────────────────────────────────────── */}
      {editing && (
        <ItemModal
          item={editing.item}
          saving={busy}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
      {showOrder && (
        <OrderModal
          items={lowItems}
          centerName={centerName}
          recipients={recipients}
          emailing={emailing}
          platformOn={platformOn}
          onClose={() => setShowOrder(false)}
          onMarkOrdered={handleMarkOrdered}
          onEmail={handleEmailNow}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={settings}
          saving={busy}
          platformOn={platformOn}
          myNotify={myNotify}
          togglingMine={togglingMine}
          onToggleMine={handleToggleMine}
          onClose={() => setShowSettings(false)}
          onSave={handleSaveSettings}
        />
      )}
    </div>
  );
}
