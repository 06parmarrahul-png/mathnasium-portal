import { useState, useEffect, useMemo, useRef } from 'react';
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
  const [allUsers, setAllUsers] = useState([]);

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

  // Members of this channel = everyone with platform-chat access (admin /
  // owner / super-admin), across every centre. Drives the right-hand roster.
  useEffect(() => {
    if (!eligible) return;
    return onSnapshot(collection(db, 'users'), snap => {
      setAllUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, [eligible]);

  const eligibleMembers = useMemo(() => {
    const ROLE_ORDER = { super_admin: 0, owner: 1, admin: 2 };
    return allUsers
      .filter(u => u.approved && (u.role === 'super_admin' || u.role === 'owner' || u.role === 'admin'))
      .sort((a, b) => {
        const ra = ROLE_ORDER[a.role] ?? 9;
        const rb = ROLE_ORDER[b.role] ?? 9;
        if (ra !== rb) return ra - rb;
        return (a.displayName || '').localeCompare(b.displayName || '');
      });
  }, [allUsers]);

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
    <div className="mx-auto flex h-full max-w-6xl gap-4">
      <div className="flex h-full min-w-0 flex-1 flex-col">
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

      {/* Members sidebar — everyone with platform-chat access, grouped by role. */}
      <aside className="hidden lg:flex h-full w-60 shrink-0 flex-col overflow-hidden rounded-xl border bg-white shadow-sm">
        <div className="border-b border-gray-100 px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            In this channel · {eligibleMembers.length}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            Admins, owners, and super-admins across every centre.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {eligibleMembers.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-gray-400">No members yet.</p>
          ) : eligibleMembers.map(m => {
            const isMe = m.uid === profile?.uid;
            const role = m.role || 'admin';
            const avatarBg =
              role === 'super_admin' ? 'bg-purple-600'
              : role === 'owner'     ? 'bg-red-600'
              : 'bg-emerald-600';
            const roleLabel =
              role === 'super_admin' ? 'Super Admin'
              : role === 'owner'     ? 'Owner'
              : 'Admin';
            const centreLabel = Array.isArray(m.centerIds) && m.centerIds.length > 0
              ? m.centerIds[0]
              : (m.centerId || '');
            return (
              <div key={m.id || m.uid}
                title={m.email || m.displayName}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-gray-50 ${isMe ? 'bg-purple-50/40' : ''}`}>
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${avatarBg}`}>
                  {(m.displayName || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-gray-800">
                    {m.displayName || '—'}
                    {isMe && <span className="ml-1 text-[10px] font-normal text-purple-700">(you)</span>}
                  </p>
                  <p className="flex items-center gap-1 text-[10px] text-gray-400">
                    <span>{roleLabel}</span>
                    {centreLabel && (
                      <>
                        <span className="text-gray-300">·</span>
                        <span className="inline-flex items-center gap-0.5"><Building2 size={9} /> {centreLabel}</span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
