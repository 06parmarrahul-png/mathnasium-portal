import { useState, useEffect } from 'react';
import {
  collection, doc, getDoc, getDocs, onSnapshot,
  setDoc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { DEFAULT_CENTER_CONFIG } from '../lib/centerConfig';
import {
  Shield, ShieldAlert, Globe, Plus, Building2, Users,
  ArrowRight, CheckCircle2, AlertTriangle,
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
  const { profile, isSuperAdmin, activeCenterId, switchCenter, userCenters } = useAuth();
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
