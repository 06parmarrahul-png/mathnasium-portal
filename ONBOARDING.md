# Mathnasium Portal — New Centre Onboarding

A step-by-step guide for getting a brand-new Mathnasium centre live on the portal. Read top-to-bottom; by the end you'll have posted your first schedule.

Two audiences are covered:

1. **Platform operator (super-admin)** — what *I* do before handing the keys to a new centre's owner.
2. **Centre owner** — what *you* do on day one to set up your centre and run your first month.

Skip to the section that applies to you.

---

## Part 1 — Platform operator pre-flight

These steps take roughly 10 minutes. They happen *before* the new centre's owner logs in for the first time, so the experience is clean on their end.

### 1.1 Create the centre

Sign in as super-admin, go to **Manage Centres**, click **Create New Center**. Fill in:

- **Centre ID** — a short URL-safe slug (e.g., `burnaby`, `richmond-no-6`). This is permanent; it shows up in Firestore paths and signup URLs. Pick something stable.
- **Name** — the centre's public name (e.g., "Mathnasium of Burnaby").
- **City / Province / Country** — for the centre roster.

Leave **"Add me as a member"** *unchecked* unless you actually need to switch into the centre frequently for support. You can always switch in later — being listed as a member just shows you in their staff roster, which is noisy.

Click **Create**. The centre is now live on the platform but has no people, no shifts, no config beyond defaults.

### 1.2 Set the centre's operating days

Still on **Manage Centres**, scroll to **Operating Days** for the new centre and toggle on the days the centre actually opens (Mon–Sat is the default; some centres are also open Sunday or closed Monday).

This is super-admin only; the centre owner can't change it themselves. Get it right before they log in.

### 1.3 Set the centre's shift colours (optional)

If the new centre prefers different colours than the platform defaults for shift roles (e.g., they want Instructor in blue instead of green), edit them under **Appearance** on Manage Centres. Most new centres don't care; defaults are fine.

### 1.4 Set up billing

Go to **Platform Revenue**, find the new centre's row, click **Edit**. Set:

- **Tier** — Starter / Growth / Pro (or Free for an internal/pilot centre)
- **Monthly amount** — whatever you've agreed with them in $CAD
- **Next bill date** — usually the first of next month
- **Status** — leave as None for a pilot; set to **Trial** if they're in a free-trial window, or **Active** once they're paying

Save. If they're paying via Stripe, click **Send Checkout Link** and email it to them; otherwise leave it for later.

### 1.5 Send the owner their signup link

The signup URL is just `https://your-portal-domain/signup`. The new owner will pick their centre from the dropdown — that's why centre creation has to happen first. Tell them:

1. Go to `<signup-url>`
2. Pick their centre from the dropdown
3. Fill in name, email, password
4. Wait — they'll see a "pending approval" screen

### 1.6 Approve and promote the new owner

Once they sign up, switch into their centre (Manage Centres → "Switch to" on their row). Go to **Admin Panel** → **Manage Users**. You'll see their account in the Pending section.

Click **Approve**.

By default they're created as `instructorType: Instructor` with `role: instructor`. To make them the actual centre owner, you need to update their Firestore profile directly:

1. Open Firebase Console → Firestore → `users/<their-uid>`
2. Change `role` from `instructor` to `owner`
3. Save

This step is intentionally not in the UI — owner is a privileged role and giving the admin panel a "promote to owner" button would be a foot-gun. Two minutes in Firebase Console is worth the safety.

Tell the new owner to reload the portal — they should now see the full Owner sidebar.

### 1.7 Hand off

That's it on the operator side. Send the new owner a link to **Part 2** below.

---

## Part 2 — Centre owner first-day setup

Welcome. Your platform operator has set up your centre on the back end. Now it's your turn to make it match how your centre actually runs.

This takes roughly 30–45 minutes the first time. After that the portal mostly runs itself.

### 2.1 Set your instructional hours

Go to **Centre Settings** in the sidebar. Find **Instructional Hours**.

These are the hours each day where you're actively teaching students — not when the centre is open, not when admin work happens. The auto-scheduler uses this to clamp instructor shifts to teaching time only.

Common Mathnasium defaults:

- Mon–Thu: 3:00 PM – 7:00 PM
- Fri: 3:00 PM – 6:00 PM
- Sat: 10:00 AM – 2:00 PM

Edit per day to match your centre. Save.

### 2.2 Set your operating hours

Right below Instructional Hours, **Operating Hours** is the full open-to-close window including pre-teaching prep and post-teaching cleanup. Hosts and admin-time staff get scheduled against this; "Full Day" availability submissions also use this range.

Typical defaults:

- Mon–Thu: 10:00 AM – 8:00 PM
- Fri: 10:00 AM – 7:00 PM
- Sat: 9:00 AM – 3:00 PM

### 2.3 Fixed staff (salaried directors, lead instructors)

Anyone whose schedule never changes — your Centre Director who's always in Mon–Fri 11–7, your part-time event coordinator, etc. — goes in **Fixed Staff**. They get seeded onto the schedule automatically every week without needing to submit availability.

Add them by display name (matching exactly how their portal account will be named). Set their per-day shift strings (e.g., "11:00 AM - 7:00 PM" or "Off" for days they don't work).

### 2.4 Guaranteed shift names

People who must always get a shift on any day they submit availability — typically your senior instructors who are essential for student continuity. Add their **first names** to the **Guaranteed Shift** list.

The auto-scheduler protects guaranteed people from being bumped by lower-priority staff. If they submit availability, they get a shift; period.

### 2.5 Salaried staff (excluded from hourly payroll)

If anyone at your centre is paid a flat salary — your Centre Director, typically — add their **full display name** to the **Salaried Staff** list. They still appear on the schedule but get filtered out of the hourly-payroll comparison report.

### 2.6 Add your holidays

Go to **Admin Panel** → **Holidays**. Add any stat closures or centre-specific closure days (BC Day, Family Day, the week you're closed between Christmas and New Year, etc.).

The auto-scheduler will skip these days entirely — no one gets scheduled, even if they submitted availability.

### 2.7 Invite your instructors

Send your instructors the same signup link the platform operator sent you — `<signup-url>`. They'll pick your centre from the dropdown and sign up the same way you did.

As each one signs up:

1. Go to **Admin Panel** → **Manage Users**
2. Find them in the Pending section
3. Set their **Role / Type** (Instructor, Lead, Host)
4. Set their **Teaching Sub-Roles** — at least one of Elementary, Highschool, or Online. Without any sub-role they can't claim shifts or be auto-scheduled.
5. Set their **Priority** (1 = most senior, 3 = newest) — drives the auto-scheduler's ordering when there's competition for slots
6. Click **Approve**

If anyone signs up at the wrong centre, click **Reject** — their account is fully disabled, not just hidden.

### 2.8 First availability cycle

Tell your instructors to log in and submit availability for next month via the **Schedule** page. They click any day, pick a time range (or "Full Day"), and save. Bulk submission is also available via "Set Weekly" for a faster pass through the month.

Give them at least a week's window to submit before you run the scheduler.

### 2.9 Run the auto-scheduler

When availability is in for next month:

1. Go to **Admin Panel** → **Auto-Scheduler**
2. Pick the target month
3. Click **Generate Schedule**

The scheduler builds a draft, day by day. You'll see who's assigned, what hours, and any warnings (low-staff days, Hosts auto-promoted to Instructor to cover a gap, etc.).

Click **Show coverage** on any day for a half-hour-by-half-hour staffing grid — it tells you the peak instructor count and when, useful for capacity decisions.

### 2.10 Review and adjust

Click **Edit** on any day to:

- Tweak shift start/end times for any person
- Swap someone's sub-role for the day (e.g., bump a Highschool-capable person up if you got a Highschool student that day)
- Remove someone who shouldn't be there
- Add someone manually from the approved-staff pool

Save your edits — they stick in the draft until you post.

### 2.11 Post the schedule

Once the draft looks right, click **Post Schedule**. This:

- Writes every shift to Firestore as a live shift
- Emails every instructor that the schedule is posted
- Drops a system message into team chat
- Locks the draft (you can still edit individual shifts after posting via the weekly grid; you just can't re-run the auto-scheduler over the same month without first clearing it)

Your schedule is live.

---

## Part 3 — Day-to-day operations

A short reference for the things you'll be doing regularly.

### Posting an open shift

Someone called in sick on a Wednesday at 5pm. Go to **Admin Panel** → **Scheduling** weekly grid, click the empty cell for that slot, choose **Add Open Shift**. Pick role + sub-role. Save.

It shows up on the Shift Board for every eligible instructor; whoever claims it first gets it, and it auto-becomes a real shift on their schedule.

### Approving time-off

Instructors request via the **Schedule** page (click any day → "Request Time Off"). Approvals live at **Admin Panel** → **Requests**.

Click **Approve** — if they already have shifts in the requested range, those shifts automatically convert to open shifts that other instructors can claim. You don't have to remember to release them manually.

### Running payroll

End of pay period, go to **Admin Panel** → **Payroll**. Pick your date range. Each instructor's scheduled hours show up; click any name to see their per-shift breakdown.

If you use Radius for actual time-clock data: click **Import Radius Export**, drop in the .xlsx file. The portal will match each Radius row to its scheduled shift and flag discrepancies > 15 minutes. Names match fuzzily (first + last token) so middle names and hyphens won't trip it.

Salaried staff (the list you set up in Section 2.5) are automatically excluded from the hourly report.

### Posting announcements

**Announcements** in the sidebar. Pinned announcements always sit at the top of every instructor's home page until you unpin them. Use sparingly so they don't lose impact.

---

## Part 4 — Troubleshooting

### "The auto-scheduler made an empty schedule"

99% of the time: no instructors submitted availability for that month. Check **Schedule** as the owner — do you see availability dots? If not, ping your team.

The other 1%: every available instructor was also on approved time off for that range, or the day is marked as a holiday.

### "An instructor can't claim shifts on the Shift Board"

They probably have zero sub-roles assigned. Open Manage Users, find them, set at least one of Elementary / Highschool / Online. Reload — they should see claimable shifts immediately.

### "I see a 'Multi-Center Setup Required' banner"

Means the centre was created but the migration to stamp `centerId` on existing docs never ran. Your platform operator should run it from **Admin Panel** → **Manage Users** → **Multi-Center Setup** → **Run multi-center migration**. One-time, safe to run multiple times.

### "I logged in and the sidebar looks wrong / I can't see Owner pages"

Your account's `role` is still set to `instructor`. Ping your platform operator to flip it to `owner` in Firebase Console (Part 1, step 1.6).

### "The portal is super slow on Schedule or Admin"

The portal loads the last 180 days of shifts and availability — at high-volume centres this is still hundreds of docs. Should still be fast. If it's not, check your Firestore indexes are deployed (`firebase deploy --only firestore:indexes`).

For data older than 180 days, the live calendar won't show it — payroll back-fills and analytics need a different surface that doesn't exist yet. Tell your platform operator and they can grab data directly from Firestore in the meantime.

---

## Part 5 — What you can change vs. what the platform operator changes

You can change anytime, no help needed:

- Instructional hours, operating hours (Centre Settings)
- Fixed staff list, guaranteed names, salaried staff (Centre Settings)
- Holidays (Admin Panel → Holidays)
- Anyone's role / sub-role / priority / max-days (Manage Users)
- Schedule (post, edit, delete shifts via the weekly grid)
- Open shifts, time-off approvals, announcements, payroll runs

Only the platform operator can change:

- Centre identity (name, city, province, country)
- Which days the centre operates on (Operating Days)
- Shift role colours (Appearance)
- Your billing tier / monthly amount / payment status
- Anyone's `role` field (instructor → owner, etc.)
- Creating or archiving centres

For those, message your platform operator. Audit-logged actions are visible to them on the **Audit Logs** page, so any change to your data on their side leaves a timestamped trail.

---

## Need help?

The platform operator is reachable via **Platform Chat** in the sidebar — that's the direct line to support. It's a separate channel from your in-centre team chat; instructors don't see Platform Chat at all.

For urgent issues, also fine to email or text the operator directly.

Welcome to the platform.
