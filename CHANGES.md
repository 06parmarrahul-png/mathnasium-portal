# Changes Log

## Pass 14 — Role hierarchy + Super Admin + center switching + shift-type indicator

Lint status: ✅ 0 errors, 0 warnings

Two things in this pass: (1) the full 4-tier role hierarchy you described — super_admin / owner / admin / instructor — plus the Super Admin dashboard and center-switching, and (2) an instructor-requested feature: showing whether a shift is in-centre or online.

### Role hierarchy

```
super_admin  →  god mode. Sees every center. Only role that can create centers.
                Use it as a support account to drop into any center.
owner        →  full admin panel for their center, INCLUDING Center Settings.
                (Analytics — money in/out — is a planned addition.)
admin        →  full admin panel for their center, EXCEPT Center Settings.
                Day-to-day operations: scheduling, users, payroll, requests.
instructor   →  personal schedule, availability, shift board, chat.
```

**`AuthContext` now exposes clean role helpers** — `isSuperAdmin`, `isOwner`, `isAdmin`, `isInstructor`, `canSeeAdminPanel` (admin+owner+super_admin), `canSeeCenterSettings` (owner+super_admin). Components read these instead of comparing `profile.role` strings everywhere.

**`ProtectedRoute`** updated: `requireOwner` now means "requires admin-panel access" (admin/owner/super_admin all pass). New `requireSuperAdmin` prop for the super-admin-only route.

**Admin Panel** — the Center Settings tab only shows for owners + super_admins. Plain admins see Scheduler / Manage Users / Auto-Scheduler / Payroll / Requests but not Settings.

### Super Admin dashboard (`/super-admin`)

New page, super-admin only (with a one-time bootstrap path described below):

- **Lists every center** on the platform with city/province.
- **Create New Center** form — id slug, name, city, province, country. Creates the `centers/{id}` doc + seeds `centers/{id}/config/main` with sensible defaults. Optionally adds the creator as a member so you can immediately switch into the new center to set it up.
- **Switch to any center** — one click puts you in "god view" of that center, seeing exactly what their owner sees. This is your support tool.
- **Bootstrap section** — since you can't easily reach the Firebase Console, this is how the *first* super-admin gets created: if no super-admin exists yet and you're an owner, a "Promote me to Super Admin" button appears. One-time, self-service. Disappears once a super-admin exists.

**Firestore rules**: center creation (`centers/{id}` create) is restricted to `super_admin` only — center owners explicitly **cannot** add new centers. That's the security boundary you asked for.

### Center switching

**`AuthContext.activeCenterId`** is now real React state (was derived), with a `switchCenter(centerId)` function. Switching updates state + localStorage; every Firestore listener in the app re-subscribes because they all depend on `activeCenterId`.

**`CenterSwitcher`** — a dropdown in the sidebar. Shows for super-admins (lists all centers) and multi-center staff (lists their centers). Hidden for single-center users — nothing to switch.

### Shift-type indicator (instructor request)

An instructor asked to be able to tell whether a shift is in-centre or online. The data already existed (`shiftType` field: `In-Centre` / `Online` / `Both`) — it just wasn't shown to instructors. Now it is:

- **Schedule calendar cells** — a tiny icon in the top-right of each shift block: 🏢 building (In-Centre), 💻 laptop (Online), 📶 wifi (Both).
- **Day modal "Your Shift" card** — a clear labeled pill: "In-Centre" / "Online" / "In-Centre + Online" with matching icon and color.
- **Home page upcoming-shift card** — a frosted pill with the icon + label, so it's the first thing they see on login.
- **Calendar legend** — updated with an icon key.

Note this is distinct from the sub-role coloring (lime/teal/indigo) which says *what* they teach. The shift-type icon says *where* they work.

### Files touched

```
new:   src/pages/SuperAdmin.jsx          (dashboard: list/create/switch centers, bootstrap)
new:   src/components/CenterSwitcher.jsx (sidebar dropdown)
mod:   src/contexts/AuthContext.jsx       (activeCenterId as state, switchCenter, role helpers)
mod:   src/components/ProtectedRoute.jsx  (requireOwner = admin-panel access; requireSuperAdmin)
mod:   src/components/Layout.jsx          (role-aware nav, Super Admin link, CenterSwitcher)
mod:   src/pages/Admin.jsx                (canSeeAdminPanel guard, Center Settings owner-only)
mod:   src/pages/App.jsx → App.jsx        (/super-admin route)
mod:   src/pages/Schedule.jsx             (shift-type icons in cells + day modal + legend)
mod:   src/pages/Home.jsx                 (shift-type pill on upcoming shift card)
mod:   firestore.rules                    (center create = super_admin only)
```

### Deploy steps

```bash
npm run build
npm run lint
git add -A
git commit -m "Role hierarchy: super_admin/owner/admin/instructor + Super Admin dashboard + shift-type indicator"
git push
npx firebase-tools deploy --only firestore:rules
```

### After deploy — how to become Super Admin and test multi-center

1. Reload your portal. You're currently `role: 'owner'`.
2. In the sidebar you won't see "Super Admin" yet — go directly to the URL: `yoursite.com/super-admin`
3. You'll see a yellow **"No Super Admin Exists Yet"** box. Click **"Promote me to Super Admin"**.
4. Page reloads. You're now `super_admin`. "Super Admin" appears in the sidebar.
5. Go to Super Admin → **Create New Center** → make a `burnaby-test` center, check "add me as a member", create.
6. The sidebar **Center Switcher** now lets you flip between Langley and Burnaby Test.
7. Switch to Burnaby Test — Schedule / Manage Users / etc. are all empty. **That's the isolation working.**
8. Add a shift in Burnaby, switch back to Langley — Langley is untouched. ✅
9. Open Center Settings while in Burnaby — it has its own default config, not Langley's fixed staff.

---

## Pass 13 — Multi-center Phase 4: Firestore security rules (server-side isolation)

Lint status: ✅ 0 errors, 0 warnings (no JS changes)

**Phase 2 added client-side filtering. Phase 4 adds server-side enforcement.** Without these rules, a user with a few minutes of dev-tools knowledge could open their browser console, manually craft a query for another center's data, and read it. With these rules, Firestore itself rejects any read/write that doesn't match the user's center.

### What's new

**`firestore.rules`** at the project root — a complete ruleset that enforces center isolation, role-based privileges, and per-collection access patterns.

Helper functions defined once at the top:
- `isSignedIn()` — has an auth token
- `profile()` — fetches the signed-in user's profile from `/users/{uid}`
- `profileExists()` — guards against never-signed-up edge cases
- `isApproved()` — must be approved by an owner
- `userCenters()` — returns the user's `centerIds` array (with fallback to legacy `centerId`)
- `hasCenterAccess(centerId)` — true if the user belongs to that center
- `isOwnerAtCenter(centerId)` — owner role + has access to that center
- `isSuperAdmin()` — for future cross-center management UIs

Per-collection rules:

| Collection                  | Read                                                          | Write                                                                   |
|-----------------------------|---------------------------------------------------------------|-------------------------------------------------------------------------|
| `centers/{id}`              | Public (for future signup picker)                             | `isSuperAdmin()` for create; owner-of-center for update/delete         |
| `centers/{id}/config/main`  | `hasCenterAccess(id)`                                         | `isOwnerAtCenter(id)`                                                  |
| `users/{userId}`            | Self, or owner reading users at their center, or super-admin  | Self (excluding role/approved/centerIds/guaranteed); owner; super-admin |
| `shifts/{id}`               | `hasCenterAccess(centerId)`                                   | Approved user at center can create/update; owner deletes                |
| `availability/{id}`         | `hasCenterAccess(centerId)`                                   | User can create/update/delete their own; owner can override            |
| `openShifts/{id}`           | `hasCenterAccess(centerId)`                                   | Owner creates/deletes; any approved user updates (claim flow)          |
| `timeOffRequests/{id}`      | `hasCenterAccess(centerId)`                                   | User submits theirs; owner approves/denies                              |
| `chat/{id}`                 | `hasCenterAccess(centerId)`                                   | Approved user creates/updates; owner deletes                            |
| `announcements/{id}`        | `hasCenterAccess(centerId)`                                   | Owner-only writes                                                        |
| `notificationPreferences/{userId}` | Self only                                              | Self only                                                                |

**Privilege escalation prevention.** The most important rule: when a user updates their own profile, they cannot change `role`, `approved`, `centerId`, `centerIds`, or `guaranteed`. Those stay owner-only. Without this, anyone could promote themselves to "owner" by editing their profile from the dev console.

**`firebase.json`** updated to include the rules path so `firebase deploy --only firestore:rules` knows where to find them.

### How to deploy

```bash
npx firebase-tools deploy --only firestore:rules
```

That's it. Output should be:
```
✔  cloud.firestore: rules file firestore.rules compiled successfully
✔  firestore: released rules firestore.rules to cloud.firestore
✔  Deploy complete!
```

### How to verify it worked

After deploy, do these tests in your browser:

1. **As owner — log in.** Schedule, Admin, Chat, Today's Snapshot all should still load. (You're allowed everywhere because you're the owner.)
2. **As an instructor account — log in.** Schedule, Chat, ShiftBoard should load. Admin should be blocked (the route guard already does this; rules are belt-and-suspenders).
3. **Edge case — open browser console as an instructor and try:**
   ```js
   firebase.firestore().collection('users').get()
   ```
   It should fail with `permission-denied`. (Instructor can't list other users.)

If anything is broken — e.g., legitimate operations are denied — you'll see "missing or insufficient permissions" in the browser console. Read the console, identify which collection is failing, and tell me what error you see. I'll patch the rule.

### Rollback (if anything breaks)

If something legitimate stops working and you need to roll back fast:

1. Open Firebase Console → Firestore → Rules tab.
2. Replace the rules with this temporary permissive default:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
3. Click **Publish**. Live within seconds. The portal returns to "any signed-in user can do anything" mode (= what you had before today).
4. Tell me what broke and I'll fix the real rules.

### What this does NOT solve

These rules don't audit-log or rate-limit. They don't encrypt data at rest beyond Firebase's defaults (which are already TLS in transit + AES-256 at rest). They don't prevent owners from looking at their own users' notification preferences (those are self-only by uid match — owners can't read them). For a stricter "managers shouldn't see private user prefs" rule, that's already in place.

### Files touched

```
new:   firestore.rules        (full multi-tenant ruleset)
mod:   firebase.json           (point at firestore.rules)
```

---

## Pass 12 — Multi-center Phase 2: queries scoped to active center + migration gate

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

**This is the pass that makes multi-center isolation real.** Until now, every Firestore read returned data from every center because no query filtered by `centerId`. After this pass, every read is scoped — Langley users only see Langley's shifts, availability, chat, announcements, time-off requests, and so on. Add a Burnaby center later and Burnaby data is invisible to Langley.

### What's new

**`firestore.indexes.json`** at the project root — defines every composite index Firestore needs for the new center-scoped queries (centerId + date, centerId + createdAt, centerId + userId, etc.). Saves you from clicking "create index" links in the Firebase Console one by one.

**Every collection-listing query is now centerId-filtered.** Specifically:

| File                              | Collection                                     | New filter                                            |
|-----------------------------------|------------------------------------------------|-------------------------------------------------------|
| `Schedule.jsx`                    | availability, shifts, openShifts, timeOffRequests | `where('centerId', '==', activeCenterId)`           |
| `Admin.jsx`                       | users                                          | `where('centerIds', 'array-contains', activeCenterId)` |
| `Admin.jsx`                       | availability, shifts, openShifts, timeOffRequests | `where('centerId', '==', activeCenterId)`           |
| `Chat.jsx`                        | chat                                           | `where('centerId', '==', activeCenterId)`             |
| `Layout.jsx`                      | openShifts, chat (badge data)                  | `where('centerId', '==', activeCenterId)`             |
| `Announcements.jsx`               | announcements                                  | `where('centerId', '==', activeCenterId)`             |
| `ShiftBoard.jsx`                  | openShifts, chat                               | `where('centerId', '==', activeCenterId)`             |
| `TodaysSnapshot.jsx`              | shifts (today)                                 | `where('centerId', '==', activeCenterId)`             |
| `Home.jsx`                        | shifts (mine), announcements                   | `where('centerId', '==', activeCenterId)`             |

Single-doc reads (`getDoc(doc(db, 'users', uid))`, etc.) don't need filtering — they target a specific document by ID.

**Users collection uses `array-contains` on `centerIds`.** Since the data model supports staff working at multiple Mathnasium locations, a user belongs to centers via an array, not a single field. The query asks "give me users whose centerIds array includes the active center."

**`src/components/MigrationBanner.jsx`** — a full-screen modal gate that detects whether the multi-center migration has been run and forces it to be run before the app is usable. Shows up if `centers/{activeCenterId}` doesn't exist. **Without this banner, Phase 2's filtered queries would silently return nothing for un-migrated installs and the portal would look completely empty.** Now the banner says "Multi-Center Setup Required" with a one-click migration button.

- **Owners** see the migration button directly. Click → migration runs → banner disappears → portal works.
- **Instructors** see a friendlier "Tell your owner" message. They wait for the owner to run it.
- **The migration logic is the same as before** (creates `centers/langley`, seeds `centers/langley/config/main`, stamps `centerId` on every existing doc). Just surfaced more aggressively.

### Why this all has to ship together

1. If we **filter queries** without **running the migration**, every read returns nothing → empty app → user thinks something broke.
2. If we **run the migration** without **filtering queries**, queries still return everything across all centers (no isolation) → defeats the purpose.
3. If we **deploy code** without **deploying indexes**, the first query of each new shape errors with "missing index" → Firebase shows a URL, but it's friction.

The migration banner solves (1). The `firestore.indexes.json` file solves (3). Both together solve everything.

### Safe-deploy steps (do in this order)

1. **Push the code.**
   ```bash
   git add -A
   git commit -m "Phase 2: scope every Firestore read to the active center; add migration gate"
   git push
   ```
   Wait for Vercel to deploy and go green.

2. **Deploy the Firestore indexes** (do this BEFORE you reload the live site, otherwise queries will fail with "missing index" errors until you click each URL).

   If you have Firebase CLI installed (`npm install -g firebase-tools`, then `firebase login` once):
   ```bash
   firebase deploy --only firestore:indexes
   ```
   If you don't have Firebase CLI: open Firebase Console → Firestore → Indexes tab → click "Create Index" and copy each entry from `firestore.indexes.json`. Or just reload the live site, watch the console for "missing index" errors, click the URL each error gives you (Firebase auto-fills the form). Either way works; CLI is faster.

3. **Reload the live site as the owner.** A modal will appear immediately: **"Multi-Center Setup Required"**.

4. **Click "Run multi-center migration"**. It takes a few seconds. The modal disappears when done.

5. **Verify everything works.** Click around — Schedule, Admin, Chat, Today's Snapshot, Shift Board. All should display data exactly as before. (Behind the scenes, every query now has a `where('centerId', '==', 'langley')` clause, but since every doc is now tagged, results are identical.)

### What this unlocks

You're now ready for Phase 4 (Firestore security rules). Phase 4 will add server-side enforcement: even if a malicious client crafts a request for another center's data, Firestore itself will reject it. Defense in depth.

### Files touched

```
new:   firestore.indexes.json                  (composite indexes for multi-center queries)
new:   src/components/MigrationBanner.jsx      (full-screen migration gate)
mod:   src/components/Layout.jsx                (renders MigrationBanner; queries filter by centerId)
mod:   src/components/TodaysSnapshot.jsx        (filter by centerId)
mod:   src/pages/Schedule.jsx                   (filter all 4 listeners by centerId)
mod:   src/pages/Admin.jsx                      (filter all 5 listeners by centerId; users by array-contains)
mod:   src/pages/Chat.jsx                       (filter chat by centerId)
mod:   src/pages/Home.jsx                       (filter shifts + announcements by centerId)
mod:   src/pages/Announcements.jsx              (filter by centerId)
mod:   src/pages/ShiftBoard.jsx                 (filter openShifts + chat by centerId)
```

---

## Pass 11 — Multi-center Phase 3: scheduler config moves to Firestore + Center Settings UI

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

Scheduler tunables (instructional hours, fixed staff, guaranteed names, salary list, operating hours) used to be **hardcoded constants** in `lib/scheduler.js`, `Schedule.jsx`, and `Admin.jsx`. That meant every Mathnasium center inherited Langley's specifics — Saturday 9 AM – 3 PM, Jasper Wu as Center Director, Luke as guaranteed, etc. Useless if Burnaby has different hours or different fixed staff.

Now those values live **per-center** in Firestore, with a real **Center Settings** UI in the admin panel to edit them.

### What's new

**`src/lib/centerConfig.js`** — single module that defines every center-tunable:
- `name`, `city`, `province`, `country`, `timezone`
- `instructionalHours` (per day) — teaching window
- `operatingHours` (per day) — open-to-close including admin time
- `defaultMinPerDay`, `defaultMaxPerDay`, `defaultMaxDaysPerWeek`
- `guaranteedNames` (array of first names)
- `salaryStaff` (array of full names — excluded from hourly payroll)
- `fixedStaff` (map keyed by display name; per-day shift strings)

`DEFAULT_CENTER_CONFIG` has safe defaults; `LANGLEY_DEFAULT_CONFIG` has the exact current values used by Langley today, used by the migration to seed Firestore.

`mergeCenterConfig(serverData)` merges any partial server config with the defaults so every consumer can rely on the full shape.

**AuthContext now subscribes to `centers/{activeCenterId}/config/main`** in real time. Edits in the Center Settings UI flow back out to every page automatically. `useAuth()` exposes a new `centerConfig` field.

**Scheduler engine reads from config.** `generateSchedule({ ..., centerConfig })` now accepts the per-center tunables and uses them for instructional-hour clamping, fixed-staff seeding, and guaranteed-name matching. Falls back to legacy hardcoded values when no config is provided (pre-migration safety).

**Schedule.jsx full-day picker reads from config.** Both the single-day calendar modal and the weekly bulk modal now use `centerConfig.operatingHours` to compute the "Full Day" range per day-of-week, passed down via a `fullDayByDow` prop.

**Admin payroll exclusions read from config.** The `salaryStaff` set comes from the active center's config (regression fix — it was lost in an earlier merge conflict and is now back).

**Admin's `seedFixedShiftsForDates` reads fixed-staff map from config.** Same fallback to legacy `FIXED_SCHEDULES` when no config is loaded.

**Migration also seeds the config doc.** When you run "Run multi-center migration" in Manage Users, it now also creates `centers/langley/config/main` with `LANGLEY_DEFAULT_CONFIG` (which captures everything currently hardcoded in Langley). After migration, Firestore is the source of truth.

**`src/components/CenterSettingsTab.jsx`** — new admin tab with a clean form-based editor for everything:

- **Identity card** — center name, city, province, country, timezone
- **Instructional Hours table** — per-day start/end pickers
- **Operating Hours table** — per-day start/end pickers
- **Guaranteed Shift list** — add/remove first names with chip UI
- **Salaried Staff list** — add/remove full names with chip UI
- **Fixed Staff display** (read-only this pass) — shows current entries; full editor is its own future pass

Sticky save bar at the bottom shows "Unsaved changes" / "Saved" status, plus a Discard button. Saves via `setDoc` with `merge: true` so partial updates don't wipe untouched fields.

### What's NOT in this pass

- **Fixed-staff editor** is read-only. Adding/editing fixed staff still requires direct Firestore writes (or running the migration to re-seed). Doing this safely needs more thought — those entries have per-day shift strings ("11:00 AM - 7:00 PM"), Saturday-week filters, etc. Coming later.
- **Scheduler still uses STAFFING_COUNT_ROLES, ROLE_DISPLAY_ORDER, SUB_ROLES** as global constants. Those describe Mathnasium's role taxonomy (Instructor, Lead, Host, Elementary, Highschool, Online) which is the same across centers — left global on purpose.

### Roadmap from here

- ✅ Phase 1 — multi-center groundwork (centerId + migration)
- ✅ Phase 3 — scheduler config to Firestore + Center Settings UI (this pass)
- Phase 2 — filter every read by activeCenterId
- Phase 4 — Firestore security rules to enforce isolation
- Phase 5 — center-picker dropdown at signup
- Phase 6 — end-to-end test with a 2nd center
- Phase 7 — sidebar center-switcher (multi-center staff + super-admins)
- Phase 8 — center-management UI (super-admin adds new centers)

### Files touched

```
new:   src/lib/centerConfig.js                  (DEFAULT + LANGLEY_DEFAULT + merge helper)
new:   src/components/CenterSettingsTab.jsx     (admin editor UI)
mod:   src/contexts/AuthContext.jsx              (subscribe + expose centerConfig)
mod:   src/lib/scheduler.js                       (clampToInstructionalHours, getFixedStaffForDay,
                                                    isGuaranteed all accept config; generateSchedule
                                                    threads it through)
mod:   src/pages/Admin.jsx                        (passes centerConfig to scheduler;
                                                    salaryStaff/fixedStaff read from config;
                                                    new "Center Settings" tab + import; migration
                                                    seeds config doc)
mod:   src/pages/Schedule.jsx                     (buildFullDayByDow from config; pass via prop
                                                    to DayModal + WeeklyAvailabilityModal)
```

### How to test

1. Deploy + run the multi-center migration (if you haven't already from Pass 10).
2. Go to **Admin → Center Settings**.
3. Try changing a value — say, set Tuesday instructional hours to 4–7 PM instead of 3–7 PM. Hit Save.
4. Generate a draft schedule for next month. Confirm Tuesday shifts get clamped to 4–7 PM (was 3–7 PM before).
5. Add a name to "Guaranteed Shift" list, hit Save. Confirm that person now gets prioritized in the auto-scheduler.
6. Set Saturday operating hours to 8 AM – 4 PM. Open Schedule, click a future Saturday, hit "Set Availability" → top "Full Day" preset should now read "Full Day · 8:00 AM – 4:00 PM".
7. Verify nothing else broke (existing shifts/availability still display correctly).

---

## Pass 10 — Multi-center groundwork (Phase 1 of 8)

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

This is the first phase of turning the portal into a multi-tenant platform that can serve every Mathnasium in BC, then Canada, then globally. **The portal still behaves identically for current users** — this pass is purely additive scaffolding for tenant isolation. Phase 2 (filtering reads by `centerId`) and beyond come later.

### What's new

**`src/lib/centers.js`** — single source of truth for "which Mathnasium am I working with right now?"
- `DEFAULT_CENTER_ID` = `'langley'`
- `getUserCenters(profile)` — returns the user's centerIds (always at least one entry, fallback `['langley']`)
- `getActiveCenterId(profile)` — returns the currently-active center for this user, persisted in localStorage so multi-center staff can switch later
- `setActiveCenterId(id)` — write the active choice to localStorage
- `canSwitchCenters(profile)` — true for users with >1 center or super-admins (used later for the sidebar dropdown)

**AuthContext now exposes `activeCenterId`.** Every component that does a Firestore write can pull it via `useAuth()`. Until a user's profile says otherwise, this is `'langley'`.

**Multi-center fields on user profiles.** New signups now get:
- `centerId: 'langley'` — primary center (the one shown by default)
- `centerIds: ['langley']` — array, supports staff who work at multiple centers

For multi-center staff, the array gets longer (`['langley', 'burnaby']`); the primary `centerId` is the default to show. The owner can edit these in Manage Users (UI for that lands in a later phase).

**Every Firestore write now stamps `centerId`.** Going forward, every shift, availability slot, open shift, time-off request, chat message, announcement, and notification preference doc gets a `centerId` written to it. If the doc already had one (e.g. derived from the open shift it was claimed from), that wins; otherwise it falls back to the user's `activeCenterId`.

**One-time migration button in Admin → Manage Users.** A new "Multi-Center Setup" section with a button labelled **"Run multi-center migration"**. It:
1. Creates `centers/langley` if it doesn't exist (with name, city, province, country, timezone)
2. Walks every collection (`users`, `shifts`, `availability`, `openShifts`, `timeOffRequests`, `chat`, `announcements`, `notificationPreferences`)
3. Stamps `centerId: 'langley'` on every doc that doesn't already have one
4. Adds `centerIds: ['langley']` to user docs that don't have an array yet
5. Reports per-collection counts ("users: 12, shifts: 487, …") so you can see what got touched
6. Idempotent — safe to run twice; already-migrated docs are skipped

Designed to be the **only** time this runs. After that, all new writes already include `centerId` so the database stays consistent.

### What's NOT in this pass

- **Reads still don't filter by `centerId`.** Everyone still sees all data. That changes in Phase 2, where every `onSnapshot` / `getDocs` query gets a `where('centerId', '==', activeCenterId)` filter.
- **No center-picker dropdown at signup yet.** New users default to Langley. The dropdown lands once a 2nd center exists in `centers/`.
- **No Firestore security rules tightening.** Rules that enforce centerId isolation come in Phase 4 — they're security-critical and need careful review.
- **No center-switcher in the sidebar yet.** That's Phase 7 (for multi-center staff and super-admins).
- **Scheduler config is still hardcoded.** Fixed staff names, instructional hours, full-day ranges — all still live in code constants. Phase 3 moves them into per-center config docs in Firestore so each Mathnasium can have different hours, fixed staff, etc.

### How to roll this out

1. Deploy this pass.
2. In production, log in as owner.
3. Go to **Admin → Manage Users**, scroll to the **Multi-Center Setup** section.
4. Click **"Run multi-center migration"**, confirm the prompt.
5. Wait a few seconds, see the per-collection counts.
6. Verify the portal still works exactly as before (it should — no read paths changed).
7. Done. The database is now multi-center-shaped.

### Files touched

```
new:   src/lib/centers.js                      (single source of truth)
mod:   src/contexts/AuthContext.jsx            (signup writes centerId/centerIds; expose activeCenterId)
mod:   src/pages/Admin.jsx                     (handleAddShift, handleAddOpenShift,
                                                 seedFixedShiftsForDates, handlePostSchedule
                                                 chat write — all stamp centerId.
                                                 New "Multi-Center Setup" section + migration handler.)
mod:   src/pages/Schedule.jsx                   (handleSaveAvail, handleSaveBulk, handlePostSwap,
                                                 handleClaimOpenShift, handleRequestTimeOff)
mod:   src/pages/Chat.jsx                       (handleSend, accept-shift confirmation)
mod:   src/pages/ShiftBoard.jsx                 (handleClaim shift + chat, handleTakeSwap chat)
mod:   src/pages/Announcements.jsx              (handlePost)
mod:   src/pages/NotificationPreferences.jsx    (handleSave)
```

---

## Pass 9 — Today's Snapshot on the owner's home page

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

When the owner logs in, the home page now starts with a **Today's Snapshot** dashboard showing exactly what's happening today.

### What's new

**`src/components/TodaysSnapshot.jsx`** — new component that subscribes to today's shifts (`where date == todayStr`) and renders:

- **Date header** (e.g. "Friday, May 8, 2026")
- **Stat tiles** (4 of them):
  - Instructors (teaching count — Instructor / Lead / promoted Host)
  - Hosts (regular non-promoted)
  - Online (online instructors)
  - Total scheduled hours across the day
- **The same CoverageGrid used in the auto-scheduler** — half-hour density with per-person rows, sub-role colored bars, peak-instructor summary

**Auto-refreshes at midnight.** The component captures `now` on mount and re-checks every 60 seconds. If the date rolls over while the tab is open, the queries and labels update without a manual refresh.

**Empty state.** If no shifts are posted for today, shows a clean "No staff scheduled today" message with a hint pointing to the Admin Panel — instead of just rendering an empty grid.

**Loading state.** Brief spinner while the first Firestore snapshot arrives, then the data renders. Avoids the awkward "empty state flash" that would otherwise appear.

### Home page treatment for owners

Home (`/`) now branches by role:

| Role        | What they see                                                             |
|-------------|----------------------------------------------------------------------------|
| Owner       | Today's Snapshot → Latest announcement → Quick actions (incl. Admin link) |
| Instructor  | Upcoming shift card → Latest announcement → Quick actions                 |

The owner's container also widens (`max-w-5xl` vs `max-w-3xl`) so the coverage grid has room to breathe without horizontal scrolling on most laptops.

### Files touched

```
new:   src/components/TodaysSnapshot.jsx   (date-aware, auto-refreshes, reuses CoverageGrid)
mod:   src/pages/Home.jsx                   (renders TodaysSnapshot for owners,
                                              wider container for owner view)
```

---

## Pass 8 — Per-day Coverage Grid (half-hour staffing density)

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

Each day in the auto-scheduler draft now has a "Show coverage" button that expands into a half-hour-resolution staffing grid — so you can see exactly how many instructors you have at each time slot before posting, and decide student capacity accordingly.

### What's new

**`src/components/CoverageGrid.jsx`** — a new reusable component that renders a Gantt-style table for a single day:

- **Rows**: every assigned person on that day, sorted by role (Instructors → Hosts → Online).
- **Columns**: half-hour slots from open to close, sized to the day-of-week (Mon–Thu 10 AM – 8 PM, Fri 10 AM – 7 PM, Sat 9 AM – 3 PM).
- **Cells**: filled with a sub-role-colored bar (lime/teal/indigo) when that person's shift covers that slot, hover to see the person's name and shift time.
- **Sticky left column** for names — scroll horizontally on small screens without losing context.
- **Hour-mark column dividers** are darker; half-hour ones are subtle. Hour labels show; half-hour cells stay blank.

**Two summary rows at the bottom:**

- **"Instructors"** (bold, blue) — count of *teaching* staff per slot. Only Instructor / Lead / promoted-Host roles count. This is the number that matters for student-capacity decisions.
- **"All staff"** (smaller, gray) — total bodies in the centre per slot, including non-teaching Hosts and Online instructors.

A summary line at the top shows peak instructor count and what time it hits ("Peak instructors: 3 @ 4p"). Footer note clarifies what counts as a teaching role and what doesn't.

**Per-day expand toggle** in the Admin draft schedule. Each day card now ends with a "Show coverage" button that toggles the grid. There's also an "Expand all" / "Collapse all" pair in the schedule header for surveying the whole month at once.

**Live updates in edit mode.** When you click Edit on a day and the coverage grid is expanded, the bars and totals update *as you tweak times* — drag a shift earlier and you'll see the slot count change immediately. Lets you fine-tune coverage in real time.

### Why this is useful

When you're staring at a draft thinking "do I have enough people on Thursday?", you can now answer it concretely: open the coverage grid, eye the "Instructors" total at 5 PM, and know if you can fit another student. Previously this required either mental math or actually posting the schedule and counting on the weekly spreadsheet.

It also makes obvious things you couldn't see before — like "everyone leaves at 7 PM but I have a 6:30 student cancellation, am I stranded after?" Now there's a row for each person and you can see who's bridging the late slot.

### Files touched

```
new:   src/components/CoverageGrid.jsx   (Gantt table + summary)
mod:   src/pages/Admin.jsx               (expandedDays state, expand-all/collapse-all,
                                           per-day "Show coverage" toggle, conditional
                                           render of CoverageGrid)
```

---

## Pass 7 — Editable shift times in the auto-scheduler draft

Lint status: ✅ 0 errors, 0 warnings
Parse status: ✅ all source files parse clean

Previously you could only add/remove people from a day in the draft schedule — actual shift times were locked in by the scheduler. Now you can fine-tune everything before posting.

### What's new

**Edit mode in the draft Day-by-Day Schedule** is now a real editor instead of just an add/remove panel. Each assigned person becomes a row with:

- Sub-role-colored avatar with initials (lime / teal / indigo)
- Name + remove button
- **Start time input** (HH:MM picker)
- **End time input** (HH:MM picker)
- **Sub-role dropdown** (Elementary / Highschool / Online)

Edit anything you want, click "Save day", and your changes are kept in the draft until you click "Post Schedule" — at which point they get written to Firestore exactly as edited.

**Adding someone to a day from the editor** now also seeds a sensible default shift:
- **Instructor / Lead / etc.** — defaults to that day's instructional window (Mon–Thu 3–7 PM, Fri 3–6 PM, Sat 10 AM – 2 PM)
- **Hosts** — defaults to the day's full-day window (Mon–Thu 10 AM – 8 PM, Fri 10 AM – 7 PM, Sat 9 AM – 3 PM)

So you can drop a Lead into Wednesday and it pre-fills 3–7 PM, no manual typing required.

**Empty-state hint.** If everyone is already on the roster for that day, the "Add from approved staff" section shows "All approved staff are already assigned." instead of an empty row.

### Implementation details

- Three new handlers added to `Admin.jsx`:
  - `handleUpdateDayShiftTime(name, field, value)` — patches one half (start or end) of someone's shift string in the draft
  - `handleUpdateDaySubRole(name, value)` — changes someone's sub-role in the draft
  - `parseShiftTimeStr(str)` — parses both `HH:MM` and `H:MM AM/PM` formats back to `[start, end]` so the time inputs can show the right values
- `handleAddToDay` now also seeds the new entry's `shiftTimes` and chooses the default based on the user's `instructorType`
- `handlePostSchedule` already reads `day.shiftTimes` when writing to Firestore, so no change needed there — your edits flow straight through

### Files touched

```
mod:   src/pages/Admin.jsx   (three new handlers, parseShiftTimeStr,
                              DRAFT_DEFAULT_HOURS map, redesigned edit-mode
                              UI with editable rows)
```

---

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
