/**
 * CentreRolesTab — the Discord-style role editor.
 *
 * Create a role, colour it, tick what it can do, and say whether shifts
 * worked under it count toward the instructor:student ratio. Roles live
 * per centre on `centers/{id}/config/main`, and a user holds one through
 * their `instructorType` at that centre — the field Manage Staff already
 * edits, so nothing needs migrating.
 *
 * Two things this screen is careful about, both enforced in
 * src/lib/roles.js rather than here:
 *
 *   Built-ins can't be deleted. Existing user records and historical
 *   shift documents reference them by name; removing one would strip
 *   permissions from whoever holds it and orphan the shifts. They can
 *   still be renamed, recoloured and re-permissioned.
 *
 *   No role can grant `roles.manage`. This editor is open to a centre
 *   director, not only Enterprise, so without that boundary a director
 *   could mint a role that let them edit platform roles everywhere.
 *   It's stripped on read, on write, and again at resolution.
 *
 * Saving writes BOTH shapes: `staffRoles` (the rich array this screen
 * reads) and `staffRolePermissions` (a flat name → permissions map the
 * Firestore rules read, because the rules language can't search a list of
 * maps). permissionLookup() derives the second from the first.
 */

import { useMemo, useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast, confirmDialog } from '../lib/notify';
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit';
import {
  Shield, Plus, Trash2, X, Users, Check, GripVertical, AlertTriangle, Palette,
} from 'lucide-react';
import {
  resolveRoles, permissionGroups, makeRoleId, validateRole, canDeleteRole,
  roleHolderCount, serializeRoles, permissionLookup, permissionLabel,
} from '../lib/roles';
import { staffTypeColorHex, contrastText } from '../lib/centerConfig';
import { defaultIncludedInRatio } from '../lib/ratioCount';

// A small, deliberately limited palette. Free-form hex pickers produce
// roles nobody can tell apart on the weekly grid; these are the colours
// the grid already uses, so a role always looks like it belongs.
const ROLE_COLORS = [
  '#dc2626', '#ea580c', '#ca8a04', '#84cc16', '#16a34a', '#0d9488',
  '#06b6d4', '#2563eb', '#4338ca', '#9333ea', '#db2777', '#92400e',
  '#0f172a', '#64748b',
];

function RoleSwatch({ role, size = 10 }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, backgroundColor: role.color }}
      aria-hidden="true"
    />
  );
}

/** The create / edit sheet. */
function RoleEditor({ role, allRoles, onCancel, onSave, onDelete, holders }) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color);
  const [countsInRatio, setCountsInRatio] = useState(!!role.countsInRatio);
  const [permissions, setPermissions] = useState(new Set(role.permissions || []));

  const draft = { ...role, name, color, countsInRatio, permissions: [...permissions] };
  const error = validateRole(draft, allRoles);
  const groups = permissionGroups();

  const toggle = (id) => setPermissions(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Renaming a role that people hold re-points them, because a user's
  // role IS their instructorType string. Worth saying out loud rather
  // than discovering afterwards.
  const renaming = role.name !== name && holders > 0;

  return (
    <div className="rounded-2xl border-2 border-purple-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b bg-purple-50/60 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <RoleSwatch role={draft} size={12} />
          <h3 className="truncate text-sm font-bold text-gray-900">
            {role.isNew ? 'New role' : `Editing "${role.name}"`}
          </h3>
          {role.builtIn && (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
              Built-in
            </span>
          )}
        </div>
        <button onClick={onCancel} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Cancel">
          <X size={16} />
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Role name</label>
            <input
              type="text"
              value={name}
              maxLength={40}
              onChange={e => setName(e.target.value)}
              placeholder="Assistant Lead"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
            />
            <p className="mt-1 text-xs text-gray-400">
              This is the title you pick in Manage Staff, and the label on shifts.
            </p>
          </div>
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
              <Palette size={12} /> Colour
            </label>
            <div className="flex flex-wrap gap-1.5">
              {ROLE_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Colour ${c}`}
                  aria-pressed={color === c}
                  className={`h-7 w-7 rounded-lg border-2 transition-transform ${
                    color === c ? 'border-gray-900 scale-110' : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: c }}
                >
                  {color === c && <Check size={13} strokeWidth={3} style={{ color: contrastText(c) }} className="mx-auto" />}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Ratio default — the tie-in to the per-shift toggle. */}
        <label className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
          countsInRatio ? 'border-emerald-200 bg-emerald-50/60' : 'border-gray-300 bg-gray-50'
        }`}>
          <div className="pr-3">
            <p className={`text-xs font-semibold ${countsInRatio ? 'text-emerald-900' : 'text-gray-900'}`}>
              Counts toward the ratio
            </p>
            <p className={`mt-0.5 text-xs ${countsInRatio ? 'text-emerald-700/80' : 'text-gray-600'}`}>
              Sets how the <b>Included in Ratio</b> toggle starts on a new shift for this role.
              Whoever creates the shift can still flip it.
            </p>
          </div>
          <div className="relative mt-0.5 inline-flex shrink-0">
            <input type="checkbox" checked={countsInRatio} onChange={e => setCountsInRatio(e.target.checked)} className="peer sr-only" />
            <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-500 peer-checked:after:translate-x-full peer-checked:after:border-white" />
          </div>
        </label>

        {/* Permissions */}
        <div>
          <p className="mb-1 text-xs font-medium text-gray-500">Permissions</p>
          <p className="mb-2 text-xs text-gray-400">
            These are <b>added</b> to whatever the person&rsquo;s platform role already allows — a role can
            grant access, never remove it. To give someone less, lower their platform role on the People tab.
          </p>
          <div className="space-y-3">
            {groups.map(g => (
              <div key={g.name} className="rounded-lg border border-gray-200">
                <p className="border-b bg-gray-50 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                  {g.name}
                </p>
                <div className="divide-y">
                  {g.permissions.map(p => (
                    <label key={p.id} className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={permissions.has(p.id)}
                        onChange={() => toggle(p.id)}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-800">{p.label}</span>
                        <span className="block text-xs text-gray-500">{p.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {renaming && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {holders} {holders === 1 ? 'person holds' : 'people hold'} this role. Renaming it changes their
              title too, and shifts already worked keep the old label.
            </span>
          </p>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">{error}</p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={() => onSave(draft)}
            disabled={!!error}
            className="flex-1 rounded-lg bg-purple-600 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-40"
          >
            {role.isNew ? 'Create role' : 'Save changes'}
          </button>
          {canDeleteRole(role) && !role.isNew && (
            <button
              onClick={onDelete}
              className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
              aria-label="Delete role"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CentreRolesTab({ users, centers }) {
  const { profile, activeCenterId, centerConfig, isSuperAdmin } = useAuth();
  // Enterprise can edit any centre's roles; everyone else edits their own.
  const [centreId, setCentreId] = useState(activeCenterId);
  const editingActive = centreId === activeCenterId;
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  // Roles for a centre other than the active one aren't in context, so
  // they're loaded on demand and held here.
  const [otherConfig, setOtherConfig] = useState(null);

  const config = editingActive ? centerConfig : otherConfig;

  const roles = useMemo(
    () => resolveRoles(config, (name) => staffTypeColorHex(name, config)),
    [config],
  );

  const loadCentre = async (id) => {
    setCentreId(id);
    setEditing(null);
    if (id === activeCenterId) { setOtherConfig(null); return; }
    try {
      const { getDoc } = await import('firebase/firestore');
      const snap = await getDoc(doc(db, 'centers', id, 'config', 'main'));
      setOtherConfig(snap.exists() ? snap.data() : {});
    } catch {
      toast.error('Could not load that centre&rsquo;s roles.');
      setOtherConfig({});
    }
  };

  /** Write the whole registry back, in both shapes. */
  const persist = async (next, description) => {
    setSaving(true);
    try {
      const staffRoles = serializeRoles(next);
      await setDoc(
        doc(db, 'centers', centreId, 'config', 'main'),
        { staffRoles, staffRolePermissions: permissionLookup(staffRoles) },
        { merge: true },
      );
      if (!editingActive) setOtherConfig(c => ({ ...(c || {}), staffRoles }));
      await logAuditEvent({
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        actor: profile,
        centerId: centreId,
        details: { area: 'centreRoles', change: description },
      }).catch(() => {});
      toast.success(description);
      setEditing(null);
    } catch (err) {
      console.error('[CentreRoles] save failed:', err);
      toast.error(err?.message || 'Could not save. You may not have permission to edit this centre.');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = (draft) => {
    const exists = roles.some(r => r.id === draft.id);
    const next = exists
      ? roles.map(r => (r.id === draft.id ? { ...r, ...draft } : r))
      : [...roles, { ...draft, builtIn: false }];
    persist(next, exists ? `Updated the "${draft.name}" role.` : `Created the "${draft.name}" role.`);
  };

  const handleDelete = async (role) => {
    const holders = roleHolderCount(role, users, centreId);
    const ok = await confirmDialog({
      title: `Delete the "${role.name}" role?`,
      body: holders > 0
        ? `${holders} ${holders === 1 ? 'person still holds' : 'people still hold'} this role. `
          + 'They keep their title, but lose everything this role granted and fall back to what '
          + 'their platform role allows. Nobody is locked out of the portal.'
        : 'Nobody currently holds it, so nothing else changes.',
      confirmLabel: 'Delete role',
      destructive: true,
    });
    if (!ok) return;
    persist(roles.filter(r => r.id !== role.id), `Deleted the "${role.name}" role.`);
  };

  const startNew = () => setEditing({
    id: makeRoleId('New Role', roles),
    name: '',
    color: ROLE_COLORS[9],
    countsInRatio: defaultIncludedInRatio({ role: 'Instructor' }),
    permissions: [],
    builtIn: false,
    isNew: true,
  });

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-bold text-gray-900">
              <Shield size={15} className="text-purple-600" />
              Centre roles
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Job titles and what each one can do. A role adds to a person&rsquo;s platform role — it never takes anything away.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isSuperAdmin && centers?.length > 0 && (
              <select
                value={centreId}
                onChange={e => loadCentre(e.target.value)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-purple-500 focus:outline-none"
              >
                {centers.map(c => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
              </select>
            )}
            <button
              onClick={startNew}
              disabled={saving || !!editing}
              className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-40"
            >
              <Plus size={14} /> New role
            </button>
          </div>
        </div>
      </div>

      {editing && (
        <RoleEditor
          role={editing}
          allRoles={roles}
          holders={roleHolderCount(editing, users, centreId)}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
          onDelete={() => handleDelete(editing)}
        />
      )}

      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <ul className="divide-y">
          {roles.map(role => {
            const holders = roleHolderCount(role, users, centreId);
            const isEditing = editing?.id === role.id;
            return (
              <li
                key={role.id}
                className={`flex flex-wrap items-center gap-3 px-4 py-3 ${isEditing ? 'bg-purple-50/40' : 'hover:bg-gray-50'}`}
              >
                <GripVertical size={14} className="shrink-0 text-gray-300" aria-hidden="true" />
                <span
                  className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold"
                  style={{ backgroundColor: role.color, color: contrastText(role.color) }}
                >
                  {role.name}
                </span>

                <span className="flex items-center gap-1 text-xs text-gray-500" title={`${holders} at this centre`}>
                  <Users size={12} /> {holders}
                </span>

                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  role.countsInRatio
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-gray-200 bg-gray-50 text-gray-500'
                }`}>
                  {role.countsInRatio ? 'In ratio' : 'Out of ratio'}
                </span>

                <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {role.permissions.length === 0 ? (
                    <span className="text-xs italic text-gray-400">No extra permissions</span>
                  ) : role.permissions.map(id => (
                    <span key={id} className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] text-gray-600">
                      {permissionLabel(id)}
                    </span>
                  ))}
                </span>

                <button
                  onClick={() => setEditing(role)}
                  disabled={saving}
                  className="shrink-0 rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  Edit
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <p className="px-1 text-xs text-gray-400">
        Built-in roles can be renamed, recoloured and re-permissioned, but not deleted — staff records and
        past shifts refer to them by name. Changing platform roles (Owner, Enterprise, Admin) stays on the
        People tab, and no centre role can grant it.
      </p>
    </div>
  );
}
