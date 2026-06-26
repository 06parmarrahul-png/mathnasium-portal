import { useEffect, useState } from 'react';
import {
  X, Mail, Phone, Building2, Shield, ShieldCheck, UserCog, Lock,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getContact } from '../lib/userContact';

/**
 * UserProfileModal — a lightweight viewer for someone else's profile.
 *
 * Privacy model:
 *  - Public to everyone signed in: photo, displayName, pronouns, bio,
 *    role pill, instructor type, centre membership.
 *  - Email / phone visible if EITHER:
 *      (a) the target user has opted in (mirror exists on the user doc as
 *          publicEmail / publicPhone), OR
 *      (b) the viewer is admin / admin_assistant / owner / super_admin
 *          (we fetch the private sub-doc when this is true).
 *
 *   <UserProfileModal user={someUser} onClose={() => ...} />
 *
 * No prop drilling needed — the modal pulls the viewer's role from
 * AuthContext to decide whether to make the admin fetch.
 */

const ROLE_LABEL = {
  super_admin:     'Enterprise',
  owner:           'Owner',
  admin_assistant: 'Admin Assistant',
  admin:           'Admin',
  instructor:      'Instructor',
};

const ROLE_PILL = {
  super_admin:     'bg-purple-100 text-purple-700 border-purple-200',
  owner:           'bg-red-100 text-red-700 border-red-200',
  admin_assistant: 'bg-teal-100 text-teal-700 border-teal-200',
  admin:           'bg-emerald-100 text-emerald-700 border-emerald-200',
  instructor:      'bg-gray-100 text-gray-600 border-gray-200',
};

function initialsOf(user) {
  const name = user?.displayName || `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
  if (!name) return '?';
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

export default function UserProfileModal({ user, onClose }) {
  const { profile: viewerProfile, isAdmin, isAdminAssistant, isOwner, isSuperAdmin } = useAuth();
  const viewerCanSeePrivate = isAdmin || isAdminAssistant || isOwner || isSuperAdmin;
  const isSelf = viewerProfile?.uid && user?.uid && viewerProfile.uid === user.uid;

  // Pull the private contact sub-doc when the viewer has rights to see
  // it. Firestore rules enforce the gate even if the client lies; we
  // skip the fetch entirely for non-admins / non-self to avoid the
  // wasted permission-denied round trip.
  const [privateContact, setPrivateContact] = useState(null);
  useEffect(() => {
    if (!user?.uid) return;
    if (!viewerCanSeePrivate && !isSelf) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await getContact(user.uid);
        if (!cancelled) setPrivateContact(c);
      } catch { /* permission-denied / network — render the public bits only */ }
    })();
    return () => { cancelled = true; };
  }, [user?.uid, viewerCanSeePrivate, isSelf]);

  // Close on Escape — small QoL.
  useEffect(() => {
    if (!user) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user, onClose]);

  if (!user) return null;

  const role = user.role || 'instructor';
  const roleLabel = ROLE_LABEL[role] || role;
  const rolePill = ROLE_PILL[role] || ROLE_PILL.instructor;
  const centres = Array.isArray(user.centerIds) && user.centerIds.length > 0
    ? user.centerIds
    : (user.centerId ? [user.centerId] : []);
  const displayName = user.displayName
    || `${user.firstName || ''} ${user.lastName || ''}`.trim()
    || 'User';
  const initials = initialsOf(user);

  // Decide what email / phone to display:
  //  - Admin / self → private sub-doc value (always the truth)
  //  - Anyone else  → public mirror on the user doc, only if user opted in
  const visibleEmail = (viewerCanSeePrivate || isSelf)
    ? (privateContact?.email || user.publicEmail || '')
    : (user.emailPublic ? user.publicEmail : '');
  const visiblePhone = (viewerCanSeePrivate || isSelf)
    ? (privateContact?.phone || user.publicPhone || '')
    : (user.phonePublic ? user.publicPhone : '');
  // True if the value comes from admin access rather than the user's own
  // opt-in — drives the small "(admin view)" hint badge.
  const emailIsPrivateView = viewerCanSeePrivate && !isSelf && !user.emailPublic && !!visibleEmail;
  const phoneIsPrivateView = viewerCanSeePrivate && !isSelf && !user.phonePublic && !!visiblePhone;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Banner with photo */}
        <div className="relative bg-gradient-to-br from-gray-900 via-purple-900 to-red-900 px-6 pt-6 pb-4">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 rounded-full bg-white/10 p-1.5 text-white/80 hover:bg-white/20 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
          <div className="flex items-center gap-4">
            {user.photoURL ? (
              <img
                src={user.photoURL}
                alt={displayName}
                className="h-16 w-16 rounded-full object-cover border-2 border-white/30"
              />
            ) : (
              <div className={`flex h-16 w-16 items-center justify-center rounded-full text-xl font-bold text-white border-2 border-white/30 ${
                role === 'super_admin'      ? 'bg-purple-600'
                  : role === 'owner'        ? 'bg-red-600'
                  : role === 'admin_assistant' ? 'bg-teal-600'
                  : role === 'admin'        ? 'bg-emerald-600'
                  : 'bg-gray-600'
              }`}>
                {initials}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold text-white truncate">{displayName}</h2>
              {user.pronouns && (
                <div className="mt-0.5 text-xs text-white/70">{user.pronouns}</div>
              )}
              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${rolePill}`}>
                  {role === 'super_admin' ? <ShieldCheck size={10} /> : role === 'owner' ? <Shield size={10} /> : <UserCog size={10} />}
                  {roleLabel}
                </span>
                {user.instructorType && user.instructorType !== roleLabel && (
                  <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white">
                    {user.instructorType}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-3">
          {user.bio && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">About</p>
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{user.bio}</p>
            </div>
          )}

          {visibleEmail && (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Mail size={14} className="text-gray-400 shrink-0" />
              <a href={`mailto:${visibleEmail}`} className="truncate text-purple-700 hover:underline">
                {visibleEmail}
              </a>
              {emailIsPrivateView && (
                <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0 text-[10px] font-semibold text-amber-700" title="Visible to you because you're an admin">
                  <Lock size={9} /> admin view
                </span>
              )}
            </div>
          )}

          {visiblePhone && (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Phone size={14} className="text-gray-400 shrink-0" />
              <a href={`tel:${visiblePhone}`} className="truncate text-purple-700 hover:underline">
                {visiblePhone}
              </a>
              {phoneIsPrivateView && (
                <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0 text-[10px] font-semibold text-amber-700" title="Visible to you because you're an admin">
                  <Lock size={9} /> admin view
                </span>
              )}
            </div>
          )}

          {centres.length > 0 && (
            <div className="flex items-start gap-2 text-sm text-gray-700">
              <Building2 size={14} className="text-gray-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <span className="font-medium text-gray-800">
                  {centres.length === 1 ? 'Centre' : 'Centres'}
                </span>
                <span className="ml-1 text-gray-500">{centres.join(', ')}</span>
              </div>
            </div>
          )}

          {!user.bio && (
            <p className="text-xs text-gray-400 italic">
              {displayName.split(' ')[0]} hasn't added a bio yet.
            </p>
          )}

          {/* When the viewer has NO right to see private contact AND the
              target hasn't opted in to share, surface that fact briefly so
              the modal doesn't feel like a blank wall. Keeps the user-
              education load low without nagging admins who already see it. */}
          {!visibleEmail && !visiblePhone && !viewerCanSeePrivate && !isSelf && (
            <p className="text-[11px] text-gray-400 italic flex items-center gap-1">
              <Lock size={10} /> Contact info is private — reach out via your manager.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
