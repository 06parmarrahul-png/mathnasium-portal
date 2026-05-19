# Resend Setup — replaces EmailJS

All four portal notifications (schedule posted, open shift, shift claimed, time-off decision) now go through **Resend** instead of EmailJS. Templates live as code in `src/lib/emailService.js`, so there are no dashboard template limits to worry about.

## Architecture

```
Browser (emailService.js)
    │  POST /api/send-email  + Firebase ID token
    ▼
Vercel serverless function (api/send-email.js)
    │  resend.batch.send(...)
    ▼
Resend → recipient inboxes
```

The serverless function verifies the caller's Firebase ID token (must be an approved user) before passing the batch to Resend. The Resend API key never touches the browser.

## One-time setup

### 1. Sign up at https://resend.com

Free tier: **3,000 emails/month, 100/day, no credit card.** Your team of 39 will use roughly 250–400/month.

### 2. Verify a sending domain (production) — or skip for testing

In Resend dashboard → **Domains** → **Add Domain**.

- If you own a custom domain (e.g. `mathnasiumlangley.com`), add it and paste the SPF / DKIM / DMARC records Resend gives you into your DNS provider. Takes 5–10 minutes to verify. Then your `from` address can be `noreply@mathnasiumlangley.com`.
- If you don't have a domain yet, you can use `onboarding@resend.dev` as the from address. **Resend only lets you send to your own signup email with this**, so it's only useful for smoke-testing — it will fail when trying to email actual staff.

### 3. Create an API key

Resend dashboard → **API Keys** → **Create API Key** → name it "Mathnasium Portal Production" → Permission: **Sending access** → copy the key (starts with `re_`).

### 4. Set environment variables in Vercel

Vercel → your project → **Settings → Environment Variables**. Add two:

| Name | Value | Environments |
|---|---|---|
| `RESEND_API_KEY` | `re_...` (paste your key) | Production, Preview |
| `RESEND_FROM` | `Mathnasium Langley <noreply@yourdomain.com>` | Production, Preview |

After saving, **redeploy** your project so the function picks up the new env vars (Vercel doesn't hot-reload them).

### 5. Install the npm dependency locally

```bash
npm install
```

(`package.json` already lists `resend` as a dep and dropped `@emailjs/browser`.)

## Verifying it works

1. Deploy to Vercel (or run `vercel dev` locally).
2. Sign in to the portal as an admin and post an open shift.
3. Check the Resend dashboard → **Logs**. You should see one entry per recipient with status `delivered`.
4. If you see errors:
   - `RESEND_API_KEY env var is not set` → step 4 above
   - `domain not verified` → either verify your domain (step 2) or use `onboarding@resend.dev` for testing
   - `403 Account not approved` → the caller's Firestore profile has `approved: false`

## Volume budget

| Trigger | Emails per event | Frequency | Monthly total |
|---|---|---|---|
| Schedule posted | 39 (every staff) | ~1× / month | 39 |
| Open shift posted | 39 (every staff) | ~5× / month | 195 |
| Shift claimed | 1 claimer + ~3 admins | ~5× / month | 20 |
| Time-off decision | 1 (requester) | ~10× / month | 10 |
| **Total** | | | **~265 / month** |

That's 9% of the 3,000/month free cap. You have plenty of headroom for growth — even at 60 staff and 10 open shifts/month you'd be at ~720.

## Where each email fires

| Email | Trigger | File |
|---|---|---|
| Schedule posted | Admin clicks "Post Schedule" | `src/pages/Admin.jsx` `handlePostSchedule` |
| Open shift posted | Admin adds an open shift | `src/pages/Admin.jsx` `handleAddOpenShift` |
| Shift claimed | Employee claims an open shift | `src/pages/Schedule.jsx` + `src/pages/ShiftBoard.jsx` |
| Time-off approved/denied | Admin clicks Approve or Deny | `src/pages/Admin.jsx` (time-off section) |

All four are **fire-and-forget** — if Resend is down or the serverless function errors, the database write still succeeds and the UI doesn't block. Failures log to the browser console as `[emailService] Send failed: ...` and to the Vercel function logs.

## Changing the email template

Edit `src/lib/emailService.js`. The subject and `body` (plain text, newlines = line breaks) are composed per notification type. The serverless function (`api/send-email.js`) wraps everything in a basic HTML shell with the red Mathnasium CTA button — edit `bodyToHtml()` there if you want a different look.
