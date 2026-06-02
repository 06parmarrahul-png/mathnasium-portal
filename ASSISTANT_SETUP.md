# Owner Assistant — Setup

Floating "Jarvis-style" chatbot, owner-only, mounted globally. Each owner gets their own session, their own memory, their own message log. Backed by Claude with tool use.

## How it works

- **Widget** (`src/components/OwnerAssistant.jsx`) — bottom-right pill on every page. Renders only when `useAuth().isOwner` is true.
- **API** (`api/assistant/chat.js`) — Vercel serverless function. Verifies the Firebase ID token, refuses non-owners, calls Claude with the tool list, runs each `tool_use` block, writes the assistant reply (and a one-line trace for each tool call) into Firestore.
- **Tools** (`api/assistant/_tools.js`) — `send_email` (Resend), `get_center_data` (Firestore — staff, open shifts, announcements, center config), `schedule_event` (writes to the owner's personal events subcollection), `save_long_term_memory` (appends a durable fact to a summary the model sees on every turn).
- **Storage** — `/ownerAssistant/{ownerUid}` holds the long-term `summary`; `/ownerAssistant/{ownerUid}/messages` is the chat log; `/ownerAssistant/{ownerUid}/events` is the personal calendar. Firestore rules silo each owner to their own doc tree.
- **Memory model** — short-term: last 30 messages fed to Claude every turn. Long-term: free-text summary the model edits via the memory tool.
- **Emotion-aware tone** — handled in the system prompt. Claude reads the owner's message and adjusts (calming when stressed, brief when focused, casual when casual).

## Required env vars (Vercel project settings)

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/ → API Keys |
| `FIREBASE_SERVICE_ACCOUNT` | already set — same one `api/send-email.js` uses |
| `RESEND_API_KEY` | already set |
| `RESEND_FROM` | already set |

## Deploy steps

1. Add `ANTHROPIC_API_KEY` to Vercel env vars (Production + Preview).
2. Push the branch — Vercel auto-deploys.
3. Deploy the updated rules: `firebase deploy --only firestore:rules`.
4. Sign in as an owner — you'll see the red "Assistant" pill bottom-right.

## Quick smoke tests

- Click pill → panel opens with greeting.
- Type "How many open shifts do we have?" → it calls `get_center_data` and answers.
- Type "Remember that I prefer morning meetings." → it calls `save_long_term_memory`; next session, the system prompt will include that fact.
- Type "Email <yourself@x.com> a short thank-you note from me." → it calls `send_email`.

## Knobs (`api/assistant/chat.js`)

- `MODEL` — defaults to `claude-sonnet-4-5-20250929`. Swap for `claude-opus-4-6` if you want more reasoning power per call.
- `HISTORY_LIMIT` (30) — how much context Claude sees each turn.
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
