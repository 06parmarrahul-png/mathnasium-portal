import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { DEFAULT_CENTER_ID, getActiveCenterId } from '../lib/centers';
import { DEFAULT_CENTER_CONFIG, mergeCenterConfig } from '../lib/centerConfig';

const AuthContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [centerConfig, setCenterConfig] = useState(DEFAULT_CENTER_CONFIG);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setUser(u);
    if (u) {
      const snap = await getDoc(doc(db, 'users', u.uid));
      snap.exists() ? setProfile(snap.data()) : setProfile(null);
    } else {
      setProfile(null);
    }
    setLoading(false);
  }), []);

  // Active center derived from the profile (and optionally localStorage for
  // multi-center staff who picked a non-primary one). Memoized so the
  // subscription effect below only re-fires when the active center changes.
  const activeCenterId = useMemo(() => getActiveCenterId(profile), [profile]);

  // Subscribe to the active center's config doc. Falls back to defaults if
  // the doc doesn't exist (pre-migration state). Re-runs the subscription
  // when the active center changes. activeCenterId is guaranteed truthy by
  // getActiveCenterId() — it always returns at least DEFAULT_CENTER_ID — so
  // we can subscribe unconditionally.
  useEffect(() => (
    onSnapshot(
      doc(db, 'centers', activeCenterId, 'config', 'main'),
      (snap) => {
        setCenterConfig(mergeCenterConfig(snap.exists() ? snap.data() : null));
      },
      () => setCenterConfig(DEFAULT_CENTER_CONFIG),
    )
  ), [activeCenterId]);

  const login = async (email, password) => {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  };

  const resetPassword = async (email) => {
    await sendPasswordResetEmail(auth, email.trim());
  };

  /**
   * signup
   * @param {string} email
   * @param {string} password
   * @param {string} displayName
   * @param {Object} extras - { instructorType, phone }
   */
  const signup = async (email, password, displayName, extras = {}) => {
    const cleanEmail = email.trim();
    const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
    // Always default new accounts to plain "Instructor". The owner promotes
    // people to Lead/Admin/Manager etc. from the admin panel after approval.
    // Don't trust any role value passed in from the signup form.
    //
    // Center assignment: until the signup form has a center-picker dropdown
    // (Phase 5), every new user lands in the default center. The owner can
    // move them to another center by editing centerIds in Manage Users
    // (or, for multi-center staff, add a second center to the array).
    const centerId = extras.centerId || DEFAULT_CENTER_ID;
    const profileData = {
      uid: cred.user.uid,
      email: cleanEmail,
      displayName: displayName.trim(),
      role: 'instructor',
      approved: false,
      // Scheduling fields (set defaults; admin can edit)
      instructorType: 'Instructor',
      priority: 2,           // Admin sets this (1=high, 2=medium, 3=low)
      maxDaysPerWeek: 5,     // Admin can override
      phone: extras.phone || '',
      // Multi-center fields — primary + array (for staff who work at multiple)
      centerId,
      centerIds: [centerId],
      createdAt: new Date().toISOString(),
    };
    await setDoc(doc(db, 'users', cred.user.uid), profileData);
    setProfile(profileData);
  };

  const logout = async () => {
    await signOut(auth);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{
      user,
      profile,
      loading,
      login,
      signup,
      logout,
      resetPassword,
      // Currently-active center for this user. Reads from profile.centerIds[]
      // (or profile.centerId, or DEFAULT_CENTER_ID as fallback). Multi-center
      // staff will be able to switch via a sidebar dropdown in a later phase.
      activeCenterId,
      // Center settings (instructional hours, fixed staff, salary list, etc.)
      // — falls back to defaults if no Firestore doc exists yet.
      centerConfig,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
