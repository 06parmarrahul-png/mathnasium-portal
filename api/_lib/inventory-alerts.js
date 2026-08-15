// Inventory low-stock sweep.
//
// WHY THIS IS A LIBRARY AND NOT A ROUTE
//   Vercel's Hobby plan caps a deployment at 12 Serverless Functions and
//   this project is at the ceiling. Anything under api/_lib/ is treated
//   as a module, not a function, so the sweep rides along inside the
//   existing daily cron (api/cron/send-shift-reminders.js) instead of
//   costing a slot. If the project ever moves to Pro, lifting this back
//   out into api/cron/check-inventory.js is a copy-paste.
//
// WHAT IT DOES
//   For every centre, finds the supplies at or below their reorder point
//   and emails the admin team a ready-to-order list — item, how many to
//   buy, and the order link an admin set up on the item. That link is the
//   whole point: "we're low on glue sticks" becomes one click instead of
//   a hunt for last year's invoice.
//
// WHO GETS IT
//   1. The recipients set on the centre's alert settings (Inventory →
//      Alerts), if any.
//   2. Otherwise every approved owner / admin_assistant / director /
//      admin at that centre. Instructors are never included — inventory
//      is an admin-and-above surface.
//   Platform super-admins are deliberately excluded; they'd otherwise get
//   one of these for every centre on the platform.
//
// THROTTLING — this is what makes a DAILY run safe
//   The host cron runs every morning, but a centre only gets an email
//   when there's something new to say:
//
//     • something just hit ZERO that wasn't out before  → send today
//     • the list changed and it's been 3+ days          → send
//     • the list hasn't changed at all                  → resend after 7 days
//     • nothing is low                                  → silence
//
//   So a slow drip of items going low doesn't produce a daily nag, but a
//   genuine "we are OUT of printer toner" reaches the team the morning it
//   happens rather than the following Monday.
//
// ENV
//   RESEND_API_KEY, RESEND_FROM — same vars the host cron already needs.
//   PORTAL_URL (optional) — absolute portal URL for the email button.
//                           Falls back to VERCEL_URL.

import { Resend } from 'resend';

let _resend = null;
function resendClient() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY env var is not set');
  _resend = new Resend(key);
  return _resend;
}

// Roles that receive the low-stock email when no explicit recipients are
// set. Mirrors canSeeAdminPanel in AuthContext, minus super_admin.
const ADMIN_ROLES = new Set(['owner', 'admin_assistant', 'director', 'admin']);
const DIRECTOR_TITLES = new Set([
  'center director', 'centre director',
  'dir. of education', 'director of education',
]);

function isAdminish(u) {
  if (ADMIN_ROLES.has(u.role)) return true;
  const t = String(u.instructorType || '').trim().toLowerCase();
  return DIRECTOR_TITLES.has(t);
}

// Category keys → display labels. Kept in sync with INVENTORY_CATEGORIES
// in src/lib/inventory.js; duplicated because API routes can't import
// from src/ in this deployment layout. Add a category there, add it here.
const CATEGORY_LABELS = {
  steam:          'STEAM (STEM + Art)',
  events:         'Events',
  games:          'Games',
  holidays:       'Holidays',
  summer_camp:    'Summer Camp',
  crafts:         'Crafts',
  fun_days:       'Fun Days',
  administrative: 'Administrative',
  cleaning:       'Cleaning',
  rewards:        'Rewards',
};

const MIN_GAP_MS    = 3 * 24 * 60 * 60 * 1000; // changed list: wait 3 days
const REPEAT_GAP_MS = 7 * 24 * 60 * 60 * 1000; // unchanged list: repeat weekly

function statusOf(item) {
  const qty = Number(item.qty) || 0;
  const par = Number(item.par) || 0;
  if (qty <= 0) return 'out';
  if (par > 0 && qty <= par) return 'low';
  return 'ok';
}

function portalUrl() {
  if (process.env.PORTAL_URL) return process.env.PORTAL_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return '';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Fingerprint of the outstanding list — id + status, order-independent. */
function alertKey(items) {
  return items.map(i => `${i.id}:${statusOf(i)}`).sort().join('|');
}

/**
 * Should this centre be emailed right now?
 * Returns a reason string when yes, or null when we stay quiet.
 */
function shouldSend(key, low, settings) {
  const lastAt = settings.lastAlertSentAt ? Date.parse(settings.lastAlertSentAt) : 0;
  if (!lastAt) return 'first alert';

  // Anything that has just hit zero jumps the queue — an OUT item is
  // blocking a session today, not next week.
  const prev = new Set(String(settings.lastAlertKey || '').split('|').filter(Boolean));
  const newlyOut = low.some(i => statusOf(i) === 'out' && !prev.has(`${i.id}:out`));
  if (newlyOut) return 'something newly out of stock';

  const age = Date.now() - lastAt;
  if (key !== settings.lastAlertKey && age >= MIN_GAP_MS) return 'list changed';
  if (age >= REPEAT_GAP_MS) return 'weekly reminder, still outstanding';
  return null;
}

function buildText(centreName, groups, link) {
  const lines = [`Supply reorder list — ${centreName}`, ''];
  for (const [label, items] of groups) {
    lines.push(label.toUpperCase());
    for (const i of items) {
      const want = Number(i.reorderQty) || Number(i.par) || 1;
      const tag = statusOf(i) === 'out' ? 'OUT OF STOCK' : 'low';
      lines.push(`  - ${i.name}: order ${want} ${i.unit || 'each'} (have ${Number(i.qty) || 0}, ${tag})`);
      if (i.orderUrl) lines.push(`      ${i.orderUrl}`);
    }
    lines.push('');
  }
  if (link) lines.push(`Update counts in the portal: ${link}/inventory`);
  return lines.join('\n');
}

function buildHtml(centreName, groups, link) {
  const sections = groups.map(([label, items]) => {
    const rows = items.map(i => {
      const want = Number(i.reorderQty) || Number(i.par) || 1;
      const badge = statusOf(i) === 'out'
        ? '<span style="background:#fee2e2;color:#991b1b;border-radius:9999px;padding:2px 8px;font-size:11px;font-weight:700;">OUT</span>'
        : '<span style="background:#fef3c7;color:#92400e;border-radius:9999px;padding:2px 8px;font-size:11px;font-weight:700;">LOW</span>';
      const orderCell = i.orderUrl
        ? `<a href="${esc(i.orderUrl)}" style="color:#dc2626;font-weight:600;text-decoration:none;">Order &rarr;</a>`
        : '<span style="color:#9ca3af;">no link set</span>';
      return `<tr>
  <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">
    <strong style="color:#111827;">${esc(i.name)}</strong><br>
    <span style="color:#6b7280;font-size:12px;">Order ${want} ${esc(i.unit || 'each')} &middot; have ${Number(i.qty) || 0}</span>
  </td>
  <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;text-align:center;">${badge}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;text-align:right;font-size:13px;">${orderCell}</td>
</tr>`;
    }).join('');

    return `<p style="margin:22px 0 6px 0;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af;">${esc(label)}</p>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;">${rows}</table>`;
  }).join('');

  const cta = link
    ? `<p style="margin:26px 0 0 0;"><a href="${esc(link)}/inventory" style="background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">Open Inventory</a></p>`
    : '';

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#374151;line-height:1.55;max-width:640px;">
<p style="margin:0 0 6px 0;">Hi team,</p>
<p style="margin:0 0 14px 0;">These supplies at <strong>${esc(centreName)}</strong> are at or below their reorder point. Order links are attached where one has been set up on the item.</p>
${sections}
${cta}
<p style="margin:22px 0 0 0;font-size:12px;color:#9ca3af;">Sent by Ratio. Change who receives this in Inventory &rarr; Alerts.</p>
</div>`;
}

/**
 * Run the sweep across every centre.
 *
 * @param {object}  args
 * @param {object}  args.db           firebase-admin Firestore instance
 * @param {string}  args.fromAddress  RESEND_FROM
 * @param {boolean} [args.force]      ignore throttling (manual test runs)
 * @returns {Promise<object>} per-centre report — safe to include in a
 *                            cron response body.
 */
export async function runInventorySweep({ db, fromAddress, force = false }) {
  if (!fromAddress) throw new Error('RESEND_FROM env var is not set');

  const link = portalUrl();
  const nowIso = new Date().toISOString();
  const centersSnap = await db.collection('centers').get();
  const report = [];
  let emailsSent = 0;

  for (const centreDoc of centersSnap.docs) {
    const centerId = centreDoc.id;
    const centreData = centreDoc.data() || {};

    // The human name ("Mathnasium Langley") lives in config/main — the
    // top-level centres doc is mostly identity/billing.
    let configName = null;
    try {
      const cfg = await db.collection('centers').doc(centerId)
        .collection('config').doc('main').get();
      configName = cfg.exists ? (cfg.data() || {}).name : null;
    } catch { /* fall through to the id */ }
    const centreName = configName || centreData.name || centreData.displayName || centerId;

    // ─── Items ───────────────────────────────────────────────────────
    const invSnap = await db.collection('centers').doc(centerId).collection('inventory').get();

    let settings = {};
    const items = [];
    for (const d of invSnap.docs) {
      if (d.id === '__settings') { settings = d.data() || {}; continue; }
      if (d.id.startsWith('__')) continue;
      const data = d.data() || {};
      if (data.archived) continue;
      items.push({ id: d.id, ...data });
    }

    if (settings.alertsEnabled === false) {
      report.push({ centerId, skipped: 'alerts disabled' });
      continue;
    }

    const low = items
      .filter(i => statusOf(i) !== 'ok')
      .sort((a, b) => {
        const sa = statusOf(a) === 'out' ? 0 : 1;
        const sb = statusOf(b) === 'out' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });

    if (low.length === 0) {
      report.push({ centerId, skipped: 'nothing low' });
      continue;
    }

    // ─── Throttling ──────────────────────────────────────────────────
    const key = alertKey(low);
    const reason = force ? 'forced' : shouldSend(key, low, settings);
    if (!reason) {
      report.push({ centerId, skipped: 'throttled', lowItems: low.length });
      continue;
    }

    // ─── Recipients ──────────────────────────────────────────────────
    let recipients = Array.isArray(settings.alertEmails)
      ? settings.alertEmails.map(e => String(e).trim()).filter(Boolean)
      : [];

    if (recipients.length === 0) {
      const usersSnap = await db.collection('users')
        .where('centerIds', 'array-contains', centerId)
        .get();
      recipients = usersSnap.docs
        .map(d => d.data() || {})
        .filter(u => u.approved && u.email && isAdminish(u))
        .map(u => String(u.email).trim());
    }

    recipients = [...new Set(recipients)];

    if (recipients.length === 0) {
      report.push({ centerId, skipped: 'no recipients' });
      continue;
    }

    // ─── Group by category for a readable email ──────────────────────
    const byCat = new Map();
    for (const i of low) {
      const label = CATEGORY_LABELS[i.category] || 'Other';
      if (!byCat.has(label)) byCat.set(label, []);
      byCat.get(label).push(i);
    }
    const groups = [...byCat.entries()];

    const outCount = low.filter(i => statusOf(i) === 'out').length;
    const subject = outCount > 0
      ? `${centreName}: ${outCount} supply item${outCount === 1 ? '' : 's'} OUT, ${low.length} to reorder`
      : `${centreName}: ${low.length} supply item${low.length === 1 ? '' : 's'} running low`;

    const payload = recipients.slice(0, 100).map(to => ({
      from: fromAddress,
      to:   [to],
      subject,
      text: buildText(centreName, groups, link),
      html: buildHtml(centreName, groups, link),
    }));

    try {
      const { error } = await resendClient().batch.send(payload);
      if (error) throw new Error(error.message || 'Resend batch error');

      await db.collection('centers').doc(centerId)
        .collection('inventory').doc('__settings')
        .set({
          alertsEnabled:   settings.alertsEnabled !== false,
          alertEmails:     Array.isArray(settings.alertEmails) ? settings.alertEmails : [],
          lastAlertSentAt: nowIso,
          lastAlertKey:    key,
        }, { merge: true });

      emailsSent += payload.length;
      report.push({ centerId, sent: payload.length, reason, lowItems: low.length, outItems: outCount });
    } catch (err) {
      console.error(`[inventory-alerts] ${centerId} failed:`, err);
      report.push({ centerId, error: err.message || String(err) });
    }
  }

  return { centres: centersSnap.size, emailsSent, report };
}
