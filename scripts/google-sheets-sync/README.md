# Google Sheets → Ratio auto-sync

Stop exporting CSVs. Ratio can pull your Student Assessment Tracker
straight from Google Sheets every time you edit it.

## How it works

1. A tiny Apps Script lives in your Google Sheet.
2. On every edit, it POSTs the sheet contents to
   `https://ratiosolved.com/api/scheduler/appointments?action=sync-students`.
3. Ratio's server runs the same parser as the existing CSV import —
   section headers (Elementary / High School / Online), hybrid routing,
   "binder" → assessment flag, column-I assigned instructor.
4. Anything in Firestore that's no longer in the sheet gets deleted.
   **The sheet is the source of truth.**

Privacy: the sheet stays fully private. No service account, no
published-to-web URL, no third party. The script runs as you and pushes
directly to your Ratio server over HTTPS.

## One-time setup (~2 minutes)

1. In Ratio, go to **Scheduler Creation → Setup tab**. Find the
   **Auto-sync from Google Sheets** card and click **Enable auto-sync**.
   Ratio mints a long random token and shows it to you exactly once.

2. Open your Student Assessment Tracker Google Sheet.

3. Click **Extensions → Apps Script**. Delete whatever is in
   `Code.gs` and paste the contents of `RatioSync.gs` (in this folder).

4. At the top of the script, fill in the two values Ratio gave you:
   ```js
   const CENTER_ID = 'your-center-id';
   const SYNC_TOKEN = 'the-long-random-string';
   ```

5. Save the script (disk icon), then run the function named `setup`.
   Apps Script will ask for permissions to read your sheet and make
   HTTPS requests — accept them. You'll see a popup that says
   "Ratio sync installed."

6. Done. Edit any cell in the sheet; Ratio's roster updates within
   seconds. The sheet's menu bar will also have a new **Ratio → Sync
   now** option if you ever want to force one manually.

## Troubleshooting

**"Sync failed (403): Invalid sync token"** — the token in the script
doesn't match the one in Ratio. Either click **Rotate token** in Ratio
and paste the new one, or re-paste the original carefully (no extra
spaces or line breaks).

**"Sync failed (400): X-Ratio-Center header required"** — the
`CENTER_ID` constant at the top of the script is empty. Fill it in.

**Sheet edits aren't pushing.** Re-run the `setup` function from the
Apps Script editor — that re-installs the onEdit trigger. (The trigger
can get cleared if you make structural changes to the script.)

**I rotated the token by accident and don't know the new one.** Click
**Rotate token** again — that mints another one and shows it. Paste
the new value into the script.

## Security

- The token is 32 bytes of CSPRNG randomness, stored only in your
  Firestore at `centers/{centerId}/schedulerSettings/main.sheetSync.token`
  and in your Apps Script source.
- Tokens are compared using constant-time equality on the server.
- Rotating the token instantly invalidates the old one — the next sync
  attempt with the old token will 403 and prompt you to update.
- Disconnect from the Ratio UI deletes the token entirely. The server
  will reject any sync attempt until a new token is issued.
