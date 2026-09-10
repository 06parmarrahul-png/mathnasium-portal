import { useEffect, useMemo, useState } from 'react';
import {
  collection, onSnapshot, query, addDoc, updateDoc, deleteDoc, doc,
} from 'firebase/firestore';
import { CalendarPlus, Pencil, Trash2, PartyPopper, Users, GraduationCap, Star } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast, confirmDialog } from '../lib/notify';
import {
  EVENT_TYPE_LIST, eventTypeLabel, validateEvent, asDate, toISO, isUsableEvent,
} from '../lib/centreEvents';

/**
 * Centre Events — where a staff meeting or a fun day becomes a real date.
 *
 * Before this, neither had anywhere to live. "Fun Day" existed as an
 * announcement CATEGORY, but announcements only carry the date they were
 * posted, so nothing could sort by when the thing actually happens — and in
 * a year of announcements the category was never used once.
 *
 * Kept deliberately small. Whoever runs the floor should be able to add
 * next Thursday's meeting in about fifteen seconds, from the same screen
 * that shows them what is already booked. A calendar that takes effort to
 * fill in stays empty, and an empty "What's on" card is worse than none —
 * people learn to ignore the space.
 */
const TYPE_ICON = {
  meeting: Users,
  'fun-day': PartyPopper,
  training: GraduationCap,
  other: Star,
};

const BLANK = { title: '', date: '', startTime: '', endTime: '', type: 'meeting', note: '' };

export default function CentreEvents() {
  const { activeCenterId, profile, canSeeAdminPanel } = useAuth();
  const [events, setEvents] = useState(null);
  const [draft, setDraft] = useState(null);      // null = form closed
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const today = toISO(new Date());

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'centers', activeCenterId, 'events')),
      snap => setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setEvents([]),
    );
  }, [activeCenterId]);

  const { upcoming, past } = useMemo(() => {
    const usable = (events || []).filter(isUsableEvent)
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      upcoming: usable.filter(e => e.date >= today),
      past: usable.filter(e => e.date < today).reverse(),
    };
  }, [events, today]);

  const save = async () => {
    const problem = validateEvent(draft);
    if (problem) { setError(problem); return; }
    setSaving(true);
    try {
      const body = {
        title: draft.title.trim(),
        date: draft.date,
        startTime: draft.startTime || null,
        endTime: draft.endTime || null,
        type: draft.type || 'other',
        note: (draft.note || '').trim(),
      };
      if (draft.id) {
        await updateDoc(doc(db, 'centers', activeCenterId, 'events', draft.id), body);
        toast.success('Event updated.');
      } else {
        await addDoc(collection(db, 'centers', activeCenterId, 'events'), {
          ...body,
          createdAt: new Date().toISOString(),
          createdBy: profile?.displayName || profile?.email || null,
        });
        toast.success('Event added — staff will see it on their home page.');
      }
      setDraft(null);
      setError('');
    } catch (e) {
      setError(e?.message || 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (ev) => {
    const ok = await confirmDialog({
      title: `Delete "${ev.title}"?`,
      message: 'It will disappear from everyone’s home page. This cannot be undone.',
      confirmText: 'Delete',
      cancelText: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'centers', activeCenterId, 'events', ev.id));
      toast.success('Deleted.');
    } catch (e) { toast.error(e?.message || 'Could not delete that.'); }
  };

  if (!canSeeAdminPanel) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border bg-white p-6 text-center">
        <p className="text-sm text-gray-600">
          Centre events are managed by admins. You&apos;ll see what&apos;s on from your home page.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-10">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Centre Events</h1>
          <p className="mt-1 text-sm text-gray-500">
            Staff meetings, fun days and training. Everything here shows on every
            instructor&apos;s home page — this week&apos;s in their list, the rest under
            &ldquo;What&apos;s on&rdquo;.
          </p>
        </div>
        {!draft && (
          <button onClick={() => { setDraft({ ...BLANK, date: today }); setError(''); }}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700">
            <CalendarPlus size={16} /> Add an event
          </button>
        )}
      </div>

      {/* Closures aren't entered here — they're already configured, and
          asking for them twice is how two sources of truth start. */}
      <p className="mb-5 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-[13px] leading-relaxed text-blue-900">
        Centre <b>closures</b> don&apos;t belong here — statutory holidays and closed days
        come from Centre Settings → Holidays, and staff already see those under
        &ldquo;What&apos;s on&rdquo;. This page is for things that <i>happen</i>.
      </p>

      {draft && (
        <div className="mb-6 rounded-xl border border-gray-300 bg-white p-5 shadow-sm">
          <h2 className="mb-4 font-semibold text-gray-900">
            {draft.id ? 'Edit event' : 'New event'}
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="mb-1 block text-xs font-semibold text-gray-600">What is it?</span>
              <input value={draft.title} autoFocus
                onChange={e => { setDraft(d => ({ ...d, title: e.target.value })); setError(''); }}
                placeholder="Staff meeting"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
            </label>

            <label>
              <span className="mb-1 block text-xs font-semibold text-gray-600">Date</span>
              <input type="date" value={draft.date}
                onChange={e => { setDraft(d => ({ ...d, date: e.target.value })); setError(''); }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
            </label>

            <label>
              <span className="mb-1 block text-xs font-semibold text-gray-600">Type</span>
              <select value={draft.type}
                onChange={e => setDraft(d => ({ ...d, type: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none">
                {EVENT_TYPE_LIST.map(t => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </label>

            <label>
              <span className="mb-1 block text-xs font-semibold text-gray-600">
                Starts <span className="font-normal text-gray-400">— leave blank for all day</span>
              </span>
              <input type="time" value={draft.startTime}
                onChange={e => { setDraft(d => ({ ...d, startTime: e.target.value })); setError(''); }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
            </label>

            <label>
              <span className="mb-1 block text-xs font-semibold text-gray-600">
                Ends <span className="font-normal text-gray-400">— optional</span>
              </span>
              <input type="time" value={draft.endTime}
                onChange={e => { setDraft(d => ({ ...d, endTime: e.target.value })); setError(''); }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
            </label>

            <label className="sm:col-span-2">
              <span className="mb-1 block text-xs font-semibold text-gray-600">
                Anything staff should know <span className="font-normal text-gray-400">— optional</span>
              </span>
              <input value={draft.note}
                onChange={e => setDraft(d => ({ ...d, note: e.target.value }))}
                placeholder="Pizza after. Wear red."
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
            </label>
          </div>

          {error && <p className="mt-3 text-sm font-semibold text-red-600">{error}</p>}

          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={save} disabled={saving}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60">
              {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Add it'}
            </button>
            <button onClick={() => { setDraft(null); setError(''); }}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      <EventList title="Coming up" rows={upcoming} onEdit={setDraft} onDelete={remove}
        empty="Nothing booked. Staff see an empty “What's on” card until something is." />
      {past.length > 0 && (
        <EventList title="Already happened" rows={past.slice(0, 10)} muted
          onEdit={setDraft} onDelete={remove} />
      )}

      {events === null && <p className="text-sm text-gray-500">Loading…</p>}
    </div>
  );
}

function EventList({ title, rows, onEdit, onDelete, empty, muted }) {
  return (
    <div className="mb-6">
      <p className="mb-2 text-xs font-bold uppercase tracking-widest text-gray-500">{title}</p>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-6 text-center text-sm text-gray-500">
          {empty}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-white">
          {rows.map((ev, i) => {
            const Icon = TYPE_ICON[ev.type] || Star;
            const d = asDate(ev.date);
            return (
              <div key={ev.id}
                className={`flex flex-wrap items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t' : ''} ${muted ? 'opacity-60' : ''}`}>
                <span className="flex w-12 shrink-0 flex-col items-center rounded-lg bg-gray-100 py-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                    {d ? d.toLocaleDateString('en-CA', { month: 'short' }) : '—'}
                  </span>
                  <span className="text-base font-bold leading-none text-gray-900">
                    {d ? d.getDate() : '?'}
                  </span>
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <Icon size={13} className="shrink-0 text-gray-400" />
                    <b className="truncate text-sm text-gray-900">{ev.title}</b>
                  </span>
                  <span className="block text-xs text-gray-500">
                    {eventTypeLabel(ev.type)}
                    {ev.startTime ? ` · ${ev.startTime}${ev.endTime ? `–${ev.endTime}` : ''}` : ' · all day'}
                    {ev.note ? ` · ${ev.note}` : ''}
                  </span>
                </span>

                <span className="flex shrink-0 gap-1">
                  <button onClick={() => onEdit({ ...ev, startTime: ev.startTime || '', endTime: ev.endTime || '', note: ev.note || '' })}
                    title="Edit" className="rounded p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => onDelete(ev)}
                    title="Delete" className="rounded p-2 text-gray-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
