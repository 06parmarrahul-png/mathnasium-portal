import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import RatioLogo from '../components/RatioLogo';

const FRIENDLY_ERRORS = {
  'auth/invalid-credential':  'Invalid email or password.',
  'auth/wrong-password':      'Invalid email or password.',
  'auth/user-not-found':      'No account found with this email.',
  'auth/invalid-email':       'That email address is not valid.',
  'auth/user-disabled':       'This account has been disabled. Contact the center owner.',
  'auth/too-many-requests':   'Too many failed attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed': 'Network error. Please check your connection and try again.',
};

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      const code = err?.code || '';
      setError(FRIENDLY_ERRORS[code] || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setError('');
    if (!email.trim()) {
      setError('Enter your email address above first.');
      return;
    }
    setLoading(true);
    try {
      // Route through our own /api/send-password-reset (Resend-backed)
      // instead of Firebase's default sender. Firebase's reset emails
      // come from noreply@<project>.firebaseapp.com and tend to land
      // in spam; this version arrives from the verified Resend domain
      // and reliably hits the inbox.
      const r = await fetch('/api/send-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          continueUrl: window.location.origin + '/login',
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `Reset request failed (${r.status}).`);
      }
      // Endpoint deliberately returns success for unknown emails too —
      // we just trust it and show the same confirmation either way.
      setResetSent(true);
    } catch (err) {
      setError(err?.message || 'Could not send reset email. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-red-900 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 inline-block"><RatioLogo size={72} /></div>
          {/* No centre is known yet at sign-in time — the user picks
              theirs in the form below (or has one from their existing
              account). Keep the header centre-neutral. */}
          <h1 className="text-3xl font-bold text-white">Ratio Solved</h1>
          <p className="mt-1 text-gray-400">Staff Scheduling</p>
        </div>
        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          <h2 className="mb-6 text-xl font-bold text-gray-900">{resetMode ? 'Reset Password' : 'Sign In'}</h2>
          {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 border border-red-200">{error}</div>}
          {resetSent && (
            <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700 border border-green-200">
              If an account exists for that email, a password reset link has been sent. Check your inbox.
            </div>
          )}

          {!resetMode ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="email"
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                  placeholder="you@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">Password</label>
                  <button
                    type="button"
                    onClick={() => { setResetMode(true); setError(''); setResetSent(false); }}
                    className="text-xs font-medium text-red-600 hover:text-red-700"
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  type="password"
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                  placeholder="Enter your password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <button type="submit" disabled={loading} className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-red-700 disabled:opacity-50">
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleReset} className="space-y-4">
              <p className="text-sm text-gray-500">Enter your email address and we'll send you a link to reset your password.</p>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="email"
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                  placeholder="you@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={loading} className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-red-700 disabled:opacity-50">
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
                <button
                  type="button"
                  onClick={() => { setResetMode(false); setError(''); setResetSent(false); }}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  Back to Sign In
                </button>
              </div>
            </form>
          )}

          {!resetMode && (
            <p className="mt-6 text-center text-sm text-gray-500">
              Don't have an account?{' '}
              <Link to="/signup" className="font-medium text-red-600 hover:text-red-700">Create Account</Link>
            </p>
          )}
        </div>

        {/* Ratio brand tagline — small, muted, doesn't compete with the
            sign-in form but lets the brand promise live somewhere
            visible on the way in. */}
        <p className="mt-6 text-center text-xs text-gray-400 leading-snug">
          More time with students. More time with family. Less time on everything else.
        </p>
        <p className="mt-1.5 text-center text-[10px] uppercase tracking-[0.2em] text-gray-500">
          Powered by Ratio
        </p>
      </div>
    </div>
  );
}
