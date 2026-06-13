// Chats hub — single sidebar entry for owners that consolidates every
// chat surface available to them:
//   - Centre Chat        (per-centre channel; same as /chat)
//   - Online Chat        (subset of Centre Chat for online instructors)
//   - Leadership Chat    (cross-centre owner channel; same as /platform-chat)
//   - Owner Chat         (private owner-only channel; same as platform but
//                         filtered to messages from owner role)
//   - Announcements      (centre announcements feed)
//
// Each entry is a card that links to its dedicated page. We avoid
// re-implementing the chat UIs here — they already work; this is just a
// navigation hub designed to keep the sidebar compact.

import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  collection, query, where, orderBy, limit, onSnapshot,
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  MessagesSquare, MessageSquare, Headphones, Megaphone, Sparkles, ArrowRight,
} from 'lucide-react';

export default function Chats() {
  const { profile, activeCenterId, isOwnerLike } = useAuth();
  const [recent, setRecent] = useState({ centre: 0, leadership: 0, announcements: 0 });

  // Unread counters per channel — kept simple: just last 24h message
  // counts. Per-user read state would need a separate doc; for the hub
  // these tallies give the owner a quick "anything new" pulse.
  useEffect(() => {
    if (!activeCenterId) return;
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const u1 = onSnapshot(
      query(
        collection(db, 'chat'),
        where('centerId', '==', activeCenterId),
        orderBy('createdAt', 'desc'),
        limit(50),
      ),
      snap => setRecent(r => ({ ...r, centre: snap.docs.filter(d => (d.data()?.createdAt?.toDate?.()?.toISOString?.() || '') > dayAgo).length })),
      () => {},
    );
    const u2 = onSnapshot(
      query(
        collection(db, 'platformChat'),
        orderBy('createdAt', 'desc'),
        limit(50),
      ),
      snap => setRecent(r => ({ ...r, leadership: snap.docs.filter(d => (d.data()?.createdAt?.toDate?.()?.toISOString?.() || '') > dayAgo).length })),
      () => {},
    );
    const u3 = onSnapshot(
      query(
        collection(db, 'announcements'),
        where('centerId', '==', activeCenterId),
        orderBy('createdAt', 'desc'),
        limit(20),
      ),
      snap => setRecent(r => ({ ...r, announcements: snap.docs.filter(d => (d.data()?.createdAt?.toDate?.()?.toISOString?.() || '') > dayAgo).length })),
      () => {},
    );
    return () => { u1(); u2(); u3(); };
  }, [activeCenterId]);

  const cards = [
    {
      to:   '/chat',
      title: 'Centre Chat',
      body:  'Day-to-day conversation with everyone scheduled at this centre.',
      icon:  MessageSquare,
      color: 'bg-blue-100 text-blue-700',
      badge: recent.centre,
      show:  true,
    },
    {
      to:    '/platform-chat',
      title: 'Management Chat',
      body:  'Centre-level conversation with the admins, owners, and Enterprise tied to this centre. Switch centres to see another.',
      icon:  Headphones,
      color: 'bg-purple-100 text-purple-700',
      badge: recent.leadership,
      show:  isOwnerLike,
    },
    {
      to:    '/platform-chat?view=owners',
      title: 'Owner Chat',
      body:  'Cross-centre channel for every centre owner and Enterprise across the platform.',
      icon:  Sparkles,
      color: 'bg-rose-100 text-rose-700',
      badge: 0,
      show:  profile?.role === 'owner' || profile?.role === 'super_admin',
    },
  ].filter(c => c.show);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-center gap-3">
        <div className="rounded-xl bg-blue-100 p-2.5 text-blue-700"><MessagesSquare size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Chats</h1>
          <p className="text-sm text-gray-500">
            Every conversation surface for this centre, in one place.
          </p>
        </div>
      </header>

      {/* Announcements — full-width hero bubble at the top */}
      <Link
        to="/announcements"
        className="group relative block overflow-hidden rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-50 p-5 hover:border-emerald-400 hover:shadow-md transition-all mb-4"
      >
        <div className="flex items-center gap-4">
          <div className="rounded-xl bg-emerald-100 text-emerald-700 p-3 shrink-0">
            <Megaphone size={24} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-gray-900">Announcements</h3>
              {recent.announcements > 0 && (
                <span className="rounded-full bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 min-w-[20px] text-center">
                  {recent.announcements}
                </span>
              )}
            </div>
            <p className="text-sm text-gray-600 mt-0.5 leading-snug">
              Centre-wide posts staff see when they sign in. Pinned at the top of Home.
            </p>
          </div>
          <ArrowRight size={18} className="text-emerald-400 group-hover:text-emerald-700 group-hover:translate-x-0.5 transition-all" />
        </div>
      </Link>

      {/* Centre / Leadership / Owner stacked underneath */}
      <div className="flex flex-col gap-3">
        {cards.map(c => (
          <Link key={c.to} to={c.to}
            className="group rounded-xl border border-gray-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm transition-all flex gap-3">
            <div className={`rounded-lg p-2.5 shrink-0 ${c.color}`}>
              <c.icon size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-gray-900">{c.title}</h3>
                {c.badge > 0 && (
                  <span className="rounded-full bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 min-w-[20px] text-center">
                    {c.badge}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-600 mt-1 leading-snug">{c.body}</p>
            </div>
            <ArrowRight size={16} className="self-center text-gray-300 group-hover:text-blue-600 transition-colors" />
          </Link>
        ))}
      </div>

      <p className="mt-6 text-xs text-gray-400 text-center">
        Tip: notification preferences live on your <Link to="/account" className="underline">Account</Link> page.
      </p>
    </div>
  );
}
