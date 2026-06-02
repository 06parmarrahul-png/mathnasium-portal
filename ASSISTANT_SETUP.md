# Owner Assistant — Setup

Floating "Jarvis-style" chatbot, owner-only, mounted globally. Each owner gets their own session, their own memory, their own message log. Backed by **Google Gemini 2.0 Flash** (free tier) with tool use.

## How it works

- **Widget** (`src/components/OwnerAssistant.jsx`) — bottom-right pill on every page. Renders only when `useAuth().isOwner` is true.
- **API** (`api/assistant/chat.js`) — Vercel serverless function. Verifies the Firebase ID token, refuses non-owners, calls Gemini with the tool list, runs each `functionCall` part, writes the assistant reply (and a one-line trace for each tool call) into Firestore.
- **Tools** (`api/assistant/_tools.js`) — `send_email` (Resend), `get_center_data` (Firestore — staff, open shifts, announcements, center config), `schedule_event` (writes to the owner's personal events subcollection), `save_long_term_memory` (appends a durable fact to a summary the model sees on every turn).
- **Storage** — `/ownerAssistant/{ownerUid}` holds the long-term `summary`; `/ownerAssistant/{ownerUid}/messages` is the chat log; `/ownerAssistant/{ownerUid}/events` is the personal calendar. Firestore rules silo each owner to their own doc tree.
- **Memory model** — short-term: last 30 messages fed to Gemini every turn. Long-term: free-text summary the model edits via the memory tool.
- **Emotion-aware tone** — handled in the system prompt. The model reads the owner's message and adjusts (calming when stressed, brief when focused, casual when casual).

## Required env vars (Vercel project settings)

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | https://aistudio.google.com/app/apikey → **Create API key** (free, Google sign-in, no card required) |
| `FIREBASE_SERVICE_ACCOUNT` | already set — same one `api/send-email.js` uses |
| `RESEND_API_KEY` | already set |
| `RESEND_FROM` | already set |

**Free tier limits** (Gemini 2.0 Flash): 15 requests/minute, 1,500 requests/day. Comfortable for owner-scale traffic.

## Deploy steps

1. Add `GEMINI_API_KEY` to Vercel env vars (Production + Preview + Development).
2. Push the branch — Vercel auto-deploys.
3. Deploy the updated rules: `firebase deploy --only firestore:rules`.
4. Sign in as an owner — you'll see the red "Assistant" pill bottom-right.

## Quick smoke tests

- Click pill → panel opens with greeting.
- Type "How many open shifts do we have?" → it calls `get_center_data` and answers.
- Type "Remember that I prefer morning meetings." → it calls `save_long_term_memory`; next session, the system prompt will include that fact.
- Type "Email <yourself@x.com> a short thank-you note from me." → it calls `send_email`.

## Knobs (`api/assistant/chat.js`)

- `MODEL` — defaults to `gemini-2.0-flash`. For a quality bump, swap to `gemini-2.5-pro` (still free, lower daily limit). To switch to Claude later, point the request at the Anthropic Messages API and change the request/response mappers.
- `HISTORY_LIMIT` (30) — how much context the model sees each turn.
- `MAX_TOOL_TURNS` (6) — hard ceiling on tool-call iterations per request.
- `MAX_TOKENS` (1024) — reply length cap.

## Adding a new tool

In `api/assistant/_tools.js`:

1. Add a schema object to `TOOL_DEFINITIONS`.
2. Add a handler to `TOOL_HANDLERS` — signature `async (input, ctx) => result`. `ctx` is `{ profile, centerId, db, ownerUid }`.
3. Optionally add a one-line summary in `summarizeToolResult` in `chat.js` so the UI trace reads nicely.

## Security notes

- The API route refuses anyone whose Firestore profile isn't `role === 'owner'` and `approved === true`.
- Firestore rules block client-side access to any other owner's assistant data.
- Tools run server-side with the Admin SDK and are scoped to the caller's `ownerUid` / `centerId` — no cross-owner leakage path.
- The model never sees raw API keys; all secrets stay in Vercel env.
