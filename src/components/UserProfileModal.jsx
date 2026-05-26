import { useEffect } from 'react';
import {
  X, Mail, Building2, Shield, ShieldCheck, UserCog,
} from 'lucide-react';

/**
 * UserProfileModal — a lightweight viewer for someone else's profile.
 *
 * Opens when a teammate clicks a name / avatar in chat surfaces (Chat,
 * Leadership Chat) or admin lists (Manage Users, Manage Roles). Shows
 * the picture, name, role badge, centre membership, and bio.
 *
 * Pass the full user object — every caller already has it loaded.
 * No extra Firestore read at open time.
 *
 *   <UserProfileModal user={someUser} onClose={() => ...} />
 *
 * The bio is the field someone can edit on /account. If it's empty
 * we hide the section so the modal stays tight.
 */

const ROLE_LABEL = {
  super_admin: 'Enterprise',
  owner:       'Owner',
  admin:       'Admin',
  instructor:  'Instructor',
};

const ROLE_PILL = {
  super_admin: 'bg-purple-100 text-purple-700 border-purple-200',
  owner:       'bg-red-100 text-red-700 border-red-200',
  admin:       'bg-emerald-100 text-emerald-700 border-emerald-200',
  instructor:  'bg-gray-100 text-gray-600 border-gray-200',
};

function initialsOf(user) {
  const name = user?.displayName || `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
  if (!name) return '?';
  return name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

export default function UserProfileModal({ user, onClose }) {
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
    || user.email
    || 'User';
  const initials = initialsOf(user);

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
                role === 'super_admin' ? 'bg-purple-600'
                  : role === 'owner'   ? 'bg-red-600'
                  : role === 'admin'   ? 'bg-emerald-600'
                  : 'bg-gray-600'
              }`}>
                {initials}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-bold text-white truncate">{displayName}</h2>
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

          {user.email && (
            <div className="flex items-center gap-2 text-sm text-gray-700">
              <Mail size={14} className="text-gray-400 shrink-0" />
              <a href={`mailto:${user.email}`} className="truncate text-purple-700 hover:underline">
                {user.email}
              </a>
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
        </div>
      </div>
    </div>
  );
}
