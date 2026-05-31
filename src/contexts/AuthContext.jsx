import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'firebase/auth';
import { doc, setDoc, onSnapshot, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { DEFAULT_CENTER_ID, getActiveCenterId, setActiveCenterId as persistActiveCenterId, getUserCenters } from '../lib/centers';
import { DEFAULT_CENTER_CONFIG, mergeCenterConfig } from '../lib/centerConfig';
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit';
import { buildInitialMembership } from '../lib/centerMembership';

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

  // Subscribe to the signed-in user's profile via onSnapshot so any update
  // anywhere (admin approval, super-admin centre swap, self-update from a
  // different tab, career-plan save) reflects immediately without a sign-out.
  // The previous one-shot getDoc was a silent-bug factory whenever any
  // surface mutated the user doc.
  useEffect(() => {
    let unsubUser = null;
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (unsubUser) { unsubUser(); unsubUser = null; }
      if (u) {
        unsubUser = onSnapshot(
          doc(db, 'users', u.uid),
          (snap) => {
            const p = snap.exists() ? snap.data() : null;
            setProfile(p);
            setLoading(false);
          },
          () => {
            // Permission / network errors — leave existing profile in place
            // and stop the loading spinner so the UI doesn't hang.
            setLoading(false);
          },
        );
      } else {
        setProfile(null);
        setActiveCenterIdState(DEFAULT_CENTER_ID);
        setLoading(false);
      }
    });
    return () => {
      unsubAuth();
      if (unsubUser) unsubUser();
    };
  }, []);

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

  // First-login seed for notificationPreferences. Most staff have never
  // opened the Notification Preferences page, so the shift-reminder cron
  // had nobody to email. On the user's first authenticated load we drop
  // in a sensible default doc (email on, 1 day before) — they can still
  // change it later. We only write when the doc doesn't already exist,
  // so this never clobbers a user who's already customised their prefs.
  useEffect(() => {
    if (!profile?.uid) return;
    let cancelled = false;
    (async () => {
      try {
        const ref = doc(db, 'notificationPreferences', profile.uid);
        const snap = await getDoc(ref);
        if (cancelled || snap.exists()) return;
        await setDoc(ref, {
          userId:             profile.uid,
          userName:           profile.displayName || '',
          centerId:           getActiveCenterId(profile),
          email:              profile.email || '',
          phone:              profile.phone || '',
          emailEnabled:       true,
          smsEnabled:         false,
          reminderTiming:     '1day',
          shiftSwapNotify:    true,
          announcementNotify: true,
          seededAt:           new Date().toISOString(),
          updatedAt:          new Date().toISOString(),
        });
      } catch (err) {
        // Don't break the app if the seed fails — worst case the user
        // just doesn't get default reminders until they visit the prefs
        // page themselves.
        console.warn('[notif-prefs seed] skipped:', err?.message || err);
      }
    })();
    return () => { cancelled = true; };
  }, [profile?.uid, profile?.email, profile?.displayName, profile?.phone, profile]);

  /**
   * Switch which center is active (used by the sidebar center-switcher
   * for super-admins and multi-center staff). Persists the choice in
   * localStorage so it survives a page reload.
   *
   * Super-admin switches are written to the audit log so centre owners
   * can see exactly when the platform operator dropped into their data.
   * Multi-centre staff switches (e.g. an instructor flipping between
   * their two centres) are not logged — that's normal app activity.
   */
  const switchCenter = (newCenterId) => {
    if (!newCenterId) return;
    const prevCenterId = activeCenterId;
    persistActiveCenterId(newCenterId);
    setActiveCenterIdState(newCenterId);
    if (profile?.role === 'super_admin' && newCenterId !== prevCenterId) {
      // Fire-and-forget — see lib/audit.js for why we never await this.
      logAuditEvent(profile, {
        action: AUDIT_ACTIONS.CENTER_SWITCH,
        centerId: newCenterId,
        details: { fromCenterId: prevCenterId || null },
      });
    }
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
    // Operational fields (instructorType, priority, approved, etc.) are
    // now scoped per-centre via `centerMemberships`. The top-level copies
    // are kept as the legacy fallback so reads in any code path that
    // hasn't been migrated yet still produce a sensible value. See
    // src/lib/centerMembership.js for the full rationale.
    const initialMembership = buildInitialMembership({
      instructorType: 'Instructor',
      priority:       2,
      maxDaysPerWeek: 5,
      subRoles:       [],
      guaranteed:     false,
      approved:       false,
    });
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
      // Per-centre operational state. Editing in Centre A no longer
      // changes role / priority / approval in Centre B.
      centerMemberships: {
        [centerId]: initialMembership,
      },
      createdAt: new Date().toISOString(),
    };
    await setDoc(doc(db, 'users', cred.user.uid), profileData);
    setProfile(profileData);
  };

  const logout = async () => {
    await signOut(auth);
    setProfile(null);
  };

  /**
   * Profile is now live via onSnapshot, so callers don't need to manually
   * re-fetch after writing. Kept as a no-op so existing call sites keep
   * working without churn.
   */
  const refreshProfile = async () => {};

  return (
    <AuthContext.Provider value={{
      user,
      profile,
      loading,
      login,
      signup,
      logout,
      resetPassword,
      refreshProfile,
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
