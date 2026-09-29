# SMS Setup — replacing Apptoto's reminders

Text reminders for families, with a STOP that actually works.

The blocker on dropping Apptoto was never the booking page — that already
exists at `/book/:centerId`. It was that we could not text families, and
could not let them opt out. This is how that gets turned on.

## Architecture

```
Family books  →  /api/intakes  →  intake + lead  →  reminder cron
                                                        │
                                       consent gate (src/lib/consent.js)
                                                        │
                                              Twilio → family's phone
                                                        │
                       family replies STOP  →  /api/notify?action=sms-inbound
                                                        │
                                          consent record: withdrawn
```

Every send asks `maySend()` first. There is deliberately **one** gate: a
second way to send would be a second way to text somebody who said stop.

## What it costs

Figures below were accurate when written and **should be checked against
Twilio's current pricing page** — per-message rates and carrier surcharges
move, and Canadian surcharges have been changing.

| Item | Approx. |
|---|---|
| Toll-free number | **~$2 / month** |
| Outbound SMS (US/Canada) | **~1–1.5¢** per 160-character segment, carrier fees included |
| Inbound SMS (a STOP, a reply) | **~0.75¢** each |
| Toll-free verification | **free** (costs time, not money) |

A worked example, using Langley's real funnel volume (~48 leads/month):

```
60 assessments/month × 3 messages   (confirmation + 24h + 2h)   = 180 SMS
180 × $0.012                                                    ≈ $2.16
toll-free number                                                ≈ $2.15
                                                          total ≈ $4.31/month
```

Five times that volume is still under $15/month. Email stays on Resend's
free tier (3,000/month) — family reminders add roughly 120/month.

Compare against the Apptoto invoice. The saving is not really the point
though: the point is the booking page, the funnel and the reminders being
one system that a district manager can see across every centre.

### One cost worth considering separately

Vercel **Hobby** allows 12 serverless functions and this project has
exactly 12 — which is why `api/notify.js`, `api/apptoto.js` and
`api/intakes.js` each carry several routes rather than being split. Pro is
about $20/month and lifts that. Hobby's terms are also for non-commercial
use, and Ratio bills through Stripe. Worth a look independently of SMS.

## One-time setup

### 1. Twilio account and a toll-free number

https://www.twilio.com → sign up → **Phone Numbers → Buy a number** →
filter **Toll-free**, capability **SMS**.

Toll-free rather than a local 10DLC number on purpose: verification is
days rather than weeks, throughput is higher, and it is the right shape
for appointment reminders.

### 2. Submit toll-free verification — do this FIRST, it is the long pole

**Phone Numbers → Regulatory Compliance → Toll-Free Verification.**

Expect days to ~2 weeks. Until it passes, messages are heavily throttled
or blocked outright, so start it before anything else is ready.

It asks for **proof of opt-in**, and this is the part that trips people
up: they want to see the form where the family agrees, with the consent
wording visible. So:

1. Turn Ratio's booking page on for the centre first (step 5 below).
2. Screenshot `/book/<centerId>` with the consent checkbox in frame.
3. Submit that as the opt-in proof.

Use the real wording from the page in the "opt-in description" box, and
sample messages that match what the cron actually sends.

### 3. Environment variables (Vercel → Settings → Environment Variables)

| Name | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console |
| `TWILIO_FROM` | the toll-free number, E.164 — `+18005550100` |
| `UNSUBSCRIBE_SECRET` | any long random string, e.g. `openssl rand -base64 32` |
| `SMS_HELP_CONTACT` | what HELP replies point at — a centre address you control |
| `PORTAL_URL` | your stable production URL, no trailing slash |

`PORTAL_URL` is not optional here even though other code treats it as
such. Without it the unsubscribe link falls back to `VERCEL_URL`, which
is the URL of one *deployment* and changes every time you push. An
unsubscribe link sits in somebody's inbox for months; built from
`VERCEL_URL` it stops working the next time you deploy, and a dead
opt-out link is worse than no link at all — the reply is "report spam".

`TWILIO_AUTH_TOKEN` is not optional. The inbound route **refuses to trust
any request** when it is unset, rather than accepting unsigned ones —
that route can mark a number as withdrawn, and via START as consenting
again, so an unsigned caller could forge the record.

Redeploy after adding them; Vercel only picks up env changes on a build.

### 4. Point Twilio's inbound webhook at Ratio

**Phone Numbers → your toll-free number → Messaging → A message comes in**

```
https://<your-app>/api/notify?action=sms-inbound&centerId=<centreId>
```

Method **POST**. One URL per centre — the `centerId` is what decides whose
consent record a STOP writes to, because consent is given to a sender and
a family telling Langley to stop has not told Burnaby anything.

### 5. Turn Ratio's own booking page on

**Centre Settings → Intake booking** → enable. It defaults to off.

Then book a test assessment through `/book/<centerId>` yourself and check
it lands in Intakes *and* in Leads.

### 6. Have the consent wording reviewed

The wording on the booking form today is Mathnasium corporate's, and it
covers **advertising** only — "recurring advertising text messages… about
promotions". It is optional and unticked by default, which is correct.

What it is not is permission to send an appointment reminder. The gate
handles that distinction (a booking is basis for a reminder and never for
a promotion), but the page should probably say so in a second plain line,
and whoever owns compliance should approve both. The current text also
points at `SMS@mathnasium.com`, an address this app does not control —
`SMS_HELP_CONTACT` should be something the centre can actually answer.

This file implements a policy. It does not certify one.

## Testing before real families see it

1. Text **HELP** to the toll-free number → expect the centre's help reply.
2. Text **STOP** → expect one confirmation, and check
   `centers/<id>/contactConsent/sms:+1…` shows `state: withdrawn` with your
   message in `history`.
3. Book an assessment with that same number → the reminder must **not**
   send, and the skip reason should read `withdrawn`.
4. Text **START** → state returns to `granted`, reminders resume.
5. Click the unsubscribe link in a family email → the email record goes
   `withdrawn` and the page says so without asking anyone to log in.

## Going live

Run both systems for a few weeks. Leads carry a `source`, so **Where they
come from** on the district page answers the only question that matters:
how many families still arrive through Apptoto. When that is near zero,
cancel it.
