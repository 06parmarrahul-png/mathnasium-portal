# Ratio — Mathnasium Instructor Portal

Multi-centre staff portal: scheduling, payroll, students, leads, inventory.
Live at **ratiosolved.com**. Primary centre id is `langley`.

## Stack

| Thing | What |
|---|---|
| Frontend | React 19 + Vite 8, React Router 7, Tailwind 4, `lucide-react` icons, `date-fns` |
| Backend | Firebase — Firestore + Auth. Project `mathnasium-langley` |
| Serverless | Vercel functions in `api/` |
| Email | Resend (`RESEND_API_KEY`, `RESEND_FROM`) |
| Payments | Stripe (`api/stripe/`) |
| AI assistant | Gemini (`GEMINI_API_KEY`, `api/assistant/`) |
| Bookings | Acuity iCal feeds, parsed server-side |
| Tests | Vitest |

## Deploy

**Push to `main` on GitHub → Vercel auto-deploys.** There is no deploy command.
The user works in VS Code — give them copy-paste `git` commands, one command per
fenced ```bash block, never a `$` prefix.

```
cd "/Users/wulfe/Desktop/Ratio Company/Ratio Website"
git add -A
git commit -m "..."
git push
```

Firebase is a **backend, not a deploy target**. Pushing code doesn't touch it.
Only `firebase deploy --only firestore:rules` when `firestore.rules`,
`storage.rules` or `firestore.indexes.json` change.

### Hard constraint: 12 serverless functions

Vercel Hobby caps the project at 12, and `api/` is **exactly at 12**. Do not add
a new file under `api/`. Multiplex onto an existing handler with a query param —
see `api/scheduler/appointments.js`, which serves both a single day and a date
range, and also handles a student-sync POST. Files prefixed `_` (`api/_lib/`,
`api/assistant/_tools.js`) aren't routed and don't count.

## Before you change anything

```
npx eslint src/ api/        # must be clean
npx vitest run src/lib/     # must all pass
npx vite build              # must succeed
```

`eslint` here **exempts unused vars matching `/^[A-Z_]/`**, so dead
module-level SCREAMING_CASE constants are never flagged. Check by hand.

Project imports are extensionless (Vite resolves them); plain `node` cannot run
these files directly.

## Firestore shape

Top-level: `users`, `shifts`, `availability`, `openShifts`, `timeOffRequests`,
`centers`, `announcements`, `chat`, `auditLog`, `leads`-adjacent collections.

Per centre: `centers/{centerId}/config/main` (operatingDays, holidays,
instructionalHours, fixedStaff, salaryStaff, staffingBudget, autoHostNames),
plus `schedulerStudents`, `schedulerAliases`, `schedulerSettings/main`,
`schedulerTemplates`, `demandSnapshots`, `walkIns`, `inventory`.

### The single biggest gotcha: resolve per-centre fields

`instructorType`, `subRoles`, `approved`, `isVolunteer`, `maxDaysPerWeek` and
`guaranteed` live under `centerMemberships[centerId]`, with the top-level value
only as a fallback (`PER_CENTRE_FIELDS` in `src/lib/centerMembership.js`).

**Always `resolveUserForCenter(u, activeCenterId)` before reading them.**
Admin.jsx does this as `usersForCentre`. Reading raw fails *silently*: Rahul's
top-level `subRoles` is `['Elementary']` while his Langley membership is
`['Elementary','Host']`, so a raw read once made zero of 51 users host-capable
and locked the designated host out of the host desk.

## Scheduling domain

Two engines, sharing libraries:

- **`src/lib/scheduler.js`** → `generateSchedule()`. Availability-driven. Called
  from one place: `src/pages/Admin.jsx`. Pure, unit-tested.
- **`src/pages/StaffingBoard.jsx`** (`/staffing-board`) → demand-driven. Reads
  real bookings, emits shift slots, human assigns people.

Supporting pure libs, all tested: `demand-staffing.js` (bookings → per-date
min/max), `shift-shaping.js` (demand curve → contiguous shift blocks),
`board-budget.js` (placements → budget buckets), `budgetBuckets.js`,
`subRoles.js`, `centerMembership.js`, `timeOff.js`, `statPay.js`.

### Rules that are settled — do not re-litigate

- **Ratio: aim 1:3.5, floor 1:4.** `min = ceil(peak/4)`, `max = ceil(peak/3.5) + cushion`.
- **Order: Leads outrank Instructors, then fewest shifts.** Nothing else.
- **The per-person priority tier (1/2/3) was DELETED** — "broken and doesn't work
  properly". Gone from the engine, Manage Staff, membership fields and auth
  defaults. Old docs may still carry a `priority` field; it's ignored and a
  regression test pins that. **Do not reintroduce it.** (`rolePriority` /
  `subPriorityInTier` in `CoverageGrid.jsx` are display sorting — unrelated.)
- **Month-at-a-time was removed.** A week is the maximum planning horizon.
- **Over-staffing is cheap** — idle instructors do training modules. Err high.
- **Trainees and volunteers never fill a ratio slot.**
- Headcount precedence: `config.perDate['YYYY-MM-DD']` > `config.perDay['Monday']`
  > `minPerDay`/`maxPerDay`.

### Fixed staff and the two desks

- **Host = a CAPABILITY in `subRoles`**, checked with `hasCapability(u.subRoles,
  'Host')`. NOT `instructorType === 'Host'`. Rahul Parmar is the designated host
  (`autoHostNames`).
- **Admin assistant = `instructorType === 'Admin'`** — there is no 'Admin'
  capability. Rachel Rozelle, the only one, works 10:00–14:00 Mon–Fri (never
  Saturday — there's no Saturday `adminAssistant` budget). Never takes a floor
  shift.
- **Management** (Vinod, Neeru, Sabrina) comes from `centerConfig.fixedStaff`,
  which is **empty `{}`** at Langley, so it falls back to `FIXED_SCHEDULES` in
  `scheduler.js`. Vinod is Off Mondays; Neeru is Off Fridays.
- **Salaried staff** (`centerConfig.salaryStaff` = Neeru, Vinod) are shown as
  plain working hours and **excluded from the hourly budget**, same as the
  Staffing Budget page. Counting them makes every day read as over budget.

### Budget

`WEEKDAY_DEFAULTS` in `budgetBuckets.js` is the per-DAY model: Mon/Wed 52h,
Tue/Thu 43h, Fri/Sat 39.5h, split across instructional / online / steam / host /
adminAssistant / adminHours. `bucketHoursForShift` splits a floor shift at the
instructional window (inside → Instructional, outside → Admin Hours); Host and
Admin shifts are whole-shift buckets. The Staffing Board measures against
`instructional + host + adminAssistant + adminHours` only — Online and STEAM are
budgeted the same day but scheduled elsewhere.

## Inspecting live data (read-only)

Service account at `../Pricing and Codes/mathnasium-langley-firebase-adminsdk-*.json`.
Run scripts **from inside `Ratio Website/`** so `firebase-admin` resolves. Some
queries need composite indexes — drop `orderBy` and sort in JS instead.

## Working style the user expects

- **Verify, never assume.** Read the real code and the real data before building.
  The thing very likely already exists. State what exists and what the actual gap
  is *before* writing anything.
- Deliverables get lint + tests + build run, and UI changes get looked at.
  The Admin and Staffing Board pages are behind Firebase auth, so verify visuals
  by rendering the component's markup against `dist/assets/*.css` on a scratch
  static server.
- Say plainly what was and wasn't verified. Don't claim a UI works if you
  couldn't sign in to see it.

## Known issue

`scheduler-app/.git/config` (the sibling standalone Acuity dashboard, a separate
repo) has a **live GitHub PAT committed in its remote URL**. It needs revoking.
