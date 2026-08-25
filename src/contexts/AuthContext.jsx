import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'firebase/auth';
import { doc, setDoc, onSnapshot, getDoc, getDocs, query, where, collection, limit } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { DEFAULT_CENTER_ID, getActiveCenterId, setActiveCenterId as persistActiveCenterId, getUserCenters } from '../lib/centers';
import { DEFAULT_CENTER_CONFIG, mergeCenterConfig } from '../lib/centerConfig';
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit';
import { buildInitialMembership, resolveUserForCenter } from '../lib/centerMembership';

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
  //
  // `admin_assistant` is owner-EQUIVALENT for everything centre-level
  // (admin panel, centre settings, payroll, scheduling, users, etc.) but
  // is intentionally NOT included in `isOwner` so they don't appear in
  // the Owners-only cross-centre platformChat. Use `isOwnerLike` for
  // permission gates where AA should be treated the same as the owner.
  const role = profile?.role || null;
  const isSuperAdmin       = role === 'super_admin';
  const isOwner            = role === 'owner';
  const isAdminAssistant   = role === 'admin_assistant';
  const isAdmin            = role === 'admin';   // distinct from owner (no center settings)
  const isInstructor       = role === 'instructor';
  // Centre Directors and Directors of Education are top-of-org staff who
  // run the centre day-to-day. Rahul asked for them to have the SAME
  // access as the owner (see everything, edit everything) without
  // wearing the owner label — that keeps the owner slot uniquely
  // assigned to the person on the lease/franchise agreement while
  // giving directors the tools they actually need.
  //
  // Detection: their staff title lives in centerConfig.fixedStaff keyed
  // by displayName. We check both the modern `role` field there
  // (matches FIXED_SCHEDULES semantics) and the legacy top-level
  // instructorType so a director account created before the fixedStaff
  // migration still passes.
  // Director detection is intentionally permissive — matches ANY of:
  //   1. profile.role === 'director'  (first-class role, easiest path)
  //   2. profile.instructorType is a director title (per-centre or legacy)
  //   3. centerConfig.fixedStaff[displayName].role is a director title
  //      (case-insensitive so 'center director' vs 'Center Director'
  //      doesn't matter)
  // Any one of these = full owner-equivalent access.
  const DIRECTOR_TITLES = new Set([
    'Center Director', 'Centre Director',
    'Dir. of Education', 'Director of Education',
  ]);
  const matchesDirectorTitle = (v) => {
    if (!v || typeof v !== 'string') return false;
    const n = v.trim().toLowerCase();
    for (const t of DIRECTOR_TITLES) if (t.toLowerCase() === n) return true;
    return false;
  };
  const fixedStaffTitle = profile?.displayName
    ? centerConfig?.fixedStaff?.[profile.displayName]?.role
    : null;
  const isDirector = (
    role === 'director' ||
    matchesDirectorTitle(fixedStaffTitle) ||
    matchesDirectorTitle(profile?.instructorType) ||
    matchesDirectorTitle(profile?.centerMemberships?.[activeCenterId]?.instructorType)
  );

  // True for any role that should see what the owner sees at the centre
  // level (owner + AA + super-admin + directors). DON'T use this for
  // platformChat — that one is strictly owner+super_admin.
  const isOwnerLike        = isOwner || isAdminAssistant || isSuperAdmin || isDirector;
  const canSeeAdminPanel    = isSuperAdmin || isOwner || isAdminAssistant || isAdmin || isDirector;
  const canSeeCenterSettings = isSuperAdmin || isOwner || isAdminAssistant || isDirector;
  // Lead is an instructorType, not a top-level role. Check per-centre
  // first (centerMemberships[activeCenterId].instructorType) and fall
  // back to the legacy top-level instructorType field for accounts
  // that haven't been migrated to per-centre membership yet.
  const isLead = (
    profile?.centerMemberships?.[activeCenterId]?.instructorType === 'Lead'
    || profile?.instructorType === 'Lead'
  );
  // Roles allowed to drive the Student Scheduler day-of-day —
  // owners, admin-assistants, plain admins, super-admins, AND lead
  // instructors (per Rahul's request: Leads often run the floor and
  // need to assign instructors / print / check students in).
  const canRunScheduler = canSeeAdminPanel || isLead;
  const userCenters = useMemo(() => getUserCenters(profile), [profile]);

  // Subscribe to the active center's config doc. Falls back to defaults if
  // the doc doesn't exist (pre-migration state). Re-runs the subscription
  // when the active center changes. activeCenterId is guaranteed truthy by
  // getActiveCenterId() — it always returns at least DEFAULT_CENTER_ID — so
  // we can subscribe unconditionally.
  //
  // Depends on BOTH activeCenterId AND the auth user so the listener
  // re-establishes after sign-out → sign-in. Without re-subscribing on
  // auth change, signing out tears down the listener (Firestore rules
  // require isSignedIn for reads) and a subsequent sign-in leaves
  // centerConfig stuck at defaults — the symptom: holidays, salary
  // staff list, etc. appear to "disappear" after re-auth even though
  // they're safely in Firestore. Skipping the subscribe while signed
  // out also avoids a noisy permission-denied error in dev tools.
  useEffect(() => {
    if (!user) {
      // Synchronizing external auth state (signed out) into local state —
      // the sanctioned exception, same rationale as the activeCenterId
      // resync effect above.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCenterConfig(DEFAULT_CENTER_CONFIG);
      return;
    }
    return onSnapshot(
      doc(db, 'centers', activeCenterId, 'config', 'main'),
      (snap) => {
        setCenterConfig(mergeCenterConfig(snap.exists() ? snap.data() : null));
      },
      () => setCenterConfig(DEFAULT_CENTER_CONFIG),
    );
  }, [activeCenterId, user]);

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
    const centerId = extras.centerId || DEFAULT_CENTER_ID;

    // Auto-promote the FIRST signup at a centre to owner+approved.
    // Rationale: until now, every signup defaulted to pending-instructor,
    // requiring a super-admin to promote them manually. That was a hidden
    // step where new-centre owners got stuck (they'd sign up, see a
    // "pending approval" screen, and assume the app was broken). For any
    // centre that already has an approved owner, this branch is skipped
    // and the legacy pending-instructor flow takes over — so existing
    // centres are unaffected and only the actual owner gets auto-promoted.
    let isFirstOwner = false;
    try {
      const ownersSnap = await getDocs(query(
        collection(db, 'users'),
        where('centerIds', 'array-contains', centerId),
        where('role', '==', 'owner'),
        where('approved', '==', true),
        limit(1),
      ));
      isFirstOwner = ownersSnap.empty;
    } catch {
      // If the query fails (rare — rules or transient), fall back to the
      // pending-instructor flow rather than risk auto-granting owner to
      // someone we couldn't verify.
      isFirstOwner = false;
    }

    const role     = isFirstOwner ? 'owner'    : 'instructor';
    const approved = isFirstOwner;
    // Operational fields (instructorType, priority, approved, etc.) are
    // now scoped per-centre via `centerMemberships`. The top-level copies
    // are kept as the legacy fallback so reads in any code path that
    // hasn't been migrated yet still produce a sensible value. See
    // src/lib/centerMembership.js for the full rationale.
    const initialMembership = buildInitialMembership({
      instructorType: isFirstOwner ? 'Owner' : 'Instructor',
      priority:       2,
      maxDaysPerWeek: 5,
      subRoles:       [],
      guaranteed:     false,
      approved,
    });
    const profileData = {
      uid: cred.user.uid,
      email: cleanEmail,
      displayName: displayName.trim(),
      role,
      approved,
      // Scheduling fields (set defaults; admin can edit)
      instructorType: isFirstOwner ? 'Owner' : 'Instructor',
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

  // ─── The signed-in user's capabilities AT THE ACTIVE CENTRE ───────────
  // `subRoles` is a per-centre field: Manage Staff writes it to
  // centerMemberships[centreId].subRoles. Reading profile.subRoles directly
  // gets the stale TOP-LEVEL copy, so ticking "Highschool" for someone had
  // no effect on what they were allowed to claim — the UI showed the new
  // sub-role while every capability check still saw the old list.
  //
  // resolveUserForCenter layers the membership over the top-level values,
  // so this falls back correctly for anyone with no membership row yet.
  // Volunteer is a PER-CENTRE flag on the membership row, not a role:
  // someone can volunteer at Langley and be paid staff elsewhere, and
  // their top-level `role` stays 'instructor' either way. That's why the
  // chat roster was labelling volunteers "Instructor" — it was reading
  // the role, which is correct and also not what anyone means.
  //
  // Volunteers get a deliberately bare-bones portal: their shifts, and
  // not much else. Chat surfaces are gated on this.
  const isVolunteer = useMemo(
    () => resolveUserForCenter(profile, activeCenterId)?.isVolunteer === true,
    [profile, activeCenterId],
  );

  const mySubRoles = useMemo(() => {
    const resolved = resolveUserForCenter(profile, activeCenterId);
    return Array.isArray(resolved?.subRoles) ? resolved.subRoles : [];
  }, [profile, activeCenterId]);

  return (
    <AuthContext.Provider value={{
      user,
      profile,
      mySubRoles,
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
      isDirector,
      isAdminAssistant,
      isOwnerLike,
      isAdmin,
      isInstructor,
      isLead,
      isVolunteer,
      canSeeAdminPanel,
      canSeeCenterSettings,
      canRunScheduler,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
