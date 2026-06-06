// OwnerAssistant — floating "Jarvis-style" chat widget for owners.
//
// Rendered globally from App.jsx. Visible only when the signed-in user
// has role === 'owner'. Persists chat history per owner in Firestore
// (collection: ownerAssistant/{uid}/messages) so conversations resume
// across sessions and devices. Forwards messages to /api/assistant/chat,
// which calls Claude with tools (email, schedule, data lookups, memory).
//
// UI: bottom-right pill that expands to a panel. Mobile-friendly: panel
// is 92vw × 80vh on narrow screens, fixed size on desktop.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection, query, orderBy, limit, onSnapshot, addDoc, serverTimestamp,
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { Sparkles, X, Send, Loader2 } from 'lucide-react';

const HISTORY_LIMIT = 50;

export default function OwnerAssistant() {
  // AA gets the same assistant as the owner — the API handler verifies the
  // role and the Firestore rules already include them via isOwnerLike().
  const { profile, isOwnerLike, activeCenterId } = useAuth();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  const ownerUid = profile?.uid || null;

  // Live-subscribe to this owner's chat history. Scoped per-owner via the
  // /ownerAssistant/{uid}/messages subcollection — Firestore rules enforce
  // that nobody else can read it.
  useEffect(() => {
    if (!ownerUid || !isOwnerLike) return;
    const q = query(
      collection(db, 'ownerAssistant', ownerUid, 'messages'),
      orderBy('createdAt', 'asc'),
      limit(HISTORY_LIMIT),
    );
    return onSnapshot(q, (snap) => {
      setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => {
      console.warn('[OwnerAssistant] history subscribe failed:', err?.message);
    });
  }, [ownerUid, isOwnerLike]);

  // Auto-scroll to newest message when the panel is open.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, sending]);

  const greeting = useMemo(() => {
    const name = profile?.displayName?.split(' ')[0] || 'there';
    return `Hi ${name}. I'm your assistant — ask me about your center, schedule something, draft an email, or just chat.`;
  }, [profile?.displayName]);

  // Owner / AA gate. Render nothing for everyone else.
  if (!isOwnerLike || !ownerUid) return null;

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setError('');
    setSending(true);

    // Optimistic write — also creates the message doc that Claude will
    // see on the next history read. The server appends the assistant
    // reply (and any tool-call records) to the same subcollection.
    try {
      await addDoc(collection(db, 'ownerAssistant', ownerUid, 'messages'), {
        role: 'user',
        content: text,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      setSending(false);
      setError('Couldn’t save your message. ' + (err?.message || ''));
      return;
    }
    setInput('');

    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: text,
          centerId: activeCenterId || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `Request failed (${res.status})`);
      }
      // Server writes the assistant reply directly to Firestore, which
      // streams back through the onSnapshot above — nothing to do here.
    } catch (err) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setSending(false);
    }
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-[60] flex flex-col items-end pointer-events-none print:hidden">
      {open && (
        <div
          className="pointer-events-auto mb-3 flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
          style={{ width: 'min(92vw, 400px)', height: 'min(80vh, 600px)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-200 bg-gradient-to-r from-red-600 to-rose-700 px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              <div>
                <div className="text-sm font-semibold leading-tight">Ratio Assistant</div>
                <div className="text-[11px] text-white/80 leading-tight">Personal AI for owners</div>
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded-full p-1 hover:bg-white/10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gray-50 px-3 py-3 space-y-2">
            {messages.length === 0 && (
              <div className="rounded-xl bg-white border border-gray-200 p-3 text-sm text-gray-700">
                {greeting}
              </div>
            )}
            {messages.map((m) => (
              <Bubble key={m.id} role={m.role} content={m.content} toolName={m.toolName} />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-gray-500 px-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-gray-200 bg-white p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
                placeholder="Ask anything…"
                rows={1}
                className="flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-red-500 focus:bg-white max-h-32"
              />
              <button
                onClick={send}
                disabled={sending || !input.trim()}
                className="rounded-xl bg-red-600 p-2 text-white hover:bg-red-700 disabled:opacity-40"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <div className="px-1 pt-1 text-[10px] text-gray-400">
              Press Enter to send · Shift+Enter for newline
            </div>
          </div>
        </div>
      )}

      {/* Launcher pill */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="pointer-events-auto group flex items-center gap-2 rounded-full bg-gradient-to-br from-red-600 to-rose-700 px-4 py-3 text-white shadow-lg hover:shadow-xl transition-shadow"
        aria-label={open ? 'Close assistant' : 'Open assistant'}
      >
        <Sparkles className="h-4 w-4" />
        <span className="text-sm font-medium hidden sm:inline">
          {open ? 'Close' : 'Assistant'}
        </span>
      </button>
    </div>
  );
}

function Bubble({ role, content, toolName }) {
  if (role === 'tool') {
    return (
      <div className="text-[11px] text-gray-500 italic px-2">
        ⚙ {toolName || 'tool'} {content ? `· ${content}` : ''}
      </div>
    );
  }
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap shadow-sm ${
          isUser
            ? 'bg-red-600 text-white rounded-br-sm'
            : 'bg-white text-gray-800 border border-gray-200 rounded-bl-sm'
        }`}
      >
        {content}
      </div>
    </div>
  );
}
