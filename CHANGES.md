# Changes Log

## Pass 6 — Auto-scheduler clamps to instructional hours + cleaner draft UI

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

Two issues fixed: (1) instructors with "Full Day" availability were getting scheduled for the entire 10-hour window instead of just teaching hours, and (2) the auto-scheduler's draft preview was visually noisy and hard to scan.

### Issue 1 — Shifts now clamp to instructional hours

The auto-scheduler used to take an instructor's submitted availability and use that *as* the scheduled shift. Someone who said "I'm free 10 AM – 8 PM" would be put on the schedule for 10 hours. That's wrong — availability is "I'm here for any kind of work"; the *scheduled shift* should only be the teaching window.

A new `INSTRUCTIONAL_HOURS` map at the top of `lib/scheduler.js` defines the per-day teaching window:

| Day        | Teaching window     |
|------------|---------------------|
| Mon–Thu    | 3:00 PM – 7:00 PM   |
| Friday     | 3:00 PM – 6:00 PM   |
| Saturday   | 10:00 AM – 2:00 PM  |

A new `clampToInstructionalHours()` helper intersects the user's availability with this window. So 10 AM – 8 PM on a Monday becomes a 3 PM – 7 PM shift; 4 PM – 9 PM becomes a 4 PM – 7 PM shift.

**Who gets clamped:**
- ✅ **Instructor** roles — clamped (they're teaching, not doing admin time)
- ✅ **Lead** roles — clamped (same reason)
- ✅ **Host (auto-promoted to Instructor)** — clamped (they're teaching that day)
- ❌ **Host (regular)** — NOT clamped (admin work happens outside teaching hours, that's the point)
- ❌ **Online Instructor** — NOT clamped (online sessions are flex hours)

If real teaching hours change, edit the `INSTRUCTIONAL_HOURS` map and everyone's shifts adjust automatically. (Two separate maps now: `Schedule.jsx`'s `FULL_DAY_BY_DOW` is the *availability* full-day range; `scheduler.js`'s `INSTRUCTIONAL_HOURS` is the *scheduled shift* teaching window.)

### Issue 2 — Cleaner draft schedule UI

The day-by-day list of pills got cramped fast — at 10+ instructors per day, names ran into each other and shift times were hard to spot. New layout:

**Each day is a card.** Headers got an upgrade:
- Day name in bold
- Status pill: green "Staffed" when good, red "Low staff — need 2 more" when short (replaces the old red `LOW STAFF` chip — gives the actual number that's missing)
- Compact instructor / total counts
- Edit button is always visible on hover, not floating

**Roster is a 2/3-column responsive grid of mini-cards.** Each card shows:
- Avatar circle, colored by sub-role (lime / teal / indigo) — instant scan for who's covering what
- Name in bold
- Shift time below (now correctly clamped to instructional hours)
- Right-side mini-badges: amber "HOST" / indigo "ONLINE" / sub-role single-letter pill (E/H/O)

**Sorted by role.** Instructor/Lead first, then Host, then Online — so the per-day card naturally reads like a roster (frontline staff at the top).

**Edit mode** got the same upgrade: removable chips inherit their sub-role color, and the "Add from approved staff" buttons each show a colored dot for that user's primary sub-role so admin can preview who they're adding.

**Low-staff days** now have a subtle red left-edge accent bar and a soft red background tint, instead of a heavy red wash that fights with the rest of the UI.

### Files touched

```
mod:   src/lib/scheduler.js   (INSTRUCTIONAL_HOURS map, clampToInstructionalHours
                                helper, applied at all four assignment sites:
                                inCentre first pass, inCentre second pass,
                                Host promoted, plus Host regular kept
                                unclamped)
mod:   src/pages/Admin.jsx     (Day-by-Day Schedule UI redesign — mini-card
                                grid, sub-role colored avatars, role-sorted,
                                cleaner edit mode, low-staff treatment)
```

---

## Pass 5 — Host scheduling (Rahul) + per-user "Guaranteed shift" toggle

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

The Host position (you) is now scheduled like any other staff member with two pieces of special handling:

1. **Always assigned when available** — when you submit availability, you always get a shift (no losing slots to higher-priority instructors).
2. **Auto-promote on shortage** — by default your shift is tagged `role: Host` and doesn't count toward the per-day instructor minimum. But if a day's instructor count comes up short of `minPerDay` AND you have the Elementary sub-role, the scheduler tags your shift as `role: Instructor` for that day so you fill the gap. A warning is added to the draft so the admin sees who got promoted before posting.

### What's new

**Removed Rahul Parmar from `FIXED_SCHEDULES`.** You used to live in `lib/scheduler.js` as a fixed-staff entry with every day set to "Off" — which silently excluded you from the entire auto-scheduler. Now you're a regular schedulable user.

**`isHostRole(instructor)` helper** in `lib/scheduler.js` — anyone with `instructorType: 'Host'` is now recognized and routed through the new Host pass.

**Three-way split in `generateSchedule`.** Per day, available users are now split into:
- **`onlineOnly`** — same as before, online-only instructors not counted toward in-centre ratio
- **`hosts`** — new bucket (Host role users), assigned in their own pass with auto-promote logic
- **`inCentre`** — regular instructors competing for slots

**`promotedFromHost` counter** tracks how many Hosts were auto-promoted to Instructor for staffing math. The day's `inCentreTotal` now includes promoted Hosts so warnings about "only N staff (need M)" are accurate. A separate informational warning records each promotion ("ℹ Wednesday May 14: Rahul Parmar (Host) promoted to Instructor to cover staffing shortfall.") so it shows up in the draft review.

**Per-user `guaranteed` flag.** `isGuaranteed()` now checks `instructor.guaranteed === true` on the user profile in addition to the hardcoded `GUARANTEED_NAMES` set. So Luke / Ainsley / Kaitlyn keep working from the hardcoded list, but any new guaranteed user — including you — can be marked from the admin panel without editing code.

**"Guaranteed shift" toggle in Admin → Manage Users.** Each instructor card now has a green toggle near the bottom labelled "Guaranteed shift" with a short explainer. Hosts get an additional sentence about auto-promotion. Stored as `guaranteed: true | false` on the user doc.

### Files touched

```
mod:   src/lib/scheduler.js   (Rahul removed from FIXED_SCHEDULES,
                                isHostRole helper, host-pass + auto-promote,
                                guaranteed flag check)
mod:   src/pages/Admin.jsx     (Manage Users → "Guaranteed shift" toggle)
```

### How to set up your account

(One-time setup, all done from the running portal — no code changes needed.)

1. Log in to the portal with your **non-owner** Mathnasium account (the one you said you have separately).
2. Have the owner go to **Admin → Manage Users**, find your row, and:
   - **Role / Type** → set to **Host**
   - **Teaching Sub-Roles** → click **Elementary** (so you can be auto-promoted on shortage days)
   - **Guaranteed shift** → flip the toggle on
3. Submit availability through Schedule like a regular instructor.

The next time the auto-scheduler runs, you'll appear on every day you submitted availability — tagged "Host" by default, "Instructor" on shortage days.

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

Sub-roles (Elementary / Highschool / Online) were already being saved on every shift but they weren't showing up anywhere except on the Shift Board cards. Now an instructor can open their schedule and immediately see what kind of shift each day is.

### Color scheme

| Sub-role     | Color                | Tailwind  |
|--------------|----------------------|-----------|
| Elementary   | Lime / yellow-green  | `lime-500` |
| Highschool   | Teal                 | `teal-500` |
| Online       | Dark indigo blue     | `indigo-700` |

These colors live in **one file** — `src/lib/subRoles.js`. Every page in the app imports from there, so the next time you want to tweak Elementary's exact shade or swap Online to a different blue, it's a one-line change instead of hunting through five components.

### What's new

**Schedule calendar (instructor view)** — the colored time-block on each shift day is now tinted by sub-role. Lime block = Elementary day, teal block = Highschool day, dark indigo block = Online day. The sub-role label is also stamped in the corner. Replaces the old uniform blue. Calendar legend updated to match.

**Day modal "Your Shift"** — the existing pill that showed `subRoleLabel` (an old field that no shift actually had) now shows the new sub-role with a colored dot + matching pill style. So clicking a future shift gives you the full breakdown including the sub-role.

**Admin weekly spreadsheet** — each shift cell keeps its existing role-color background (Instructor green, Lead orange, Host blue, etc. — useful for staffing decisions) but gets a new colored stripe along the left edge indicating its sub-role. The cell label also picks up an `· E` / `· H` / `· O` suffix so even at small sizes the sub-role is readable. Legend updated with a "Stripe:" section.

**Home page upcoming shift card** — the big red gradient card now ends with a frosted-glass-style sub-role pill at the right edge, so the very first thing an instructor sees when they log in tells them what kind of day they're about to have.

**Admin "Manage Users" sub-role chips** — the toggleable Elementary/Highschool/Online chips on each instructor card now use the new lime/teal/indigo colors instead of the old blue/purple/teal mapping, so onboarding visually matches what the instructor will see on their schedule.

**ShiftBoard pills** — also pull from the shared module now, so the same chips on the Shift Board match.

### Files touched

```
new:   src/lib/subRoles.js              (single source of truth for colors)
mod:   src/pages/Schedule.jsx           (calendar block coloring + day modal pill + legend)
mod:   src/pages/Admin.jsx              (left-stripe indicator + legend + Manage Users chips)
mod:   src/pages/Home.jsx               (upcoming shift card pill)
mod:   src/pages/ShiftBoard.jsx         (migrate pill component to shared module)
```

---

## Pass 3 — "Full Day" availability shortcut

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

Instructors asked for a way to mark themselves available all day instead of picking a specific time range. Added it to both availability modals.

"Full Day" means the **entire day**, including admin prep before opening (binders, inventory, event setup) and cleanup after closing — not just the teaching window. The default ranges:

- **Mon–Thu:** 10:00 AM – 8:00 PM
- **Friday:** 10:00 AM – 7:00 PM
- **Saturday:** 9:00 AM – 3:00 PM

These live in a single `FULL_DAY_BY_DOW` constant at the top of `Schedule.jsx`. If real-world hours shift, edit one map and both modals update automatically.

### What's new

**Single-day modal (calendar cell → "Set Availability"):** the first preset on every day is the marquee **"Full Day"** option, with a distinct emerald style and a clock emoji so it's clearly the all-day pick. The label shows the actual range (e.g. "Full Day · 10:00 AM – 8:00 PM"). The shorter teaching-only ranges sit below as additional options for instructors who only want to be in for lessons.

**Weekly bulk modal ("Set Weekly" button):** a new **"Full day for each"** checkbox sits next to the Time label. When toggled on:
- The From/To time inputs are replaced with an explainer box clarifying that the range covers admin work + cleanup, not just teaching
- Each selected date is saved with the appropriate hours for *that day* — Saturday gets 9 AM – 3 PM, weekdays get 10 AM – 8 PM, Friday 10 AM – 7 PM
- Per-day chips in the preview show each day's specific time on hover

### Implementation note

`handleSaveBulk` was changed from `(dates, startTime, endTime)` to `(items)` where `items = [{date, startTime, endTime}]`. This was needed so the weekly modal can save different hours for different days in a single batched write. Single uniform-time saves still work — the modal just emits the same hours on every item.

### Files touched

```
mod:   src/pages/Schedule.jsx   (FULL_DAY_BY_DOW constant, single-day preset
                                 styling, weekly modal toggle, handleSaveBulk
                                 signature)
```

---

## Pass 2 — Shift Board feature

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

Added a dedicated **Shift Board** page so open shifts and swap requests no longer clutter the team chat. Took the opportunity to introduce per-shift sub-role gating: instructors can only claim or take shifts that match their teaching level (Elementary / Highschool / Online).

### What's new

**`src/pages/ShiftBoard.jsx`** (new). Two stacked sections — Open Shifts (admin-posted) and Swap Requests (instructor-posted). Each card shows date, time, role, and a colored sub-role pill. Eligible cards have a green Claim/Take button; ineligible ones show a disabled "Requires Highschool" pill so people understand the system. Toggle in the top right ("Hide ones I can't take") filters the view, saved to `localStorage` so the choice sticks across reloads. Empty states for both sections. Past-dated shifts are auto-hidden.

**Sidebar item with badge.** New "Shift Board" entry in the left nav between Scheduling and Chat. The badge shows the count of items *eligible for this user* — so Ainsley (Elementary only) sees a `2` even if there are five total shifts on the board because three are Highschool. Badge updates in real time via Firestore listeners.

**Sub-role on every shift.** All three admin modals (Add Shift, Edit Shift, Add Open Shift) now have a required Teaching Level dropdown defaulting to Elementary. Auto-scheduler tags generated shifts based on each instructor's primary capability — Online-only → Online, has Highschool → Highschool, otherwise Elementary. `seedFixedShiftsForDates` defaults fixed staff to Elementary. The owner can change any shift's sub-role at any time via the edit modal.

**Sub-role flows through swap and claim.** When an instructor posts a swap, the shift's sub-role is copied onto the chat doc so the board can show the right pill and gate the take button. When someone claims an open shift, the new shifts doc inherits the open shift's sub-role.

**Eligibility rule:**
- Users with **zero sub-roles** are locked out of all shifts on the board (admin needs to assign at least one before they can participate).
- For shifts with a `subRole`, user must have that sub-role in their profile.
- For legacy shifts without a `subRole` (anything created before this update), users with at least one sub-role can take them. This avoids breaking existing data the moment the feature ships.
- Defense-in-depth: the eligibility check is repeated *inside* the Firestore transaction so a malicious client can't bypass the UI gate.

**Chat is cleaner.** Messages with `type === 'shift_swap'` and `type === 'open_shift_alert'` are now filtered out of the rendered chat. The data still exists in Firestore (so the Shift Board can read swap docs and old data isn't lost) — they're just not visible in chat. Confirmation messages ("Sarah took Dev's shift on Tuesday") and "Schedule posted" announcements are still shown — useful chronological context.

**Race-safe transactions** are reused in the new ShiftBoard claim and take flows — same pattern as the audit fixes — so simultaneous clicks can't double-book.

### Files touched

```
new:   src/pages/ShiftBoard.jsx
mod:   src/App.jsx                      (route + import)
mod:   src/components/Layout.jsx        (sidebar item, badge counter, listeners)
mod:   src/pages/Admin.jsx              (subRole in 3 modals + handlers + seed)
mod:   src/pages/Schedule.jsx           (subRole in handlePostSwap, handleClaimOpenShift)
mod:   src/pages/Chat.jsx               (filter shift_swap and open_shift_alert)
mod:   src/lib/scheduler.js             (shiftSubRoleFor + subRoles map per day)
```

### Migration notes

- **No backfill needed.** Legacy shifts without a `subRole` keep working; users with sub-roles can claim/take them as before.
- **Onboarding requirement added.** When you approve a new instructor, you should set their teaching sub-roles in the admin panel before they'll see anything actionable on the Shift Board. The board shows them an amber banner explaining this.
- **Old chat clutter:** existing `shift_swap` and `open_shift_alert` posts from before this deploy are now hidden in chat (per your request). They still exist in Firestore but the chat feed will look cleaner.

---

## Pass 1 — Audit fixes

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
