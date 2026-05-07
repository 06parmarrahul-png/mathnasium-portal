# Mathnasium Langley · Instructor Portal

A web app for the Mathnasium Langley team. Instructors submit availability, request time off, swap shifts, view announcements, and chat with the team. Owners run the schedule, approve users, manage roles, post open shifts, run payroll, and cross-reference Radius timesheet data against scheduled shifts.

## Stack

- **Frontend:** React 19 + Vite
- **Routing:** react-router-dom v7
- **Styling:** Tailwind CSS v4
- **Backend:** Firebase (Auth + Firestore)
- **Email notifications:** EmailJS (browser SDK)
- **Deploy:** Vercel

## Prerequisites

- Node.js 18+ (recommend 20)
- A Firebase project with Email/Password auth enabled and Firestore in production mode
- (Optional) An EmailJS account for outgoing email notifications

## Getting started

```bash
npm install
npm run dev
```

The dev server runs at `http://localhost:5173`.

To build for production:

```bash
npm run build       # output goes to dist/
npm run preview     # serve the prod build locally
npm run lint        # run eslint
```

## Project layout

```
src/
├── App.jsx                      # routes + error boundary
├── main.jsx                     # React entrypoint
├── firebase.js                  # Firebase init (auth + firestore)
├── contexts/
│   └── AuthContext.jsx          # login / signup / logout / password reset
├── components/
│   ├── ErrorBoundary.jsx        # catches render errors
│   ├── Layout.jsx               # sidebar + header shell
│   ├── Logo.jsx
│   └── ProtectedRoute.jsx       # auth + approval + owner gating
├── pages/
│   ├── Login.jsx                # sign in + forgot password
│   ├── Signup.jsx
│   ├── Home.jsx                 # dashboard
│   ├── Schedule.jsx             # calendar, availability, swaps, time off
│   ├── Chat.jsx                 # team chat + shift swap accept
│   ├── Announcements.jsx
│   ├── NotificationPreferences.jsx
│   └── Admin.jsx                # owner-only: scheduler, users, payroll, requests
└── lib/
    ├── scheduler.js             # auto-scheduler engine (pure logic)
    └── emailService.js          # EmailJS wrappers
```

## Firestore collections

- `users` — one doc per user, keyed by uid. Fields: `email`, `displayName`, `role` (`'instructor'` or `'owner'`), `instructorType` (Instructor/Lead/Host/Admin/Manager/Center Director/Dir. of Education), `priority`, `maxDaysPerWeek`, `subRoles[]`, `approved`, `phone`, `createdAt`.
- `availability` — one doc per (user, date). Doc id is `${uid}_${dateStr}` so writes are idempotent.
- `shifts` — assigned shifts. Fields include `userId`, `userName`, `date`, `startTime`, `endTime`, `role`, `shiftType`, `status`.
- `openShifts` — shifts available to claim. `status` is `'open'` or `'claimed'`.
- `timeOffRequests` — `status` is `'pending'`, `'approved'`, or `'denied'`.
- `chat` — messages + system events (shift swaps, schedule postings).
- `announcements` — posts visible to everyone.
- `notificationPreferences` — one doc per user, keyed by uid.

## Security model

1. **Auth:** Firebase email/password.
2. **Approval gate:** New signups land with `approved: false`. The owner approves from the admin panel. `ProtectedRoute` blocks anyone without an approved profile. Users with a deleted profile are also blocked.
3. **Owner gate:** `/admin` is wrapped in `<ProtectedRoute requireOwner>`. Non-owners get a "Not authorized" screen and never subscribe to the admin data feeds.
4. **Role on signup:** All new accounts are created as plain `instructorType: 'Instructor'`. The owner promotes from the admin panel — users can't pick "Admin" at signup.
5. **Firestore rules:** *(Recommended; not yet shipped in this repo.)* Lock the `users` collection so only the owner reads it; everyone reads/writes only their own `availability`, `notificationPreferences`, and `timeOffRequests`; anyone authenticated can read `announcements`, `chat`, `shifts`, `openShifts` but only the owner can write outside their own claim/swap actions.

## Environment / config

Firebase web config and the EmailJS public key currently live in source. They are technically safe to expose (Firebase web keys + EmailJS public keys are both designed to be public) but rotation requires a code commit. A future improvement is to move these to `import.meta.env.VITE_*` in `.env.local` (already gitignored).

## Deploying

The repo deploys cleanly to Vercel with the included `vercel.json`. SPA rewrites are configured (any deep link falls back to `index.html`) and security headers are set. Push to `main` triggers a deploy via the Vercel GitHub integration.

## Useful commands

```bash
npm run lint          # check code
npm run build         # production build
git status            # see what's changed
```

## Auditing & known issues

See `AUDIT.md` for a prioritized list of items found during code review, including ones not yet fixed. Open issues like Firestore rules and bigger refactors are tracked there.
