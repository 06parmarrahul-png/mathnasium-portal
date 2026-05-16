import { useState, useEffect } from 'react';
import {
  collection, doc, getDoc, getDocs, onSnapshot,
  setDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  DEFAULT_CENTER_CONFIG, DEFAULT_ASSIGNMENT_COLORS,
  ASSIGNMENT_COLOR_KEYS, assignmentColorHex, contrastText, ALL_WEEKDAYS,
} from '../lib/centerConfig';
import {
  Shield, ShieldAlert, Globe, Plus, Building2, Users,
  ArrowRight, CheckCircle2, AlertTriangle, Palette, Save, RotateCcw,
  CalendarDays, CalendarX, Trash2,
} from 'lucide-react';

/**
 * Super-Admin Dashboard — platform-owner controls.
 *
 * Visible only to users with role === 'super_admin'.
 * Lets the platform operator:
 *  - List every center on the platform
 *  - Create a new center (only super-admin can do this)
 *  - Switch the active center to any center (god view / support mode)
 *
 * Bootstrap section appears when the current user is an owner but NOT
 * yet a super-admin AND no super-admin exists on the platform — this
 * is how the very first super-admin gets created without Firebase
 * Console access. After bootstrap, this section disappears.
 */

export default function SuperAdmin() {
  const { profile, isSuperAdmin, activeCenterId, switchCenter, userCenters, centerConfig } = useAuth();
  const [centers, setCenters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapError, setBootstrapError] = useState('');

  // Subscribe to all centers (super-admin can see them all; centers/{id} is
  // public-readable). Also runs for pre-bootstrap owners so they see the
  // list when checking if any super-admin exists yet.
  useEffect(() => (
    onSnapshot(
      collection(db, 'centers'),
      snap => {
        setCenters(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false),
    )
  ), []);

  // Check whether a super-admin exists on the platform (for the bootstrap
  // UI). Only runs once on mount for the current user. setState calls here
  // are legitimate (we're querying Firestore and reflecting the result) —
  // eslint's advisory is overly cautious for this pattern.
  useEffect(() => {
    if (!profile) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isSuperAdmin) { setNeedsBootstrap(false); return; }
    if (profile.role !== 'owner') return; // only owners can bootstrap
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'users'));
        const existing = snap.docs.find(d => d.data()?.role === 'super_admin');
        if (!cancelled) setNeedsBootstrap(!existing);
      } catch {
        if (!cancelled) setNeedsBootstrap(false);
      }
    })();
    return () => { cancelled = true; };
  }, [profile, isSuperAdmin]);

  // Block non-super-admins (unless they're a bootstrap-eligible owner).
  if (!profile) return null;
  if (!isSuperAdmin && !needsBootstrap) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">This page is for the platform operator only.</p>
      </div>
    );
  }

  // ─── Bootstrap handler ───────────────────────────────────────────────
  const handleBootstrap = async () => {
    if (!profile?.uid) return;
    setBootstrapping(true);
    setBootstrapError('');
    try {
      // Double-check no super-admin exists (race safety)
      const usersSnap = await getDocs(collection(db, 'users'));
      const exists = usersSnap.docs.find(d => d.data()?.role === 'super_admin');
      if (exists) {
        setBootstrapError('A super-admin already exists. Bootstrap not allowed.');
        setBootstrapping(false);
        return;
      }
      await updateDoc(doc(db, 'users', profile.uid), {
        role: 'super_admin',
        promotedToSuperAdminAt: serverTimestamp(),
      });
      // Hard reload so AuthContext picks up the new role.
      window.location.reload();
    } catch (err) {
      setBootstrapError(err?.message || 'Bootstrap failed.');
      setBootstrapping(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-purple-100 p-2.5 text-purple-700">
          <Shield size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Super Admin</h1>
          <p className="text-sm text-gray-500">Platform-level controls. Create centers, switch contexts, support any location.</p>
        </div>
      </div>

      {/* Bootstrap ─────────────────────────────────────────────────────── */}
      {!isSuperAdmin && needsBootstrap && (
        <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-6 shadow-sm">
          <div className="flex items-start gap-3 mb-3">
            <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-amber-900">No Super Admin Exists Yet</h3>
              <p className="text-sm text-amber-800 mt-0.5">
                The platform doesn't have a super-admin account. As the first owner, you can promote yourself to super-admin one time. This unlocks center creation and god-mode support across all centers.
              </p>
            </div>
          </div>
          {bootstrapError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 mb-3 text-sm text-red-700">
              {bootstrapError}
            </div>
          )}
          <button
            onClick={handleBootstrap}
            disabled={bootstrapping}
            className="flex items-center gap-2 rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            <Shield size={15} />
            {bootstrapping ? 'Promoting…' : 'Promote me to Super Admin'}
          </button>
        </div>
      )}

      {/* Centers list + create form (super-admin only) ─────────────────── */}
      {isSuperAdmin && (
        <>
          <CreateCenterForm existing={centers.map(c => c.id)} />

          <AppearanceEditor
            activeCenterId={activeCenterId}
            centerConfig={centerConfig}
            activeCenterName={centers.find(c => c.id === activeCenterId)?.name || activeCenterId}
          />

          <OperatingDaysEditor
            activeCenterId={activeCenterId}
            centerConfig={centerConfig}
            activeCenterName={centers.find(c => c.id === activeCenterId)?.name || activeCenterId}
          />

          <HolidaysEditor
            activeCenterId={activeCenterId}
            centerConfig={centerConfig}
            activeCenterName={centers.find(c => c.id === activeCenterId)?.name || activeCenterId}
          />

          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={18} className="text-purple-600" />
              <h3 className="font-semibold text-gray-900">All Centers ({centers.length})</h3>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Switch to any center to see exactly what their owner sees — useful for support and debugging.
            </p>
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <div className="h-6 w-6 animate-spin rounded-full border-4 border-purple-600 border-t-transparent" />
              </div>
            ) : centers.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No centers yet. Create one above.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {centers.map(c => {
                  const isActive = activeCenterId === c.id;
                  const isMine = userCenters?.includes(c.id);
                  return (
                    <div
                      key={c.id}
                      className={`rounded-xl border-2 p-4 transition-all ${isActive ? 'border-purple-500 bg-purple-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <div className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${isActive ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
                            <Building2 size={15} />
                          </div>
                          <div>
                            <p className="font-bold text-gray-900 leading-tight">{c.name || c.id}</p>
                            <p className="text-xs text-gray-500">
                              {[c.city, c.province].filter(Boolean).join(', ') || '—'}
                            </p>
                          </div>
                        </div>
                        {isActive && (
                          <span className="rounded-full bg-purple-600 px-2 py-0.5 text-xs font-bold text-white">ACTIVE</span>
                        )}
                      </div>
                      <div className="flex items-center justify-between mt-3">
                        <span className="text-xs text-gray-400">id: <code className="text-gray-600">{c.id}</code></span>
                        {!isActive && (
                          <button
                            onClick={() => switchCenter(c.id)}
                            className="flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-200 transition-colors"
                          >
                            Switch to <ArrowRight size={12} />
                          </button>
                        )}
                        {isMine && (
                          <span className="text-xs text-emerald-600 flex items-center gap-1">
                            <CheckCircle2 size={12} /> Member
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-5">
            <h4 className="font-semibold text-gray-700 mb-1 flex items-center gap-2"><Users size={14} /> Future</h4>
            <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
              <li>Cross-center search (find an instructor by name across all centers)</li>
              <li>Platform-wide analytics dashboard (total centers, users, shifts)</li>
              <li>Impersonate owner of any center (with audit log)</li>
              <li>Disable / archive a center</li>
              <li>Billing &amp; subscription management</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Sub-component: Appearance (shift colors) editor ─────────────────────

function AppearanceEditor({ activeCenterId, centerConfig, activeCenterName }) {
  // Local working copy of the shift-assignment color map. Seeded from the
  // active center's config (merged with the built-in defaults so every
  // assignment has a value to start from).
  const initial = () => {
    const out = {};
    for (const role of ASSIGNMENT_COLOR_KEYS) {
      out[role] = assignmentColorHex(role, centerConfig);
    }
    return out;
  };
  const [colors, setColors] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');

  // Re-seed if the active center changes (switchCenter) or config updates.
  useEffect(() => {
    const out = {};
    for (const role of ASSIGNMENT_COLOR_KEYS) {
      out[role] = assignmentColorHex(role, centerConfig);
    }
    setColors(out);
  }, [centerConfig, activeCenterId]);

  const dirty = ASSIGNMENT_COLOR_KEYS.some(
    r => colors[r] !== assignmentColorHex(r, centerConfig)
  );

  const setOne = (role, hex) => setColors(c => ({ ...c, [role]: hex }));

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { assignmentColors: colors, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (err) {
      setError(err?.message || 'Failed to save colors.');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    // Reset to the built-in defaults (visually) — not saved until "Save".
    const out = {};
    for (const role of ASSIGNMENT_COLOR_KEYS) out[role] = DEFAULT_ASSIGNMENT_COLORS[role];
    setColors(out);
  };

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-1">
        <Palette size={18} className="text-purple-600" />
        <h3 className="font-semibold text-gray-900">Appearance — Shift Colors</h3>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Each shift on the admin weekly grid is filled with its assignment's
        color (these also tint the payroll cards). Changes apply to{' '}
        <strong>{activeCenterName}</strong> only — the center you're currently
        viewing. Use the sidebar switcher to edit a different center.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {ASSIGNMENT_COLOR_KEYS.map(role => (
          <div key={role} className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2">
            {/* Live swatch preview */}
            <span
              className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold"
              style={{ backgroundColor: colors[role], color: contrastText(colors[role]) }}
            >
              {role.split(' ').map(w => w[0]).join('').slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-800 truncate">{role}</p>
              <p className="text-xs text-gray-400 font-mono">{colors[role]}</p>
            </div>
            <input
              type="color"
              value={colors[role]}
              onChange={e => setOne(role, e.target.value)}
              className="shrink-0 h-9 w-12 rounded cursor-pointer border border-gray-200 bg-white"
              title={`Pick color for ${role}`}
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          <Save size={14} />
          {saving ? 'Saving…' : 'Save Colors'}
        </button>
        <button
          onClick={handleReset}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RotateCcw size={13} />
          Reset to defaults
        </button>
        {dirty && !savedAt && (
          <span className="flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle size={13} /> Unsaved changes
          </span>
        )}
        {savedAt && !dirty && (
          <span className="flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 size={13} /> Saved
          </span>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}

// ─── Sub-component: Operating Days editor ────────────────────────────────

function OperatingDaysEditor({ activeCenterId, centerConfig, activeCenterName }) {
  // Working copy of the operating-days list, seeded from the active center's
  // config (or the Mon–Sat default if it has none yet).
  const seed = () => {
    const cfg = Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0
      ? centerConfig.operatingDays
      : DEFAULT_CENTER_CONFIG.operatingDays;
    return ALL_WEEKDAYS.filter(d => cfg.includes(d));
  };
  const [days, setDays] = useState(seed);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');

  // Re-seed when the active center changes or its config updates.
  useEffect(() => {
    const cfg = Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0
      ? centerConfig.operatingDays
      : DEFAULT_CENTER_CONFIG.operatingDays;
    setDays(ALL_WEEKDAYS.filter(d => cfg.includes(d)));
  }, [centerConfig, activeCenterId]);

  const savedDays = Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0
    ? ALL_WEEKDAYS.filter(d => centerConfig.operatingDays.includes(d))
    : DEFAULT_CENTER_CONFIG.operatingDays;
  const dirty = JSON.stringify(days) !== JSON.stringify(savedDays);

  const toggle = (day) => setDays(cur =>
    cur.includes(day)
      ? cur.filter(d => d !== day)            // turn the day off
      : ALL_WEEKDAYS.filter(d => cur.includes(d) || d === day) // on, keep week order
  );

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { operatingDays: days, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (err) {
      setError(err?.message || 'Failed to save operating days.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-1">
        <CalendarDays size={18} className="text-purple-600" />
        <h3 className="font-semibold text-gray-900">Operating Days</h3>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        The days <strong>{activeCenterName}</strong> is open. Closed days are
        dropped from the admin weekly grid, greyed out on the Schedule
        calendar, and skipped by the auto-scheduler. Every center must keep at
        least one day open.
      </p>

      <div className="flex flex-wrap gap-2">
        {ALL_WEEKDAYS.map(day => {
          const on = days.includes(day);
          const isLastOn = on && days.length === 1;
          return (
            <button
              key={day}
              onClick={() => !isLastOn && toggle(day)}
              disabled={isLastOn}
              title={isLastOn ? 'A center must be open at least one day' : ''}
              className={`rounded-lg px-3 py-2 text-sm font-semibold border-2 transition-all ${
                on
                  ? 'bg-purple-600 text-white border-purple-600'
                  : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
              } ${isLastOn ? 'cursor-not-allowed opacity-90' : ''}`}
            >
              {day}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          <Save size={14} />
          {saving ? 'Saving…' : 'Save Days'}
        </button>
        {dirty && !savedAt && (
          <span className="flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle size={13} /> Unsaved changes
          </span>
        )}
        {savedAt && !dirty && (
          <span className="flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 size={13} /> Saved
          </span>
        )}
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
    </div>
  );
}

// ─── Canadian holiday calculators (used by the auto-fill button) ─────────

// Anonymous Gregorian (Meeus/Jones/Butcher) Easter algorithm — returns the
// Date of Western Easter Sunday for the given year. Good Friday is 2 days
// before; everything else we need is a fixed date or an Nth weekday.
function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// Nth occurrence of weekday (0=Sun..6=Sat) in monthIdx (0=Jan..11=Dec).
function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
  const first = new Date(year, monthIdx, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, monthIdx, 1 + offset + (n - 1) * 7);
}

// The Monday falling on or before a given date — Victoria Day's definition.
function mondayOnOrBefore(year, monthIdx, day) {
  const d = new Date(year, monthIdx, day);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * BC statutory holidays for the given year. Returns an array of
 * { date: 'YYYY-MM-DD', name } in chronological order.
 * Covers New Year's, Family Day, Good Friday, Victoria Day, Canada Day,
 * BC Day, Labour Day, Thanksgiving, Remembrance Day, Christmas, Boxing Day.
 */
function canadianStatHolidays(year) {
  const easter = easterDate(year);
  const goodFriday = new Date(easter);
  goodFriday.setDate(easter.getDate() - 2);
  return [
    { date: `${year}-01-01`, name: "New Year's Day" },
    { date: toDateKey(nthWeekdayOfMonth(year, 1, 1, 3)), name: 'Family Day' },
    { date: toDateKey(goodFriday),                       name: 'Good Friday' },
    { date: toDateKey(mondayOnOrBefore(year, 4, 24)),    name: 'Victoria Day' },
    { date: `${year}-07-01`, name: 'Canada Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 7, 1, 1)), name: 'BC Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 8, 1, 1)), name: 'Labour Day' },
    { date: toDateKey(nthWeekdayOfMonth(year, 9, 1, 2)), name: 'Thanksgiving' },
    { date: `${year}-11-11`, name: 'Remembrance Day' },
    { date: `${year}-12-25`, name: 'Christmas Day' },
    { date: `${year}-12-26`, name: 'Boxing Day' },
  ];
}

// ─── Sub-component: Holidays editor ──────────────────────────────────────

function HolidaysEditor({ activeCenterId, centerConfig, activeCenterName }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const holidays = Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [];
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const sorted = [...holidays].sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));
  const upcoming = sorted.filter(h => (h?.date || '') >= todayStr);
  const past     = sorted.filter(h => (h?.date || '') <  todayStr);

  const saveList = async (next) => {
    setSaving(true);
    setError('');
    try {
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { holidays: next, updatedAt: serverTimestamp() },
        { merge: true },
      );
    } catch (err) {
      setError(err?.message || 'Failed to save holidays.');
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    setError('');
    if (!date) { setError('Pick a date.'); return; }
    if (holidays.some(h => h.date === date)) {
      setError('That date is already on the list.');
      return;
    }
    const next = [...holidays, { date, name: name.trim() || 'Closed' }];
    await saveList(next);
    setDate('');
    setName('');
  };

  const handleDelete = async (d) => {
    const next = holidays.filter(h => h.date !== d);
    await saveList(next);
  };

  // One-click: drop every BC stat holiday for the current and next calendar
  // year into the list. Dedupes against whatever's already there so
  // clicking twice is a no-op.
  const autoFillYears = [new Date().getFullYear(), new Date().getFullYear() + 1];
  const handleAutoFill = async () => {
    const all = autoFillYears.flatMap(y => canadianStatHolidays(y));
    const existing = new Set(holidays.map(h => h?.date));
    const toAdd = all.filter(h => !existing.has(h.date));
    if (toAdd.length === 0) {
      setError('All Canadian holidays for these years are already on the list.');
      setTimeout(() => setError(''), 3000);
      return;
    }
    await saveList([...holidays, ...toAdd]);
  };

  const fmt = (ds) => {
    if (!ds) return '';
    const [y, m, day] = ds.split('-');
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(day, 10));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  };

  const [showPast, setShowPast] = useState(false);

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-center gap-2">
        <CalendarX size={18} className="text-purple-600" />
        <h3 className="font-semibold text-gray-900">Holidays</h3>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        One-off days <strong>{activeCenterName}</strong> is closed (stat holidays,
        renovations, etc.). Holiday dates are dropped from the admin grid, greyed
        out on the Schedule calendar, and skipped by the auto-scheduler.
      </p>

      {/* Add form */}
      <div className="mb-4 grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-end">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Name (optional)</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Christmas Day"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={saving || !date}
          className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
        >
          <Plus size={14} /> Add
        </button>
      </div>
      {error && (
        <p className="mb-3 flex items-center gap-1 text-xs text-red-600">
          <AlertTriangle size={12} /> {error}
        </p>
      )}

      {/* One-click BC stat holiday auto-fill (current year + next year) */}
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-purple-100 bg-purple-50/60 px-3 py-2">
        <p className="min-w-0 text-xs text-purple-900">
          Don't want to type them all in? Auto-fill BC statutory holidays for{' '}
          <strong>{autoFillYears[0]}</strong> and <strong>{autoFillYears[1]}</strong>.
        </p>
        <button
          type="button"
          onClick={handleAutoFill}
          disabled={saving}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
        >
          <CalendarDays size={13} /> Auto-fill
        </button>
      </div>

      {/* Upcoming list */}
      {upcoming.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-400">
          No upcoming holidays.
        </p>
      ) : (
        <div className="space-y-1.5">
          {upcoming.map(h => (
            <div key={h.date} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <CalendarX size={14} className="shrink-0 text-purple-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-gray-800">{h.name || 'Closed'}</p>
                <p className="text-xs text-gray-500">{fmt(h.date)}</p>
              </div>
              <button
                type="button"
                onClick={() => handleDelete(h.date)}
                disabled={saving}
                className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Past collapsible */}
      {past.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowPast(s => !s)}
            className="text-xs font-semibold text-gray-500 hover:text-gray-800"
          >
            {showPast ? '− Hide' : '+ Show'} past holidays ({past.length})
          </button>
          {showPast && (
            <div className="mt-2 space-y-1.5">
              {past.slice().reverse().map(h => (
                <div key={h.date} className="flex items-center gap-3 rounded-lg border border-gray-100 bg-white px-3 py-2 opacity-70">
                  <CalendarX size={14} className="shrink-0 text-gray-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-gray-700">{h.name || 'Closed'}</p>
                    <p className="text-xs text-gray-400">{fmt(h.date)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDelete(h.date)}
                    disabled={saving}
                    className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"
                    title="Remove"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-component: Create Center form ───────────────────────────────────

function CreateCenterForm({ existing }) {
  const { profile, switchCenter } = useAuth();
  const [open, setOpen] = useState(false);
  const [centerId, setCenterId] = useState('');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [province, setProvince] = useState('BC');
  const [country, setCountry] = useState('Canada');
  const [addMeAsOwner, setAddMeAsOwner] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

  // Auto-fill id from name unless user has typed their own id
  const onNameChange = (v) => {
    setName(v);
    if (!centerId || centerId === slugify(name)) {
      setCenterId(slugify(v));
    }
  };

  const handleCreate = async () => {
    setError('');
    if (!centerId.trim() || !name.trim()) {
      setError('Center ID and Name are both required.');
      return;
    }
    const id = slugify(centerId);
    if (existing.includes(id)) {
      setError(`A center with id "${id}" already exists. Pick a different id.`);
      return;
    }
    setCreating(true);
    try {
      // Create the center identity doc
      await setDoc(doc(db, 'centers', id), {
        id,
        name: name.trim(),
        city: city.trim(),
        province: province.trim(),
        country: country.trim(),
        timezone: 'America/Vancouver',
        createdAt: serverTimestamp(),
      });
      // Seed the per-center config with reasonable defaults
      await setDoc(doc(db, 'centers', id, 'config', 'main'), {
        ...DEFAULT_CENTER_CONFIG,
        name: name.trim(),
        city: city.trim(),
        province: province.trim(),
        country: country.trim(),
        createdAt: serverTimestamp(),
      });

      // Optionally add the creator as a member of this center too —
      // useful for the super-admin to use their existing account to
      // poke around the new center.
      if (addMeAsOwner && profile?.uid) {
        const meSnap = await getDoc(doc(db, 'users', profile.uid));
        const me = meSnap.exists() ? meSnap.data() : {};
        const cur = Array.isArray(me.centerIds) ? me.centerIds : (me.centerId ? [me.centerId] : []);
        if (!cur.includes(id)) {
          await updateDoc(doc(db, 'users', profile.uid), {
            centerIds: [...cur, id],
          });
        }
      }

      // Reset + close
      setCenterId(''); setName(''); setCity(''); setProvince('BC'); setCountry('Canada');
      setOpen(false);
      // Switch to the new center so the user can immediately see it empty
      if (addMeAsOwner) switchCenter(id);
    } catch (err) {
      setError(err?.message || 'Failed to create center.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Plus size={18} className="text-purple-600" />
          <h3 className="font-semibold text-gray-900">Create New Center</h3>
        </div>
        {!open ? (
          <button
            onClick={() => setOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 transition-colors"
          >
            <Plus size={13} /> New Center
          </button>
        ) : (
          <button
            onClick={() => { setOpen(false); setError(''); }}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            Cancel
          </button>
        )}
      </div>
      {!open ? (
        <p className="text-sm text-gray-500">Onboard a new Mathnasium location. Only super-admins can do this — center owners cannot add new centers themselves (security boundary).</p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Center Name</label>
              <input
                type="text"
                value={name}
                onChange={e => onNameChange(e.target.value)}
                placeholder="Mathnasium Burnaby"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Center ID (slug)
              </label>
              <input
                type="text"
                value={centerId}
                onChange={e => setCenterId(slugify(e.target.value))}
                placeholder="burnaby"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none font-mono"
              />
              <p className="text-xs text-gray-400 mt-0.5">Lowercase, no spaces. This becomes part of the database key — cannot change later.</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
              <input
                type="text"
                value={city}
                onChange={e => setCity(e.target.value)}
                placeholder="Burnaby"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Province</label>
              <input
                type="text"
                value={province}
                onChange={e => setProvince(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Country</label>
              <input
                type="text"
                value={country}
                onChange={e => setCountry(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={addMeAsOwner}
              onChange={e => setAddMeAsOwner(e.target.checked)}
              className="accent-purple-600 h-4 w-4"
            />
            <span className="text-sm text-gray-700">Add me as a member of this center & switch to it (recommended for testing)</span>
          </label>
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <button
            onClick={handleCreate}
            disabled={creating || !centerId.trim() || !name.trim()}
            className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            {creating ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Creating…
              </>
            ) : (
              <>
                <Plus size={14} /> Create Center
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
