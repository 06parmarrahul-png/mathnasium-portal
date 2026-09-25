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

### The desk: editing a note

A note can be rewritten — **who it's for, what it says, the day it was logged**
— from an Edit button on the card. `NoteEditor` in `ManagementDesk.jsx`, with
the pure parts in `deskNotes.js`: `noteDraft()`, `validateDraft()`,
`editFields()`, `editLabel()`.

**IT IS DELIBERATELY NOT THE COMPOSER AGAIN.** A note is written as one line and
`deskParse.js` reads the address off the front of it, which is a good way to
write and a bad way to correct: the commonest reason to edit at all is that the
reading was wrong — the initials matched the wrong person, or nobody. Offering
the same grammar would make the same guess twice, and the stored `body` has
already had the address stripped off it, so re-parsing would re-address a note
whose sentence happens to open with two capitals. So nothing in the editor is
inferred: tick who, type what.

Three things worth knowing before changing it:

- **`subject` is kept in step with `body`.** The desk renders the body, but
  `DeskHomeCard` and `searchBlob()` read the subject, so a corrected note whose
  subject was left behind would carry on saying the old thing in the two places
  people are most likely to see it from. When a note is *about* somebody, the
  subject stays that name — same rule the composer uses.
- **Imported initials survive an edit.** A note addressed to "MY" or "VB/NG" has
  no account to tick, so `noteDraft()` reads those codes back out of `toLabel`
  and they ride alongside any real person picked. They only come off when
  somebody takes them off. `recipientChips()` now shows them beside the real
  recipients rather than dropping them, which the create path could already
  produce ("VB/MY, can you…") and the card was quietly hiding.
- **Every edit is stamped** — `editedAt` / `editedByName`, shown on the card.
  Anyone who can open the desk can edit anything on it, which is what the rules
  allow and what the shared spreadsheet allowed before them; a restriction in
  the page the rules don't back would be theatre. The stamp is what makes it
  honest instead. **Edits overwrite** — there is no version history, so the
  previous wording is gone. Settled notes can be corrected without reopening.

**No rules change was needed**: `allow update: if canUseDeskAt(centerId)` was
always field-free.

### The desk: acknowledging a note

A note addressed to you carries an **Acknowledge** button; pressing it puts
*"Neeru acknowledged this · Tue, Sep 22"* on the card for everyone. `acksOf()`,
`canAcknowledge()`, `toggleAck()`, `ackSummary()` and `ackLine()` in
`deskNotes.js`; `AckButton` / `AckLine` in `ManagementDesk.jsx`. Stored as
`acks: [{ uid, name, at }]`, the same shape as `replies`.

**IT IS NOT A FIFTH STATUS, and that is the point.** Open / In progress /
Waiting / Settled describe the WORK; this describes the READING, and the two
come apart constantly — a note can sit acknowledged and untouched for a week
(seen, not started), or be settled by somebody it was never addressed to (done,
never read by the person it was for). Folding it into `NOTE_STATUSES` would lose
exactly the case worth knowing about. Nothing about `isOpen()`, the badge or the
"for me" inbox changes.

- **Only the people a note is addressed to can tick it** (`canAcknowledge()` is
  `isForMe()`), because the line it writes names them — anyone else pressing it
  would be putting words in somebody's mouth. A note to Everyone is addressed to
  the whole desk, so everyone may. An imported note addressed to "MY" offers it
  to nobody: there is no account behind those initials.
- **It toggles.** The tick is a claim about a person, so that person can take it
  back. The write only ever carries their own uid.
- **Replying acknowledges, once.** Otherwise the card could show Neeru's reply
  above "nobody has acknowledged this", which is the contradiction that makes
  people stop trusting a tick. Only for a recipient, only the first time.
- **Nothing is shown until somebody ticks.** A board of 121 notes each saying
  "nobody has read this" is a board people stop reading — the absence of the
  line is the answer and its appearance is the news. The "not yet Rachel" tail
  appears only once *somebody* has ticked, which is the genuinely ambiguous
  state; it never lists a whole-team note's recipients, and never names somebody
  with no live account, because a "not yet" that can never clear teaches people
  to ignore the line.
- **Sky, not green.** Green on this card means settled. Giving the tick its own
  colour is what stops "acknowledged" being read as "done" at a glance.

**NOT ENFORCED BY THE RULES, deliberately.** `/notes` allows any desk member to
update any field, so a determined person could already rewrite the note itself;
one narrow rule for this field while the rest of the document stays open would
buy nothing and cost a chunk of the per-request expression budget
`canUseDeskAt()` already lives inside. **No rules change was needed.**

### Which side of the floor a booking lands on

Order, strongest evidence first (`categorizeOne` in
`api/scheduler/appointments.js`):

1. Powerplay → HS. 2. `@home` / online / virtual → Online.
3. Alias → the aliased student's category.
4. **The student tracker** — matched on the booking name, and the right
   answer every time it is available.
5. **The appointment TYPE**, via `sideFromTypeName()` in
   `api/_lib/appointmentSide.js`. Only reached when the name matched no
   student: a first session, a booking in a parent's name, a spelling the
   tracker doesn't hold.
6. Otherwise `Unknown`, which staff place by hand.

**The half-hour block (live 1 Oct 2026).** Acuity type *"Langley In-Centre
30 minute math tutoring"*, on the hour — 3/4/5/6 weekdays, 10/11/12/1/2
Saturdays, capped at 2 bookings a block **in Acuity** (Ratio neither knows
nor enforces that). It is young students only, Great Foundations to about
grade 2, so unlike the 60 and 90 minute types its name IS evidence of a
side and `sideFromTypeName()` reads it as Elementary. Without that a new
Great Foundations student's first session lands in Unknown.

`tutor` is required alongside the length — a 30 minute *assessment* is not
this block. And the rule is tried **last**, so it can only ever turn an
Unknown into Elementary; a type that says "High School" is still HS.

**Nothing else needed changing for it.** The feed floors duration at 30
(`Math.max(30, …)`, appointments.js) and Acuity always sends `DTEND`, so a
half-hour booking arrives as 30 rather than rounding to an hour;
`spanOf()` then covers exactly one 30-minute slot, so demand counts it once
and the 1:3.5 / 1:4 maths is untouched. The grid's on-hour column already
takes any duration on the EM side.

**The HS side would need work** if half-hour sessions are ever opened
there: its on-hour column filters to `duration === 60` and sweeps
everything else into the 1.5-hour column.

**On the sheet, a short session is badged.** A 30-minute student sits in
the same on-the-hour column as the full-hour students and looked identical
to them, so they could be kept at a desk half an hour past their session —
or a desk could free up unnoticed. `shortSessionLabel()` /
`sessionEndMinutes()` in `src/lib/sessionLength.js`; the teal chip in
`StudentRow`. **Only SHORTER-than-standard sessions are marked** — a longer
one already has the HS 1.5 hr column saying so, and a chip repeating a
column heading is clutter on a sheet that gets printed. `sessionEndMinutes`
returns MINUTES, not a clock face: `timeFormat.scan.test.js` fails a
thirteenth hand-rolled AM/PM, and the reader's 12/24h preference lives in
`useTimeFormat()`.

**Notes sit UNDER each student, full width.** They used to share the line
with the name and take the leftover width, so the box changed size with the
length of the name above it. `basis-full` inside the student's `<li>` keeps
every note the same width and unmistakably that student's. `StudentRow` is
exported for `SchedulerCreation.render.test.jsx` — the page needs a parsed
feed day, check-ins, assignments, a ratio config and a roster before it
renders anything, but one row stands alone.

### Holidays & closures — one list, two views

`centers/{id}/config/main.holidays`, entries of `{ date, name, stat? }`.
`HolidaysEditor` shows it two ways: **Closures** (everything — the door is
shut) and **Holidays** (the statutory subset payroll pays). Holidays are a
FILTER, not a second stored list — two lists would need the stats written
into both, and the day somebody edits one and not the other is the day
payroll and the schedule disagree. Pure parts in `src/lib/centreClosures.js`.

**What makes a day statutory** is `isPaidStatHoliday()` in `statPay.js`:
`stat === true` pays, `stat === false` doesn't, and **no flag falls back to
whether the DATE is a real BC stat**. That fallback is why the list
self-corrects and needs no migration.

**Twelve, not eleven.** The National Day for Truth and Reconciliation
(Sept 30) has been a BC statutory holiday since 2023 and was missing. It
was missing in TWO places: `statPay.bcStatHolidays()` and a byte-identical
copy inside HolidaysEditor, Easter algorithm and all, feeding the Auto-fill
button. They agreed only because both were stale. **There is now one list**
and the editor imports it. If BC adds a thirteenth, `statPay.js` is the only
file to touch.

**Closing a stretch is one action.** The add form takes an optional "to"
date and writes every day between. Days already on the list are left alone
rather than overwritten — closing the week around Christmas must not rename
Christmas Day to "Winter break", because that entry is the stat one. Ranges
are capped at `MAX_RANGE_DAYS` (60): not a policy, a guard against a
mis-keyed year writing three thousand entries with no undo.

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

## The new look — two opt-in homes

Two alternative Homes, because two groups open the portal to ask different
questions. **Floor staff** — instructors, leads, hosts, trainees,
volunteers — ask "am I on today, and does anyone need anything from me?",
on a phone. **Leadership** — owners, directors, the admin assistant,
admins and Managers — ask "is the floor covered, and what is waiting on
me". The classic Home answers neither, through a sidebar built for an
owner's eighteen links behind a hamburger.

### THE RULE BOTH OF THEM LIVE UNDER — read this before adding a card

It started as four doors — owner, director, host, instructor — and three
were **removed after review**: their figures depended on live Radius reads
and cross-collection maths this app cannot do quickly or completely, so the
numbers were not trustworthy. **A dashboard that is confidently wrong is
worse than no dashboard.** The deleted owner board led with "hours against
budget" and "people on ratio, every open day this month". Both were
derived. Both are why it went.

Leadership has a door again (2026-09-19), under that finding rather than
around it: **every figure on either home is a DIRECT READ of one
collection.** Today's shifts, unclaimed open shifts, accounts awaiting
approval, time-off requests, booked assessments, the leads funnel,
availability rows, centre events, announcements.

**Deliberately absent, and staying absent: ratio coverage, hours against
budget, enrolment, attendance, revenue.** If you are about to add one, you
are rebuilding the version that got deleted — wait for the Radius API in
`Ratio_Radius_API_Request_Brief.docx`. A test in
`LeadershipHome.render.test.jsx` asserts none of those words reach the
page. ("enrolled" is exempt: it is a leads status a human sets in this app.)

### Who gets which

`newLookHomeFor(auth)` in `src/lib/newLook.js` returns `'leadership'` or
`'floor'`. It asks **"is this leadership"** rather than listing job titles,
so a custom centre role invented in Manage Roles lands on the right side
without a code change. A Host carries `admin.panel` at Langley and is still
floor staff — the permission is not what decides it. **Managers are on the
leadership home** (they became the admin tier on 2026-09-14 and carry most
of the desk); they were on the floor home before.

`newLookActive()` is only about opting in now, since everybody has a home.

**OFF by default, per uid.** Nobody meets a redesigned portal because a
deploy landed, and signing out of one account into another does not carry
the setting across.

### The leadership home

`src/pages/homes/LeadershipHome.jsx` — **one page, not three.** A Manager
and a Director carry the same permissions apart from `centre.settings`, so
the differences are gated cards rather than separate files: Directors and
above get the Centre settings shortcut and the availability count.

**Assessments TODAY names the family.** It was a week of them showing a time
and a bare grade — "Today 3:00 PM … 2" — which answered *when* and never *who*,
and pushed the rest of the page down to answer a question nobody opens this
home to ask. Today only, at the centre's request (2026-09-22): "who is coming
in today" is the one that changes what anybody does before 3pm, and the whole
list is one click away on Intakes. Each row leads with the child, carries the
guardian and the time beneath — no day prefix, since every row is today — and
shows a note when there is one. `gradeLabel()` gives a bare number its
word ("Grade 2"), because a lone "2" beside a time in a column headed by
nothing reads as a count; PreK and K are left exactly as the family typed them.
A booking with no name says **"Name not recorded"** rather than rendering a
blank row — imported ones can arrive that way and the blank looks like a fault.

**A REFUSED READ IS NOT AN EMPTY WEEK, and this was live.** `centerIntakes` is
owner-tier in the rules (a parent's name, email and phone), and **Managers reach
this home** — so the listener's error path set `[]` and the card told them
"None booked this week" when the week was full. That is precisely the
confidently-wrong figure this page exists to avoid. It now says the assessments
are not shown to them, and why. Mutation-tested. The same shape is on the
Calendar. If you add another owner-tier read to this page, give it the same
treatment.

Two traps it hit in the building, both worth knowing:

- **There is no "submitted availability" flag on a person.** Availability
  is one row per person per DAY, so the only honest answer is how many
  distinct `userId`s have a row dated today or later. A first pass read an
  invented `availabilitySubmittedFor` field and would have reported nobody,
  forever, confidently — inside the page built to prevent exactly that.
- **`min-w-0` on the grid columns is load-bearing.** `truncate` sets
  `white-space: nowrap`, whose min-content is the whole string, and a grid
  item's `min-width` defaults to `auto` — so the track could not shrink
  below 408px on a 390px phone and the cards ran off the edge. Measured
  before and after. `InstructorHome` has the same shape and `truncate` in
  three places inside its grid; it has not been checked.

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
`min-h-[56px]`, past the 44px minimum. **Loose end:** those tabs were
drawn for floor staff, and leadership now reach the new look too — a
director on a phone gets Today / Schedule / Shifts / Chat, where Schedule
means their own shifts. It works; it is not necessarily what they want.
`.nl-tabbar` carries
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
Payroll default.

**Sick leave standing and the stat-pay forecast were REMOVED from this page
(2026-09-16), at the owners' request.** The portal was quoting BC Employment
Standards entitlements — five days, ninety days' probation, 15-of-30 qualifying
days — at staff on a self-serve page, and that is the centre's conversation to
have. What replaced both is the plain fact people wanted: **`sickDaysThisYear()`
— how many days you called in sick, resetting 1 January.** Distinct dates, so a
split shift counts once, and `profile.externalSickDates` covers a sick day with
nothing scheduled. Manage Payroll keeps its own sick and stat tabs untouched;
those are for the people running payroll, and `statPay.js` still serves them.

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

A short maths game a day, a per-centre board, a monthly winner. **Four games
live:** Sprint 60 (timed arithmetic), Mathle (guess the equation), Connections
(sixteen numbers, four sets) and Ratio Rush (the centre's own staffing maths).

**Each game scores itself.** "Better" means something different in each — more
correct in Sprint, FEWER guesses in Mathle — so the registry entry carries
`score(outcome)` and `resultOf(outcome)`, and every game lands on the same 0–120
scale with **100 for a par run**. That is what stops any one game carrying a
month. The page owns the WRITE; a game only plays and reports an outcome, so a
new game cannot invent its own way onto the board. `clampPoints`/`clampResult`
guard the row, because a game returning NaN is a value Firestore cannot store
and the rules would refuse.

**A FINISHED GAME STAYS ON SCREEN.** The page used to unmount it the moment
it reported its outcome, which threw away the part that matters most when you
lose: Connections laying out the sets, Mathle spelling out the equation. You
got a score and no answer. A finished run is now `playing.done` — board still
up, result card beside it, roster hidden until **Back to the games**. Both
games reveal in the same shape: what you found keeps its colour, what you
missed is named underneath. The timed two close themselves off when they end
(**Time.** / **That's the ten.**, input gone) — a board that stays up has to
stop looking playable, or people keep answering a run that is already scored.

**EVERY SPRINT ANSWER IS A WHOLE NUMBER, and the percentage branch is where
that broke.** It drew any even number and rounded — "even, so 25% lands whole"
is not true, 25% of 158 is 39.5 — so the game asked "10% of 158" and accepted
only 16. The box takes digits, so there was no way to be right. The percentage
is now drawn first and the number second, as a multiple it divides exactly.
The old whole-number test passed throughout: it checked the stored answer was
an integer, not that it was the right one. Both timed games say what they take
(**Whole numbers only** / **Whole instructors only — always round up**), the
second being the actual staffing rule rather than a hint.

**Engines live in `src/lib/games/`, all pure and seeded** (`mathle.js`,
`connections.js`, `ratioRush.js`). Daily puzzles seed from `centre|date|game`,
so the whole centre argues about the same board and nobody can reroll; practice
adds a nonce. Two things worth knowing:
- **Mathle never runs a player's string as code.** `evaluate()` is a two-pass
  parser with a strict alphabet and strict number/operator alternation — without
  the latter, `1;2` read as 1 because the tokeniser silently dropped what it
  didn't recognise.
- **Connections boards are checked for a UNIQUE solution before being dealt.**
  The properties overlap on purpose (64 is a square AND a power of two), so the
  generator only draws numbers that ONE chosen property claims. A board with two
  valid answers is unfair, and there's a prize attached to the month.
- **Ratio Rush uses `requiredForSlot()` from demand-staffing.js** — the same
  function the Staffing Board sizes real days with, so the game teaches the
  thing it tests. It asks at the **floor, 1:4**, not the 1:3.5 aim: four is
  a number you can divide by standing on the floor, three and a half
  against a sixty-second clock is a different skill. A miss shows the
  division, and `aimNote()` adds what the aim would have wanted whenever
  that is a different number — so the easy ratio never reads as the target.

**Still unbuilt, and deliberately:** the bank-based games (Riddle of the Day,
Spot the Error, Close Enough) and the weekly Cross-number. Those need real
content authored by staff plus a submission-and-approval flow — a different job
from a generator, and the "Fun Day category nobody used" warning applies.

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

## The public booking page (`/book/:centerId`)

Parent-facing, no login, no auth: a week-view slot grid plus the intake
form. `src/pages/PublicBook.jsx`, availability engine in
`api/_lib/intakeAvailability.js`, settings in
`components/IntakeBookingSettings.jsx` (Centre Settings).

- **Free slots are GREEN**, the picked one solid green, taken ones dim,
  with a legend. They were red, and a red cell reads as *unavailable* to
  everybody. Required fields have NEUTRAL borders for the same reason — red
  ones made an untouched form look like a rejected one.
- **Picking a slot walks the page down to the form** over ~900ms and stops
  **72px short**, so the grid still shows and the reader can see there is
  something above. It aborts the moment they touch the wheel, screen or a
  key; `prefers-reduced-motion` gets a plain jump. `src/lib/smoothScroll.js`.
  **"Change time slot"** rides in the selected-slot card (a "Cancel" button
  existed, buried under the SMS disclaimer, named as though it abandoned
  the booking).
- **`maxIntakesPerDay` + `maxIntakesPerWeekday`** cap assessments per day —
  "three a day, but two on Fridays". Blank = no limit, so an untouched
  centre is unchanged. Enforced in `computeWeekSlots` (the whole day closes,
  marked FULL) **and** in `validateSlot`, which reports the DAY as full
  rather than the time as taken — that sends a parent to another day
  instead of another time on the same full day.
- **`intakeSettings.address`** appears under "This assessment happens in
  person, at our centre", on the page and the confirmation. The note shows
  **even with no address saved** — turning up is the part a parent has to
  know.
- **Calendar holds and centre closures now narrow the grid too** — see
  "The Calendar" below. A held slot carries `held: true` (distinct from
  `taken`, so the two can be worded differently); a closed day carries
  `closed` + `closureName` and no slots at all.

Two traps, both caught by tests:

- **`Number(null)` is `0`.** A cap of `null` coerced to zero would have
  closed online booking at every centre on deploy. Check for blank BEFORE
  `Number()`.
- **A slot is a wall-clock string with no zone** (`2026-09-25T17:00:00`),
  and `validateSlot` parsed it as local then read **UTC** getters off it.
  Correct only because Vercel runs UTC; on any other runtime a Friday
  evening booking validated as Saturday. Now read straight off the string.
  The engine's tests pass under UTC, Vancouver and Sydney.

## The Calendar (`/calendar`) — management's own dates

A week/month calendar for the people who schedule the centre around itself.
`src/pages/RatioCalendar.jsx`, model and maths in `src/lib/ratioCalendar.js`
(pure, tested), rules in `tests/rules/calendar.rules.test.js`.

**The point of it is the hold.** Apptoto books a lead into Google Calendar and
Google then refuses anything overlapping it. Here, an entry with
`holdsBooking: true` is handed to the booking engine as one more busy block,
and the collision check that already refuses a double-booking refuses these the
same way. No second opinion about who may book when.

**THE TRAP, and it is the reason holds travel in their own list:**
`countIntakesOn` counts everything in `bookedSlots` against the per-day
assessment cap. Fold holds in there and one staff meeting eats one of Friday's
two assessments. `computeWeekSlots(..., { holds, closures })` takes them as a
SEPARATE argument — they collide, they never count. Pinned by
"DOES NOT use up the day-s assessment allowance".

**It READS three things it does not own**: closures/stat holidays
(`centerConfig.holidays`), fun days and meetings (`centers/{id}/events`), and
booked `centerIntakes`. Only entries are stored, at
`centers/{centerId}/calendar/{id}`.

**Approved time off was a fourth layer and was REMOVED (2026-09-22)** at the
centre's request — "not useful for us". This page answers "what is booked into
the building"; who is away is a staffing question, and Manage Staff Schedule
already paints an approved day off on the cell it belongs to. Nothing was
deleted from `timeOffRequests`; the calendar stopped subscribing to it. Don't
re-add it as an oversight — `LAYERS` and `rowsForDate` both say so, and a test
asserts an approved day off cannot reach the page. Anything else
ends with the same fact in two places disagreeing with itself — which is why
Centre Events stays exactly where it is and keeps its own (wider) rules.

**The booking page never looked at `centerConfig.holidays`.** Nothing in
`api/intakes.js`, `intakeAvailability.js` or `PublicBook.jsx` read them, so a
family could book an assessment on Labour Day — the weekday had instructional
hours and nothing said the centre was shut. A closed day now emits **no slots
at all** with `closed: true` and its name, and `validateSlot` refuses it. A
closure is deliberately NOT `dayFull`: "full" sends a parent to another time,
"closed" sends them to another day.

**`blockedStarts()` is why the composer can warn before you save.** It mirrors
`slotStartsForDay` + `isSlotTaken` on the client, so ticking the hold says
"Families will not be offered 3pm, 3:30pm, 4pm, 4:30pm" and "that day will have
2 bookable times left" while there is still a Cancel button. A slot flush
against the end of a hold (5:00 against a hold ending 5:00) is NOT blocked —
blocking it costs a bookable hour for nothing.

**The two implementations are separate on purpose.** A Vercel function may not
import from `src/`, so `holdBlocks()` in `ratioCalendar.js` and `loadHolds()` in
`api/intakes.js` are written out twice. They are pinned against the SAME fixture
(Langley, Friday 25 Sep 2026, teaching 3–7, 60-minute assessments every 30) in
both test files. Change one, change the other.

`holdsBooking` is filtered in JS rather than in the Firestore query, so the read
needs no composite index — the date range alone is a single-field range.

**RECURRENCE IS MATERIALISED — one document per occurrence, sharing a
`seriesId`.** That is not a storage preference. `api/intakes.js` finds holds
with a `date >= … <= …` range query, and a document carrying an RRULE has
exactly one `date`: store the rule alone and a recurring hold would block the
first week and then silently stop, which nobody notices until a family books
over the management meeting. Every read path already understands a dated row,
so materialising needed no change anywhere else. Mutation-tested — collapsing
the series back to one document fails two tests.

Rules: `weekly | biweekly | fourweekly | monthly`. **Monthly is the nth
WEEKDAY** ("the fourth Wednesday"), not the same date — and a month with no
fifth Wednesday is skipped rather than slid to the fourth, because sliding
puts a meeting in diaries nobody agreed to. Series run 12 months by default,
hard-capped at `MAX_OCCURRENCES` (200), written in one `writeBatch`.

A later occurrence landing on a **centre closure is dropped**, and the composer
says how many. The **start date is always kept** even if it is a closure:
somebody chose that exact day, and an empty series ("I pressed save and nothing
appeared") is a worse answer than one meeting on an odd day they can see and
move.

Editing or deleting an occurrence asks **"Just this one" / "This and all later
ones"**. A forward edit never writes `date` — it is the only thing telling two
occurrences apart, and pushing one over the others would collapse the series
onto a single day. Turning an existing one-off into a series **keeps that
document** as the first occurrence, so nothing anyone has already looked at
moves or changes id. Re-cutting the pattern of a LIVE series is deliberately
not offered: it means deciding what happens to occurrences people were already
told about. Delete the later ones and make it again.

The page's calendar listener is **unfiltered** (`collection(…, 'calendar')`),
which is what lets a forward edit find its siblings without a second query. A
year of weekly meetings is ~53 tiny documents; if series ever get numerous this
is the thing to window.

**Who gets it:** a new `calendar.access` permission — owners, both directors,
Managers, admin assistants, Hosts. Not Leads, for the same reason they are off
the Management Desk: a Lead runs the floor for a shift, and taking assessment
slots off the public page is not that job. `canUseCalendarAt()` in the rules
mirrors the seed list and falls through to `hasPermAt`, so a centre that grants
it to a Lead in Manage Roles gets it on both sides.

**This is the first NEW permission since the catalogue was written**, and it
exercised the additive rule for real: a centre whose saved `staffRoles` predate
`calendar.access` never had the chance to consider it, so `resolveRoles` keeps
the built-in grant rather than silently removing a page. Without that, every
centre that had ever opened the role editor would have shipped with no Calendar
for its Hosts. Pinned in `Layout.render.test.jsx`.

### Importing a Google Calendar

`src/lib/icsImport.js` (pure, tested) + `components/CalendarImport.jsx`.

**AN IMPORTED ASSESSMENT GOES TO `centerIntakes`, NOT TO THE CALENDAR.** That
collection alone feeds `bookedSlots` in api/intakes.js, so an assessment filed
as a calendar entry leaves its hour on sale and the public page takes a second
family for it. It also is the only thing the per-day cap counts and the only
thing the Intakes page and the Leads funnel read. The Calendar already READS
centerIntakes, so writing to the right collection shows it on the calendar
anyway — the wrong one just loses everything else. Mutation-tested: routing
assessments to the calendar fails four tests.

**Each imported assessment also creates a LEAD**, and the two point at each
other (`intake.leadId` / `lead.intakeId`). `leadDocFrom()` was pulled out of
`createLead()` so the import can put the same shape into a writeBatch —
importing a lead the funnel cannot read would be a silent loss. An assessment
whose date has passed goes in as **Assessed**, not New, or a month of history
lands at the top of the funnel looking like fresh enquiries. There is a switch
to turn it off.

**Undoing an import:** `scripts/clear-calendar-import.cjs` (dry run unless
`--apply`). It deletes only documents stamped `source: 'google-import'`, so a
"clear the calendar" can never erase a family who booked on the website —
`centerIntakes` holds both. Run 2026-09-22 at Langley: 136 deleted (88
assessments, 48 entries), 3 real `source: 'web'` bookings and 8 hand-made
Management Team Meeting entries untouched. `--all-entries` also removes
hand-made calendar entries.

**The first live import named every child "Booked".** `nameFromSummary` strips
the words that describe an appointment and keeps the longest thing left — and a
real calendar is full of booking STATES, so "Booked" survived as a name.
`NOISE_RE` now eats booked / confirmed / scheduled / cancelled / no-show / not
coming / available / open / slot / hold / TBD. A title with nothing else in it
yields `''`, which the panel counts and flags rather than importing.

`looksLikeAName()` then rejects what is left if it is a note rather than a
person — one to three words, no digits, no "!". The same live run produced
"Book Your Skills Today!" and "might have 2nd student" as children's names.

### The real Langley booking format

Every booking on that calendar is titled **`Appointment Booked:`** — which
contains no word meaning assessment — and the details are `key: value` lines
in the DESCRIPTION, half prose and half **snake_case**:

```
Name:
Phone: 6047167699
Email: moonf83@gmail.com
Created: Wednesday September 16, 2026 8:22 PM
Client Timezone: America/Vancouver
Start Time: Saturday September 26, 2026 1:30 PM PDT
Duration: 60.0 minutes
Appointment Type:
guardian_name: Francis Moon
child_name: Catherine Moon
child_grade_dropdown: 2
utm_source: google
radid: langleybc
```

**THE BUG THAT COST 88 IMPORTS:** the labels were matched as
`guardian\s*name\s*:`, and an underscore is not whitespace. Nothing matched,
so every assessment arrived with no guardian, no grade, and a child called
"Booked" (the title's leftovers). `labelledFields()` now folds every key to
spaces — `guardian_name`, `Guardian Name` and `guardian-name` are one thing —
and the fields are picked by what the key CONTAINS, so `child_grade_dropdown`
is a grade. utm tags, `radid` and `dlmode` match nothing and are ignored.

**`Start Time` in that body is deliberately ignored.** It is a snapshot from
when the booking was made and can disagree with the event it sits on — the
real sample says Saturday the 26th on an event running Tuesday the 22nd.
DTSTART is what the calendar actually shows, so DTSTART wins. Pinned by a test.

**Classification is structural, not textual.** `looksLikeABooking()` returns
true when the description carries a child or guardian key, and `classify()`
checks that FIRST — "Appointment Booked:" would otherwise fall through every
keyword to `task` and never reach the Intakes list.

**`[NOT COMING] Appointment Booked:`** is a real title there. The event is not
STATUS:CANCELLED, so skipping it would lose the record; importing it as
scheduled would hold an hour for somebody who has already said they are not
coming. It comes in as a **cancelled** intake, and its lead as **lost**.

The review table also shows each event's own description ("what it read", or
"no description"), and the original title is stamped on the assessment as
`sourceSummary`, so a row that still comes back blank is explainable rather
than a mystery.

**An assessment is edited in its own editor** (`components/AssessmentEditor.jsx`,
pure bits in `lib/assessments.js`), because it is a centerIntakes document and
the entry composer writes somewhere else entirely. Who / what / where / when, in
that order. Where is the centre's address from `intakeSettings.address`,
read-only — it is a Centre Settings field and the family was shown the same
string. A clash with another booking is a **warning, never a block**: staff
double-book on purpose, and the public page is where a collision must actually
be refused, which it already is.

**Editing here never touches Google.** The import is a one-way snapshot. Two
calendars that both think they are in charge is how a family gets told two
different times.

**Managers and Hosts hold `calendar.access` but CANNOT read `centerIntakes`** —
that collection is `isOwnerLike() || isSuperAdmin()` in the rules, deliberately,
because an assessment carries a parent's name, email and phone and those roles
are kept off every other PII route (Leads, Case Study, Supply & Demand). So they
see the Calendar with no assessments on it. The page now SAYS so instead of
rendering a quiet empty layer, and hides the Import button from them rather than
offering a write the rules will refuse. Widening the rule would cross a boundary
that was drawn on purpose — don't, without deciding to.

**A real export is the WHOLE calendar.** Langley's first run came back with
about 2,110 events, most of them years old — unusable as a review table and
not something anyone wants written into a live centre. The panel opens on a
date range defaulting to **the first of last month** (recent history plus
everything ahead), shows what the file spans and how many the range leaves
out, and warns above `REVIEW_COMFORTABLE` (400) rows that it is more than
anyone will really check.

The range is applied **before the rows are built**, not as another skip
reason — a skipped row still renders, and 2,110 of those is the original
problem. Corrections already typed are held by row id, so moving the dates
never throws away someone's work.

**A file, not the Google API.** OAuth + refresh tokens + a webhook is two or
three routes and `api/` is at exactly 12. An exported .ics is parsed in the
browser for nothing. Google Calendar → Settings → Import & export → Export.

**Times are converted, not copied.** A Google event is a UTC instant or a wall
clock plus a TZID; everything Ratio stores is the centre's own wall clock.
`19:00Z` is a noon assessment here — writing "19:00" would move it to the
evening. `toCentreLocal` / `zonedToUtc` are the same two-pass DST maths as
api/calendar/[token].js, and the tests check both sides of the November change.

**Nothing is written before somebody reads it.** Guardian and child names are
not fields in a calendar event; they are prose a booking tool wrote into
SUMMARY and DESCRIPTION, so every extraction is a guess and every row lands in
an editable review table first. A guardian is NEVER guessed from the title —
the name in a title is the child's far more often than not, and a child's name
in the parent field is worse than a blank somebody fills in.

Skipped rather than imported, and shown with the reason: cancelled events,
recurring masters (importing one brings a single occurrence and silently loses
the rest — Ratio has its own recurrence), and anything already brought in.
Re-running is safe: the event UID is stored as `sourceUid`.

An import **never sets `holdsBooking`**. Closing assessment slots has a cost the
composer spells out one entry at a time; an import must not make that decision
silently, forty rows at once.

A VALARM inside a VEVENT has its own DESCRIPTION ("Reminder"). Taking it
overwrites the parent and child details the import exists for — the parser
tracks depth so it cannot.

A day the centre does not open is **hatched and labelled**, not left blank — an
empty column and a shut one look identical and only one is worth booking into.

**A day the centre never opens is DROPPED from the week grid**, so the rest
take its width — Langley is shut on Sundays and that dead seventh column was
squeezing the six that matter. It follows `operatingDays`, not the weekend: a
centre closed on Mondays loses Monday instead.

**It comes back the moment something is on it.** The composer takes any date,
so a permanently hidden column would hide a real entry — and an entry you
cannot see is worse than a narrow one. The column reappearing is itself the
signal that something is there. The range label reads off the days SHOWN for
the same reason: "Sep 20 – Sep 26" over a grid that opens on Monday the 21st
is a small lie, and it is the line people read to know where they are.

**The assignee picker is type-to-filter**, the same shape the Student
Scheduler's roster search uses: empty query shows everyone, otherwise a plain
case-insensitive substring on the display name. Not a new widget — the one that
already existed. Two behaviours the tests pin:

- **Anybody already ticked stays in the list** whatever the query says. Tick
  somebody, type a name that does not match them, and watching them vanish
  reads as "it did not save".
- **The list never reshuffles.** Floating the selected to the top moves the row
  out from under the cursor mid-click, so a ticked person keeps their place.

**Two things at the same time sit SIDE BY SIDE.** Reported as "I cannot put
multiple things on the same day at the same time" — they saved perfectly well,
and every entry was drawn full width and absolutely positioned, so the later
one covered the earlier one's title, its time and its click target.
`layoutOverlaps()` is the usual calendar packing in two passes: CLUSTER the
day in start order, cutting a new cluster whenever an entry starts after
everything before it has ended, then give each entry the first COLUMN whose
last entry has already finished. Overlap is transitive — A over B over C is one
cluster even when A and C never touch, or A and C would be drawn in the same
place. Back-to-back (3–4 then 4–5) is deliberately NOT a clash; halving those
would shrink every entry on a normally busy afternoon for nothing. Three to a
column drops the second line, because a clipped half-line is worse than none.
Mutation-tested.

**Today is marked on the HEADER CELL ONLY**, and this took two goes to get
right. Red text on the date alone was too quiet on a seven-column grid; a tint
running the whole column was worse — a solid stripe behind every entry on the
busiest day of the week, fighting the things you are actually reading. The
date and its filled pill are where the eye looks for the day anyway, so the
mark belongs there and stops there. `--nl-today` goes on the header cell; a
render test asserts exactly one element carries it and that it is the one
holding the date. A **now line** still crosses today's column, drawn only when
this week is on screen and the time is inside the hours drawn — a marker pinned
to the top edge at 7am reports a time that is not on the grid.

**THE RED BUDGET.** `index.css` says brand red is *identity and actions only*,
and the first pass spent it on today's tint, today's pill, the now line, every
closure AND every fun day — six pink chips across the all-day band under a pink
column beside a red button. The whole page read as one alarm. Inside the grid,
brand red now means exactly two things:

- a **closure** — the centre is shut, which is a stop
- the **now line** — this instant

Everything else took a colour of its own. Today's tint is a warm NEUTRAL; the
date is a filled **ink** pill, the same "selected" idiom as the Week / Month
toggle, in both views. Centre events and fun days moved to `--nl-info` (blue),
a fifth semantic colour added for them: a fun day is daily texture, not an
alert. A render test counts the brand-coloured elements inside the grid and
fails if anything but the now line claims one.

**`min-w-0` on every 1fr cell is load-bearing, for the second time in this
codebase.** The week is three SIBLING grids sharing `54px repeat(7, 1fr)` —
header, all-day band, hour grid. `1fr` is `minmax(auto, 1fr)` and a grid item's
automatic minimum is its min-content, which `truncate` (white-space: nowrap)
makes the whole string. One long fun-day title ("Rock Paper Scissors
Tournament") widened its own column and squeezed the rest, **in the all-day row
only** — the header holds three characters and the hour columns hold nothing but
absolutely-positioned children, so both stayed even and the band drifted out of
line with the dates above it. The month grid has the same shape and the same
chips. jsdom does not lay out, so the tests pin the class rather than the
geometry; mutation-tested.

## A job title is copied onto shifts, like a name

A shift stores the person's `instructorType` at the moment it is created,
and the coverage grid reads that copy — so promoting someone to Lead left
every shift already on the calendar showing the old title (this is why Luke
still drew as HS after his promotion).

`propagateRole` in `Admin.jsx` mirrors `propagateRename` next to it, with
two differences: **only shifts from today forward** (a worked shift records
the job that was done, and payroll reads the same field), and **only shifts
still carrying the title they are leaving** — a future shift deliberately
scheduled as another role is real data, not staleness. The grid is built
for "LEAD 11-3 covering for the owner, HOST 3-7".

The rule lives in `src/lib/roleBackfill.js`, shared with
`scripts/backfill-shift-roles.js` (dry run unless `--apply`) so the one-off
repair cannot drift from the live path. The script **reports and makes a
person name the stale title** rather than guessing: a run against live data
found fifteen people with `Training` shifts on one date, which was a real
all-staff training day, and two Leads with deliberate `Host` shifts. A
blanket "make shifts match titles" would have wiped all of them.

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

## One clock — 12-hour by default, 24-hour if you ask

Every time a person reads goes through **`src/lib/timeFormat.js`**. Components
bind it once with `useTimeFormat()` and call it like the old local helpers:

```js
const fmtTime = useTimeFormat();
fmtTime('15:30')               // "3:30 PM"      prose and cards
fmtTime.compact('15:30')       // "3:30PM"       chart axes, grid headers
fmtTime.short('15:00')         // "3pm"          dense boards
fmtTime.tick('15:00')          // "3p"           hour marks on an axis
fmtTime.range(start, end)      // "3:00 PM – 7:00 PM"
fmtTime.clock(ts)              // "3:04 PM"      a timestamp
fmtTime.stamp(ts)              // "Sep 20, 3:04 PM"
fmtTime.format                 // '12h' | '24h', to pass into a lib function
```

**The preference** is `users/{uid}.timeFormat`, set on My Account → Clock and
nowhere else. It is per person, live (AuthContext already watches the user
doc, so changing it re-renders open pages), and defaults to 12-hour — what
the centre says out loud. Anything unreadable falls back to 12-hour rather
than throwing; `useTimeFormat` works with no auth provider at all, so a card
rendered on its own in a test still formats.

**Storage and input stay 24-hour.** Shift times, slot keys and every
`<input type="time">` are "HH:MM" because that sorts, compares and
round-trips. This is display only — never write a formatted time back.

**Three things deliberately ignore the preference**, all for the same reason —
the reader isn't the person whose setting we hold: `emailService.js`, the
payroll XLSX / availability CSV exports, and **text written into the chat**
(a claimed shift, a swap request). A chat message is stored once and read by
everyone, so it carries the shared 12-hour default instead of its author's
clock. The public booking page has no signed-in reader, so it takes the
default too.

**Why this exists**: twelve hand-rolled `fmtTime`s had grown across the app and
disagreed with each other, and several surfaces skipped them and printed the
stored "15:30" — Manage Availability's hint, the centre events list, the
weekly-patterns table, the coverage tooltip. `timeFormat.scan.test.js` scans
every source file for a hand-built AM/PM suffix or a `toLocaleTimeString`
without `hour12`, and fails on either, so a thirteenth copy can't appear.
Lib functions that build a sentence for the screen (`doubleBooking`,
`availabilityLog`, `availabilityFit`) take the format as a last argument and
default to 12-hour.

## Cole — the mascot each person picks

The A+ at the top of the sidebar (and the phone header, and sign-up) is now
**Cole**, Ratio's mascot, in one of eight outfits: `classic` (Cole),
`coach` (Coach Cole), `cool` (Cool Cole), `bot` (Cole-bot), `gamer` (Gamer
Cole), `coffee` (Cole-feine), `corgi` (Cole-gi) and `sleepy` (Sleepy Cole).
Each person picks one at sign-up and can change it on Account → "Your character"; it's stored as
`users/{uid}.mascot` and read through `resolveMascotId()`, so a missing or
unknown value draws the original. No rules change was needed — self-update
already allows any field except role / approval / centre ones.

`src/lib/mascots.js` builds every drawing as SVG markup from one rig
(shaded balls, face, gloves, poses) and `components/Mascot.jsx` shows it as an
`<img>` data URL — its own document, so clip-path ids can't collide, and no
markup is injected. `mascots.test.js` parses every outfit x pose x crop,
because a typo in one pose would be a broken image for exactly the people who
picked it. The old Mathnasium `Logo.jsx` was deleted with its last use.

**THE ONE RULE FOR A NEW COLE: its signature must be at HEAD height.** The
40px sidebar icon draws the head crop in the neutral `stand` pose, so
anything held in a hand is out of frame there and that Cole is an exact
copy of the original where people see it most. Hence the headset on Gamer
Cole, the wired eyes on Cole-feine and the hood on Cole-gi; the controller,
the cup and the bone are for the full-body views only. A test renders all
eight head icons and asserts they are distinct markup.

Two more things learned by getting them wrong:

- **The body is a BALL.** Garment shapes with corners fight it — Sleepy
  Cole wore a gown with lapels and a belt, and it read as a purple arrow
  stuck to a sphere. What works is a chest emblem (the original's colon,
  Gamer's pixel heart) or something wrapping the ball (his pyjama stripes,
  clipped to it).
- **A stroke's width is part of its geometry.** Cole-9's tail path cleared
  the head crop; its 19px stroke did not, and drew a stray brown mark
  beside the 40px icon.

Poses: `stand`, `thumbs`, `wave`, `cheer`, `think`, `peace`, `coach`,
`game`, `sip`, `fetch`, `yawn`. A pose can name a PROP (`clipboard`,
`controller`, `cup`, `bone`) instead of a glove; a prop draws its own
glove(s), so that hand is left empty in the pose. Full body is used on the
new home's greeting, head crop everywhere else.

Cole-9, a dog Cole, was added and retired the same day — `resolveMascotId()`
sends a retired id back to the original, which is what makes removing one
safe. Check Firestore before deleting another (nobody had picked him).

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
