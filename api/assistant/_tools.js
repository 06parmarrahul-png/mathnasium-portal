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
import { generateSchedule } from '../../src/lib/scheduler.js';
import { mergeCenterConfig } from '../../src/lib/centerConfig.js';

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
    name: 'generate_schedule',
    description:
      'Auto-schedule instructors for a day, week, or month. Reads availability ' +
      'and approved staff from Firestore, runs the scheduler engine, and writes ' +
      'the resulting shifts as DRAFTS to the active centre. The owner publishes ' +
      'from the weekly grid afterwards (instructors do not see drafts). ' +
      'For range="day" supply date; for range="week" supply weekStartDate (a ' +
      'Monday); for range="month" supply month + year. Returns counts and any ' +
      'warnings (low-staff days, host promotions, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        range: { type: 'string', enum: ['day', 'week', 'month'] },
        date:           { type: 'string', description: 'YYYY-MM-DD — for range="day"' },
        weekStartDate:  { type: 'string', description: 'YYYY-MM-DD Monday — for range="week"' },
        month:          { type: 'string', description: 'Month name like "June" — for range="month"' },
        year:           { type: 'number', description: 'e.g. 2026 — for range="month"' },
        minPerDay:      { type: 'number', description: 'Optional override (default 8)' },
        maxPerDay:      { type: 'number', description: 'Optional override (default 11)' },
        maxDaysPerWeek: { type: 'number', description: 'Optional override (default 5)' },
      },
      required: ['range'],
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

  async generate_schedule(input, ctx) {
    const centerId = ctx.centerId;
    if (!centerId) throw new Error('no active centerId in context');
    const range = String(input.range || '').toLowerCase();
    if (!['day', 'week', 'month'].includes(range)) {
      throw new Error('range must be "day", "week", or "month"');
    }

    // Resolve the start/end window before doing any I/O so input errors
    // surface fast and cheap.
    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    let startDateStr, endDateStr, monthArg, yearArg;
    if (range === 'day') {
      if (!isYmd(input.date)) throw new Error('range="day" requires date "YYYY-MM-DD"');
      startDateStr = endDateStr = input.date;
    } else if (range === 'week') {
      if (!isYmd(input.weekStartDate)) throw new Error('range="week" requires weekStartDate "YYYY-MM-DD"');
      startDateStr = input.weekStartDate;
      const wkStart = new Date(startDateStr + 'T00:00:00');
      const wkEnd   = new Date(wkStart);
      wkEnd.setDate(wkStart.getDate() + 6);
      endDateStr = `${wkEnd.getFullYear()}-${String(wkEnd.getMonth() + 1).padStart(2, '0')}-${String(wkEnd.getDate()).padStart(2, '0')}`;
    } else {
      if (!input.month) throw new Error('range="month" requires month name');
      if (!input.year)  throw new Error('range="month" requires year');
      monthArg = String(input.month);
      yearArg  = Number(input.year);
    }

    // ── Load everything the scheduler needs ────────────────────────────
    // Centre config (instructional hours, fixed staff, guaranteed names,
    // operatingDays, holidays, salaryStaff).
    const cfgSnap = await ctx.db.collection('centers').doc(centerId)
      .collection('config').doc('main').get();
    const centerConfig = mergeCenterConfig(cfgSnap.exists ? cfgSnap.data() : null);

    // Approved staff at this centre, excluding volunteers (mirrors the
    // client-side handleGenerate flow).
    const usersSnap = await ctx.db.collection('users')
      .where('centerIds', 'array-contains', centerId)
      .get();
    const allUsers = usersSnap.docs.map(d => {
      const u = d.data();
      const m = u.centerMemberships?.[centerId] || {};
      return {
        uid:            d.id,
        displayName:    u.displayName,
        email:          u.email,
        role:           u.role,
        approved:       m.approved        ?? u.approved        ?? false,
        instructorType: m.instructorType  ?? u.instructorType  ?? 'Instructor',
        priority:       m.priority        ?? u.priority        ?? 2,
        subRoles:       m.subRoles        ?? u.subRoles        ?? [],
        guaranteed:     m.guaranteed      ?? u.guaranteed      ?? false,
        maxDaysPerWeek: m.maxDaysPerWeek  ?? u.maxDaysPerWeek  ?? 5,
        isVolunteer:    m.isVolunteer     ?? u.isVolunteer     ?? false,
      };
    });
    const schedulableUsers = allUsers.filter(u =>
      u.approved && u.role !== 'owner' && u.role !== 'super_admin'
      && u.isVolunteer !== true
    );

    // Availability — pull a wide-enough window. For month we cover the
    // month + the 6 calendar months before it for dayName fallback; for
    // day/week we still pull 6 months back so the fallback works.
    const sixMonthsAgo = (() => {
      const d = new Date(startDateStr || `${yearArg}-01-01`);
      d.setMonth(d.getMonth() - 6);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    })();
    const availSnap = await ctx.db.collection('availability')
      .where('centerId', '==', centerId)
      .where('date', '>=', sixMonthsAgo)
      .get();
    const allAvail = availSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Approved time-off — used to suppress availability for those dates.
    const toSnap = await ctx.db.collection('timeOffRequests')
      .where('centerId', '==', centerId)
      .where('status', '==', 'approved')
      .get();
    const approvedTimeOff = new Set();
    toSnap.docs.forEach(r => {
      const data = r.data();
      if (!data.startDate || !data.endDate) return;
      const cur = new Date(data.startDate + 'T00:00:00');
      const end = new Date(data.endDate + 'T00:00:00');
      while (cur <= end) {
        const ds = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
        approvedTimeOff.add(`${data.userId}-${ds}`);
        cur.setDate(cur.getDate() + 1);
      }
    });
    const filteredAvail = allAvail.filter(a =>
      !approvedTimeOff.has(`${a.userId}-${a.date}`)
    );

    // ── Run the engine ───────────────────────────────────────────────
    const result = generateSchedule({
      instructors: schedulableUsers,
      availability: filteredAvail,
      previousMonthsAvail: [],
      ...(monthArg
        ? { month: monthArg, year: yearArg }
        : { startDate: startDateStr, endDate: endDateStr }),
      config: {
        minPerDay:      Number.isFinite(input.minPerDay)      ? Number(input.minPerDay)      : 8,
        maxPerDay:      Number.isFinite(input.maxPerDay)      ? Number(input.maxPerDay)      : 11,
        maxDaysPerWeek: Number.isFinite(input.maxDaysPerWeek) ? Number(input.maxDaysPerWeek) : 5,
      },
      centerConfig,
    });

    // ── Persist the generated shifts as DRAFTS ───────────────────────
    // Skip fixed staff in this write — they get re-seeded separately by
    // the owner's "Sync Fixed Staff This Week" action if needed. (The
    // engine does include them in scheduleDays for coverage math, but
    // they're written from the fixedStaff config map, not from this
    // result.)
    const fixedNameSet = new Set(Object.keys(centerConfig.fixedStaff || {}));
    let writeCount = 0;
    const BATCH = 450;
    const toWrite = [];
    for (const day of result.days) {
      for (const name of day.assignedEmployees) {
        if (fixedNameSet.has(name)) continue;
        const user = schedulableUsers.find(u => u.displayName === name);
        const shiftStr = day.shiftTimes?.[name] || '';
        const [startRaw, endRaw] = shiftStr.includes(' - ')
          ? shiftStr.split(' - ') : ['15:00', '20:00'];
        toWrite.push({
          userId: user?.uid || name,
          userName: name,
          centerId,
          date: day.date,
          startTime: (startRaw || '15:00').trim(),
          endTime:   (endRaw   || '20:00').trim(),
          role: day.roles?.[name] || 'Instructor',
          subRole: day.subRoles?.[name] || 'Elementary',
          status: 'draft',
          autoScheduled: true,
          scheduledByAssistant: true,
        });
      }
    }

    for (let i = 0; i < toWrite.length; i += BATCH) {
      const batch = ctx.db.batch();
      const slice = toWrite.slice(i, i + BATCH);
      for (const s of slice) {
        const ref = ctx.db.collection('shifts').doc();
        batch.set(ref, s);
      }
      await batch.commit();
      writeCount += slice.length;
    }

    return {
      ok: true,
      range,
      window: { startDate: result.startDate, endDate: result.endDate },
      daysGenerated:   result.days.length,
      shiftsWritten:   writeCount,
      warningsCount:   (result.warnings || []).length,
      warnings:        (result.warnings || []).slice(0, 12), // truncate so the LLM context stays tight
      openShiftNeeded: (result.openShiftNeeded || []).length,
      note: 'Shifts saved as drafts. Owner publishes from Admin → weekly grid.',
    };
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
