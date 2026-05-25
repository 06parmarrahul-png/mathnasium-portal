import { useEffect, useRef, useState } from 'react';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import {
  reauthenticateWithCredential, EmailAuthProvider,
  updatePassword, verifyBeforeUpdateEmail,
} from 'firebase/auth';
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import { db, storage } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast, confirmDialog } from '../lib/notify';
import {
  UserCog, Mail, Lock, Image as ImageIcon, Trash2, Save, AlertTriangle,
  CheckCircle2, ShieldAlert,
} from 'lucide-react';

/**
 * Account Details — the signed-in user's self-service profile page.
 *
 * Sections:
 *  - Profile picture (Firebase Storage upload, removable)
 *  - Personal info (firstName, lastName, bio)
 *  - Email (verifyBeforeUpdateEmail — sends a verification link to the
 *    new address; the auth-level change happens when they click it)
 *  - Password (re-auth with current password, then updatePassword)
 *
 * All operations are client-side Firebase Auth + Firestore. No backend.
 *
 * Notes:
 *  - displayName stays in sync with firstName + lastName so existing
 *    surfaces that read displayName don't change behaviour.
 *  - Email-change actually flips the user's auth email only after
 *    verification; we keep the Firestore email field in sync at the
 *    moment they initiate. If they don't click the verification link,
 *    they can still sign in with the OLD email until they do.
 */

const MAX_BIO_LEN = 280;
const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4 MB

function splitDisplayName(displayName) {
  const parts = (displayName || '').trim().split(/\s+/);
  return {
    firstName: parts[0] || '',
    lastName:  parts.slice(1).join(' ') || '',
  };
}

export default function AccountDetails() {
  const { profile, user } = useAuth();

  // Seed the local form from the live profile. The profile is live via
  // onSnapshot so any change anywhere (e.g. an admin touched their
  // role) reactively reflects here.
  const seed = () => {
    const split = splitDisplayName(profile?.displayName);
    return {
      firstName: profile?.firstName ?? split.firstName,
      lastName:  profile?.lastName  ?? split.lastName,
      bio:       profile?.bio || '',
    };
  };

  const [form, setForm] = useState(seed);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');

  // Re-seed if the upstream profile changes while the page is open
  // (e.g. another tab edited the user, an admin updated something).
  useEffect(() => {
    setForm(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.displayName, profile?.firstName, profile?.lastName, profile?.bio]);

  const dirty = (
    form.firstName !== (profile?.firstName ?? splitDisplayName(profile?.displayName).firstName) ||
    form.lastName  !== (profile?.lastName  ?? splitDisplayName(profile?.displayName).lastName) ||
    form.bio       !== (profile?.bio || '')
  );

  const handleSaveProfile = async () => {
    if (!profile?.uid) return;
    setProfileError('');
    const first = form.firstName.trim();
    const last  = form.lastName.trim();
    if (!first) { setProfileError('First name is required.'); return; }
    setSavingProfile(true);
    try {
      await updateDoc(doc(db, 'users', profile.uid), {
        firstName: first,
        lastName:  last,
        displayName: [first, last].filter(Boolean).join(' '),
        bio: form.bio.trim().slice(0, MAX_BIO_LEN),
        profileUpdatedAt: serverTimestamp(),
      });
      toast.success('Profile updated.');
    } catch (err) {
      setProfileError(err?.message || 'Failed to save profile.');
    } finally {
      setSavingProfile(false);
    }
  };

  if (!profile) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not signed in</h2>
        <p className="text-sm text-gray-500">Sign in to manage your account.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-purple-100 p-2.5 text-purple-700"><UserCog size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Account Details</h1>
          <p className="text-sm text-gray-500">Manage how you appear and how you sign in.</p>
        </div>
      </div>

      {/* Profile picture */}
      <ProfilePictureCard profile={profile} />

      {/* Personal info */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <UserCog size={16} className="text-purple-600" />
          <h2 className="font-semibold text-gray-900">Personal Info</h2>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">First name</label>
            <input
              type="text"
              value={form.firstName}
              onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Last name</label>
            <input
              type="text"
              value={form.lastName}
              onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <label className="text-xs font-semibold uppercase tracking-wide text-gray-500">Bio</label>
            <span className="text-[11px] text-gray-400">
              {form.bio.length}/{MAX_BIO_LEN}
            </span>
          </div>
          <textarea
            rows={3}
            value={form.bio}
            onChange={e => setForm(f => ({ ...f, bio: e.target.value.slice(0, MAX_BIO_LEN) }))}
            placeholder="A short blurb your team will see when they click on you — what you teach, what you're good at, what's a good question to ask you."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none resize-none"
          />
        </div>

        {profileError && (
          <p className="mt-3 flex items-center gap-1 text-xs text-red-600">
            <AlertTriangle size={12} /> {profileError}
          </p>
        )}

        <div className="mt-4">
          <button
            onClick={handleSaveProfile}
            disabled={!dirty || savingProfile}
            className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
          >
            <Save size={14} />
            {savingProfile ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      {/* Email */}
      <EmailCard profile={profile} user={user} />

      {/* Password */}
      <PasswordCard profile={profile} user={user} />
    </div>
  );
}

// ─── Profile picture card ──────────────────────────────────────────────────

function ProfilePictureCard({ profile }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handlePick = () => fileRef.current?.click();

  const handleUpload = async (file) => {
    if (!file || !profile?.uid) return;
    setError('');
    if (!file.type.startsWith('image/')) {
      setError('Pick an image file.'); return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError('Image must be under 4 MB.'); return;
    }
    setUploading(true);
    try {
      // Stable path per user — uploading overwrites the previous one,
      // so we don't accumulate orphan files.
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `profile-pictures/${profile.uid}/avatar.${ext}`;
      const ref = storageRef(storage, path);
      await uploadBytes(ref, file, { contentType: file.type });
      const url = await getDownloadURL(ref);
      await updateDoc(doc(db, 'users', profile.uid), {
        photoURL: url,
        photoPath: path,
        profileUpdatedAt: serverTimestamp(),
      });
      toast.success('Profile picture updated.');
    } catch (err) {
      setError(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async () => {
    if (!profile?.uid || !profile?.photoURL) return;
    const ok = await confirmDialog({
      title: 'Remove profile picture?',
      message: 'Your initials will be shown instead.',
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setError('');
    try {
      // Best-effort delete the underlying object so we don't leave
      // orphans in Storage. The user doc is the source of truth — if
      // delete fails the URL is what counts.
      if (profile.photoPath) {
        try { await deleteObject(storageRef(storage, profile.photoPath)); }
        catch { /* ignore — file might already be gone */ }
      }
      await updateDoc(doc(db, 'users', profile.uid), {
        photoURL: null,
        photoPath: null,
        profileUpdatedAt: serverTimestamp(),
      });
      toast.success('Profile picture removed.');
    } catch (err) {
      setError(err?.message || 'Failed to remove picture.');
    }
  };

  const initials = (
    (profile?.firstName?.[0] || profile?.displayName?.[0] || '?')
    + (profile?.lastName?.[0] || '')
  ).toUpperCase();

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <ImageIcon size={16} className="text-purple-600" />
        <h2 className="font-semibold text-gray-900">Profile Picture</h2>
      </div>

      <div className="flex items-center gap-5">
        <div className="shrink-0">
          {profile?.photoURL ? (
            <img
              src={profile.photoURL}
              alt={profile.displayName || 'Profile picture'}
              className="h-20 w-20 rounded-full object-cover border-2 border-gray-200"
            />
          ) : (
            <div className="h-20 w-20 rounded-full flex items-center justify-center bg-red-600 text-white text-2xl font-bold">
              {initials}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-gray-700">
            {profile?.photoURL ? 'Your team sees this picture next to your name.' : 'Upload a picture and your team will see it next to your name in chat, the shift board, and Manage Users.'}
          </p>
          <p className="mt-1 text-xs text-gray-400">PNG / JPG / WebP. Under 4 MB.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={handlePick}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
            >
              <ImageIcon size={14} />
              {uploading ? 'Uploading…' : (profile?.photoURL ? 'Change picture' : 'Upload picture')}
            </button>
            {profile?.photoURL && (
              <button
                onClick={handleRemove}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
              >
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>
          {error && (
            <p className="mt-2 flex items-center gap-1 text-xs text-red-600">
              <AlertTriangle size={12} /> {error}
            </p>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ─── Email card ────────────────────────────────────────────────────────────

function EmailCard({ profile, user }) {
  const [editing, setEditing] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleChange = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!newEmail.trim() || !currentPassword) {
      setError('Enter your new email and current password.');
      return;
    }
    if (newEmail.trim().toLowerCase() === (profile?.email || '').toLowerCase()) {
      setError('That\'s already your email.');
      return;
    }
    setBusy(true);
    try {
      // Re-auth — Firebase requires recent auth for email changes.
      const credential = EmailAuthProvider.credential(user.email, currentPassword);
      await reauthenticateWithCredential(user, credential);

      // Send verification link to the new address. Firebase Auth's email
      // only flips after they click it.
      await verifyBeforeUpdateEmail(user, newEmail.trim());

      // Keep the Firestore doc in sync optimistically. If they never
      // verify, the auth email stays old; the Firestore email shows
      // new. Worst-case the user (or an admin) corrects it manually.
      await updateDoc(doc(db, 'users', profile.uid), {
        email: newEmail.trim(),
        emailChangePendingAt: serverTimestamp(),
      });

      setSuccess(`Verification email sent to ${newEmail.trim()}. Click the link there to finish the change, then sign in with the new address.`);
      setEditing(false);
      setNewEmail('');
      setCurrentPassword('');
    } catch (err) {
      const code = err?.code || '';
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setError('Current password is incorrect.');
      } else if (code === 'auth/invalid-email') {
        setError('That email address is not valid.');
      } else if (code === 'auth/email-already-in-use') {
        setError('Another account already uses that email.');
      } else if (code === 'auth/requires-recent-login') {
        setError('Sign out and sign back in, then try again.');
      } else {
        setError(err?.message || 'Failed to update email.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Mail size={16} className="text-purple-600" />
        <h2 className="font-semibold text-gray-900">Email</h2>
      </div>

      <p className="text-sm text-gray-700">
        Current email: <span className="font-mono text-gray-900">{profile?.email || user?.email || '—'}</span>
      </p>

      {success && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      {!editing ? (
        <button
          onClick={() => { setEditing(true); setError(''); setSuccess(''); }}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          Change email
        </button>
      ) : (
        <form onSubmit={handleChange} className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">New email</label>
            <input
              type="email"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              autoComplete="email"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Current password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
              required
            />
            <p className="mt-1 text-xs text-gray-400">Required to confirm it's really you.</p>
          </div>
          {error && (
            <p className="flex items-center gap-1 text-xs text-red-600">
              <AlertTriangle size={12} /> {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send verification'}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setError(''); setNewEmail(''); setCurrentPassword(''); }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── Password card ─────────────────────────────────────────────────────────

function PasswordCard({ profile, user }) {
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleChange = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!current || !next || !confirm) {
      setError('Fill every field.'); return;
    }
    if (next !== confirm) {
      setError('New password and confirmation don\'t match.'); return;
    }
    if (next.length < 8) {
      setError('Use at least 8 characters for the new password.'); return;
    }
    setBusy(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, current);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, next);
      await updateDoc(doc(db, 'users', profile.uid), {
        passwordChangedAt: serverTimestamp(),
      });
      setSuccess('Password updated.');
      setEditing(false);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      const code = err?.code || '';
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setError('Current password is incorrect.');
      } else if (code === 'auth/weak-password') {
        setError('That new password is too weak. Try a longer one.');
      } else if (code === 'auth/requires-recent-login') {
        setError('Sign out and sign back in, then try again.');
      } else {
        setError(err?.message || 'Failed to update password.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Lock size={16} className="text-purple-600" />
        <h2 className="font-semibold text-gray-900">Password</h2>
      </div>

      <p className="text-sm text-gray-700">
        Use a password you don't use anywhere else. At least 8 characters.
      </p>

      {success && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-800">
          <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      {!editing ? (
        <button
          onClick={() => { setEditing(true); setError(''); setSuccess(''); }}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
        >
          Change password
        </button>
      ) : (
        <form onSubmit={handleChange} className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Current password</label>
            <input
              type="password"
              value={current}
              onChange={e => setCurrent(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
              required
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">New password</label>
              <input
                type="password"
                value={next}
                onChange={e => setNext(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Confirm new password</label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                autoComplete="new-password"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-purple-500 focus:outline-none"
                required
              />
            </div>
          </div>
          {error && (
            <p className="flex items-center gap-1 text-xs text-red-600">
              <AlertTriangle size={12} /> {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {busy ? 'Updating…' : 'Update password'}
            </button>
            <button
              type="button"
              onClick={() => { setEditing(false); setError(''); setCurrent(''); setNext(''); setConfirm(''); }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
