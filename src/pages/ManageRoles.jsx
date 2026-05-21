import { useEffect, useMemo, useState } from 'react';
import {
  collection, doc, onSnapshot, updateDoc, setDoc, serverTimestamp, getDoc,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit';
import { toast, confirmDialog } from '../lib/notify';
import {
  UserCog, ShieldAlert, Shield, Building2, KeyRound, AlertTriangle, Lock, X,
} from 'lucide-react';

/**
 * Manage Roles — Enterprise-only cross-centre role editor.
 *
 * Filter by centre, see every user there, change their platform `role`
 * field (instructor ↔ admin freely; owner promotion behind a 4-digit
 * code; demotion of an owner back to admin/instructor also Enterprise-
 * only with confirmation).
 *
 * Distinct from the existing Admin Panel → Manage Users screen, which
 * edits per-centre operational fields (instructorType, subRoles,
 * priority, approval). This screen only touches `role`.
 *
 * The 4-digit owner-promotion code is stored as a SHA-256 hash in the
 * `platform/meta` Firestore doc. Plain text is never persisted. On first
 * use (no code set yet), Enterprise users are prompted to set one.
 *
 * Note: 4 digits is a guardrail — it forces two Enterprise users to
 * coordinate before someone gets owner power, not a hard security
 * boundary. Firestore rules still gate role writes by Enterprise
 * privilege, so a non-Enterprise actor cannot promote regardless of
 * whether they know the code.
 */

const ROLE_LABELS = {
  super_admin: 'Enterprise',
  owner:       'Owner',
  admin:       'Admin',
  instructor:  'Instructor',
};

const ROLE_COLORS = {
  super_admin: 'bg-purple-100 text-purple-700 border-purple-200',
  owner:       'bg-red-100 text-red-700 border-red-200',
  admin:       'bg-emerald-100 text-emerald-700 border-emerald-200',
  instructor:  'bg-gray-100 text-gray-600 border-gray-200',
};

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export default function ManageRoles() {
  const { profile, isSuperAdmin } = useAuth();
  const [users, setUsers] = useState([]);
  const [centers, setCenters] = useState([]);
  const [centerFilter, setCenterFilter] = useState('__all__');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [codeMeta, setCodeMeta] = useState({ hasCode: false, loading: true });
  // { mode: 'set' | 'promote' | 'demote_owner', user, targetRole }
  const [modal, setModal] = useState(null);

  // Subscribe to centres (for the filter dropdown).
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    return onSnapshot(
      collection(db, 'centers'),
      snap => setCenters(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setCenters([]),
    );
  }, [isSuperAdmin]);

  // Subscribe to users. Firestore rules allow any signed-in user to read
  // /users, and Enterprise-only writes are still enforced by the existing
  // rule clause requiring isOwner() || isSuperAdmin() for `role` changes.
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    return onSnapshot(
      collection(db, 'users'),
      snap => {
        setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [isSuperAdmin]);

  // Subscribe to the platform meta doc so we know whether a promote code
  // has been set yet (controls the "set code first" UX).
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    return onSnapshot(
      doc(db, 'platform', 'meta'),
      snap => {
        const data = snap.exists() ? snap.data() : null;
        setCodeMeta({
          hasCode: !!data?.ownerPromoteCodeHash,
          loading: false,
        });
      },
      () => setCodeMeta({ hasCode: false, loading: false }),
    );
  }, [isSuperAdmin]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter(u => {
        if (centerFilter === '__all__') return true;
        const ids = Array.isArray(u.centerIds) ? u.centerIds
                  : u.centerId ? [u.centerId] : [];
        return ids.includes(centerFilter);
      })
      .filter(u => {
        if (!q) return true;
        return (u.displayName || '').toLowerCase().includes(q)
            || (u.email || '').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Surface elevated roles at the top so they're easy to find.
        const order = { super_admin: 0, owner: 1, admin: 2, instructor: 3 };
        const ra = order[a.role] ?? 9;
        const rb = order[b.role] ?? 9;
        if (ra !== rb) return ra - rb;
        return (a.displayName || a.email || '').localeCompare(b.displayName || b.email || '');
      });
  }, [users, centerFilter, search]);

  // ─── Role change handlers ──────────────────────────────────────────

  /** Quick instructor ↔ admin toggle. No code prompt — Enterprise can
   *  flip these freely.  Owner / Enterprise roles are handled below
   *  via the modal flow. */
  const handleQuickRoleChange = async (user, nextRole) => {
    if (user.uid === profile.uid) {
      toast.error("You can't change your own role here.");
      return;
    }
    if (user.role === 'super_admin') {
      toast.error('Demote another Enterprise user from the Demote button.');
      return;
    }
    if (user.role === 'owner' || nextRole === 'owner' || nextRole === 'super_admin') {
      toast.error('Use the elevated-role buttons for owner / Enterprise changes.');
      return;
    }
    const ok = await confirmDialog({
      title: `Change role to ${ROLE_LABELS[nextRole]}?`,
      message: `${user.displayName || user.email} → ${ROLE_LABELS[nextRole]}.`,
      confirmText: 'Change role',
    });
    if (!ok) return;
    await applyRoleChange(user, nextRole, { codeUsed: false });
  };

  const handlePromoteToOwner = (user) => {
    if (!codeMeta.hasCode) {
      setModal({ mode: 'set_then_promote', user, targetRole: 'owner' });
    } else {
      setModal({ mode: 'promote', user, targetRole: 'owner' });
    }
  };

  const handleDemoteOwner = async (user) => {
    const ok = await confirmDialog({
      title: 'Demote owner?',
      message: `${user.displayName || user.email} is currently Owner. Demote to Admin? They'll keep centre access but lose Centre Analytics, Centre Settings, and the ability to manage other admins.`,
      confirmText: 'Demote to Admin',
      danger: true,
    });
    if (!ok) return;
    await applyRoleChange(user, 'admin', { codeUsed: false });
  };

  const applyRoleChange = async (user, nextRole, { codeUsed }) => {
    const fromRole = user.role;
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        role: nextRole,
        roleChangedAt: serverTimestamp(),
        roleChangedBy: profile.uid,
      });
      // Fire-and-forget audit entry.
      logAuditEvent(profile, {
        action: AUDIT_ACTIONS.ROLE_CHANGE,
        targetUserId: user.uid,
        details: {
          fromRole, toRole: nextRole,
          targetName: user.displayName || user.email || user.uid,
          codeUsed: !!codeUsed,
        },
      });
      toast.success(`${user.displayName || 'User'} is now ${ROLE_LABELS[nextRole]}.`);
    } catch (err) {
      toast.error(err?.message || 'Failed to update role.');
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────

  if (!profile) return null;
  if (!isSuperAdmin) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Manage Roles is for Enterprise users only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-purple-100 p-2.5 text-purple-700">
          <UserCog size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Manage Roles</h1>
          <p className="text-sm text-gray-500">
            Change platform roles across every centre. Owner promotion requires the 4-digit code.
          </p>
        </div>
      </div>

      {/* Filter row */}
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-gray-500" />
            <label className="text-sm font-medium text-gray-700">Centre:</label>
            <select
              value={centerFilter}
              onChange={e => setCenterFilter(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
            >
              <option value="__all__">All centres ({users.length} users)</option>
              {centers.map(c => (
                <option key={c.id} value={c.id}>{c.name || c.id}</option>
              ))}
            </select>
          </div>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="flex-1 min-w-[180px] rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
          />
          <button
            onClick={() => setModal({ mode: 'set' })}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            title={codeMeta.hasCode ? 'Rotate the owner-promotion code' : 'Set the owner-promotion code'}
          >
            <KeyRound size={14} />
            {codeMeta.hasCode ? 'Rotate Code' : 'Set Code'}
          </button>
        </div>
        {!codeMeta.hasCode && !codeMeta.loading && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>No owner-promotion code is set yet. The first time you promote someone to Owner you'll be asked to set one.</span>
          </div>
        )}
      </div>

      {/* Users list */}
      <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-purple-600 border-t-transparent" />
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="py-12 text-center">
            <UserCog size={28} className="mx-auto text-gray-300 mb-2" />
            <p className="text-sm text-gray-400 italic">No users match this filter.</p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filteredUsers.map(u => {
              const isMe = u.uid === profile.uid;
              const role = u.role || 'instructor';
              const roleCls = ROLE_COLORS[role] || ROLE_COLORS.instructor;
              const ids = Array.isArray(u.centerIds) ? u.centerIds
                        : u.centerId ? [u.centerId] : [];
              return (
                <li key={u.uid} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-gray-50">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900 truncate">
                        {u.displayName || u.email || u.uid}
                        {isMe && <span className="ml-2 text-xs text-gray-400">(you)</span>}
                      </p>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${roleCls}`}>
                        {ROLE_LABELS[role] || role}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 truncate">
                      {u.email}
                      {ids.length > 0 && <> · <span className="text-gray-400">{ids.join(', ')}</span></>}
                      {u.approved === false && <span className="ml-2 text-amber-600">· pending approval</span>}
                    </p>
                  </div>

                  {/* Action buttons. Self-edit is blocked at the handler
                      level too; here we just dim the row. */}
                  {isMe ? (
                    <span className="text-xs text-gray-400 italic">Can't edit yourself</span>
                  ) : role === 'super_admin' ? (
                    <span className="flex items-center gap-1 text-xs text-purple-700">
                      <Shield size={12} /> Enterprise account
                    </span>
                  ) : role === 'owner' ? (
                    <button
                      onClick={() => handleDemoteOwner(u)}
                      className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
                    >
                      Demote to Admin
                    </button>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {role !== 'instructor' && (
                        <button
                          onClick={() => handleQuickRoleChange(u, 'instructor')}
                          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                        >
                          → Instructor
                        </button>
                      )}
                      {role !== 'admin' && (
                        <button
                          onClick={() => handleQuickRoleChange(u, 'admin')}
                          className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                          → Admin
                        </button>
                      )}
                      <button
                        onClick={() => handlePromoteToOwner(u)}
                        className="flex items-center gap-1 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
                        title="Owner promotion requires the 4-digit code"
                      >
                        <Lock size={11} /> → Owner
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {modal && (
        <RoleCodeModal
          mode={modal.mode}
          user={modal.user}
          targetRole={modal.targetRole}
          codeAlreadySet={codeMeta.hasCode}
          actorProfile={profile}
          onClose={() => setModal(null)}
          onPromote={async ({ user, targetRole, codeUsed }) => {
            await applyRoleChange(user, targetRole, { codeUsed });
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Modal: set / rotate / verify the 4-digit code ─────────────────────────

function RoleCodeModal({ mode, user, targetRole, codeAlreadySet, actorProfile, onClose, onPromote }) {
  // Modes:
  //   set              → Enterprise rotating / setting the code (no promotion)
  //   set_then_promote → no code yet AND user is promoting someone to owner
  //                      (set, then immediately promote)
  //   promote          → code exists, verify it before promoting
  const isSetting = mode === 'set' || mode === 'set_then_promote';
  const isPromoting = mode === 'promote' || mode === 'set_then_promote';

  const [code, setCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const valid = (s) => /^\d{4}$/.test(s);

  const handleSubmit = async () => {
    setError('');
    if (!valid(code)) { setError('Code must be exactly 4 digits (0–9).'); return; }
    if (isSetting && code !== confirmCode) {
      setError('Codes don\'t match. Re-enter to confirm.');
      return;
    }
    setBusy(true);
    try {
      const hash = await sha256Hex(code);
      if (isSetting) {
        await setDoc(
          doc(db, 'platform', 'meta'),
          {
            ownerPromoteCodeHash: hash,
            ownerPromoteCodeSetAt: serverTimestamp(),
            ownerPromoteCodeSetBy: actorProfile.uid,
          },
          { merge: true },
        );
        logAuditEvent(actorProfile, {
          action: AUDIT_ACTIONS.PROMOTE_CODE_SET,
          details: { rotated: codeAlreadySet },
        });
        toast.success(codeAlreadySet ? 'Code rotated.' : 'Code set.');
      } else if (isPromoting) {
        // Verify against the stored hash.
        const snap = await getDoc(doc(db, 'platform', 'meta'));
        const stored = snap.exists() ? snap.data()?.ownerPromoteCodeHash : null;
        if (!stored || stored !== hash) {
          setError('Incorrect code. Owner promotion blocked.');
          setBusy(false);
          return;
        }
      }
      // Then promote, if that's what this modal is doing.
      if (isPromoting && user) {
        await onPromote({ user, targetRole, codeUsed: true });
        return;
      }
      onClose();
    } catch (err) {
      setError(err?.message || 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'set'              ? (codeAlreadySet ? 'Rotate Owner-Promotion Code' : 'Set Owner-Promotion Code')
    : mode === 'set_then_promote' ? 'Set Code, Then Promote'
    : 'Confirm Owner Promotion';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-purple-100 p-1.5 text-purple-700"><KeyRound size={16} /></div>
            <h3 className="font-bold text-gray-900">{title}</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {isPromoting && user && (
          <p className="mb-3 text-sm text-gray-600">
            Promoting <strong>{user.displayName || user.email}</strong> to <strong>{ROLE_LABELS[targetRole]}</strong>.
          </p>
        )}
        {mode === 'set_then_promote' && (
          <div className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>No code is set yet. Set one now to continue with the promotion.</span>
          </div>
        )}

        <label className="block text-xs font-medium text-gray-600 mb-1">
          {isSetting ? 'New 4-digit code' : 'Enter 4-digit code'}
        </label>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          value={code}
          onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
          placeholder="••••"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-lg tracking-[0.5em] font-mono text-center focus:border-purple-500 focus:outline-none"
          autoFocus
        />

        {isSetting && (
          <>
            <label className="mt-3 block text-xs font-medium text-gray-600 mb-1">Confirm code</label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={confirmCode}
              onChange={e => setConfirmCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              placeholder="••••"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-lg tracking-[0.5em] font-mono text-center focus:border-purple-500 focus:outline-none"
            />
          </>
        )}

        {error && (
          <div className="mt-3 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={busy || !valid(code) || (isSetting && !valid(confirmCode))}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {busy ? 'Working…' : (isPromoting ? 'Promote' : (codeAlreadySet ? 'Rotate' : 'Set Code'))}
          </button>
        </div>
      </div>
    </div>
  );
}
