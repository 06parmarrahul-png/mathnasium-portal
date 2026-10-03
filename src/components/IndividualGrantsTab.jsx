import { useMemo, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { UserCheck, Search, Check, Loader2 } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import { membershipFieldPath, resolveUserForCenter } from '../lib/centerMembership';
import { resolvePermissions, resolveRoles } from '../lib/roles';
import {
  grantablePermissions, grantsFor, toggleGrant, permissionLabel, peopleWithGrants, isRedundant,
} from '../lib/individualGrants';
import { roleDisplayName } from '../lib/roleLabel';

/**
 * Manage Staff → Individuals.
 *
 * Access given to a PERSON rather than to a title. The centre wanted
 * three senior instructors running the Student Scheduler without making
 * them Leads and without handing it to every instructor — this is where
 * that is done, one name at a time.
 *
 * ADDITIVE ONLY, and the screen says so. A grant can give somebody
 * something their title does not; it can never take away something it
 * does. Taking away belongs on the role, where it is visible to everyone
 * at once rather than hidden on one person's record.
 *
 * The rules live in src/lib/individualGrants.js — including the one that
 * matters: the platform-only permissions cannot be granted here any more
 * than a centre role can grant them.
 */
export default function IndividualGrantsTab({ users = [] }) {
  const { activeCenterId, centerConfig } = useAuth();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);     // uid being edited
  const [saving, setSaving] = useState('');

  const roles = useMemo(() => resolveRoles(centerConfig, () => '#999'), [centerConfig]);
  const grantable = useMemo(() => grantablePermissions(), []);

  // What each person's TITLE already gives them, so the screen can say
  // when a grant is adding nothing.
  const rolePermsFor = (u) => {
    const forCentre = resolveUserForCenter(u, activeCenterId);
    return resolvePermissions({
      platformRole: u.role,
      instructorType: forCentre?.instructorType,
      isVolunteer: forCentre?.isVolunteer,
      roles,
    });
  };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (users || [])
      .filter(u => !needle || String(u.displayName || '').toLowerCase().includes(needle))
      .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
  }, [users, q]);

  const granted = useMemo(() => peopleWithGrants(users, activeCenterId), [users, activeCenterId]);

  const flip = async (u, id) => {
    const next = toggleGrant(grantsFor(u, activeCenterId), id);
    setSaving(`${u.uid}:${id}`);
    try {
      await updateDoc(doc(db, 'users', u.uid), {
        [membershipFieldPath(activeCenterId, 'extraPermissions')]: next,
      });
      toast.success(next.includes(id)
        ? `${u.displayName} can now ${permissionLabel(id).toLowerCase()}.`
        : `Took ${permissionLabel(id).toLowerCase()} back from ${u.displayName}.`);
    } catch (e) {
      toast.error(e?.message || 'Could not save that.');
    } finally {
      setSaving('');
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center gap-2">
          <UserCheck size={16} className="text-blue-600" />
          <h3 className="font-semibold text-gray-900">Access for one person</h3>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-gray-600">
          For the people you trust with something their job title doesn&rsquo;t carry —
          a senior instructor who runs the Student Scheduler, say. It only ever
          <b> adds</b>: it can give somebody more than their title does, never less.
          To take something away from everyone with a title, edit the role instead.
          Grants apply at <b>{activeCenterId}</b> only.
        </p>

        {granted.length > 0 && (
          <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-[13px] text-blue-900">
            <b>{granted.length} {granted.length === 1 ? 'person has' : 'people have'} extra access:</b>{' '}
            {granted.map(r => `${r.user.displayName} (${r.grants.map(permissionLabel).join(', ')})`).join(' · ')}
          </div>
        )}
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search staff…" aria-label="Search staff"
          className="w-full rounded-lg border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-red-500 focus:outline-none"
        />
      </div>

      <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
        {rows.map(u => {
          const forCentre = resolveUserForCenter(u, activeCenterId);
          const mine = grantsFor(u, activeCenterId);
          const rolePerms = rolePermsFor(u);
          const isOpen = open === u.uid;
          return (
            <div key={u.uid} className="px-4 py-3">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : u.uid)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-3 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900">{u.displayName}</span>
                  <span className="block text-xs text-gray-500">
                    {roleDisplayName(forCentre?.instructorType) || 'No title'}
                    {mine.length > 0 && (
                      <> · <span className="font-semibold text-blue-700">
                        {mine.map(permissionLabel).join(', ')}
                      </span></>
                    )}
                  </span>
                </span>
                <span className="text-xs font-semibold text-gray-400">{isOpen ? 'Close' : 'Change'}</span>
              </button>

              {isOpen && (
                <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                  {grantable.map(p => {
                    const on = mine.includes(p.id);
                    const covered = isRedundant(p.id, rolePerms);
                    const busy = saving === `${u.uid}:${p.id}`;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => flip(u, p.id)}
                        disabled={!!saving}
                        // Named for the action, not just the permission: a
                        // screen reader lands on "Grant: Run the Student
                        // Scheduler", which says what pressing does.
                        aria-label={`${on ? 'Remove' : 'Grant'}: ${p.label}`}
                        aria-pressed={on}
                        className={`flex items-start gap-2 rounded-lg border p-2.5 text-left transition-colors disabled:opacity-60 ${
                          on ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50/40'
                        }`}
                      >
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          on ? 'border-blue-600 bg-blue-600 text-white' : 'border-gray-300'
                        }`}>
                          {busy ? <Loader2 size={10} className="animate-spin" /> : on ? <Check size={11} /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium text-gray-900">{p.label}</span>
                          {covered && (
                            <span className="block text-[11.5px] text-gray-500">
                              Their title already includes this
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-gray-500">Nobody matches that.</p>
        )}
      </div>
    </div>
  );
}
