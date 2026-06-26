import { useState, useEffect } from 'react';
import {
  collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, query, where, orderBy, getDocs,
} from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { Megaphone, Plus, Trash2, Pin, PinOff, Edit3, Loader2 } from 'lucide-react';
import { confirmDialog, toast } from '../lib/notify';
import { attachEmails } from '../lib/userContact';
import { notifyAnnouncement } from '../lib/emailService';

const CATEGORIES = {
  general:   { bg: 'bg-gray-100',  text: 'text-gray-700',  label: 'General' },
  'fun-day': { bg: 'bg-green-100', text: 'text-green-700', label: 'Fun Day' },
  policy:    { bg: 'bg-blue-100',  text: 'text-blue-700',  label: 'Policy'  },
  urgent:    { bg: 'bg-red-100',   text: 'text-red-700',   label: 'Urgent'  },
};

const BLANK_DRAFT = { title: '', text: '', category: 'general', pinned: false };

export default function Announcements() {
  const { profile, activeCenterId, centerConfig, canSeeAdminPanel } = useAuth();
  const [posts, setPosts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  // editingId === null → composing a new post (will send emails on save)
  // editingId === '<id>' → updating an existing post (no email re-send)
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(BLANK_DRAFT);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => onSnapshot(
    query(
      collection(db, 'announcements'),
      where('centerId', '==', activeCenterId),
      orderBy('date', 'desc'),
    ),
    snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      data.sort((a, b) => a.pinned && !b.pinned ? -1 : !a.pinned && b.pinned ? 1 : 0);
      setPosts(data);
    },
  ), [activeCenterId]);

  // Anyone with admin-panel access can post + manage announcements —
  // matches the Firestore rule. Instructors / hosts still read-only.
  const canPostAnnouncements = canSeeAdminPanel;

  const openCompose = () => {
    setEditingId(null);
    setDraft(BLANK_DRAFT);
    setShowForm(true);
  };

  const openEdit = (post) => {
    setEditingId(post.id);
    setDraft({
      title:    post.title || '',
      text:     post.text || '',
      category: post.category || 'general',
      pinned:   !!post.pinned,
    });
    setShowForm(true);
    // Scroll-to-form is nice but adds complexity; the form is right at
    // the top of the list, so a normal page scroll-up by the user is
    // sufficient here.
  };

  const cancelForm = () => {
    setShowForm(false);
    setEditingId(null);
    setDraft(BLANK_DRAFT);
  };

  // Email fan-out runs only on FIRST post (not edits) — we don't want
  // every typo-fix to land in 30 inboxes. Failures are swallowed; the
  // Firestore write already succeeded by the time we get here.
  const fanoutNewPostEmail = async (postData) => {
    try {
      const snap = await getDocs(query(
        collection(db, 'users'),
        where('centerIds', 'array-contains', activeCenterId),
      ));
      const approved = snap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => u.approved && u.role !== 'super_admin');
      const withEmails = await attachEmails(approved);
      await notifyAnnouncement({
        post:        postData,
        staffEmails: withEmails,
        centerName:  centerConfig?.name || 'Ratio',
      });
    } catch (err) {
      console.error('[Announcements] email fan-out failed:', err);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!draft.title.trim() || !draft.text.trim()) return;
    setSubmitting(true);

    const payload = {
      title:    draft.title.trim(),
      text:     draft.text.trim(),
      category: draft.category,
      pinned:   !!draft.pinned,
    };

    try {
      if (editingId) {
        await updateDoc(doc(db, 'announcements', editingId), {
          ...payload,
          editedAt: serverTimestamp(),
          editedBy: profile?.displayName || 'Unknown',
        });
        toast.success('Announcement updated');
      } else {
        const full = {
          ...payload,
          author:   profile?.displayName || 'Unknown',
          authorId: profile?.uid || null,
          centerId: activeCenterId,
          // 'date' kept as ISO string for backwards-compatible orderBy.
          // 'createdAt' uses the Firebase server clock — preferred for sorting.
          date:      new Date().toISOString(),
          createdAt: serverTimestamp(),
        };
        await addDoc(collection(db, 'announcements'), full);
        toast.success('Announcement posted — emails sent to staff');
        // Fire-and-forget so the modal can close right away.
        fanoutNewPostEmail(full);
      }
      cancelForm();
    } catch (err) {
      console.error('[Announcements] save failed:', err);
      toast.error('Save failed — try again');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirmDialog({
      title: 'Delete this announcement?',
      message: 'It will be removed for everyone immediately.',
      confirmText: 'Delete',
      danger: true,
    });
    if (ok) await deleteDoc(doc(db, 'announcements', id));
  };

  // Quick-toggle pin without opening the editor — saves a step for
  // the "unpin a stale post" case the owner mentioned. Silent: no
  // confirm, no toast, the visual change is the feedback.
  const togglePin = async (post) => {
    try {
      await updateDoc(doc(db, 'announcements', post.id), { pinned: !post.pinned });
    } catch (err) {
      console.error('[Announcements] pin toggle failed:', err);
      toast.error('Could not update pin');
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-red-100 p-2 text-red-600"><Megaphone size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Announcements</h1>
            <p className="text-sm text-gray-500">Stay updated with the latest news</p>
          </div>
        </div>
        {canPostAnnouncements && !showForm && (
          <button onClick={openCompose} className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-700">
            <Plus size={16} /> New Post
          </button>
        )}
      </div>

      {showForm && canPostAnnouncements && (
        <form onSubmit={handleSubmit} className="mb-6 rounded-xl border bg-white p-6 shadow-sm">
          <h3 className="mb-4 font-semibold text-gray-900">
            {editingId ? 'Edit announcement' : 'Create announcement'}
          </h3>
          <div className="space-y-3">
            <input
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
              placeholder="Announcement title"
              value={draft.title}
              onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
              required
            />
            <textarea
              className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
              rows={4}
              placeholder="Write your announcement..."
              value={draft.text}
              onChange={e => setDraft(d => ({ ...d, text: e.target.value }))}
              required
            />
            <div className="flex flex-wrap items-center gap-4">
              <select
                value={draft.category}
                onChange={e => setDraft(d => ({ ...d, category: e.target.value }))}
                className="rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
              >
                {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={draft.pinned}
                  onChange={e => setDraft(d => ({ ...d, pinned: e.target.checked }))}
                  className="rounded"
                />
                Pin to top
              </label>
              {!editingId && (
                <span className="ml-auto text-xs text-gray-500 italic">
                  All approved staff will get an email when you post.
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                {editingId ? 'Save changes' : 'Post'}
              </button>
              <button
                type="button"
                onClick={cancelForm}
                className="rounded-lg border px-4 py-2 text-sm text-gray-500 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="space-y-4">
        {posts.length === 0 ? (
          <div className="rounded-xl border bg-white p-8 text-center shadow-sm">
            <Megaphone size={32} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-500">No announcements yet.</p>
          </div>
        ) : posts.map(post => {
          const cat = CATEGORIES[post.category] || CATEGORIES.general;
          return (
            <div key={post.id} className="rounded-xl border bg-white p-5 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                {post.pinned && <Pin size={14} className="text-red-500" />}
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cat.bg} ${cat.text}`}>{cat.label}</span>
                <span className="text-xs text-gray-400">{post.date ? new Date(post.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span>
                {post.editedAt && (
                  <span className="text-[10px] text-gray-400 italic">· edited</span>
                )}
              </div>
              <h3 className="mb-1 text-lg font-semibold text-gray-900">{post.title}</h3>
              <p className="mb-3 whitespace-pre-wrap text-sm text-gray-600">{post.text}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">Posted by {post.author}</span>
                {canPostAnnouncements && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => togglePin(post)}
                      title={post.pinned ? 'Unpin' : 'Pin to top'}
                      className={`rounded-md p-1.5 transition-colors ${
                        post.pinned
                          ? 'text-red-500 hover:bg-red-50'
                          : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700'
                      }`}
                    >
                      {post.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                    </button>
                    <button
                      onClick={() => openEdit(post)}
                      title="Edit"
                      className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-blue-600 transition-colors"
                    >
                      <Edit3 size={15} />
                    </button>
                    <button
                      onClick={() => handleDelete(post.id)}
                      title="Delete"
                      className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
