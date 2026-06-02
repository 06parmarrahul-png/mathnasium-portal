// Tool definitions + runtime dispatch for the Owner Assistant.
//
// Adding a tool: define its schema in TOOL_DEFINITIONS, add a handler
// in the TOOL_HANDLERS map. The handler signature is:
//   async (input, ctx) => result   // ctx = { profile, centerId, db, ownerUid }
// Any thrown error is caught by the caller and surfaced to Claude as a
// tool_result with { error }.
//
// Tools are intentionally narrow and read/write only the caller-owner's
// scope. The chat handler verifies the caller is an owner before this
// file is even reached.

import { Resend } from 'resend';
import { FieldValue } from 'firebase-admin/firestore';

// ── Schemas advertised to Claude ─────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'send_email',
    description:
      'Send a transactional email on behalf of the owner. Use for replies, ' +
      'staff notices, parent communications. Always confirm with the owner ' +
      'before sending to external recipients unless the request was explicit.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string' },
        body:    { type: 'string', description: 'Plain text body. Newlines become paragraph breaks.' },
        cta_text: { type: 'string', description: 'Optional CTA button text' },
        cta_link: { type: 'string', description: 'Optional CTA button URL' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'get_center_data',
    description:
      'Look up information about the owner\'s active center. ' +
      'kind="staff" returns the roster, kind="open_shifts" returns upcoming open shifts, ' +
      'kind="announcements" returns recent announcements, kind="center" returns center config.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['staff', 'open_shifts', 'announcements', 'center'],
        },
        limit: { type: 'number', description: 'Max items to return (default 25)' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'schedule_event',
    description:
      'Create a calendar/reminder event for the owner. Writes to a personal ' +
      'events collection — does not affect the staff schedule.',
    input_schema: {
      type: 'object',
      properties: {
        title:     { type: 'string' },
        startISO:  { type: 'string', description: 'Start time as ISO 8601 (e.g. 2026-06-15T14:00:00-07:00)' },
        endISO:    { type: 'string', description: 'Optional end time as ISO 8601' },
        notes:     { type: 'string' },
      },
      required: ['title', 'startISO'],
    },
  },
  {
    name: 'save_long_term_memory',
    description:
      'Append a durable fact about the owner to long-term memory ' +
      '(preferences, recurring people, ongoing projects). Use sparingly — ' +
      'only for things that will be useful in future conversations.',
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'A single, concise fact to remember.' },
      },
      required: ['fact'],
    },
  },
];

// ── Resend client (lazy) ─────────────────────────────────────────────
let _resend = null;
function resendClient() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  _resend = new Resend(key);
  return _resend;
}

// ── Handlers ─────────────────────────────────────────────────────────
const TOOL_HANDLERS = {
  async send_email(input, ctx) {
    const to = String(input.to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new Error('invalid recipient email');
    }
    const from = process.env.RESEND_FROM;
    if (!from) throw new Error('RESEND_FROM not set');

    const subject = String(input.subject || '(no subject)').slice(0, 200);
    const body = String(input.body || '');
    const esc = (s) => String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html =
      `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">` +
      esc(body).split('\n').map((l) => l === '' ? '<br>' : `<p style="margin:0 0 10px 0;">${l}</p>`).join('') +
      (input.cta_link
        ? `<p style="margin:20px 0 0 0;"><a href="${esc(input.cta_link)}" style="background:#dc2626;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">${esc(input.cta_text || 'Open')}</a></p>`
        : '') +
      `<p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;">— Sent via Ratio Assistant on behalf of ${esc(ctx.profile?.displayName || 'the owner')}</p>` +
      `</div>`;

    const { data, error } = await resendClient().emails.send({
      from,
      to: [to],
      subject,
      text: body,
      html,
      reply_to: ctx.profile?.email || undefined,
    });
    if (error) throw new Error(error.message || 'Resend error');
    return { ok: true, to, subject, id: data?.id || null };
  },

  async get_center_data(input, ctx) {
    const kind = String(input.kind || '');
    const lim = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
    const centerId = ctx.centerId;
    if (!centerId && kind !== 'center') return { kind, items: [], note: 'no centerId in context' };

    if (kind === 'center') {
      if (!centerId) return { kind, note: 'no centerId' };
      const c = await ctx.db.collection('centers').doc(centerId).get();
      const cfg = await ctx.db.collection('centers').doc(centerId).collection('config').doc('main').get();
      return { kind, center: c.exists ? c.data() : null, config: cfg.exists ? cfg.data() : null };
    }

    if (kind === 'staff') {
      const snap = await ctx.db.collection('users')
        .where('centerIds', 'array-contains', centerId)
        .limit(lim).get();
      return {
        kind,
        items: snap.docs.map((d) => {
          const u = d.data();
          return {
            id: d.id,
            name: u.displayName || '',
            email: u.email || '',
            role: u.role || '',
            approved: !!u.approved,
            instructorType: u.instructorType || '',
          };
        }),
      };
    }

    if (kind === 'open_shifts') {
      const today = new Date().toISOString().slice(0, 10);
      const snap = await ctx.db.collection('openShifts')
        .where('centerId', '==', centerId)
        .where('date', '>=', today)
        .orderBy('date', 'asc')
        .limit(lim).get();
      return {
        kind,
        items: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      };
    }

    if (kind === 'announcements') {
      const snap = await ctx.db.collection('announcements')
        .where('centerId', '==', centerId)
        .orderBy('createdAt', 'desc')
        .limit(lim).get();
      return {
        kind,
        items: snap.docs.map((d) => {
          const a = d.data();
          return {
            id: d.id,
            title: a.title || '',
            body: (a.body || '').slice(0, 500),
            createdAt: a.createdAt?.toDate?.()?.toISOString?.() || a.createdAt || null,
          };
        }),
      };
    }

    return { kind, error: 'unknown kind' };
  },

  async schedule_event(input, ctx) {
    const title = String(input.title || '').trim();
    if (!title) throw new Error('title required');
    if (!input.startISO) throw new Error('startISO required');
    const ref = await ctx.db
      .collection('ownerAssistant').doc(ctx.ownerUid)
      .collection('events').add({
        title,
        startISO: String(input.startISO),
        endISO:   input.endISO ? String(input.endISO) : null,
        notes:    input.notes ? String(input.notes) : '',
        createdAt: new Date(),
      });
    return { ok: true, id: ref.id, title };
  },

  async save_long_term_memory(input, ctx) {
    const fact = String(input.fact || '').trim();
    if (!fact) throw new Error('fact required');
    const ref = ctx.db.collection('ownerAssistant').doc(ctx.ownerUid);
    const snap = await ref.get();
    const prior = snap.exists ? (snap.data().summary || '') : '';
    // Append as a bulleted line; cap total length so we don't blow up
    // the system prompt over time.
    const next = (prior ? prior + '\n' : '') + '• ' + fact;
    const trimmed = next.length > 4000 ? next.slice(next.length - 4000) : next;
    await ref.set({
      summary: trimmed,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true };
  },
};

export async function runTool(name, input, ctx) {
  const fn = TOOL_HANDLERS[name];
  if (!fn) throw new Error(`unknown tool: ${name}`);
  return fn(input, ctx);
}
