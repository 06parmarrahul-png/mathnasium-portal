import { useEffect, useMemo, useState } from 'react';
import {
  collection, onSnapshot, query, addDoc, updateDoc, deleteDoc, doc,
} from 'firebase/firestore';
import {
  CalendarPlus, Pencil, Trash2, PartyPopper, Users, GraduationCap, Star,
  ChevronLeft, ChevronRight, Loader2,
} from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast, confirmDialog } from '../lib/notify';
import {
  EVENT_TYPE_LIST, eventTypeLabel, validateEvent, asDate, toISO, isUsableEvent,
} from '../lib/centreEvents';
import {
  funDaysInMonth, monthDays, monthLabel, monthOf, stepMonth, diffMonth,
} from '../lib/funDays';
import { writeBatch } from 'firebase/firestore';

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

      <FunDayMonth events={events || []} centerId={activeCenterId} profile={profile} />

      {events === null && <p className="text-sm text-gray-500">Loading…</p>}
    </div>
  );
}

/**
 * A month of fun days, on one screen.
 *
 * There is an activity nearly every day, so entering them one at a time
 * through the form above means thirty round trips — which is how a
 * calendar stops being kept up to date by about the fourth of the month.
 * Type down the column, press save once.
 *
 * Saving writes only what CHANGED: an untouched month writes nothing, and
 * a cleared day deletes that one entry rather than the month.
 */
function FunDayMonth({ events, centerId, profile }) {
  const [ym, setYm] = useState(() => monthOf(toISO(new Date())));
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  const existing = useMemo(() => funDaysInMonth(events, ym), [events, ym]);
  const days = useMemo(() => monthDays(ym), [ym]);

  // What is on screen: the draft where it has been touched, the stored
  // value everywhere else. Keyed by date so switching months is clean.
  const valueFor = (date) => (date in draft
    ? draft[date]
    : (existing.find(e => e.date === date)?.title || ''));

  const changes = useMemo(() => diffMonth(events, draft, ym), [events, draft, ym]);
  const dirty = changes.adds.length + changes.edits.length + changes.removes.length;

  const save = async () => {
    setSaving(true);
    try {
      const batch = writeBatch(db);
      for (const a of changes.adds) {
        batch.set(doc(collection(db, 'centers', centerId, 'events')), {
          title: a.title, date: a.date, startTime: null, endTime: null,
          type: 'fun-day', note: '',
          createdAt: new Date().toISOString(),
          createdBy: profile?.displayName || profile?.email || null,
        });
      }
      for (const e of changes.edits) {
        batch.update(doc(db, 'centers', centerId, 'events', e.id), { title: e.title });
      }
      for (const r of changes.removes) {
        batch.delete(doc(db, 'centers', centerId, 'events', r.id));
      }
      await batch.commit();
      setDraft({});
      toast.success(`${monthLabel(ym)} saved — instructors see it on their home page.`);
    } catch (e) {
      toast.error(e?.message || 'Could not save those.');
    } finally {
      setSaving(false);
    }
  };

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="mt-8 rounded-xl border bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <PartyPopper size={16} className="text-green-600" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-gray-900">Fun days</h2>
          <p className="text-xs text-gray-500">
            One line per day. Instructors see today&apos;s on their home page.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setYm(m => stepMonth(m, -1))} title="Previous month"
            className="rounded-lg border p-1.5 text-gray-500 hover:bg-gray-50"><ChevronLeft size={15} /></button>
          <span className="min-w-[128px] text-center text-sm font-bold text-gray-900">
            {monthLabel(ym)}
          </span>
          <button onClick={() => setYm(m => stepMonth(m, 1))} title="Next month"
            className="rounded-lg border p-1.5 text-gray-500 hover:bg-gray-50"><ChevronRight size={15} /></button>
        </div>
      </div>

      <div className="grid gap-x-4 gap-y-1 p-3 sm:grid-cols-2">
        {days.map(d => (
          <label key={d.date}
            className={`flex items-center gap-2 rounded-lg px-2 py-1 ${
              d.weekday === 0 ? 'opacity-45' : ''}`}>
            <span className="w-14 shrink-0 text-[11px] font-bold uppercase tracking-wide text-gray-400">
              {DOW[d.weekday]} {d.day}
            </span>
            <input
              value={valueFor(d.date)}
              onChange={e => setDraft(x => ({ ...x, [d.date]: e.target.value }))}
              placeholder={d.weekday === 0 ? 'Closed' : '—'}
              className="w-full rounded-lg border border-transparent bg-gray-50 px-2.5 py-1.5 text-[13px] hover:border-gray-200 focus:border-red-500 focus:bg-white focus:outline-none" />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t px-4 py-3">
        <button onClick={save} disabled={!dirty || saving}
          className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-40">
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? 'Saving…' : dirty ? `Save ${dirty} change${dirty === 1 ? '' : 's'}` : 'Saved'}
        </button>
        {dirty > 0 && (
          <button onClick={() => setDraft({})}
            className="text-[13px] font-semibold text-gray-500 hover:text-gray-700">Discard</button>
        )}
        <span className="ml-auto text-xs text-gray-400">
          {existing.length} set for {monthLabel(ym)}
        </span>
      </div>
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
