/**
 * Avatar — small reusable component that prefers a user's uploaded
 * profile picture (photoURL) and falls back to a coloured initials
 * circle when one isn't set.
 *
 * Used everywhere the app shows "this is so-and-so":
 *   - Manage Staff list rows
 *   - Weekly grid left column
 *   - Pending Approval list
 *   - Per-user availability modal
 *   - Auto-scheduler draft cards
 *
 * Profile pictures are stored at profile-pictures/{uid}/* in Firebase
 * Storage. The storage rules allow any signed-in user to read them, so
 * the only reason a photo wouldn't render is if the user simply hasn't
 * uploaded one — in which case the initials circle keeps the row
 * looking like a real avatar instead of a blank gap.
 *
 * Props:
 *   user         — { displayName, email, photoURL, role } shape
 *   size         — diameter in px (default 32)
 *   className    — extra classes for the outer element
 *   roleColored  — if true, colour the initials circle by role (red for
 *                  owner, teal for admin_assistant, etc.). Default true.
 */
import { useState } from 'react';

function initialsOf(user) {
  const name = user?.displayName || user?.email || '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function colourFor(role) {
  switch (role) {
    case 'super_admin':     return 'bg-purple-600';
    case 'owner':           return 'bg-red-600';
    case 'admin_assistant': return 'bg-teal-600';
    case 'admin':           return 'bg-emerald-600';
    default:                return 'bg-gray-500';
  }
}

export default function Avatar({ user, size = 32, className = '', roleColored = true }) {
  // Track image-load failures so we degrade to the initials circle
  // when photoURL points at a broken / expired Storage URL. Without
  // this fallback, a broken URL leaves a permanent broken-image icon
  // wherever the avatar is rendered.
  const [errored, setErrored] = useState(false);
  const photoURL = user?.photoURL && !errored ? user.photoURL : null;
  const px = `${size}px`;
  const style = { width: px, height: px };
  const initials = initialsOf(user);
  const bgClass = roleColored ? colourFor(user?.role) : 'bg-gray-500';
  // Font size scales loosely with diameter so initials don't look
  // squashed on a 24px avatar or stretched on a 64px one.
  const fontPx = Math.max(10, Math.round(size * 0.4));

  if (photoURL) {
    return (
      <img
        src={photoURL}
        alt={user?.displayName || 'Profile picture'}
        onError={() => setErrored(true)}
        style={style}
        className={`shrink-0 rounded-full object-cover ${className}`}
      />
    );
  }
  return (
    <div
      style={{ ...style, fontSize: `${fontPx}px` }}
      className={`shrink-0 flex items-center justify-center rounded-full font-bold text-white ${bgClass} ${className}`}
      aria-label={user?.displayName || 'Profile picture'}
    >
      {initials}
    </div>
  );
}
