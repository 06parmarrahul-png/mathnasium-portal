// POST /api/assistant/chat
//
// Backend for the OwnerAssistant widget. Calls Claude with tool use,
// executes tools server-side, and writes the assistant's reply (plus
// any tool-call records) into the owner's Firestore message log so the
// widget's onSnapshot subscription updates in real time.
//
// Auth: Firebase ID token in Authorization: Bearer. Caller MUST be an
// approved user with role === 'owner'. Everyone else gets 403.
//
// Body:
//   { message: string, centerId?: string }
//
// Response: 200 { ok: true } — actual content is written to Firestore.
//
// Env vars (set in Vercel project settings):
//   ANTHROPIC_API_KEY     - from https://console.anthropic.com/
//   FIREBASE_SERVICE_ACCOUNT - already used by other API routes
//   RESEND_API_KEY, RESEND_FROM - already used by /api/send-email
//
// Notes:
//   - We deliberately use plain fetch() against the Anthropic REST API
//     rather than adding the @anthropic-ai/sdk dependency. Keeps the
//     Vercel function cold-start small.
//   - Memory model: short-term = last N messages from Firestore;
//     long-term = a free-text "summary" field on /ownerAssistant/{uid}
//     that Claude can update via the save_long_term_memory tool.
//   - Tool loop is bounded (MAX_TOOL_TURNS) so a runaway model can't
//     burn an entire serverless budget.

import { getFirestore, authenticateRequest } from '../_lib/firebase-admin.js';
import { runTool, TOOL_DEFINITIONS } from './_tools.js';

const ANTHROPIC_URL  = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VER  = '2023-06-01';
const MODEL          = 'claude-sonnet-4-5-20250929';
const HISTORY_LIMIT  = 30;     // messages of context to feed Claude
const MAX_TOOL_TURNS = 6;      // hard ceiling on tool-call iterations
const MAX_TOKENS     = 1024;

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/**
 * Convert a Firestore message doc into the shape Claude's Messages API
 * expects. We collapse tool-trace docs (role: 'tool') because they're
 * UI-only — Claude doesn't need to re-see its prior tool output.
 */
function toClaudeMessages(docs) {
  return docs
    .filter((d) => d.role === 'user' || d.role === 'assistant')
    .map((d) => ({
      role: d.role,
      content: String(d.content || ''),
    }));
}

function systemPrompt({ profile, centerName, summary, today }) {
  const name = profile?.displayName || 'the owner';
  const center = centerName || 'their Mathnasium center';
  const summaryBlock = summary
    ? `\nWhat you know about them from prior conversations:\n${summary}\n`
    : '';
  return `You are Ratio Assistant — a warm, sharp, slightly witty personal AI for ${name}, the owner of ${center}. Think Jarvis: confident, capable, never sycophantic, never robotic.

Today is ${today}.

You can help with anything an owner needs: drafting and sending emails, scheduling, looking up center data (staff, shifts, announcements), thinking through decisions, or just a quick conversation. Read the tone of the owner's message and match it — if they sound stressed, be calming and efficient; if they're casual, be casual back; if they're focused, be brief.

When you take an action via a tool, briefly confirm what you did in plain language. Don't narrate every internal step.

If you learn a durable fact about them (a preference, a recurring person, a long-running project), save it with save_long_term_memory so future-you remembers.
${summaryBlock}
Keep replies short unless the request actually needs depth.`;
}

async function callClaude({ apiKey, system, messages, tools }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': ANTHROPIC_VER,
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // Auth — owner only.
  const session = await authenticateRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const profile = session.profile;
  if (!profile?.approved) return res.status(403).json({ error: 'Account not approved' });
  if (profile.role !== 'owner') return res.status(403).json({ error: 'Owners only' });

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const userMessage = String(body?.message || '').trim();
  if (!userMessage) return res.status(400).json({ error: 'message required' });

  const db = getFirestore();
  const ownerUid = profile.uid || profile.id;
  const messagesRef = db.collection('ownerAssistant').doc(ownerUid).collection('messages');
  const rootRef     = db.collection('ownerAssistant').doc(ownerUid);

  // Pull recent history (the widget already wrote the new user message
  // into Firestore optimistically, so it's part of `recent`).
  const histSnap = await messagesRef.orderBy('createdAt', 'desc').limit(HISTORY_LIMIT).get();
  const recent = histSnap.docs.map((d) => d.data()).reverse();

  // Load long-term memory + a friendly centre name for the system prompt.
  const rootSnap = await rootRef.get();
  const summary  = rootSnap.exists ? (rootSnap.data().summary || '') : '';

  let centerName = body?.centerId || null;
  if (body?.centerId) {
    try {
      const cSnap = await db.collection('centers').doc(body.centerId).get();
      if (cSnap.exists) centerName = cSnap.data()?.name || body.centerId;
    } catch { /* non-fatal */ }
  }

  const system = systemPrompt({
    profile,
    centerName,
    summary,
    today: new Date().toISOString().slice(0, 10),
  });

  // Conversation we hand Claude. If the optimistic user message somehow
  // didn't make it in (race condition), append it explicitly.
  let convo = toClaudeMessages(recent);
  if (convo.length === 0 || convo[convo.length - 1].role !== 'user') {
    convo.push({ role: 'user', content: userMessage });
  }

  // Tool loop. Each turn either ends (stop_reason !== 'tool_use') or
  // runs tools and feeds results back. Bounded by MAX_TOOL_TURNS.
  let finalText = '';
  const toolTrace = [];
  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const resp = await callClaude({
        apiKey,
        system,
        messages: convo,
        tools: TOOL_DEFINITIONS,
      });

      // Always push assistant turn so the next iteration sees it.
      convo.push({ role: 'assistant', content: resp.content });

      if (resp.stop_reason !== 'tool_use') {
        finalText = (resp.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        break;
      }

      // Run every tool_use block, collect tool_result blocks.
      const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');
      const results = [];
      for (const tu of toolUses) {
        let out;
        try {
          out = await runTool(tu.name, tu.input || {}, {
            profile,
            centerId: body?.centerId || null,
            db,
            ownerUid,
          });
        } catch (err) {
          out = { error: err?.message || 'tool failed' };
        }
        toolTrace.push({ name: tu.name, input: tu.input, output: out });
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(out).slice(0, 6000),
        });
      }
      convo.push({ role: 'user', content: results });
    }
  } catch (err) {
    finalText = `I hit an error reaching the model: ${err?.message || err}`;
  }

  if (!finalText) finalText = '(no response)';

  // Persist tool trace records first (UI-only, render as tiny italic
  // lines), then the assistant reply itself. Doing it in this order
  // means the user sees the action acknowledged before the prose reply.
  for (const t of toolTrace) {
    await messagesRef.add({
      role: 'tool',
      toolName: t.name,
      content: summarizeToolResult(t.name, t.output),
      createdAt: new Date(),
    });
  }
  await messagesRef.add({
    role: 'assistant',
    content: finalText,
    createdAt: new Date(),
  });

  return res.status(200).json({ ok: true });
}

function summarizeToolResult(name, output) {
  if (!output) return '';
  if (output.error) return `error: ${output.error}`;
  switch (name) {
    case 'send_email':
      return `sent email to ${output.to || ''}`;
    case 'get_center_data':
      return `looked up ${output.kind || 'data'}`;
    case 'schedule_event':
      return `scheduled ${output.title || 'event'}`;
    case 'save_long_term_memory':
      return 'updated memory';
    default:
      return '';
  }
}
