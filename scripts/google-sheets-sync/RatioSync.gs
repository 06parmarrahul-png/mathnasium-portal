/**
 * Ratio — Student Assessment Tracker auto-sync.
 *
 * Paste this entire file into your Student Assessment Tracker Google Sheet:
 *   Extensions → Apps Script → replace Code.gs contents → Save.
 *
 * Then fill in the two CONFIG values below and run setup() once.
 *
 * Privacy: the sheet stays fully private. Nothing is shared with Google,
 * with a service account, or with anyone other than your own Ratio
 * server. Edits never leave Apps Script → ratiosolved.com.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────
// Both values come from Ratio → Scheduler Creation → "Google Sheets sync"
// card. Paste them between the quotes.
const CENTER_ID = '';   // e.g. 'mathnasium-langley'
const SYNC_TOKEN = '';  // long random string — keep secret

// Optional: leave as-is unless you're testing against a different domain.
const RATIO_URL = 'https://ratiosolved.com/api/scheduler/appointments?action=sync-students';

// ─── PUBLIC ENTRY POINTS ─────────────────────────────────────────────────

/** One-time setup. Run this from the Apps Script editor. */
function setup() {
  if (!CENTER_ID || !SYNC_TOKEN) {
    throw new Error('Please fill in CENTER_ID and SYNC_TOKEN at the top of this script.');
  }
  // Install the auto-sync trigger (fires on every edit).
  const existing = ScriptApp.getProjectTriggers();
  for (const t of existing) {
    if (t.getHandlerFunction() === 'autoSync') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('autoSync')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
  // Try a sync now so the user gets immediate feedback that it works.
  const result = syncNow_();
  SpreadsheetApp.getUi().alert(
    'Ratio sync installed.\n\n' + result.message,
  );
}

/** Menu item — sync the current sheet to Ratio immediately. */
function syncNow() {
  const result = syncNow_();
  SpreadsheetApp.getUi().alert(result.message);
}

/** onEdit trigger — auto-syncs when anything in the sheet changes. */
function autoSync() {
  // Apps Script onEdit fires once per cell-leave, not per keystroke, so
  // we don't need extra debouncing. But we DO want to skip syncs that
  // happen in tight succession (e.g. paste a 200-row block) — the last
  // one wins, the others would just be duplicate work.
  const props = PropertiesService.getDocumentProperties();
  const now = Date.now();
  const last = Number(props.getProperty('lastAutoSync') || 0);
  if (now - last < 2000) {
    // Mark dirty so the next eligible sync catches up.
    props.setProperty('dirtyAfter', String(now));
    return;
  }
  props.setProperty('lastAutoSync', String(now));
  syncNow_('onEdit');
}

// ─── INTERNAL ────────────────────────────────────────────────────────────

function syncNow_(source) {
  if (!CENTER_ID || !SYNC_TOKEN) {
    return { ok: false, message: 'Sync not configured. Fill in CENTER_ID and SYNC_TOKEN.' };
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const rows = sheet.getDataRange().getValues();

  const res = UrlFetchApp.fetch(RATIO_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Ratio-Center': CENTER_ID,
      'X-Ratio-Token': SYNC_TOKEN,
    },
    payload: JSON.stringify({ rows: rows, source: source || 'manual' }),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  let parsed = null; try { parsed = JSON.parse(body); } catch (e) {}

  if (code >= 200 && code < 300 && parsed && parsed.ok) {
    return {
      ok: true,
      message: 'Synced ' + parsed.imported + ' students' +
               (parsed.deleted ? ' (' + parsed.deleted + ' removed)' : '') + '.',
    };
  }
  return {
    ok: false,
    message: 'Sync failed (' + code + '): ' + (parsed?.error || body.slice(0, 200)),
  };
}

/** Adds a "Ratio" menu with a "Sync now" item when the sheet is opened. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Ratio')
    .addItem('Sync now', 'syncNow')
    .addSeparator()
    .addItem('Re-install auto-sync', 'setup')
    .addToUi();
}
