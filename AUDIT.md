# Mathnasium Langley Portal — Code Audit

Date: May 7, 2026
Reviewed: full repo (~5,000 lines of app code, plus config and lib)

> **Status:** First fix pass shipped. Items marked **✅ FIXED** below are done.
> See `CHANGES.md` for the full list of what changed in this pass.
> Items still open are kept for follow-up work.

This is a prioritized findings list. Each item has a **severity**, the **file:line** it lives in, **why it matters**, and a **proposed fix**. Pick what you want me to tackle and I'll start patching.

Severity legend:
- **P0** — bug or security issue that affects real users *now*. Fix first.
- **P1** — high-impact correctness, perf, or UX problem you'll feel as the team grows.
- **P2** — code quality, polish, future-proofing.

---

## P0 — Critical: Fix These First

### 1. Repo has a duplicate nested copy of itself — `mathnasium-portal/`
A full second copy of the project (with its own `.git/`, `node_modules/`, `package-lock.json`, etc.) lives inside the repo at `mathnasium-portal/`. Lint sees both copies, Vercel will deploy the bigger of two trees, and any edits to the "real" project don't apply to the duplicate. Almost certainly an accidental clone-into-self.

**Fix:** Delete the entire `mathnasium-portal/` directory (after confirming it has no commits you actually want). Then commit.

---

### 2. Self-assigned admin role at signup
`src/pages/Signup.jsx:6-11, 82-86` — the signup form lets *anyone* select "Admin" as their `instructorType`, and that value is written straight to their Firestore profile by `AuthContext.signup()` (`src/contexts/AuthContext.jsx:42-58`). The `approved: false` gate buys time, but you (the owner) might glance at a pending user named "John" and click Approve — they're now Admin.

**Fix:** Remove "Admin" (and arguably "Lead", "Host") from the signup dropdown. Default everyone to `instructorType: 'Instructor'` and let only the owner promote them in the admin panel. Also, your Firestore security rules should disallow users from writing `instructorType` / `priority` / `role` / `approved` on their own profile after creation.

---

### 3. Rejecting a user only deletes the Firestore doc — they can still log in
`src/pages/Admin.jsx:467` — `handleReject(uid) = deleteDoc(doc(db, 'users', uid))` removes the profile but leaves the Firebase Auth account intact. Worse, `ProtectedRoute` (`src/components/ProtectedRoute.jsx:18-37`) only blocks when `profile && !profile.approved`. If `profile === null` (because you deleted it), the check falls through and the rejected user is granted access to `<children>`.

**Fix two ways:**
1. In `ProtectedRoute`, treat missing profile the same as un-approved: `if (!profile || !profile.approved) → show pending screen`.
2. To actually delete the auth user you need a Firebase admin SDK call (Cloud Function), not just a client doc delete. At minimum, set `approved: false` and `disabled: true` on the doc and have the Function disable the auth account.

---

### 4. Race condition: two instructors can claim the same shift
- `src/pages/Chat.jsx:42-81` (`handleAcceptShift`) reads `msg.swapStatus` from local state, then `updateDoc`s. Two clients see "open", both update.
- `src/pages/Schedule.jsx:822-855` (`handleClaimOpenShift`) — same pattern on `openShifts`.

**Fix:** Use a Firestore `runTransaction` that reads the latest doc, verifies `status === 'open'`, then writes. Both updates (chat doc + shift doc, or openShifts doc + new shifts doc) should be batched in the transaction so partial writes don't strand data.

---

### 5. Chat loads the *first* 200 messages, not the latest 200
`src/pages/Chat.jsx:14-17` — `query(collection(db, 'chat'), orderBy('createdAt', 'asc'), limit(200))`. Once you cross 200 messages total, new messages stop appearing for everyone, because Firestore returns the oldest 200.

**Fix:** Query `orderBy('createdAt', 'desc'), limit(200)` and reverse the array client-side. (Or paginate properly with a cursor.)

---

### 6. Admin `/admin` route is not role-guarded
`src/App.jsx:23` — `/admin` only sits behind `<ProtectedRoute>`, which checks login + approved, not owner. The page itself does an inline check at `Admin.jsx:963` (`if (profile?.role !== 'owner') return access denied`) but the heavy data subscriptions in the `useEffect` at `Admin.jsx:439-455` (`users`, all `availability`, all `shifts`, etc.) run *before* that check returns. So any approved instructor:
- Can hit `/admin`, briefly subscribe to every collection (and the listener stays alive thanks to React's effect timing), and read all PII in users (`email`, `phone`, `priority`, `subRoles`).
- This relies on Firestore security rules being correctly locked down. If your rules are open or "any authenticated user can read users", you have a real data leak.

**Fix:**
1. Add an `<OwnerRoute>` wrapper in `App.jsx` that returns 404 for non-owners *before* mounting `Admin`.
2. Independently, audit Firestore rules — only owner reads on `users` collection (or fields like `email`/`phone`).

---

### 7. "Today" calculated in UTC — wrong half the day in Pacific
`src/pages/Home.jsx:77` — `const todayStr = new Date().toISOString().split('T')[0]` uses UTC. After ~5pm PST it's already "tomorrow" in UTC, so the homepage's "upcoming shift" filter (`s.date >= todayStr`) hides today's shift if it's later in the evening.

**Fix:** Use a local-date helper. `format(new Date(), 'yyyy-MM-dd')` from `date-fns` (which Schedule.jsx already imports). Same fix in `lib/scheduler.js:101` (`date.toISOString().split('T')[0]`) — though there it's less likely to bite because the input is constructed from `new Date(year, monthNumber-1, 1)` at midnight local.

---

### 8. Lint: a real React-correctness error
`eslint .` reports an actual bug, not just style:
```
Schedule.jsx:464  setState within useEffect body (cascading renders)
```
Plus several unused imports (Admin.jsx: `endOfWeek`, `fixedStaffHoursForDay`, `selectedProfile`, `openShiftsByDate`, `openCount`; Schedule.jsx: `parseISO`, two `err` params).

**Fix:** Refactor the `WeeklyAvailabilityModal` preview to compute via `useMemo` instead of `useEffect + setPreview`. Strip unused imports.

---

### 9. `package.json` is missing actual dependencies
The root `package.json` does not list:
- `@emailjs/browser` — imported in `src/lib/emailService.js:15`
- `xlsx` — used in `Admin.jsx:850-863` (loaded dynamically from CDN, but a real npm dep would be safer)

There's a *different* `src/package.json` that does include them — confusing duplicate file. On a fresh `npm install` from root, `emailService.js` would fail to build. (Build only works on your machine because someone ran install on the other manifest at some point.)

**Fix:** Move `@emailjs/browser` and `xlsx` into the root `package.json`. Delete `src/package.json` — it should never have existed at that path.

---

## P1 — High Impact

### 10. Every Firestore listener fetches the entire collection forever
Across `Schedule.jsx:715-729`, `Admin.jsx:439-455`, `Home.jsx:62-75`: `onSnapshot(collection(db, 'shifts'))` etc. with no `where` clause.

Today: maybe a few hundred docs, fine. In a year: thousands of `shifts`, `availability`, `chat`, `timeOffRequests` docs. Every page load downloads all of it. Firebase costs grow O(reads × users × time on page).

**Fix:** Filter listeners by a sensible window. Examples:
- `shifts`: `where('date', '>=', oneMonthAgoStr)`
- `availability`: same
- `chat`: `orderBy desc, limit 200` (also fixes finding #5)
- `users`: only the owner needs the full list; instructors should subscribe to just their own doc.
- `timeOffRequests`: instructors → `where('userId', '==', uid)`; owner → all (fine, low volume).

This will also unlock tighter Firestore rules.

---

### 11. Bulk availability writes aren't atomic
`Schedule.jsx:775-791` (`handleSaveBulk`) and `Schedule.jsx:761-773` (`handleSaveAvail`) both do `deleteDoc` then `addDoc`. Concurrent or interrupted runs leave the user with no availability for a day. Same anti-pattern as `seedFixedShiftsForDates` at `Admin.jsx:602-650`.

**Fix:** Use `setDoc(doc(db, 'availability', \`${uid}_${dateStr}\`))` — a deterministic ID makes it idempotent: writing the same date again just overwrites, no race window. Similarly use `writeBatch` for bulk operations so it's all-or-nothing.

---

### 12. `shiftType` is silently dropped on edit
`Admin.jsx:476-479` — `handleSaveEditShift` only passes `startTime, endTime, role` to `updateDoc`. The `shiftType` from the modal at `Admin.jsx:291, 325-332` is collected but never written.

**Fix:** Include `shiftType` in the updateDoc call. (1 line.)

---

### 13. No way to recover a forgotten password
`Login.jsx` has no "Forgot password?" link. Users who forget have to ask you to reset via Firebase console.

**Fix:** Add `sendPasswordResetEmail(auth, email)` flow. ~20 lines.

---

### 14. Login error matching is brittle
`Login.jsx:23-29` checks `err.message.includes('invalid-credential')`. Firebase Auth surfaces `err.code`, not message. Most users will hit the generic fallback ("Login failed. Please try again.") even when their issue is wrong password vs. unknown email vs. too-many-attempts.

**Fix:** Switch on `err.code` (`'auth/invalid-credential'`, `'auth/too-many-requests'`, etc.).

---

### 15. Approving a user sends them no notification
`Admin.jsx:466` — `handleApprove` flips `approved: true` and... that's it. The user has to check the portal manually. They submitted on Tuesday, you approved Thursday afternoon, they don't know until next week.

**Fix:** Send an EmailJS message via `emailService.js`. (You already have the infrastructure — there's even a commented-out `notifySchedulePosted` call.)

---

### 16. Native `confirm()` and `alert()` everywhere
At least 10 places: `Schedule.jsx:819, 854, 868`, `Admin.jsx:656, 661, 674, 679-680, 687, 731, 1975`, `Announcements.jsx:40`, `Chat.jsx:46, 79`. Looks unprofessional, blocks the JS thread, can't be styled, breaks on iOS in some embed contexts.

**Fix:** Replace with a small toast component (or use `react-hot-toast` — ~3KB) for notifications, and a styled `<ConfirmDialog>` for destructive actions. The "Reset All Shifts" confirm should require typing "DELETE" before enabling the button.

---

### 17. Hard-coded credentials in source
- Firebase web config in `src/firebase.js:5-12` (mostly OK — Firebase web keys are technically safe to expose, but only if Firestore rules + App Check are properly configured).
- EmailJS public key, service ID, template IDs in `src/lib/emailService.js:18-21` — these *are* safe by design, but mixing them in source means rotating requires a code commit.

**Fix:** Move both to `import.meta.env.VITE_*` variables and add `.env`, `.env.local` to `.gitignore`. Document in README.

---

### 18. `Radius` xlsx loaded from cdnjs at runtime instead of bundled
`Admin.jsx:850-863` injects a `<script>` tag pointing at `cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5`. If cdnjs is down or blocked, the import button silently fails. `xlsx` is in `src/package.json` already — just `import * as XLSX from 'xlsx'` at the top.

**Fix:** Move `xlsx` to the root `package.json` and import normally. Removes ~70 lines of dynamic-loading boilerplate.

---

### 19. Radius column indices are magic numbers
`Admin.jsx:867-885` — `row[1]` for attendanceId, `row[2]` for name, `row[4]` for date, etc. If Radius adds a column, every payroll comparison breaks silently — wrong people, wrong hours.

**Fix:** Read the header row first, build a `columnByName = {employeeName: 2, date: 4, ...}` map, then index by name. Surface a clear error if expected columns are missing.

---

### 20. Radius name matching isn't actually fuzzy
`Admin.jsx:927` — comment says "Fuzzy name match" but it's `r.name.toLowerCase().trim() === person.name.toLowerCase().trim()`. Middle names, hyphens, "Bri" vs "Brianna" — all miss.

**Fix:** Tokenize on whitespace, match on first+last token; or expose a manual mapping UI for first-time mismatches.

---

### 21. No 404 / catch-all route
`App.jsx` — typing a wrong URL renders a blank page.

**Fix:** Add `<Route path="*" element={<NotFound />} />`.

---

### 22. `React.StrictMode` + same-effect listeners
All page components do `useEffect(() => onSnapshot(...), [])` returning the unsubscribe directly. This is *correct*, but in dev with StrictMode (`main.jsx:7-9`) every effect runs twice on mount — you'll see two listeners briefly in dev. In prod it's fine. Worth being aware of when debugging "duplicate writes".

---

### 23. Time-off doesn't unassign existing shifts
If an instructor has a shift on May 15 and gets time off approved for May 14–20, the shift on May 15 stays in `shifts`. Schedule.jsx will show both "Time Off Approved" and "Your Shift" UI for the same day (the cell logic at `Schedule.jsx:872-882` returns shift first, hiding the time-off badge).

**Fix:** When approving time off (`Admin.jsx:1957`), find conflicting shifts in that range and either delete them or convert them to open shifts so they can be picked up.

---

### 24. Announcements use client-clock timestamps
`Announcements.jsx:34` — `date: new Date().toISOString()`. If a user's clock is wrong, announcements sort wrong.

**Fix:** Use `serverTimestamp()` (already imported elsewhere) and store as Firestore Timestamp, not string.

---

## P2 — Polish, Cleanup, Future-Proofing

### 25. `Admin.jsx` is 2,020 lines and `Schedule.jsx` is 1,165 — too much in one file
Both render half a dozen distinct features (tabs in Admin: scheduler grid, users, auto-scheduler, payroll, requests; Schedule: calendar + DayModal + WeeklyModal + helpers). Hard to reason about, every state change re-renders all tabs, modals are inlined.

**Fix:** Extract tabs into separate route components: `pages/admin/Scheduler.jsx`, `pages/admin/Users.jsx`, `pages/admin/Payroll.jsx` etc. Move modals into `components/`. Pull derived data into custom hooks: `useUsers()`, `useShiftsForWeek(weekStart)`, `usePayroll(start, end)`. Aim for files under 400 lines each.

### 26. Modals don't trap focus / close on Escape
None of the modals implement focus management or Escape-to-close. Bad for keyboard users and accessibility.

**Fix:** Use `<dialog>` element or a small wrapper hook with focus trap.

### 27. README is the Vite boilerplate
No setup instructions, no env-var list, no deploy notes. New collaborators (or Future You in 6 months) start from zero.

**Fix:** Replace with: project description, prerequisites, `cp .env.example .env.local`, `npm install`, `npm run dev`, deploy steps, Firestore collections list.

### 28. `index.html` title is `mathnasium-portal`
`index.html:7`. Shows in browser tab and in shared links.

**Fix:** "Mathnasium Langley Instructor Portal". Add `<meta name="description">` and `<meta name="theme-color" content="#dc2626">`.

### 29. No `.env*` in `.gitignore`
`.gitignore` only excludes `*.local`. Once you add a `.env`, you'll commit it.

**Fix:** Add `.env`, `.env.local`, `.env.*.local`.

### 30. `vercel.json` has no security headers
No CSP, no `X-Frame-Options`, no `Permissions-Policy`. Modern browsers default-deny most things, but explicit headers prevent your portal from being iframed onto a phishing site, etc.

**Fix:** Add `headers` block in `vercel.json`.

### 31. `getWeekOfMonth` defined twice with the *same* logic but different formula
`Schedule.jsx:436-438` uses `Math.ceil(date.getDate()/7)`. `lib/scheduler.js:80-82` uses `Math.floor((date.getDate()-1)/7)+1`. Equivalent for legal dates but error-prone. Pull into a shared util.

### 32. Recurrence labels are misleading
`Schedule.jsx:427-433` — "Odd weeks (1, 3, 5)" suggests "the 1st, 3rd, 5th occurrence of this weekday in the month" but the code matches by date-of-month range (week 1 = days 1-7). Most calendar apps use the former. Worth either renaming or changing logic.

### 33. `SALARY_STAFF` and other staff names live as hard-coded sets in the code
`Admin.jsx:751`, `lib/scheduler.js:37, 40-73`. Onboarding a new fixed-staff member requires a code change + redeploy.

**Fix:** Move to Firestore (e.g., a `config/fixedStaff` doc) so it can be edited from the admin panel.

### 34. No error boundary at the app root
A render error in any page brings the whole app down to a blank screen. React 19 has `<ErrorBoundary>` patterns; one wrap in `App.jsx` covers it.

### 35. No empty states / loading states for slow Firestore loads
Schedule.jsx, Admin.jsx render their grids immediately even before data arrives — looks like "no shifts" briefly, can confuse users.

**Fix:** Track a `loaded` flag per listener; show skeletons until first snapshot arrives.

### 36. No tests
Zero. The auto-scheduler in `lib/scheduler.js` is exactly the kind of pure function that's a layup to unit-test, and a regression there silently breaks payroll.

**Fix:** Add Vitest, write 5–10 tests for `generateSchedule`, `parseFixedShiftHours`, `calcTimeDiffHours`, `weekMatchesRecurrence`. Run them in CI.

### 37. Lots of inline computed expressions inside JSX
Lots of places like `Schedule.jsx:1080-1134` (giant inline IIFE) and `Admin.jsx:1066-1085` (nested filter+reduce in `<th>`) recompute on every render. Extract to `useMemo`.

### 38. Repeated time-formatting helpers
`fmtTime`, `fmtHHMM`, the format function inside `handleExportPayroll` — five copies of slightly different time formatters. DRY into `lib/time.js`.

---

## Suggested Order

If you want me to start fixing things, I'd suggest:

1. **Cleanup pass** (low risk, high signal): items #1, #8, #9, #21, #28, #29 — about an hour of mostly-mechanical edits.
2. **Security pass**: #2, #3, #6 — roughly half a day, plus you write Firestore rules with my help.
3. **Correctness bugs**: #4, #5, #7, #11, #12 — half to a full day.
4. **High-impact UX**: #13, #15, #16, #23 — half to a full day.
5. **Refactoring**: #25, plus extracting hooks — multi-day, do last.

Tell me which group (or specific items) you want to start with and I'll get going.
