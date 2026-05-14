import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import Logo from '../components/Logo';

const SIGNUP_ERRORS = {
  'auth/email-already-in-use':   'An account with this email already exists.',
  'auth/invalid-email':          'That email address is not valid.',
  'auth/weak-password':          'Password is too weak. Use at least 6 characters.',
  'auth/network-request-failed': 'Network error. Please check your connection and try again.',
};

export default function Signup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [centerId, setCenterId] = useState('');
  const [centers, setCenters] = useState([]);
  const [centersLoading, setCentersLoading] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signup } = useAuth();
  const navigate = useNavigate();

  // Load the list of centers so the new instructor can pick which Mathnasium
  // they're joining. `centers/{id}` is public-readable, so this works even
  // though the user isn't authenticated yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'centers'));
        const list = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
        if (!cancelled) {
          setCenters(list);
          // Pre-select if there's only one center (common early on)
          if (list.length === 1) setCenterId(list[0].id);
        }
      } catch {
        // If the read fails, leave the list empty — the form will show a
        // fallback message and block submission.
      } finally {
        if (!cancelled) setCentersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Please enter your full name.'); return; }
    if (!centerId) { setError('Please choose which Mathnasium center you\'re joining.'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setLoading(true);
    try {
      // Role is intentionally not user-selectable — new accounts are always
      // created as plain "Instructor"; the owner promotes from the admin panel.
      // centerId IS user-selectable: it's the center they're joining. Their
      // account lands in that center's pending-approval queue.
      await signup(email, password, name, { phone, centerId });
      navigate('/');
    } catch (err) {
      const code = err?.code || '';
      setError(SIGNUP_ERRORS[code] || 'Signup failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const selectedCenter = centers.find(c => c.id === centerId);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-red-900 px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 inline-block"><Logo size={72} /></div>
          <h1 className="text-3xl font-bold text-white">Mathnasium</h1>
          <p className="mt-1 text-gray-400">Create Your Instructor Account</p>
        </div>
        <div className="rounded-2xl bg-white p-8 shadow-2xl">
          <h2 className="mb-2 text-xl font-bold text-gray-900">Create Account</h2>
          <p className="mb-6 text-sm text-gray-500">
            Pick your center and sign up. Your account needs approval from that center's owner or admin before you can access the portal.
          </p>
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 border border-red-200">{error}</div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Center picker — first field, since it scopes everything else */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Which Mathnasium are you joining? <span className="text-red-500">*</span>
              </label>
              {centersLoading ? (
                <div className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-400">
                  Loading centers…
                </div>
              ) : centers.length === 0 ? (
                <div className="w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
                  No centers are set up yet. Contact your center owner.
                </div>
              ) : (
                <select
                  value={centerId}
                  onChange={e => setCenterId(e.target.value)}
                  required
                  className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20 bg-white"
                >
                  <option value="">Select your center…</option>
                  {centers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.id}{c.city ? ` — ${c.city}${c.province ? `, ${c.province}` : ''}` : ''}
                    </option>
                  ))}
                </select>
              )}
              {selectedCenter && (
                <p className="mt-1 text-xs text-gray-400">
                  You'll join <span className="font-medium text-gray-600">{selectedCenter.name || selectedCenter.id}</span> — make sure this is correct, it can only be changed by an admin afterward.
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Full Name</label>
              <input type="text"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                placeholder="John Doe" value={name} onChange={e => setName(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
              <input type="email"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Phone (optional)</label>
              <input type="tel"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                placeholder="+1 (604) 555-0123" value={phone} onChange={e => setPhone(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Password</label>
              <input type="password"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                placeholder="At least 6 characters" value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Confirm Password</label>
              <input type="password"
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
                placeholder="Confirm your password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
            </div>
            <button type="submit" disabled={loading || centersLoading || centers.length === 0}
              className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-colors hover:bg-red-700 disabled:opacity-50">
              {loading ? 'Creating Account…' : 'Create Account'}
            </button>
          </form>
          <p className="mt-6 text-center text-sm text-gray-500">
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-red-600 hover:text-red-700">Sign In</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
