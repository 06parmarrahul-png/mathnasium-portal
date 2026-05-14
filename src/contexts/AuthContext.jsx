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
import { DEFAULT_CENTER_ID, getActiveCenterId, setActiveCenterId as persistActiveCenterId, getUserCenters } from '../lib/centers';
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
  // activeCenterId is real state so switchCenter() can reactively re-fetch
  // every collection. Initialized from profile + localStorage on mount.
  const [activeCenterId, setActiveCenterIdState] = useState(DEFAULT_CENTER_ID);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setUser(u);
    if (u) {
      const snap = await getDoc(doc(db, 'users', u.uid));
      const p = snap.exists() ? snap.data() : null;
      setProfile(p);
      setActiveCenterIdState(getActiveCenterId(p));
    } else {
      setProfile(null);
      setActiveCenterIdState(DEFAULT_CENTER_ID);
    }
    setLoading(false);
  }), []);

  // Resync active center if profile changes (e.g., signup just wrote it,
  // or admin updated their centerIds). Synchronizing external state
  // (profile from Firestore) into local state is the standard reason
  // to setState inside an effect — eslint's warning here is overly cautious.
  useEffect(() => {
    if (!profile) return;
    const next = getActiveCenterId(profile);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveCenterIdState((cur) => cur === next ? cur : next);
  }, [profile]);

  /**
   * Switch which center is active (used by the sidebar center-switcher
   * for super-admins and multi-center staff). Persists the choice in
   * localStorage so it survives a page reload.
   */
  const switchCenter = (newCenterId) => {
    if (!newCenterId) return;
    persistActiveCenterId(newCenterId);
    setActiveCenterIdState(newCenterId);
  };

  // Convenience helpers for role checks (read by routes / components).
  const role = profile?.role || null;
  const isSuperAdmin = role === 'super_admin';
  const isOwner      = role === 'owner';
  const isAdmin      = role === 'admin';   // distinct from owner (no center settings)
  const isInstructor = role === 'instructor';
  const canSeeAdminPanel    = isSuperAdmin || isOwner || isAdmin;
  const canSeeCenterSettings = isSuperAdmin || isOwner;
  const userCenters = useMemo(() => getUserCenters(profile), [profile]);

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
      // Currently-active center for this user. Backed by real state so
      // switchCenter() reactively re-fetches every page's data.
      activeCenterId,
      switchCenter,
      userCenters,
      // Center settings (instructional hours, fixed staff, etc.)
      centerConfig,
      // Role helpers — read these in components instead of comparing
      // profile.role strings everywhere.
      role,
      isSuperAdmin,
      isOwner,
      isAdmin,
      isInstructor,
      canSeeAdminPanel,
      canSeeCenterSettings,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
