# Changes — First Fix Pass

Date: May 7, 2026
Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

This pass took the audit findings and worked through everything that could be fixed without changing the data model in ways that could break existing data, and without introducing risk of breaking what already works in production. Below is the complete list of what changed and why.

---

## Cleanup

**Deleted the duplicate nested project at `mathnasium-portal/`.** A complete second copy of the repo (including its own `.git/`, `node_modules/`, `package-lock.json`) was nested inside the project. Lint was scanning both copies; Vercel could have picked up either; edits to the "real" copy didn't apply to the duplicate. Gone.

**Deleted `src/package.json`.** A stray manifest at the wrong path that listed different dependencies than the root. Caused confusion about which deps were actually installed.

**Deleted stray `.DS_Store` files** throughout `src/`.

**Updated root `package.json`** to include the dependencies the code actually imports:
- `@emailjs/browser` (used in `src/lib/emailService.js`)
- `xlsx` (used in `Admin.jsx` for the Radius timesheet import — was being loaded dynamically from cdnjs.cloudflare.com at runtime, which is fragile)

---

## Security

**Removed self-assigned admin role at signup.** `Signup.jsx` no longer has a "Your Role" dropdown. Every new account is created as `instructorType: 'Instructor'`. The owner can promote to Lead/Host/Admin/etc. from the admin panel after approval. `AuthContext.signup()` now ignores any `instructorType` value passed in, so even a manual API call can't bypass it.

**Fixed null-profile bypass in `ProtectedRoute`.** Previously the check was `if (profile && !profile.approved) → block`, which meant a user whose Firestore profile had been deleted (e.g., after `handleReject`) had `profile === null` and *fell through* the check, getting full app access. The check is now `if (!profile || !profile.approved) → block`. Rejected users now get the pending screen instead of access.

**Added `requireOwner` route guard.** `ProtectedRoute` now takes an optional `requireOwner` prop. The `/admin` route uses it. Non-owners hitting `/admin` (by typing the URL) get a "Not authorized" screen — and crucially, they never mount the Admin component, which means they never subscribe to the `users` / `availability` / `shifts` / `openShifts` / `timeOffRequests` Firestore listeners that Admin sets up. This shrinks the attack surface even if Firestore rules are misconfigured.

**Added `noindex` meta tag** to `index.html` so the portal doesn't show up in Google.

**Added security headers in `vercel.json`:** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (blocks camera/mic/geo/FLoC), and HSTS. Prevents the portal from being iframed onto a phishing site, narrows browser permissions.

**Updated `.gitignore`** to exclude `.env`, `.env.local`, and other env-local variants so future credentials don't accidentally get committed.

---

## Bug Fixes

**Fixed: Chat was showing the oldest 200 messages, not the newest.** `Chat.jsx` previously did `orderBy('createdAt', 'asc'), limit(200)`, which means once chat passed 200 total messages, new ones stopped appearing for everyone. Changed to `orderBy desc + limit 200` and a client-side reverse so the latest 200 always render.

**Fixed: "Today" was computed in UTC.** `Home.jsx` used `new Date().toISOString().split('T')[0]`, which after ~5pm Pacific is already "tomorrow" in UTC. The "Upcoming Shift" card would hide today's shift in the evening. Now uses `format(new Date(), 'yyyy-MM-dd')` from `date-fns` (local time).

**Fixed: shift type was silently dropped on edit.** `Admin.jsx`'s `handleSaveEditShift` only wrote `startTime`/`endTime`/`role` — the `shiftType` (In-Centre / Online / Both) selected in the modal was never saved. Now included in the update.

**Fixed: race conditions on shift claims.** Two instructors clicking "Take This Shift" or "Claim" on the same shift simultaneously could both succeed because both clients read `status: 'open'` from local state and then wrote the update independently. Both `Chat.handleAcceptShift` and `Schedule.handleClaimOpenShift` now use `runTransaction` — they re-read the doc inside the transaction, verify it's still open, and atomically mark it claimed *and* create the linked shift doc. If a second person was a millisecond too late, they get a clear "already taken" message instead of a duplicate.

**Made availability writes idempotent.** Previously `handleSaveAvail` and `handleSaveBulk` did `deleteDoc` (random-ID old doc) then `addDoc` (new random-ID doc). If the second call failed, the user was left with no availability for that day. Now uses a deterministic doc id of `${uid}_${dateStr}` so writing the same (user, date) just overwrites — no race window. `handleSaveBulk` is also now a single batched write per chunk of 200 dates instead of N independent calls. Backwards-compatible: if a legacy random-ID doc exists for the date, it's deleted in the same batch.

**Fixed login error matching.** Was checking `err.message.includes(...)` which mostly missed because Firebase errors expose `err.code`, not message. Now switches on `err.code` with a friendly map covering `auth/invalid-credential`, `auth/wrong-password`, `auth/user-not-found`, `auth/invalid-email`, `auth/user-disabled`, `auth/too-many-requests`, `auth/network-request-failed`. Same applied to signup.

**Login now trims whitespace** on email before sending to Firebase. (Mobile keyboards often add a trailing space.)

**Lint: removed unused imports** (`endOfWeek`, `fixedStaffHoursForDay`, `parseFixedShiftHours`, `selectedProfile`, `openShiftsByDate`, `openCount` in Admin.jsx; `parseISO`, two `err` parameters in Schedule.jsx).

**Lint: fixed `setState` inside `useEffect`** in `WeeklyAvailabilityModal`. The preview-dates list was being computed in an effect via `setPreview(...)` — a documented React anti-pattern that triggers cascading renders. Refactored to derive the value directly with `useMemo`.

---

## Features

**Forgot Password flow on Login.** Login screen now has a "Forgot password?" link that switches the form into reset mode and uses Firebase's `sendPasswordResetEmail`. For privacy, "user not found" returns the same success message as a real send so the form doesn't leak which emails have accounts. Also exposed `resetPassword(email)` from `AuthContext` for any future use.

**404 page.** Hitting an unknown URL used to render a blank page. Now shows a friendly NotFound component with a link back to Home. (`<Route path="*" element={<NotFound />} />`.)

**Root error boundary.** A new `<ErrorBoundary>` wraps the whole app in `App.jsx`. Any render error in any page now shows a "Something went wrong" screen with the error message and a Reload button instead of a blank white page. Errors are logged to the console for debugging.

---

## Performance

**Home.jsx subscribes only to the user's own shifts.** Previously the Home component fetched the entire `shifts` collection (every shift for every instructor, every day, forever). Now uses `where('userId', '==', profile.uid)` so each user only receives their own shifts. Equality-only filter so it doesn't require a new Firestore composite index.

**`SALARY_STAFF` set is now memoized** so React doesn't see it as a new value every render (silenced an exhaustive-deps warning correctly rather than ignoring it).

---

## Polish

**`index.html`:** title is now `Mathnasium Langley · Instructor Portal` instead of `mathnasium-portal`. Added meta description, theme color (`#dc2626` to match the brand red), and `noindex`.

**Announcements use `serverTimestamp()`** for `createdAt`. The old `date: new Date().toISOString()` (client clock) is kept for backward-compatible `orderBy` — but new posts also store `createdAt` from Firestore's server clock for accurate ordering. Title and text are also trimmed on save.

**README.md** is now a real readme instead of the Vite boilerplate. Documents the stack, layout, Firestore collections, security model, deploy notes, and common commands.

**ProtectedRoute pending screen** now offers a "Sign Out" button alongside "Refresh Status" so a user can switch accounts without manually clearing storage.

**Login form** has proper `autoComplete` attributes on email/password fields for better browser/password-manager integration.

**Trims `displayName` and `email`** on signup so leading/trailing whitespace doesn't sneak into Firestore.

---

## What's left from the audit

Untouched on purpose, mostly because they need broader Firestore-rules work or larger refactors:

- **#3 (auth-account deletion on reject)** — needs a Cloud Function with admin SDK; can't be done from the client.
- **#10 (full listener filtering)** — Home is now filtered, but Schedule.jsx and Admin.jsx still load the full collections. Filtering them properly affects how the calendar grids render and needs more careful staging.
- **#16 (replace `alert`/`confirm`)** — bigger UX change; safe to do but takes a session of its own.
- **#19, #20 (Radius column index hardcoding, fuzzy name matching)** — payroll-comparison improvements; needs a real Radius export to test against.
- **#23 (time-off cancels conflicting shifts)** — real workflow change. Want to confirm with you what should happen — delete the shift, convert to open shift, or just warn the admin?
- **#25 (refactor Admin/Schedule into smaller files)** — biggest item; saved for last because it's cosmetic, not functional.
- **#33 (move fixed-staff list to Firestore)** — nice but adds an admin UI.
- **#36 (tests)** — set up Vitest later.

I'd recommend the next pass focus on Firestore rules (highest remaining security leverage) and then the listener-filtering cleanup. Tell me when you're ready and I'll do those next.
