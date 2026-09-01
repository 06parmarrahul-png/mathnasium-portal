import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

function PendingScreen({ logout }) {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="mx-4 max-w-md rounded-xl bg-white p-8 shadow-lg text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-100">
          <svg className="h-8 w-8 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <h2 className="mb-2 text-xl font-bold text-gray-900">Account Pending Approval</h2>
        <p className="mb-4 text-sm text-gray-500">Your account is awaiting approval from the center owner. You'll be able to access the portal once approved.</p>
        <div className="flex gap-2 justify-center">
          <button onClick={() => window.location.reload()} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">Refresh Status</button>
          {logout && (
            <button onClick={logout} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Sign Out</button>
          )}
        </div>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-3">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-red-600 border-t-transparent" />
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    </div>
  );
}

function NotAuthorized() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="mx-4 max-w-md rounded-xl bg-white p-8 shadow-lg text-center">
        <h2 className="mb-2 text-xl font-bold text-gray-900">Not authorized</h2>
        <p className="text-sm text-gray-500">You don't have access to this page.</p>
        <a href="/" className="mt-4 inline-block rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">Back to Home</a>
      </div>
    </div>
  );
}

function NotForVolunteers() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="mx-4 max-w-md rounded-xl bg-white p-8 shadow-lg text-center">
        <h2 className="mb-2 text-xl font-bold text-gray-900">Not part of your access</h2>
        <p className="text-sm text-gray-500">
          Volunteer accounts have a simplified portal — your schedule and shifts.
          Team messaging isn&rsquo;t included. Speak to a centre admin if you need something from it.
        </p>
        <a href="/" className="mt-4 inline-block rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">Back to Home</a>
      </div>
    </div>
  );
}

/**
 * Shown on the Shift Board to anyone who can't pick up or trade shifts.
 * Copy differs by reason: a trainee is shadowing (temporary), a
 * volunteer works what they're given (ongoing).
 */
function NotForShiftTakers({ isTraining }) {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="mx-4 max-w-md rounded-xl bg-white p-8 shadow-lg text-center">
        <h2 className="mb-2 text-xl font-bold text-gray-900">Not part of your access</h2>
        <p className="text-sm text-gray-500">
          {isTraining
            ? 'While you’re in training you work alongside an instructor rather than picking up or trading shifts. Your own schedule is on the Schedule page — speak to a centre admin if something needs to change.'
            : 'Volunteer accounts work the shifts they’re given rather than claiming or swapping. Your schedule is on the Schedule page — request time off there if you can’t make one.'}
        </p>
        <a href="/" className="mt-4 inline-block rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">Back to Home</a>
      </div>
    </div>
  );
}

/**
 * Route guard.
 *
 * Every gate here resolves to a PERMISSION from src/lib/roles.js, the same
 * set AuthContext uses for the nav. That matters: this file used to make
 * its own judgement from `profile.role` alone, so it disagreed with
 * AuthContext about director-titled accounts — the sidebar linked them to
 * the Admin Panel and this guard then showed them "Not authorized".
 * One source, one answer.
 *
 * Props (names kept for backwards-compat with the existing routes):
 *   requireOwner      → requires `admin.panel`; really means "requires
 *                       admin-panel access", not literally the owner.
 *   allowOps          → softens requireOwner to `admin.operations`, the
 *                       "operational admin" tier that Managers and Hosts
 *                       hold. Set on the admin panel, Staffing Board,
 *                       Inventory and Availability Log only — the
 *                       PII/analytics routes (Leads, Case Study, Apptoto,
 *                       Supply & Demand) and Centre Settings must NOT set
 *                       it, so Manager/Host stay out of those.
 *   requireSuperAdmin → requires `roles.manage` (Enterprise only).
 *   blockVolunteers   → requires `chat.access`.
 *   requireShiftTaking→ requires `shifts.take`.
 *   permission        → requires that permission id outright. Prefer this
 *                       for new routes; the props above are the old names
 *                       kept so the existing route table didn't have to be
 *                       rewritten in the same change.
 */
export default function ProtectedRoute({ children, requireOwner = false, requireSuperAdmin = false, blockVolunteers = false, requireShiftTaking = false, allowOps = false, permission = null }) {
  const { user, profile, loading, logout, isTraining, can } = useAuth();

  if (loading) return <LoadingScreen />;

  if (!user) return <Navigate to="/login" />;

  // Treat a missing profile the same as un-approved. Previously a deleted
  // (rejected) user with profile === null fell through this check entirely
  // and was granted access to the app.
  if (!profile || !profile.approved) {
    return <PendingScreen logout={logout} />;
  }

  // Volunteers are hidden from these surfaces in the sidebar too, but the
  // nav only hides links — this is what actually stops a typed URL.
  if (blockVolunteers && !can('chat.access')) {
    return <NotForVolunteers />;
  }

  // Shift Board is entirely about claiming and swapping, so anyone who
  // can't do either has no reason to be here. Covers volunteers AND
  // trainees — see the employment-state rules in src/lib/roles.js.
  if (requireShiftTaking && !can('shifts.take')) {
    return <NotForShiftTakers isTraining={isTraining} />;
  }

  if (requireSuperAdmin && !can('roles.manage')) {
    return <NotAuthorized />;
  }

  // allowOps drops the bar from admin.panel to admin.operations. Everyone
  // with admin.panel also has admin.operations (resolvePermissions implies
  // it), so the softened check is a strict superset — never a narrowing.
  if (requireOwner && !can(allowOps ? 'admin.operations' : 'admin.panel')) {
    return <NotAuthorized />;
  }

  if (permission && !can(permission)) {
    return <NotAuthorized />;
  }

  return children;
}
