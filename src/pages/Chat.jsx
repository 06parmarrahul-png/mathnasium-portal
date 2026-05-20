import { useState, useEffect, useMemo, useRef } from 'react';
import { collection, addDoc, onSnapshot, query, where, orderBy, limit, doc, runTransaction } from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { MessageSquare, Send, ArrowRightLeft, CheckCircle, Users, Laptop } from 'lucide-react';
import { toast } from '../lib/notify';

export default function Chat() {
  const { profile, activeCenterId } = useAuth();
  const [allMessages, setAllMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);
  const [centerUsers, setCenterUsers] = useState([]);

  // Roster of everyone at this centre — feeds the members sidebar so users
  // can see who else has access to whichever channel they're looking at.
  useEffect(() => {
    if (!activeCenterId) return;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setCenterUsers(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    );
  }, [activeCenterId]);

  // Chat channels. 'all' is the default team-wide chat that everyone sees.
  // 'online' is a side channel only the Online team uses, so they can
  // coordinate without disrupting the main feed. Messages carry a `channel`
  // field; legacy messages without one fall back to 'all'.
  const [channel, setChannel] = useState('all');
  const isOnlineMember = (profile?.subRoles || []).includes('Online') || profile?.role === 'super_admin';
  // If somebody loses Online access while looking at the Online tab, bounce
  // them back to All so they don't get stuck on an empty/hidden channel.
  useEffect(() => {
    if (channel === 'online' && !isOnlineMember) setChannel('all');
  }, [channel, isOnlineMember]);

  // Load the latest 200 messages for the active center (newest first), then
  // reverse to display chronologically. Shift-swap and open-shift-alert
  // messages are filtered out of chat — they live on the Shift Board now.
  useEffect(() => onSnapshot(
    query(
      collection(db, 'chat'),
      where('centerId', '==', activeCenterId),
      orderBy('createdAt', 'desc'),
      limit(200),
    ),
    snap => {
      const docs = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(m => m.type !== 'shift_swap' && m.type !== 'open_shift_alert');
      docs.reverse(); // newest at the bottom
      setAllMessages(docs);
    }
  ), [activeCenterId]);

  // Narrow to the active channel. Messages without a `channel` field are
  // legacy team-wide ones and stay in the 'all' tab.
  const messages = useMemo(
    () => allMessages.filter(m => (m.channel || 'all') === channel),
    [allMessages, channel],
  );

  // Members visible in the current channel — drives the sidebar roster.
  // 'all' shows every approved staff member at this centre; 'online' is
  // narrowed to users with the Online sub-role (plus super-admins who can
  // see everything for support).
  const channelMembers = useMemo(() => {
    const ROLE_ORDER = { super_admin: 0, owner: 1, admin: 2, instructor: 3, host: 4 };
    // Drop internal / system accounts (Admin Team etc.) from the visible
    // roster — they have access but aren't real people.
    const base = centerUsers.filter(u =>
      u.approved && u.internal !== true && u.displayName !== 'Admin Team',
    );
    const filtered = channel === 'online'
      ? base.filter(u => (u.subRoles || []).includes('Online') || u.role === 'super_admin')
      : base;
    return [...filtered].sort((a, b) => {
      const ra = ROLE_ORDER[a.role] ?? 9;
      const rb = ROLE_ORDER[b.role] ?? 9;
      if (ra !== rb) return ra - rb;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
  }, [centerUsers, channel]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!text.trim() || !profile || sending) return;
    // Safety net: don't let a non-Online-team user post to the Online
    // channel even if they somehow ended up on the tab.
    if (channel === 'online' && !isOnlineMember) return;
    setSending(true);
    try {
      await addDoc(collection(db, 'chat'), {
        text: text.trim(),
        userId: profile.uid,
        userName: profile.displayName,
        userRole: profile.role,
        centerId: activeCenterId,
        channel,                 // 'all' or 'online'
        createdAt: serverTimestamp(),
        type: 'message',
      });
      setText('');
    } finally {
      setSending(false);
    }
  };

  const handleAcceptShift = async (msg) => {
    if (!profile || msg.userId === profile.uid) return;
    if (msg.swapStatus !== 'open') {
      toast.error('This shift has already been taken.');
      return;
    }

    // Use a transaction so two people clicking "Take This Shift" at the same
    // time can't both succeed. The transaction re-reads the chat doc and
    // bails out if it's no longer 'open'.
    try {
      await runTransaction(db, async (tx) => {
        const chatRef = doc(db, 'chat', msg.id);
        const chatSnap = await tx.get(chatRef);
        if (!chatSnap.exists()) throw new Error('Swap message no longer exists.');
        const data = chatSnap.data();
        if (data.swapStatus !== 'open') {
          throw new Error('This shift has already been taken.');
        }

        tx.update(chatRef, {
          swapStatus: 'accepted',
          acceptedBy: profile.uid,
          acceptedByName: profile.displayName,
        });

        // Transfer the shift assignment to the acceptor
        if (msg.shiftId) {
          const shiftRef = doc(db, 'shifts', msg.shiftId);
          const shiftSnap = await tx.get(shiftRef);
          if (shiftSnap.exists()) {
            tx.update(shiftRef, {
              userId: profile.uid,
              userName: profile.displayName,
            });
          }
        }
      });

      // Confirmation message — outside the transaction (separate concern; OK to fail independently)
      await addDoc(collection(db, 'chat'), {
        text: `${profile.displayName} has taken ${msg.userName}'s shift on ${msg.shiftDate} (${msg.shiftStartTime} - ${msg.shiftEndTime}).`,
        userId: 'system',
        userName: 'System',
        userRole: 'system',
        centerId: msg.centerId || activeCenterId,
        createdAt: serverTimestamp(),
        type: 'shift_confirmation',
      });
    } catch (err) {
      toast.error(err?.message || 'Failed to accept shift. It may have already been taken.');
    }
  };

  const formatTime = (ts) => ts ? new Date(ts.seconds * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const initials = (name) => name?.split(' ').map(w => w.charAt(0)).join('').toUpperCase().slice(0, 2) || '??';

  return (
    <div className="mx-auto flex h-full max-w-6xl gap-4">
      {/* Main chat column */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-green-100 p-2 text-green-600"><MessageSquare size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Team Chat</h1>
          <p className="text-sm text-gray-500">Swap shifts, ask questions, and stay connected</p>
        </div>
      </div>

      {/* Channel tabs. The Online tab is only visible to users with the
          Online sub-role (and super-admins) so the online team can coordinate
          without disrupting the main chat. */}
      <div className="mb-3 flex items-center gap-1 rounded-xl border bg-gray-50 p-1">
        <button
          type="button"
          onClick={() => setChannel('all')}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
            channel === 'all'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-800'
          }`}
        >
          <Users size={14} /> All Team
        </button>
        {isOnlineMember && (
          <button
            type="button"
            onClick={() => setChannel('online')}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
              channel === 'online'
                ? 'bg-indigo-700 text-white shadow-sm'
                : 'text-indigo-700 hover:bg-white'
            }`}
          >
            <Laptop size={14} /> Online Team
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border bg-white shadow-sm">
        <div className="p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="py-16 text-center">
              <MessageSquare size={40} className="mx-auto mb-3 text-gray-300" />
              <p className="text-gray-500">
                {channel === 'online'
                  ? 'No messages in the Online Team channel yet. Start the conversation!'
                  : 'No messages yet. Start the conversation!'}
              </p>
            </div>
          ) : messages.map(msg => {
            const isMe = msg.userId === profile?.uid;
            const isSystem = msg.userId === 'system';
            const isShiftSwap = msg.type === 'shift_swap';
            const isConfirmation = msg.type === 'shift_confirmation';
            const isOpenShiftAlert = msg.type === 'open_shift_alert';
            const isSchedulePosted = msg.type === 'schedule_posted';

            // Open shift alert — distinct blue card with link hint
            if (isOpenShiftAlert) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="w-full max-w-md rounded-xl border-2 border-blue-200 bg-blue-50 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-lg">📢</span>
                      <span className="text-sm font-semibold text-blue-800">Open Shift Available</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-blue-700 mb-1">{msg.text.replace('📢 Open shift available!\n\n', '')}</p>
                    <div className="text-xs text-blue-400 mt-2">{formatTime(msg.createdAt)}</div>
                  </div>
                </div>
              );
            }

            // Schedule posted announcement
            if (isSchedulePosted) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="w-full max-w-md rounded-xl border-2 border-purple-200 bg-purple-50 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-lg">📅</span>
                      <span className="text-sm font-semibold text-purple-800">Schedule Posted</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-purple-700">{msg.text.replace('📅 ', '')}</p>
                    <div className="text-xs text-purple-400 mt-2">{formatTime(msg.createdAt)}</div>
                  </div>
                </div>
              );
            }

            if (isSystem || isConfirmation) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="flex items-center gap-2 rounded-full bg-green-50 px-4 py-2 text-xs font-medium text-green-700 border border-green-200">
                    <CheckCircle size={14} />
                    {msg.text}
                  </div>
                </div>
              );
            }

            if (isShiftSwap) {
              return (
                <div key={msg.id} className="flex justify-center">
                  <div className="w-full max-w-md rounded-xl border-2 border-orange-200 bg-orange-50 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <ArrowRightLeft size={16} className="text-orange-600" />
                      <span className="text-sm font-semibold text-orange-800">Shift Swap Request</span>
                      <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${msg.swapStatus === 'open' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>
                        {msg.swapStatus === 'open' ? 'Open' : 'Taken'}
                      </span>
                    </div>
                    <div className="mb-1 text-xs text-gray-500">
                      {msg.userName} &middot; {formatTime(msg.createdAt)}
                    </div>
                    <p className="mb-3 whitespace-pre-wrap text-sm text-gray-700">{msg.text}</p>
                    {msg.swapStatus === 'open' && !isMe ? (
                      <button onClick={() => handleAcceptShift(msg)}
                        className="w-full rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors">
                        Take This Shift
                      </button>
                    ) : msg.swapStatus === 'accepted' ? (
                      <div className="flex items-center gap-2 rounded-lg bg-green-100 px-3 py-2 text-sm text-green-700">
                        <CheckCircle size={16} />
                        Taken by {msg.acceptedByName}
                      </div>
                    ) : isMe && msg.swapStatus === 'open' ? (
                      <div className="rounded-lg bg-yellow-100 px-3 py-2 text-sm text-yellow-700 text-center">
                        Waiting for someone to take this shift...
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            }

            return (
              <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}>
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${msg.userRole === 'owner' ? 'bg-red-600' : 'bg-gray-600'}`}>
                  {initials(msg.userName)}
                </div>
                <div className={`max-w-xs sm:max-w-sm ${isMe ? 'text-right' : ''}`}>
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className={`text-xs font-medium ${isMe ? 'text-red-600' : 'text-gray-700'}`}>{isMe ? 'You' : msg.userName}</span>
                    {msg.userRole === 'owner' && <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">Owner</span>}
                    <span className="text-xs text-gray-400">{formatTime(msg.createdAt)}</span>
                  </div>
                  <div className={`inline-block rounded-2xl px-4 py-2 text-sm ${isMe ? 'bg-red-600 text-white rounded-br-md' : 'bg-gray-100 text-gray-800 rounded-bl-md'}`}>
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
          className="flex-1 rounded-xl border bg-white px-4 py-3 text-sm shadow-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
          placeholder={channel === 'online' ? 'Message the Online Team…' : 'Message the team…'}
          value={text}
          onChange={e => setText(e.target.value)}
        />
        <button type="submit" disabled={!text.trim() || sending}
          className={`rounded-xl p-3 text-white shadow-sm transition-colors disabled:opacity-50 ${channel === 'online' ? 'bg-indigo-700 hover:bg-indigo-800' : 'bg-red-600 hover:bg-red-700'}`}>
          <Send size={18} />
        </button>
      </form>
      </div>

      {/* Members sidebar — Discord-style. Hidden on small screens. */}
      <aside className="hidden lg:flex h-full w-60 shrink-0 flex-col overflow-hidden rounded-xl border bg-white shadow-sm">
        <div className="border-b border-gray-100 px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            {channel === 'online' ? 'Online Team' : 'All Team'} · {channelMembers.length}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {channel === 'online'
              ? 'Can see messages in this channel.'
              : 'Everyone at this centre.'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {channelMembers.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-gray-400">No members yet.</p>
          ) : channelMembers.map(m => {
            const isMe = m.uid === profile?.uid;
            const role = m.role || 'instructor';
            const avatarBg =
              role === 'super_admin' ? 'bg-purple-600'
              : role === 'owner'     ? 'bg-red-600'
              : role === 'admin'     ? 'bg-emerald-600'
              : 'bg-gray-500';
            const roleLabel =
              role === 'super_admin' ? 'Super Admin'
              : role === 'owner'     ? 'Owner'
              : role === 'admin'     ? 'Admin'
              : (m.instructorType || '');
            return (
              <div key={m.id || m.uid}
                title={m.email || m.displayName}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-gray-50 ${isMe ? 'bg-red-50/40' : ''}`}>
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${avatarBg}`}>
                  {(m.displayName || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-gray-800">
                    {m.displayName || '—'}
                    {isMe && <span className="ml-1 text-[10px] font-normal text-red-600">(you)</span>}
                  </p>
                  {roleLabel && (
                    <p className="truncate text-[10px] text-gray-400">{roleLabel}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
