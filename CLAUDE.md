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

### Terminating staff

`api/users/reject-user.js` serves **three modes** on one route (the 12-function
cap is why): `reject` (unchanged), `preview` (collect and return, delete
nothing) and `terminate` (collect, return, then erase). Preview is a separate
round trip on purpose — the export must be in the admin's hands before
anything is deleted.

Termination erases the Auth account, `users/{uid}`, and every document in
`OWNED_COLLECTIONS` (shifts, availability, openShifts, timeOffRequests, chat,
availabilityLog, notificationPreferences, auditLog). Field names there were
verified against live data — availabilityLog uses `targetUid`/`actorUid`,
auditLog uses `actorUid`/`targetUserId`, openShifts uses
`claimedBy`/`originalUserId`. A uid-only scan misses legacy docs, so shifts /
availability / timeOffRequests also sweep by `userName`.

Gated on owner-level roles (`super_admin`/`owner`/`director`/`admin_assistant`),
tighter than reject. The UI forces a JSON download of everything first, then
requires typing the person's full name. A `staff.terminated` audit entry is the
only trace left.

`mode: 'orphans'` lists names with records but NO user account, and
`mode: 'orphan-purge'` exports and clears one. Surfaced in Admin → Manage
Staff → **Orphaned records**. This exists because deleting a user's PROFILE
used to be all "Remove staff" did — 189 documents across ten people had
built up with no account attached, invisible to the app. Cleared 2026-09-02;
`Kaitlyn` (22 availability rows, uid `cSb7xnHq…`, distinct from the live
Kaitlyn MacDonald) was left deliberately pending a decision.

Purge re-derives the orphan list server-side and only acts on a name that
scan produced, so a caller can't hand over arbitrary uids. Docs whose uid is
`system` are excluded — those are the app's own chat messages, not a person.

**What it cannot remove:** chat messages *other people* wrote that mention the
name (someone else's content), and anything in Resend — Ratio only sends
through Resend and never creates contacts or audiences, so there is nothing
stored there to delete.

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
npm run test:rules          # firestore.rules, in the emulator (needs Java)
```

`eslint` here **exempts unused vars matching `/^[A-Z_]/`**, so dead
module-level SCREAMING_CASE constants are never flagged. Check by hand.

Project imports are extensionless (Vite resolves them); plain `node` cannot run
these files directly.

## Firestore shape

Top-level: `users`, `shifts`, `availability`, `openShifts`, `timeOffRequests`,
`centers`, `announcements`, `chat`, `auditLog`, `leads`-adjacent collections.

Per centre: `centers/{centerId}/config/main` (operatingDays, holidays,
instructionalHours, fixedStaff, salaryStaff, staffingBudget, autoHostNames,
staffRoles + staffRolePermissions),
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
- **Who COUNTS toward the ratio is a per-shift field, not a role guess.**
  `includedInRatio` on the shift doc, read only through `countsInRatio()` in
  `src/lib/ratioCount.js`. Set from the "Included in Ratio" toggle on
  Add/Edit/Open Shift, seeded from the role (Instructor/Lead/Manager on,
  everything else off) and then owned by whoever moves it. Every creation
  path stamps it; the role-derived default is the fallback for pre-existing
  docs only. **Do not add a seventh place that decides this from the role** —
  that was the bug. `STAFFING_COUNT_ROLES`, `countsTowardCoverage()`,
  `ON_FLOOR_ROLES`, `countsAsFloorSupply()` and `TEACHING_ROLES` are all gone.
- **Order: Leads outrank Instructors, then fewest shifts.** Nothing else.
- **The per-person priority tier (1/2/3) was DELETED** — "broken and doesn't work
  properly". Gone from the engine, Manage Staff, membership fields and auth
  defaults. Old docs may still carry a `priority` field; it's ignored and a
  regression test pins that. **Do not reintroduce it.** (`rolePriority` /
  `subPriorityInTier` in `CoverageGrid.jsx` are display sorting — unrelated.)
- **Month-at-a-time was removed.** A week is the maximum planning horizon.
- **Over-staffing is cheap** — idle instructors do training modules. Err high.
- **Trainees and volunteers never fill a ratio slot.**
- **STEAM / Summer Camp (`flexRole`) was REMOVED.** The picker is gone and
  nothing writes the field. Custom centre roles replaced it — make a role
  with "Counts toward the ratio" off. What survives is read-only support for
  58 shift docs dated 2026-07-13 → 2026-08-31 (none current), so August
  payroll bucketing and past coverage don't change; every survivor is marked
  `LEGACY`. **Don't add a new writer.**
- Headcount precedence: `config.perDate['YYYY-MM-DD']` > `config.perDay['Monday']`
  > `minPerDay`/`maxPerDay`.

### Supply & Demand — one chart per side, supply from the Student Scheduler

Two charts: **Elementary / Middle** and **High School**. They are counted apart
because an instructor stands on one side at a time — the old single centre-wide
chart counted five elementary instructors as help for four high schoolers and
read over-staffed nearly every half hour.

**Supply is the Student Scheduler**, not the rota:
`centers/{id}/schedulerInstructorAssignments/{date}` — `"<side>|<HH:MM>"` →
display names, which is what Neeru actually sets. `src/lib/floorSupply.js`
(`floorSupply`, pure, tested) turns that into per-side per-slot counts, and
falls back to `supplyFromShifts` (each shift's own sub-role) for a day whose
sides aren't set yet — a week out there is nothing to read. The card says which
of the two it is showing; `source` is `'scheduler'` or `'shifts'`.

Trainees and volunteers are on the sheet and are not a ratio slot, so `skip`
leaves them out of the count and names them under the chart. A name the roster
can't match still counts — the sheet is what happened, and a spelling we can't
match is not evidence of a trainee.

Demand per side was always there (`students.EM` / `students.HS` from the
bookings cache, less no-shows, plus walk-ins); it is no longer summed.

**The snapshot bug this fixed:** the single-card version called
`saveSnapshot(centerId, date, { ALL: … })`, but that function only reads `EM`
and `HS` — so every snapshot saved since was written as zeros, and the
auto-scheduler's "typical Monday" learnt nothing. All three live snapshots were
zeros. Per-side saving restores the shape the file always documented.

**Demand reads the scheduler's own three sources** through
`src/lib/slotDemand.js` (`demandBySide`): the bookings cache fanned across each
booking's length, minus anyone marked no-show or cancelled, plus walk-ins and
call-ins. The page previously read TWO PATHS THAT DO NOT EXIST —
`walkIns/{date}/entries`, and a `schedulerCheckIns/{date}/students`
sub-collection when check-ins are a single document — so both returned nothing:
no walk-in ever reached the chart and no no-show ever came off it. Subscriptions
now go through `scheduler-data.js`'s own `watchCheckIns` / `watchWalkIns`, so the
two screens read the same documents by construction.

Checked against live days before shipping: 15 Sept and 16 Sept 2026. The split
found High School one instructor short at 3:00pm on the 16th (4 students, 1
instructor) where the combined chart said "matched". On the 16th, Rahul read the
Student Scheduler's sixteen half hours aloud: supply matched on all sixteen, and
demand matched on all sixteen ONLY after walk-ins were counted (four that day —
two of them the students Acuity files as "Unknown", which staff add by hand).

### Coverage targets — what we want, day by day

`centerConfig.coverageModel[weekday] = { day: 12, '16:30': 14 }`. `day` is the
headline — what that whole day wants. The `'HH:MM'` keys are per-half-hour
overrides for when the afternoon isn't flat; a slot with none inherits the day,
so the flat case is one number and not eight. Read it through
`resolveCoverageModel()` / `targetFor()` in `src/lib/coverageModel.js` — never
raw. Every other staffing target in the app is a whole-day number
(`perDate > perDay > minPerDay`); this is the only one with slot resolution.

**It is the Supply & Demand chart, literally.** `components/SlotBarChart.jsx` was
lifted out of `SupplyDemand.jsx` so both pages draw through one component
(geometry and palette in `src/lib/slotChart.js`). Same bars, same marker lines,
same status pills underneath. S&D asks "enough instructors for the students
booked"; Coverage asks "enough for what we asked for" — so the series are named
`value` / `marker`, and the axis title and legend come from the caller. **Don't
recolour it in one place**: a green bar has to mean the same thing on both.

`CoverageModelCard` is the single surface, mounted on **both** Centre Analytics →
Coverage and the **Staffing Board** — Managers and Hosts can reach the board and
Centre Analytics is owner-tier, and one component means the two can't drift. It
self-subscribes (users, availability, shifts, time off) precisely because those
two pages hold different slices of data.

- **A bar per operating day**, height = instructors available, marker = that
  day's target, targets typed underneath. **Click a day** and the same chart
  redraws for that day's instructional half hours, with per-slot inputs.
- **It follows instructional hours, per weekday**, resolved for that actual date
  (`resolveInstructionalHours`), so Fri and Sat windows differ from Mon–Thu and
  a summer override moves them. It does NOT assume 3–7.
- **The bar counts PEOPLE, the expansion counts each half hour.** Somebody free
  3:00–7:00 is one instructor on the day bar and appears in all eight slot
  columns; summing slots would report them as eight.
- **Impact = instructors to FIND**, i.e. what availability can't cover. A slot
  whose rota is short but whose people are free is `Matched` with a blank
  impact — the rota gap is its own row. Mixing the two made a column read
  "Matched" with an impact of seven.
- **Who counts:** a shift goes through `countsInRatio()` as everywhere else.
  Availability has no shift to read, so `countsOnFloor()` asks the same question
  one step earlier via `roleRatioDefault()` — a custom role with "Counts toward
  the ratio" off is excluded without naming any roles.
- **No availability submitted is NOT nobody free.** Most days here have none on
  file. Those days read `No data`, sit out of the week's totals, and
  `classifySlot` will call a slot short on the rota but never unstaffable. Same
  rule as the weekly grid's failsafe. `No data` and `—` (no target set) are
  deliberately different pills.
- **Editing mirrors the config write rule**: owner tier, Enterprise, legacy
  Admin, or a Manager of that centre. **Hosts get it read-only** — they run the
  board but the rules don't let them write centre config.
- Writes use `updateDoc`, never `setDoc(merge)`: a merge write deep-merges maps,
  so a target you CLEARED would quietly survive.

**What it replaced — both look-back cards are gone.** "Average Coverage by Day"
(an 8-week average of distinct instructors against one daily number) and
"Average Instructional Hour Coverage" (the day × hour heatmap and its
lowest-coverage list). Both counted every name on a posted shift, so hosts,
trainees and the admin desk read as teaching cover, and both answered "what
already happened" when the question people brought to the page was "can we staff
next week". The Snapshot tile's "Coverage vs target" still uses the 8-week
`coverageRows`, and now counts the ratio properly.

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

### Missed sign-outs (signed in, never signed out)

An instructor taps in on Radius and leaves without tapping out. Radius
exports that row with a Time In and a blank Time Out.

**The bug:** the importer computed `actualHours` from the times (or the
Duration column), got `NaN`, and `continue`d — so the row never entered
`radiusData`. The shift then matched nothing, got `missingFromRadius:
true`, and the payroll table said **"Not in Radius"**, which reads as *they
never came in*. Someone who worked a full Saturday looked like a no-show.

`src/lib/signOut.js` (pure, tested) now models six states instead of one
boolean — `upcoming` / `absent` / `in-progress` / `open` / `self-confirmed`
/ `complete` via `signOutState()`. Open punches are kept at parse time with
`openPunch: true` and `actualHours: 0` — **zero, not a guess**: a Duration
without a tap-out isn't evidence, and inventing hours here would put a
fabricated number into payroll.

**An open punch is not automatically a missed sign-out.** Most of the time
it means the person is STILL AT WORK. A real export taken mid-afternoon on
8 Sept 2026 held 17 open punches and **14 were staff currently on the
floor** — emailing them would have asked people at their desks to confirm
they'd gone home. `signOutState()` therefore returns `'in-progress'` until
the shift's scheduled end plus `SIGNOUT_GRACE_MINUTES` (30) has passed;
only then does it become `'open'` and eligible for an email. The grace also
covers someone who finishes at 7:00 and taps out at 7:06.

Parsing lives in `src/lib/radiusTimesheet.js` (`parseRadiusRows`), not
inline in the import handler, and is tested against a real export saved at
`src/lib/__fixtures__/radius-export-2026-09-08.json`. The export's shape:
a leading blank column, a per-person section header row ("Aarav Agarkar
(I)"), one row per punch, and a "Total: 1354" subtotal — **only punch rows
carry a numeric Employee Attendance Id**, which is what separates the
three. Dates are DD/MM/YYYY, times 12-hour. Open punches have Time Out as
an empty string and BOTH Duration columns empty, but they do have an
attendance id, so they are real rows. Two employees have parentheses in
their actual names ("Jieun (Joanne) Lee", "Darshveer (Diya) Brar") — don't
use parens to detect section headers.

Flow:
1. Import flags them. An amber panel above the payroll table lists every
   open punch **whose shift has ended** with its clock-in and scheduled
   finish. Staff still on shift show a sky-blue "On shift now" chip in the
   table and are never listed or emailed.
2. Admin presses **Send sign-out requests**. Deliberately manual — the
   same period gets imported more than once (partial exports, corrections),
   and auto-sending would email staff about shifts still being checked.
3. Each person gets one email with a one-tap link. A token doc is written
   to `signOutRequests/{token}` FIRST; the email only goes if that
   succeeded, so no un-redeemable link ever reaches an inbox.
4. They confirm at `/confirm-signout?t=…` — **public route, no login**.
5. The shift gets `signOutConfirmedTime` / `signOutConfirmedBy:
   'instructor'` / `signOutConfirmedAt`, and renders purple
   "Self-confirmed sign-out".

**It is never marked `payrollResolved`.** Confirming is an answer, not a
sign-off — `payrollNeedsReview()` keeps self-confirmed rows in the
unresolved count until an admin clears them. That is the whole point of
labelling them.

**Token security.** 256 bits, document-id-as-token (a wrong guess simply
doesn't exist), single use, 14-day expiry, and it authorises exactly one
write: the sign-out time on the one shift it names, to the time the ADMIN
proposed. The redeemer supplies no time of their own, so a forwarded link
cannot be used to claim arbitrary hours. Redemption is a Firestore
transaction, so a double-tap can't apply twice. Rules give clients
**create only** on `signOutRequests` — no read (the id IS the secret, and
listing would hand over every live token), no update/delete (a client that
could edit `usedAt` could replay one).

**Where the endpoint lives.** `api/send-password-reset.js?action=confirm-signout`.
The 12-function cap left no room for a new file, and that host was chosen
because its security posture already matches — public by design, with no
privileged capability next door for a bug in the new branch to reach.
Multiplexing onto an authenticated endpoint would have put a public code
path beside privileged ones.

**Person totals.** Open punches sum to zero, so confirmed hours are folded
back in (`confirmedExtra`) and `diff` / `hasDiscrepancy` are computed
*after* that pass — deriving them from the raw punch sum left a person who
HAD confirmed still reading as hours short.

**Not yet possible:** detection only happens when an admin uploads the
XLSX, because the Radius API in `Ratio_Radius_API_Request_Brief.docx` is
still pending Mathnasium's approval. Item 2 in that brief is this feature;
a webhook would let the email go out the same evening instead.

### Availability failsafe on the weekly grid

`src/lib/availabilityFit.js` answers "did we schedule someone outside the
hours they said they could work?" — availability 4–7pm, shift 3–7pm. The
Manage Staff Schedule cell goes amber (`bg-amber-100` + inset ring, stronger
than the amber-50/40 used for holidays and pending time off) with an
"Outside availability" strip under the shift and a tooltip saying which shift
and by how much.

**It never blocks.** Scheduling outside availability is sometimes right.

Two deliberate exclusions:
- **No availability submitted → not flagged.** Live data: 960 shifts fit
  inside availability, 49 fall outside, **839 have none on file**. Colouring
  that third group would turn nearly half the grid amber and bury the 49 that
  matter. The absence of a green corner already says "they didn't tell us".
- **Time off wins.** An approved day off already paints the cell and overrides
  availability, so the clash check is skipped when `cellTimeOff` is set and
  the two can't argue on one cell.

Impact on real data: 49 of 1837 person-day cells (2.7%), worst week 7 cells.

**Who a note is for carries a colour.** `recipientChips()` turns any shape the
data takes — `toAll`, live `toUids`, imported initials like "MY", or nothing —
into chips, and `src/lib/personColor.js` gives each person one stable colour
hashed from their **uid** (so a rename doesn't repaint them, and no field, admin
screen or migration is needed).

Two rules keep it legible:
- **Solid means a person, pale means a state.** The card's pale pills are
  statuses (amber Open, indigo In progress, emerald Settled, red Overdue), so
  people are solid. Don't blur the two.
- **Red is reserved.** `YOU_COLOR` is the same red as the "this one is yours"
  rail, and `PERSON_COLORS` deliberately excludes it, so no colleague is ever
  handed the colour that means *you*.

The chip always carries initials and a name too — colour is a shortcut to
recognition, never the only thing saying who it's for. The home card tints the
SENDER's circle with the same function, so a person looks like themselves on
both surfaces.

**The composer is closed until asked for.** It used to sit open at the foot of
every view — on a desk of 121 open notes that is a large empty box and a
blinking cursor under a list people mostly came to READ. "Add entry" opens it at
the TOP, where the button is, rather than at the end of a long scroll. Closing
keeps the draft; only a sent note clears it, so a stray Escape can't bin a
half-written one.

**Deleting a note** is owner-tier only — `canDeleteNotes()` mirrors the rule's
`isOwnerLike() || isSuperAdmin()`, so Managers and Hosts run the desk but cannot
clear it. It lives behind a **tidy-up mode** (the bin next to the search box):
tick the notes, one confirmation naming the count, one batch write, one audit
entry (`desk.notes_deleted`). Deliberately not a cross on every card — the desk
settles notes rather than erasing them, and this exists for test rows and notes
typed into the wrong centre. No rules change was needed; the delete rule was
always there and the UI simply never offered it.

### The desk: four statuses, and due dates

A note is **Open · In progress · Waiting · Settled**. The middle two are
**sub-states of open**: `isOpen()` still means "not settled", so the sidebar
badge, the "for me" inbox, the settled archive and all 1,853 imported rows work
without knowing they exist. `normaliseStatus()` reads the spreadsheet's
hand-typed values as before.

**THE TRAP, and it bit twice:** the live listeners asked
`where('status', '==', 'open')` — an exact match. Under that query a note moved
to In progress **disappears off the desk** (and off the sidebar badge). Both now
use `where('status', 'in', LIVE_STATUSES)`. If you add a status, add it there.

`dueDate` is optional, `'YYYY-MM-DD'`, parsed at local noon (`new Date('2026-09-17')`
is the 16th in Pacific). It is **quiet by design**: overdue turns the chip red
and floats the note to the top of your own list, and that is all it does —
nothing is emailed, nothing auto-closes. A due date is a promise made to a
parent, not an alarm. A settled note is never "overdue"; a thing that is done
cannot be late. Anyone on the desk can set one, because the person doing the
work usually knows the real deadline.

`DeskHomeCard` puts what is waiting on you on **both** homes — Managers and
Hosts are on the phone-first one, the owner, directors and the admin assistant
on the classic one. It renders nothing for anyone who can't open the desk and
doesn't even run the query for them; `canUseDesk()` is asked exactly the way the
rules ask it. **No rules change was needed** — `status` and `dueDate` are just
fields on a note the desk tier could already write.

### Student Scheduler — notes and highlights

Per-student, PER-DAY, stored on the same check-in entry as status/tag/desk
(`centers/{id}/schedulerCheckIns/{date}` → `{ studentId: { note, highlight } }`).
Per-day is deliberate: these describe a session, not the child, and a note
carried forward for months would be worse than none.

- `setStudentNote` / `setStudentHighlight` in `scheduler-data.js`.
- Four fixed colours in `src/lib/scheduler-highlights.js`. The COLOURS are
  fixed (the sheet gets printed and carried around — it must mean the same
  thing every day); the LABELS are the centre's, editable, saved to
  `schedulerSettings.highlightLegend`.
- `highlightStyle()` carries `print-color-adjust: exact` **and** the WebKit
  prefix. Without them browsers strip the background when printing and every
  highlight silently vanishes on paper — the surface the feature is for.
- Writes: Leads / Managers / Hosts can set notes and highlights
  (`schedulerCheckIns` allows them). The LEGEND is a centre setting, so
  editing it is gated on `canSeeAdminPanel` to match the
  `schedulerSettings` rule.

### Roles and permissions

Three different things are called "role". Confusing them breaks access:

1. **`user.role`** — the PLATFORM role (`super_admin` / `owner` / `director` /
   `admin_assistant` / `admin` / `instructor`). Six fixed values, the security
   boundary, read by `firestore.rules`. Edited at **`/manage-roles`**,
   Enterprise-only. Not extensible.
2. **`centerMemberships[id].instructorType`** — the CENTRE role / job title.
   Created and edited in **Admin → Manage Staff → "Edit Role Permissions &
   Accessibility"** (the second sub-tab, needs `centre.settings`), stored as
   `staffRoles` on the centre config. Every user already has one.
3. **`subRoles`** — teaching capabilities. Unrelated to permissions.

`src/lib/roles.js` resolves a permission set from (1) + (2). Rules:

- **Permissions are ADDITIVE.** A centre role can only grant, never revoke —
  otherwise a bad edit locks an owner out of their own centre with no way
  back. To give someone less, lower their platform role.
- **Employment state is applied LAST.** Volunteer (no shifts, no chat) and
  Training (no shifts) beat every grant. Ordering is load-bearing; the
  equivalence suite caught it.
- **`roles.manage` can never be granted by a centre role** (`PLATFORM_ONLY_PERMISSIONS`).
  The editor is open to Centre Directors, so without that they could mint
  themselves Enterprise. Stripped on read, on write, and at resolution.
- **Built-in roles can't be deleted** — user records and past shifts name them.
- **A role's colour is the real one.** `assignmentColorHex()` and
  `staffTypeColorHex()` check `staffRoles` before the `assignmentColors` /
  `stateColors` palettes, so recolouring a role repaints the weekly grid.
  Centre Settings → Appearance keeps only what ISN'T a role: the three
  teaching levels (a shift's sub-role — one Instructor works all three) and
  the two shift states (Sick Pay, No-Show).
- The registry is stored **twice**: `staffRoles` (rich array, for the UI) and
  `staffRolePermissions` (flat `{name: [perm]}` map, for the rules — the rules
  language cannot search a list of maps). `permissionLookup()` derives the
  second. **Never write one without the other.**
- `AuthContext` derives `canSeeAdminPanel` / `canRunScheduler` /
  `canManageOperations` / `canSeeCenterSettings` / `canTakeShifts` from the
  permission set, and `ProtectedRoute` uses the same set. Prefer `can('x')`
  in new code. `roles.test.js` pins every
  (platform role x title x volunteer) combination against the original
  formulas, so that refactor granted and removed nothing.

- **A director title is the owner tier's to give.** It IS owner-level access
  (`isDirector()`), so `writesDirectorTitle()` in `firestore.rules` refuses one
  — any spelling, top-level or in any membership row, on create or update —
  from anyone but `isOwnerLike() || isSuperAdmin()`. A title already held is
  not a write, so Manage Staff can still save a director's other fields.
  Self-update also locks the top-level `instructorType` (setting your own to
  "Manager" used to make you one). Manage Staff hides the options via
  `canGrantDirectorTitle()` / `isDirectorTitle()` in `roles.js`. Tests:
  `tests/rules/directorTitles.rules.test.js`.

**Rules-language limits, measured in the emulator:** there is no
`exists()`/`all()` over a list or map — `isManagerAnywhere` /
`isHostAnywhere` call `.keys().exists(...)` and it errors, so today they only
work through a legacy top-level title (or `role: 'admin'`). Membership rows are
therefore checked by position (first five). A request also gets **1,000
evaluated expressions**, and running out denies: a `let` is re-evaluated at
each use, and `&&`/`||` operands all get evaluated when a denial is explained,
while `? :` evaluates one branch. Eight positions wrongly refused a Host.

Rules tests run against the emulator: `npm run test:rules` (needs Java).

### Budget

**The day model is the source of truth for the whole budget.** It lives at
`centerConfig.staffingBudget.weekdayModel`, is edited from Staffing Budget →
*Default day budget* (needs `centre.settings`), and falls back to
`WEEKDAY_DEFAULTS` in `budgetBuckets.js`. Always read it via
`resolveWeekdayModel(centerConfig)` and pass it down — `weekdayBudgetTotal(day,
model)` takes it as a second argument.

Defaults after STEAM was retired: Mon/Wed 48h, Tue/Thu 39h, Fri 36.5h, Sat
35.5h → **492h per fortnight**.

Everything derives from it:
- Manage Staff Schedule — each day header's denominator.
- Staffing Board — the same, plus which desks are budgeted.
- Staffing Budget — a pay period's target is `budgetForDates()`, the sum of the
  period's real days, holidays dropped. No 14-day-cycle arithmetic and no
  extra-day top-up: a 15- or 16-day period simply has more days in it.

**The bug this replaced:** the day model was a hardcoded constant only Manage
Schedule read, while the Staffing Budget page edited a separate per-period
number. Editing the budget moved one page and not the other, and the two had
drifted to 538h vs 688h for the same fortnight.

`staffingBudget.byPeriod['<period start>']` still holds **per-period
overrides**, and a period on/before `LEGACY_TARGETS_THROUGH` (2026-07-11) uses
the old global set. Those are the only cases where the two pages can differ;
the page labels which is in play and offers a one-click reset to the model.
Don't remove them — reviewed fortnights must keep the line they were judged on.

`bucketHoursForShift` splits a floor shift at the instructional window (inside →
Instructional, outside → Admin Hours); Host and Admin shifts are whole-shift
buckets. The Staffing Board measures against `instructional + host +
adminAssistant + adminHours` only — Online is budgeted the same day but
scheduled elsewhere. The `steam` / `summerCamp` buckets are **retired**
(`ACTIVE_BUCKETS` excludes them) but the keys survive so past periods and the 58
historical flex shifts still report.

## The new look (opt-in phone-first home for floor staff)

One alternative Home for the people who work shifts — instructors, leads,
trainees, volunteers. Their question is "am I on today, and does anyone
need anything from me?", they ask it on a phone, and the classic Home
answers it through a sidebar built for an owner's eighteen links behind a
hamburger.

**It started as four doors** — owner, director, host, instructor — and the
other three were **removed after review**: their figures depend on live
Radius reads and cross-collection maths this app cannot yet do quickly or
completely, so the numbers they showed were not trustworthy. A dashboard
that is confidently wrong is worse than no dashboard, and leadership
already has pages whose numbers are known-good. Only the instructor door
survived, because every figure on it is a direct read of that person's own
shifts, the open-shift board, or announcements.

If the Radius API in `Ratio_Radius_API_Request_Brief.docx` is ever
approved, the other three become worth revisiting — with real data.

### Who gets it

`canUseNewLook()` in `src/lib/newLook.js` reads as **"not leadership"**
rather than a list of job titles, so a custom centre role invented in
Manage Roles lands on the right side without a code change. `isOwnerLike`
(owner / admin-assistant / super-admin / director) and plain `admin` are
excluded; everyone else is floor staff. `newLookActive()` is the check
callers want: eligible AND opted in — a leftover localStorage value from
when the other doors existed cannot resurrect anything.

**OFF by default, per uid.** Nobody meets a redesigned portal because a
deploy landed, and signing out of one account into another does not carry
the setting across.

### Three ways back

1. **The toggle** at the bottom of the sidebar, and a **"Classic view"**
   link on the page itself — needed because on a phone the sidebar is
   behind a hamburger.
2. **It reverts itself.** `src/pages/HomeSwitch.jsx` wraps it in its OWN
   error boundary. This matters: the app-wide ErrorBoundary in App.jsx
   replaces the entire UI — sidebar included — so a crash here would take
   the toggle down with it and strand the user. It has already earned its
   keep once, when the director board crashed in production. On failure
   the classic Home renders, the opt-in is switched back off so a reload
   doesn't loop, and a line explains what happened.
3. **`git revert`** of the commit.

### Mobile

`MobileTabs` in `Layout.jsx` renders a bottom tab bar — Today / Schedule /
Shifts / Chat — on phones only (`lg:hidden`, where the sidebar returns),
and only when the new look is on. Shifts is hidden without `canTakeShifts`;
Chat is hidden for volunteers, who get no team messaging. Targets are
`min-h-[56px]`, past the 44px minimum. `.nl-tabbar` carries
`env(safe-area-inset-bottom)` for the iOS home indicator, and the page ends
in `pb-28` so nothing hides behind the bar.

### Shape of the change

Only four existing files are touched: `index.html` (the Outfit webfont),
`App.jsx` (route through `HomeSwitch`), `Layout.jsx` (toggle + tabs), and
`index.css` (tokens). `Home.jsx`, `Schedule.jsx`, `Admin.jsx` and
`ShiftBoard.jsx` are unmodified. All new CSS is scoped under `.nl`, so a
classic page renders identically whether the block exists or not. Muted
text is 5.1:1 on paper — the classic `text-gray-400` is 2.54:1, which
fails WCAG AA.

### Which side am I on, and when do I move

Neeru assigns instructors to a side — High School or Elementary — for each
half hour, in the Student Scheduler, before the day. Until now the only
copies were her screen and the printed sheet, so instructors walked in
asking out loud. The floor-staff home now shows it under their shift.

`centers/{id}/schedulerInstructorAssignments/{YYYY-MM-DD}` is a flat map
keyed `"<side>|<HH:MM>"` holding **display names**:

```
{ "EM|15:00": ["Kaitlyn MacDonald", "Jason Soo"],
  "HS|17:00": ["Luke Huang", "Jason Soo"] }
```

Verified against all 73 live documents: sides are only ever `HS` / `EM`,
slots are half-hourly 10:00–18:30, no other keys appear, and slots are
sparse (an unassigned half hour has no entry).

`src/lib/sideAssignments.js` collapses consecutive same-side slots into
blocks, so eight half hours read as "3:00–5:00 Elementary, 5:00–6:30 High
School". Its tests run against a **real day copied out of Firestore**.

Three rules that are easy to get wrong, all pinned by tests:

- **A gap does not merge.** Unassigned 4:00–4:30 with Elementary either
  side is two blocks, and is NOT a switch — "you move to Elementary at
  4:30" when they never left would be nonsense.
- **Before the first block, nothing is a "move".** Somebody on one side all
  day was being told "you move to High School at 5:00" while still at home.
  `nextSwitch` returns null before the day starts; a gap mid-day still
  points somewhere, because that IS useful.
- **A wrong side is worse than no side.** Matching is exact display name,
  which covers every current member of staff. A bare first name ("Bri",
  "Sofie" appear historically) matches ONLY when one person at the centre
  has it; ambiguous entries are ignored rather than guessed, because
  someone told the wrong side walks to the wrong end of the room and
  trusts it.

The roster needed for that disambiguation is fetched **only** when the
exact pass finds nothing, keeping ~50 user reads off the common path.

**Rules change:** `schedulerInstructorAssignments` read widened from
`canRunFloor` to `canRunFloor || isMemberAt(centerId)` — any staff member
of that centre. It is the least sensitive document in the scheduler (staff
names and a side; no students, contacts or pay), and every signed-in user
can already read all of `users` and `shifts`, so it exposes strictly less
than what is already open. Writes are unchanged. `isMemberAt` is a new
helper meaning "you work here", deliberately broader than any title.
Covered by five tests in `tests/rules/shifts.rules.test.js`, including that
another centre's manager is still refused and that instructors cannot
write.

### Centre Events — meetings and fun days

`centers/{centerId}/events/{id}` — `{ title, date, startTime?, endTime?,
type, note }`, types `meeting | fun-day | training | other`. Managed at
`/events` (admin+), shown to every instructor on their home.

**Why its own collection rather than announcements:** announcements carry
the date they were POSTED, not the date the thing happens, so nothing could
sort or group by it. "Fun Day" existed as an announcement *category* and had
never been used once in a year — which is what a feature with no home looks
like. A calendar needs real dates.

`src/lib/centreEvents.js`:

- **`weekAhead`** merges shifts and events into ONE date-ordered list. The
  question is "what's happening this week", not "shifts, and separately,
  events" — splitting them makes the reader do the interleaving. Drafts and
  cancellations are excluded; an all-day event sorts before timed ones.
- **`monthAhead`** adds the centre's configured holidays as closures, so a
  closed day never needs entering twice. Closures come free.
- **`monthWindow`** runs from TODAY to month end, not from the 1st — someone
  opening it on the 28th wants the next few days.
- Local-noon date parsing throughout; `new Date('2026-09-17')` is the 16th
  in Pacific.

`eventTypeShort()` feeds the badge ("Meeting") while `eventTypeLabel()`
feeds prose ("Staff meeting") — an event titled "Staff meeting" with a
"Staff meeting" badge is the title repeating itself.

**Rules:** read is `canRunFloor || isMemberAt` (staff can see the meeting
they're expected at); writes are the announcements tier (owner /
super-admin / admin) because an event IS an announcement with a date, and
deliberately narrower than the floor tools. Six emulator tests, including
that managers and hosts cannot write and instructors cannot delete.

**The empty-card risk:** "What's on" renders nothing at all when there's
nothing, rather than an empty shell — an always-empty card trains people to
ignore the space. Worth watching whether anyone actually maintains it; the
unused fun-day category is the warning from last time.

### Mobile and tablet

The floor-staff home is one column on a phone and **two from `md`** — left
is what's happening to you now (shift, sides, anything needing action),
right is what's coming (this week, what's on, pay, announcements). Reading
order, not an arbitrary split.

Five tabs, not six: Home · Schedule · **Job board** · My Pay · Chat, with
**Settings behind the avatar** in the mobile header. Six tabs on a 375px
screen is 62px each; Settings is touched about twice a year and doesn't earn
a permanent sixth of the screen. `Shifts` was renamed `Job board` — the
centre's own word for it.

### My Pay — a person's own projection

`/my-pay` shows hourly staff their own pay period: the shifts in it, hours,
sick-leave standing, stat-pay eligibility, and — once they enter an hourly
rate — an estimate of gross.

**It is not payroll and says so repeatedly.** No deductions (tax, CPP, EI),
and the caveat sits WITH the number rather than in a footer: "This is an
estimate, not a payslip… what you're actually paid comes from QuickBooks."

Two rules the page follows throughout:

- **Hours are the fact; money is the estimate.** Without a rate it leads
  with HOURS, not "$0.00" — a zero reads as an answer. `grossPay` returns
  `null` rather than 0 when there's no usable rate, and rejects absent hours
  (`Number(null)` is 0, not NaN — the same trap as `ratioOf`).
- **It mirrors Manage Payroll instead of recomputing it**, so the two can't
  drift: `pay hours = 0 if no-show, else payHoursOverride ?? scheduled`.
  **There is deliberately NO OVERTIME**, because Ratio's payroll doesn't
  compute it either — inventing time-and-a-half would disagree with the
  money that actually arrives, and people budget against this.

Pay periods are 11th–25th and 26th–10th (`periodFor`), matching the Manage
Payroll default. Sick leave and probation reuse the settled figures (5 days,
90 days); a missing hire date counts as ELIGIBLE exactly as the payroll page
treats it, and the UI says the date is missing rather than hiding the
assumption. Stat pay comes from `statPay.js` — the page shows the 15-of-30
qualifying-day progress, not just yes/no.

**Who sees it:** `isHourlyPaid()` excludes volunteers (unpaid) and anyone in
`centerConfig.salaryStaff` (paid outside the hourly sheet). Both would get a
number that isn't how they're paid, so the page turns them away with the
reason rather than rendering an empty state. The route gates itself as well
as the nav, since the URL is reachable directly.

**The hourly rate** lives at `users/{uid}/private/pay` (`src/lib/payRate.js`)
— NOT on the user document, which every signed-in user can read; a wage
there would show all 33 staff each other's pay. That private subtree is
readable by the person plus owner/super-admin/admin, so **leadership can see
what somebody entered**. That is a deliberate choice, and the box says so in
plain words before you type: "Other instructors can't see this. The centre
owner and admins can."

### Render tests exist now, and why

`src/pages/homes/InstructorHome.render.test.jsx` renders the page in jsdom
with auth and Firestore stubbed. It was added after the SECOND render-time
crash to reach production in a row — the Manage Payroll TDZ bug, then the
director board — because `vite build`, eslint and 700 unit tests all
inspect code and **none of them run React**. The only thing that catches a
component which throws while rendering is rendering it.

Two traps it caught immediately, both of which had shipped:

- `availabilityConflict(dayShifts, dayAvail)` takes **every** availability
  row for that person on that day, not one document. Rows are one per
  person per day and a person can have several; `availabilityWindows`
  iterates the argument, so a single document threw
  `(dayAvail || []) is not iterable`. Merging matters on its own too:
  10–2 plus 2–6 is 10–6 continuously, and judging rows separately invents
  a clash at the seam.
- `describeConflict(fit)` takes a **fit**, not the `{conflicts, windows,
  worst}` wrapper `availabilityConflict` returns.

Note `esbuild: { jsx: 'automatic' }` in `vite.config.js`: components rely
on the automatic JSX runtime, the react plugin supplies it for the app
build, but vitest transforms through esbuild, which defaults to the classic
runtime — so every component rendered in a test died with "React is not
defined" until both pipelines agreed.

Also mock Firestore **by collection**. A mock handing every listener the
same rows let the availability listener receive shift documents, and a test
passed for the wrong reason.

## Signup creates a pending instructor, and nothing else

`allow create` on `/users/{uid}` used to be "is this your own uid", so anyone who
could reach the signup page could write themselves `role: 'owner'` and read
`centers/{id}/leads` — parent names, emails, phone numbers. Closed 2026-09-16.

- **The rules** (`isPlainSignup`) allow a self-created account only as
  `role: 'instructor'`, `approved: false`, and with a title that grants nothing
  (Instructor / Training / Volunteer / none), top-level **and** in every
  `centerMemberships` row — positional over five rows, same shape and same
  reasons as `writesDirectorTitle`.
- **`AuthContext.signup` no longer auto-promotes** the first account at a centre
  to owner+approved. That convenience is what forced `create` to accept any
  role: the rules cannot run the "is there an owner yet" query it depended on.
  **A new centre's first owner is promoted by hand in Manage Roles**, like every
  other role change. The signup page's own copy always claimed accounts were
  "always created as plain Instructor" — now that is true.
- `tests/rules/signup.rules.test.js` opens with the exploit written the way an
  attacker would (create as owner, then go for the leads). Reverting the rule
  fails five of its tests — checked.

## Managers are the admin — the Admin platform role is retired

Decided 2026-09-14. Only two accounts were ever left on `role: 'admin'`: the
shared "Admin Team" login and the Manager. Everything the Admin role unlocked
is now unlocked by the **Manager job title, at that centre** — so a Manager is
made in Manage Staff, per centre, without an Enterprise login.

- **Rules:** `isAdminOrManagerAt(centerId)` replaced `isAdmin()` in every
  admin-only rule (announcements, Management Chat / `centerLeadership`,
  schedulerStudents/Aliases/Settings, meetings in `events`, `config`,
  `connectors`, `demandSnapshots`, deleting swap posts). It uses
  `isManagerOfCentre` — a MEMBER of that centre titled Manager there —
  NOT the older `isManagerAt`, which also accepts a legacy top-level
  `instructorType` at any centre. A mutation test proved the difference:
  with `isManagerAt`, a Burnaby Manager got into Langley on 10 paths.
  Staff private details (contact, pay rate): `isManagerOfUsersCentre`,
  the Manager's primary centre only. Tests: `tests/rules/managers.rules.test.js`.
- **Client:** the built-in Manager seed carries `ADMIN_PANEL_BASE`;
  `src/lib/managementTier.js` (`isCentreManager`, `inManagementChat`) mirrors
  the rules for the Management Chat link, page, member list and badges, and the
  Online channel. Manage Roles no longer offers "→ Admin"; demotions land on
  Instructor.
- **Server:** `api/_lib/staffAccess.js` decides who may add / approve / remove
  staff (owner tier, legacy admin, or Manager of that centre) and the removal
  ranking (a Manager ranks with Admin; a director by title with a director by
  role). Directors were missing from both endpoints' first check and could not
  add staff at all. Only the owner tier may create a director-titled account.
- **Data:** `scripts/managers-take-over-admin.cjs` (dry run unless `--apply`)
  adds the admin grants to each saved Manager role and moves admin-role
  accounts that hold a Manager title to `instructor`. It refuses the account
  switch until the DEPLOYED rules contain `isAdminOrManagerAt`. Accounts with
  no Manager title (Admin Team) are listed, not touched.

`isAdmin()` / `isAdmin` stay in place until the last admin-role account is gone.

## Ratio Games — the one thing everybody gets

A short maths game a day, a per-centre board, a monthly winner. Phase 1 is
**Sprint 60** (60 seconds of mental arithmetic); the roster and the plan for the
rest are in the draft proposal.

**OFF UNTIL THE OWNER TURNS IT ON**, per centre: `gamesEnabled` on
`centers/{id}/config/main`, read through `gamesEnabled(centerConfig)` — a
missing value is OFF. Off hides the page, the sidebar link and the home card,
and deletes nothing. The switch lives in Centre Settings and **only the owner
and Enterprise can move it**: the rules let every other config writer (Admin
Assistant, Director, Manager, a role granted `centre.settings`) save the
document as long as `gamesEnabled` is unchanged, so they keep the rest of the
page without being able to start or stop a contest with a prize attached.

**ONCE ON, EVERY ACCOUNT PLAYS.** The route carries no permission, the page
makes no check, and the rules gate on centre membership only — volunteers and
trainees included, who are turned away from Team Chat and the Job Board and
otherwise get the barest portal in the app. That is the point of it. Who is
eligible for the **prize** is deliberately NOT in the code: it is a decision
made when the gift card is handed over, so it can change without a deploy.

- `src/lib/ratioGames.js` — pure, tested: seeded question generators, scoring,
  the board. **No `Math.random()`**: questions come from `seedFrom(centre|date)`,
  so everyone here gets the same ones and nobody can reroll until they like them.
- **Three caps, each load-bearing.** Best 3 games a day (or the winner is
  whoever had the quietest shift), best 12 days a month (or the board just ranks
  hours worked, which is unfair to part-timers and looks it), streak bonus capped
  at 60. Ties break on FEWER runs — sharper, not longer.
- **One ranked run a day, enforced by the document id.**
  `centers/{id}/gameScores/{uid}_{gameId}_{date}`, create-only, and the rules
  check the id matches the fields inside it — otherwise a second run could just
  be filed under another name. Practice runs write nothing. `ranked` is decided
  when a run STARTS and carried to the end, so a good practice run can't be
  promoted after the fact.
- **What the rules cannot do** is check the maths was done — it runs in the
  browser and `api/` is at 12/12, so no server can mark it. Hence: every row
  carries its duration, the board is visible to all staff, scores are immutable
  (no update, ever), and a Manager or the owner tier can delete a bogus row.
  That deletion is the ONLY way a row goes. The prize is a modest gift card, in
  proportion to the effort of cheating for it.
- **Never a performance measure.** Optional, on their own time, and the page says
  so — staff are hourly, and a contest that feels expected is unpaid work.

## Page names and job titles — one list

Every page's name lives in `src/lib/pageNames.js` (`PAGES`). The sidebar,
the phone tabs, each page's own title, Home shortcuts, the browser tab
(`documentTitleFor`) and sentences that send someone somewhere ("it's on the
Job Board") all read from it. **Import the name; don't type it.**

Rules: the sidebar name is the name everywhere (no short forms on phones);
personal pages start with "My" (My Schedule, My Pay, My Account); Canadian
spelling, Centre. "Job Board" replaced "Shift Board" — it's the centre's own
word, from Rahul's sketch of the phone home. The header reads
"Mathnasium · Staff Portal" for everyone.

`pageNames.test.js` scans every non-test source file (comments excluded) for
retired names — Shift Board, Scheduler Creation, Notification Preferences,
Manage Users, Instructor Portal, Account Details, Centre Chat, Admin Panel,
"center owner" and others — and fails on any that come back.

Job titles: the STORED names stay as they are ("Dir. of Education",
"Center Director", "Training", "Lead", "Admin") because shift docs, payroll
buckets, the rules and exact-match checks key on them. Everywhere a person
reads one goes through `roleDisplayName()` in `src/lib/roleLabel.js` →
Director of Education, Centre Director, Trainee, Lead Instructor, Admin
Assistant. Dropdowns keep the stored value and show the display name.

`components/Layout.render.test.jsx` renders the real sidebar for all ten roles
against Langley's saved role registry: every link uses its page name, everyone
but volunteers can reach a chat (owner-shaped sidebars get **Chats**, which
Directors and the Admin Assistant used to lack), and each card shows the
right title.

## Cole — the mascot each person picks

The A+ at the top of the sidebar (and the phone header, and sign-up) is now
**Cole**, Ratio's mascot, in one of four outfits: `classic` (Cole),
`coach` (Coach Cole), `cool` (Cool Cole), `bot` (Cole-bot). Each person picks
one at sign-up and can change it on Account → "Your character"; it's stored as
`users/{uid}.mascot` and read through `resolveMascotId()`, so a missing or
unknown value draws the original. No rules change was needed — self-update
already allows any field except role / approval / centre ones.

`src/lib/mascots.js` builds every drawing as SVG markup from one rig
(shaded balls, face, gloves, poses) and `components/Mascot.jsx` shows it as an
`<img>` data URL — its own document, so clip-path ids can't collide, and no
markup is injected. Poses (`stand`, `thumbs`, `wave`, `cheer`, `think`,
`peace`, `coach`) exist for empty states and celebrations; only the head
crop is used so far. `mascots.test.js` parses all 56 combinations, because a
typo in one pose would be a broken image for exactly the people who picked it.
The old Mathnasium `Logo.jsx` was deleted with its last use.

## Server-side dates: never use UTC

Vercel Lambdas run UTC; the centre runs Pacific. From ~5pm local the
server's own calendar date is already **tomorrow**, and `shift.date` is
centre-local wall clock — so `new Date().toISOString().slice(0,10)` as
"today" was a day ahead every evening. It hid tonight's open shifts from
the Owner Assistant (`_tools.js` filters `date >= today`) and told the
model the wrong date outright.

Use `api/_lib/centreDate.js` — `centreToday()`, `centreYMD(d)`,
`centreOffsetYMD(n)`, honouring `CENTER_TZ` and DST. `_lib/` isn't routed,
so it costs nothing against the 12-function cap.

## Acuity feed cache — why the scheduler pages are fast

Measured 2026-09-15 for Langley: Acuity's iCal export is **6.8 MB, 16,093
events, 26-53 seconds** to generate. It **ignores** `minDate`/`maxDate`/
`start`/`end`/`after` and sends **no ETag or Last-Modified**
(`cache-control: no-cache`), so it can be neither narrowed nor conditionally
fetched. Student Scheduler and Supply & Demand paid that on every load, plus
449 Firestore reads (settings + 361 students + 87 aliases).

Now the feed is parsed **once** into `centers/{id}/schedulerDays/{YYYY-MM-DD}`
— one small document per date (~10-17 KB; the biggest day in a year of data is
48.7 KB, well inside the 1 MB limit). Pages **subscribe** to the one date they
need via `src/lib/schedulerFeed.js` (`watchFeedDay`), so they paint from
Firestore's local cache and then update themselves when a refresh lands. **Per
load: 45s → ~0.1s, 449 reads → 1.**

- Refresh: `POST /api/scheduler/appointments?action=refresh-feed&centerId=`.
  Fire-and-forget — `requestFeedRefresh()` never blocks a page. A page asks for
  one when what it has is older than `FEED_TTL_MS` (60s), and there's a manual
  Refresh button on both pages next to "Bookings updated N min ago".
- `maxDuration: 60` is set for that function in `vercel.json`. The default 10s
  would kill every refresh — the download alone is ~27s.
- **Only changed dates are written.** A hash per date lives in
  `schedulerCache/meta`; a normal refresh rewrites none or one. Dates that lose
  all bookings are emptied once, compared against the empty hash so they aren't
  re-cleared on every refresh forever.
- `REFRESH_LOCK_MS` (3 min) stops concurrent refreshes stampeding.
- Rules: `schedulerDays` and `schedulerCache` are **read-only to every client**
  (`allow write: if false`) — written solely by the Admin SDK. Clients subscribe
  to them, so a write path would let one person put wrong students on everyone's
  screen.
- Cold cache (nothing ever written) builds synchronously on first GET, so the
  first load after deploy is correct though slow. Every load after is fast.

**If a new /centers subcollection works on an owner account and not on anyone
else's, you forgot to deploy the rules.** There is a catch-all at the bottom of
`match /centers/{centerId}` granting read to `isOwnerLike() || isSuperAdmin()`,
so an undeployed path still works for owners and fails for Leads, Managers and
Hosts. That is deliberate — a missed path degrades to "only owners can see it" —
but it makes a missing deploy look like a role bug. `npx firebase deploy --only
firestore:rules` is a SEPARATE step from `git push`. This cost an afternoon on
`schedulerDays`; `watchFeedDay` now surfaces `permission-denied` in plain words
instead of rendering an empty day.

**Two performance traps in this file, both fixed, both easy to reintroduce:**
`tzParts` now builds its `Intl.DateTimeFormat` **once per timezone**, not once
per call; and a refresh **buckets appointments by date in one pass** instead of
handing all 16,090 to `groupSchedule` for each of 233 dates. Together those were
**200.9s of parsing, now 0.9s — 228x** — verified byte-for-byte identical output
on all 233 dates. Don't reintroduce a per-call formatter or an unbucketed
`groupSchedule(allAppts, date)` loop.

Check-ins, walk-ins and instructor assignments were always separate live
Firestore listeners and are untouched by any of this.

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
