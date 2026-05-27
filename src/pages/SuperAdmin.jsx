import { useState, useEffect } from 'react';
import {
  collection, doc, getDoc, getDocs, onSnapshot,
  setDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  DEFAULT_CENTER_CONFIG, ALL_WEEKDAYS,
} from '../lib/centerConfig';
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit';
import {
  Shield, ShieldAlert, Globe, Plus, Building2, Users,
  ArrowRight, CheckCircle2, AlertTriangle, Save,
  CalendarDays,
} from 'lucide-react';

/**
 * Manage Centres — Enterprise-only platform controls.
 *
 * Visible only to users with role === 'super_admin' (displayed as
 * "Enterprise" in the UI; the role string is preserved internally so
 * security rules and audit codes don't churn).
 *
 * Lets the Enterprise operator:
 *  - List every centre on the platform (shown at the top of the page)
 *  - Create a new centre
 *  - Edit appearance + operating days for the currently-active centre
 *  - Switch the active centre to any centre (god view / support mode)
 *
 * Bootstrap section appears when the current user is an owner but NOT
 * yet Enterprise AND no Enterprise user exists on the platform — this
 * is how the very first Enterprise account gets created without Firebase
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
          <h1 className="text-2xl font-bold text-gray-900">Manage Centres</h1>
          <p className="text-sm text-gray-500">Enterprise controls. Create centres, switch contexts, configure operating days. (Role colours moved to Centre Settings.)</p>
        </div>
      </div>

      {/* Bootstrap ─────────────────────────────────────────────────────── */}
      {!isSuperAdmin && needsBootstrap && (
        <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-6 shadow-sm">
          <div className="flex items-start gap-3 mb-3">
            <AlertTriangle size={20} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-amber-900">No Enterprise User Exists Yet</h3>
              <p className="text-sm text-amber-800 mt-0.5">
                The platform doesn't have an Enterprise account. As the first owner, you can promote yourself to Enterprise one time. This unlocks centre creation and god-mode support across all centres.
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
            {bootstrapping ? 'Promoting…' : 'Promote me to Enterprise'}
          </button>
        </div>
      )}

      {/* Centres list (Enterprise only). Pinned to the very top of the page —
          users said it was backwards to scroll past Create + Appearance +
          Operating Days before reaching the actual list of what they have. */}
      {isSuperAdmin && (
        <>
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={18} className="text-purple-600" />
              <h3 className="font-semibold text-gray-900">All Centres ({centers.length})</h3>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Switch to any centre to see exactly what their owner sees — useful for support and debugging.
            </p>
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <div className="h-6 w-6 animate-spin rounded-full border-4 border-purple-600 border-t-transparent" />
              </div>
            ) : centers.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No centres yet. Create one below.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {centers.map(c => {
                  const isActive = activeCenterId === c.id;
                  // Super-admins have access to every centre by virtue of
                  // their role, so the "Member" badge is just noise on this
                  // dashboard — and it makes the platform operator look like
                  // a regular employee of whichever centre they happen to be
                  // listed under. Show it only to non-super-admin viewers
                  // (e.g., the bootstrap-eligible owner before promotion).
                  const isMine = !isSuperAdmin && userCenters?.includes(c.id);
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

          {/* Create + per-centre configuration follow the centres list. */}
          <CreateCenterForm existing={centers.map(c => c.id)} />

          {/* Appearance / role colours moved to Centre Settings so owners
              can rebrand their own centre. Enterprise still edits per-centre
              colours from there after switching into the centre. */}

          <OperatingDaysEditor
            activeCenterId={activeCenterId}
            centerConfig={centerConfig}
            activeCenterName={centers.find(c => c.id === activeCenterId)?.name || activeCenterId}
          />

          {/* Holidays now live on the Admin Panel → Holidays tab so admins can
              manage them too. Enterprise users access them from the same place.
              Recent Activity moved to its own /audit-logs page so it's
              easier to share with curious centre owners. */}

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

// Recent Activity (audit log viewer) lives on its own page now —
// see src/pages/AuditLogs.jsx.

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

      // Log the create. Fire-and-forget; never breaks the create flow.
      logAuditEvent(profile, {
        action: AUDIT_ACTIONS.CENTER_CREATE,
        centerId: id,
        details: { name: name.trim(), city: city.trim(), province: province.trim(), addedSelfAsMember: !!addMeAsOwner },
      });

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
