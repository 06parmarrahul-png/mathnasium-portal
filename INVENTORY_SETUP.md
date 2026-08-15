# Inventory Tracker — setup

Centre supply tracking for **admins and above** (admin, admin assistant,
director, owner, super-admin). Instructors never see it.

## What shipped

| File | Change |
|---|---|
| `src/lib/inventory.js` | **new** — categories, item model, low-stock logic, Firestore reads/writes, change log, CSV, order-list email |
| `src/pages/Inventory.jsx` | **new** — the page |
| `api/cron/check-inventory.js` | **new** — weekly low-stock email to the admin team |
| `src/App.jsx` | +1 lazy import, +1 route (`/inventory`, admin-gated) |
| `src/components/Layout.jsx` | +1 sidebar link (Centre section for owners, Manage for admins) |
| `vercel.json` | +1 cron entry |
| `firestore.rules` | +2 match blocks (`inventory`, `inventoryLog`) |

Nothing existing was rewritten — every edit is additive.

## Categories

STEAM (STEM + Art) · Events · Games · Holidays · Summer Camp · Crafts ·
Fun Days · Administrative · Cleaning · Rewards

Defined once in `INVENTORY_CATEGORIES` (`src/lib/inventory.js`). Adding an
eleventh category is one entry in that array — filters, forms, CSV and the
reorder email all pick it up. If you add one, mirror the label into
`CATEGORY_LABELS` in `api/cron/check-inventory.js` (API routes can't import
from `src/`).

## Data model

```
centers/{centerId}/inventory/{itemId}       ← items, centre-scoped
centers/{centerId}/inventory/__settings     ← alert recipients + on/off
centers/{centerId}/inventoryLog/{entryId}   ← every count change, append-only
```

Everything is per centre, so Langley and Burnaby never see each other's
counts. The settings doc sits inside the items collection on purpose so it
inherits the same admin-only security rule.

Each item carries `par` (the reorder point) and `orderUrl` (the link an
admin sets up once — Amazon saved cart, Staples list, the franchise supply
portal). `qty <= par` → **Low**. `qty <= 0` → **Out**. `par = 0` → never
alerts, for things you don't restock.

## Deploy

```bash
git add -A
git commit -m "Add centre inventory tracker (admin+)"
git push
```

Vercel picks up the new API route and cron automatically. Then push the
rules — they are NOT deployed by `git push`:

```bash
firebase deploy --only firestore:rules
```

Until the rules are deployed, reads and writes to `inventory` fall through
to the existing `/centers/{centerId}/{document=**}` catch-all, which lets
every signed-in staff account **read** it. Deploy the rules the same day.

## Environment variables

The weekly email reuses what `send-shift-reminders` already needs:

| Var | Needed | Notes |
|---|---|---|
| `CRON_SECRET` | already set | Vercel Cron sends it as `Authorization: Bearer …` |
| `RESEND_API_KEY` | already set | |
| `RESEND_FROM` | already set | |
| `FIREBASE_SERVICE_ACCOUNT` | already set | |
| `PORTAL_URL` | **optional, new** | Absolute portal URL for the email button, e.g. `https://your-portal.vercel.app`. Falls back to `VERCEL_URL`. |

## The weekly email

Runs Mondays at 08:00 Pacific (`0 15 * * 1` UTC in `vercel.json`).

For each centre it collects every Low/Out item, groups them by category,
and emails the admin team a list with the order link on each row. Recipients
are whoever is set in **Inventory → Alerts**; if that's blank it falls back
to every approved owner / admin assistant / director / admin at that centre.
Super-admins are excluded on purpose — otherwise the platform operator gets
one per centre.

It won't nag. The endpoint fingerprints the outstanding list; if nothing has
changed it stays quiet for 7 days. The moment something new runs low, or
something gets restocked, the fingerprint changes and the next run sends.

Test it without waiting for Monday:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-portal.vercel.app/api/cron/check-inventory
```

Returns a per-centre JSON report (`sent`, `lowItems`, or why it skipped).

There's also an **Email the admin team now** button inside the Order list
modal, which sends the same list on demand via `/api/send-email`.

## First run

1. Sign in as owner/admin → **Inventory** in the sidebar.
2. Click **Add starter catalogue** — ~48 common Mathnasium supplies across
   all ten categories, all starting at zero.
3. Walk the shelves. Click any number to type the real count.
4. Open a few items and paste the **order link** you use for each. That's
   the field that makes the low-stock email actionable rather than
   informational.
5. **Alerts** → set who gets the Monday email.

Day to day, staff use the `−` / `+` buttons as they use things up, and the
Order list button tells you what to buy.

## Notes

- Every count change writes a row to `inventoryLog` — who, what, from → to,
  when. Visible under **Recent activity**. Admins can append and read it but
  not edit or delete it; only super-admin can prune.
- **Delete** removes an item permanently; **Archive** (in the edit modal)
  keeps the history and hides it from the default view. Prefer archive.
- Unit cost is optional. Where it's set, the reorder estimate on the page
  and in the Order list adds up what the next order will cost.
- Export gives you a CSV of whatever is currently filtered.
