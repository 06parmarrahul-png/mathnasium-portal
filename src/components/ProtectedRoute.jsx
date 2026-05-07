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

export default function ProtectedRoute({ children, requireOwner = false }) {
  const { user, profile, loading, logout } = useAuth();

  if (loading) return <LoadingScreen />;

  if (!user) return <Navigate to="/login" />;

  // Treat a missing profile the same as un-approved. Previously a deleted
  // (rejected) user with profile === null fell through this check entirely
  // and was granted access to the app.
  if (!profile || !profile.approved) {
    return <PendingScreen logout={logout} />;
  }

  if (requireOwner && profile.role !== 'owner') {
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

  return children;
}
