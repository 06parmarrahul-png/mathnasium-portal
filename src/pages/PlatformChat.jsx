import { useState, useEffect, useRef } from 'react';
import { collection, addDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { MessageSquare, Send, ShieldAlert, Building2 } from 'lucide-react';

/**
 * Platform Chat — a cross-centre support / feature-request space.
 *
 * Open to anyone with role `admin`, `owner`, or `super_admin`. Instructors
 * and hosts do not see it (Firestore rules block reads). Messages live in a
 * separate `platformChat` collection so they don't interleave with each
 * centre's team chat.
 *
 * Each message carries the sender's active centre so super-admins can tell
 * who's asking what.
 */

export default function PlatformChat() {
  const { profile, activeCenterId, isSuperAdmin, isOwner, isAdmin } = useAuth();
  const eligible = isSuperAdmin || isOwner || isAdmin;
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (!eligible) return;
    return onSnapshot(
      query(collection(db, 'platformChat'), orderBy('createdAt', 'desc'), limit(200)),
      snap => {
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        docs.reverse(); // newest at the bottom
        setMessages(docs);
      },
    );
  }, [eligible]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!text.trim() || !profile || sending || !eligible) return;
    setSending(true);
    try {
      await addDoc(collection(db, 'platformChat'), {
        text: text.trim(),
        userId: profile.uid,
        userName: profile.displayName || '',
        userRole: profile.role || '',
        centerId: activeCenterId || '',
        createdAt: serverTimestamp(),
        type: 'message',
      });
      setText('');
    } finally {
      setSending(false);
    }
  };

  const formatTime = (ts) =>
    ts ? new Date(ts.seconds * 1000).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }) : '';
  const initials = (name) => name?.split(' ').map(w => w.charAt(0)).join('').toUpperCase().slice(0, 2) || '??';
  const roleBadge = (role) => {
    if (role === 'super_admin') return { label: 'Super Admin', cls: 'bg-purple-100 text-purple-700' };
    if (role === 'owner')       return { label: 'Owner',       cls: 'bg-red-100 text-red-700' };
    if (role === 'admin')       return { label: 'Admin',       cls: 'bg-emerald-100 text-emerald-700' };
    return null;
  };

  if (!eligible) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <ShieldAlert size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Platform Chat is for centre admins, owners, and super-admins only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-purple-100 p-2 text-purple-600"><MessageSquare size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Platform Chat</h1>
          <p className="text-sm text-gray-500">
            Talk to the product team and other centre operators. Feature requests, support, anything you wish worked differently.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border bg-white shadow-sm">
        <div className="p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="py-16 text-center">
              <MessageSquare size={40} className="mx-auto mb-3 text-gray-300" />
              <p className="text-gray-500">No messages yet. Tell us what you want next.</p>
            </div>
          ) : messages.map(msg => {
            const isMe = msg.userId === profile?.uid;
            const badge = roleBadge(msg.userRole);
            return (
              <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}>
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                  msg.userRole === 'super_admin' ? 'bg-purple-600'
                    : msg.userRole === 'owner'   ? 'bg-red-600'
                    : msg.userRole === 'admin'   ? 'bg-emerald-600'
                    : 'bg-gray-600'
                }`}>
                  {initials(msg.userName)}
                </div>
                <div className={`max-w-xs sm:max-w-md ${isMe ? 'text-right' : ''}`}>
                  <div className="mb-0.5 flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-medium ${isMe ? 'text-purple-700' : 'text-gray-700'}`}>
                      {isMe ? 'You' : msg.userName}
                    </span>
                    {badge && (
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}>
                        {badge.label}
                      </span>
                    )}
                    {msg.centerId && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                        <Building2 size={9} /> {msg.centerId}
                      </span>
                    )}
                    <span className="text-xs text-gray-400">{formatTime(msg.createdAt)}</span>
                  </div>
                  <div className={`inline-block rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                    isMe
                      ? 'bg-purple-600 text-white rounded-br-md'
                      : 'bg-gray-100 text-gray-800 rounded-bl-md'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>

      <form onSubmit={handleSend} className="mt-3 flex items-center gap-2">
        <input
          className="flex-1 rounded-xl border bg-white px-4 py-3 text-sm shadow-sm focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
          placeholder="Tell us what'd make this better…"
          value={text}
          onChange={e => setText(e.target.value)}
        />
        <button
          type="submit"
          disabled={!text.trim() || sending}
          className="rounded-xl bg-purple-600 p-3 text-white shadow-sm transition-colors hover:bg-purple-700 disabled:opacity-50"
        >
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
