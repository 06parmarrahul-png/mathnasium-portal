# Ratio

A multi-tenant platform for running Mathnasium-style learning centers. What started as a single-location instructor portal (Mathnasium Langley) has grown into a product that any center can onboard onto: staff scheduling and payroll on one side, lead intake and business analytics on the other, with a platform-admin layer to operate across every center.

## Who uses it

- **Instructors** — submit availability, request time off, claim/swap shifts on the shift board, chat with the team, read announcements.
- **Leads** — same as instructors, plus can run the day-of-day Student Scheduler.
- **Owners / Admin Assistants / Directors** (`admin_assistant`, `director` are owner-equivalent at the center level) — run the schedule, approve/promote users, manage roles, post open shifts, run payroll (including cross-referencing Radius timesheet exports against scheduled shifts), manage supply inventory, review the availability/audit logs, configure center settings, and manage lead intake with a public booking page for prospective families.
- **Super admins** — operate the platform across every center: cross-center chat, platform revenue/billing, role management, and a center switcher for support.

A single account can belong to multiple centers (`centerIds[]`), with per-center role/state stored in `centerMemberships`.

## Stack

- **Frontend:** React 19 + Vite, Tailwind CSS v4, react-router-dom v7
- **Backend:** Firebase (Auth + Firestore), plus Vercel serverless functions under `api/` (Firebase Admin SDK) for anything that needs a trusted server: Stripe billing + webhooks, Resend email, Apptoto appointment sync, scheduled shift-reminder cron, calendar token links, an AI owner-assistant ("Jarvis") chat, and staff create/reject actions that touch Firebase Auth directly.
- **Payments:** Stripe (platform billing)
- **Email:** Resend (server-side) and EmailJS (some legacy client-side notifications)
- **Deploy:** Vercel

## Prerequisites

- Node.js 18+ (recommend 20)
- A Firebase project with Email/Password auth enabled, Firestore in production mode, and a service account for the Admin SDK (used by `api/`)
- Stripe and Resend accounts if you're exercising billing or transactional email locally

## Getting started

```bash
npm install
npm run dev
```

The dev server runs at `http://localhost:5173`.

```bash
npm run build       # production build → dist/
npm run preview     # serve the prod build locally
npm run lint        # eslint
npm run test        # vitest (watch)
npm run test:run    # vitest (single run)
```

## Project layout

```
src/
├── App.jsx                      # routes, lazy-loaded pages, error boundary
├── main.jsx                     # React entrypoint
├── firebase.js                  # Firebase init (auth + firestore, offline persistence)
├── contexts/
│   └── AuthContext.jsx          # auth, active center, role helpers, center config
├── components/                  # shared UI: layout, modals, cards, editors
├── pages/                       # one file per route — see App.jsx for the full route table
└── lib/                         # pure logic + Firestore helpers (scheduler engine,
                                  # analytics, inventory, leads, audit log, etc.)

api/
├── assistant/                   # owner-facing AI assistant chat
├── stripe/                      # billing + webhook handlers
├── users/                       # server-side create/reject (needs Admin SDK)
├── cron/                        # scheduled shift-reminder emails
├── calendar/, scheduler/        # tokenized calendar links, appointment sync
└── apptoto.js, intakes.js, ...  # third-party integrations
```

## Data model

Firestore is multi-tenant: most collections carry a `centerId` field, and per-center config lives at `centers/{centerId}/config/main`. Core collections include `users`, `availability`, `shifts`, `openShifts`, `timeOffRequests`, `chat`, `announcements`, `notificationPreferences`, plus newer ones backing inventory, leads/intake, and audit logging. See `src/lib/` for the read/write helpers around each.

## Security model

1. **Auth:** Firebase email/password.
2. **Approval gate:** new signups land unapproved; the owner approves from the admin panel. `ProtectedRoute` blocks unapproved or deleted profiles.
3. **Role gates:** routes are wrapped in `<ProtectedRoute requireOwner>` / `requireSuperAdmin>` / `blockVolunteers` as appropriate — see the route table in `src/App.jsx` for exactly which pages require which role.
4. **Role on signup:** the first approved signup at a center is auto-promoted to owner; everyone after that lands as a plain `instructorType: 'Instructor'` and is promoted only by an owner/admin.
5. **Firestore rules:** see `firestore.rules` in the repo root.

## Environment / config

Firebase web config lives in `src/firebase.js` (Firebase web keys are designed to be public). Server-side secrets (Firebase Admin service account, Stripe keys, Resend key, EmailJS keys) belong in Vercel environment variables / `.env.local`, not in source.

## Deploying

The repo deploys to Vercel via `vercel.json` (SPA rewrites + security headers). Push to `main` triggers a deploy through the Vercel GitHub integration.

## Auditing & known issues

`AUDIT.md` is a point-in-time code review from May 2026 against a much smaller version of this codebase; most of its items have since been fixed (see `CHANGES.md`), but it's kept for historical context rather than as a current issue tracker.
