import { useEffect, useMemo, useState } from 'react';
import {
  collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, writeBatch,
} from 'firebase/firestore';
import {
  ChevronLeft, ChevronRight, Plus, Lock, Trash2, X, Loader2, CalendarClock, Upload,
} from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast, confirmDialog } from '../lib/notify';
import { PAGES } from '../lib/pageNames';
import CalendarImport from '../components/CalendarImport';
import AssessmentEditor from '../components/AssessmentEditor';
import { resolveInstructionalHours, isOperatingDay } from '../lib/centerConfig';
import {
  KIND_LIST, kindLabel, kindTone, minutesOf, hhmm, asDate, toISO, addDays,
  weekStartOf, entrySpan, validateEntry, blockedStarts, closureMap, rowsForDate,
  layoutOverlaps,
  REPEAT_LIST, repeatLabel, isRepeating, occurrenceDates, describeSeries,
  defaultUntil,
} from '../lib/ratioCalendar';

/**
 * The Calendar — management's own view of the centre's dates.
 *
 * WHAT IT IS FOR
 *   Apptoto books a lead into Google Calendar, and Google then refuses
 *   anything that overlaps it. This is that, for Ratio: an entry can HOLD
 *   THE BOOKING PAGE, and the booking engine treats the hold exactly like
 *   an existing appointment.
 *
 * WHAT IT READS RATHER THAN OWNS
 *   Closures and stat holidays (Centre Settings), fun days and meetings
 *   (Centre Events), and booked assessments. None of them are re-entered
 *   here — the calendar shows them and links to where they live. Anything
 *   else ends with the same fact stored twice, disagreeing with itself.
 *
 *   Approved time off was here and was REMOVED at the centre's request:
 *   this page answers "what is booked into the building", and who is away
 *   is a staffing question the weekly grid already paints on its own cell.
 *
 * EVERY FIGURE IS A DIRECT READ. There is no ratio, no budget and no
 * enrolment on this page.
 */

const HOUR_PX = 44;

/* A day the centre does not open. Drawn rather than left blank, because
   an empty column and a shut one look the same and only one of them is
   worth trying to book a meeting into. */
const SHUT = {
  backgroundImage:
    'repeating-linear-gradient(45deg, transparent, transparent 6px, var(--nl-hair) 6px, var(--nl-hair) 12px)',
};

/* Today — the HEADER CELL ONLY.
   Red text on the date alone was too quiet, but a tint running the whole
   column was worse: a solid stripe behind every entry on the busiest day
   of the week, fighting the things you are actually reading. The date and
   its filled pill are where the eye looks for the day anyway, so the mark
   belongs there and stops there. */
const TODAY = { backgroundColor: 'var(--nl-today)' };

/* The hours the week grid draws. Widened to fit whatever is actually on,
   so an 8am interview is not silently off the top of the page. */
function dayBounds(rows) {
  let from = 9 * 60;
  let to = 20 * 60;
  for (const r of rows) {
    const span = entrySpan(r);
    if (!span) continue;
    from = Math.min(from, Math.floor(span.start / 60) * 60);
    to = Math.max(to, Math.ceil(span.end / 60) * 60);
  }
  return { from, to };
}

const shortTime = (t) => {
  const m = minutesOf(t);
  if (m == null) return '';
  const h = ((Math.floor(m / 60) + 11) % 12) + 1;
  return m % 60 ? `${h}:${String(m % 60).padStart(2, '0')}` : `${h}`;
};
const ampm = (t) => {
  const m = minutesOf(t);
  if (m == null) return '';
  return `${shortTime(t)}${m < 12 * 60 ? 'am' : 'pm'}`;
};
const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
const fmtLong = (iso) => asDate(iso)?.toLocaleDateString(undefined,
  { day: 'numeric', month: 'short', year: 'numeric' }) || iso;

/** A source that is not an entry cannot be edited from here. */
const isEntry = (r) => r.source === 'entry';

/* Brand red is identity and actions (index.css), so it is spent here on
   exactly two things: a CLOSURE, which is a stop, and the now line, which
   is this instant. Everything else takes a semantic colour of its own. */
const SOURCE_TONE = {
  closure: { color: 'var(--nl-brand)', wash: 'var(--nl-brandw)' },
  event:   { color: 'var(--nl-info)',  wash: 'var(--nl-infow)' },
  intake:  { color: 'var(--nl-ok)',    wash: 'var(--nl-okw)' },
};
const toneFor = (r) => SOURCE_TONE[r.source] || kindTone(r.kind);

const BLANK = {
  title: '', kind: 'meeting', date: '', startTime: '', endTime: '',
  allDay: false, assignedTo: [], assignedNames: [], holdsBooking: false, note: '',
  repeat: 'none', repeatUntil: '',
  // Which occurrences an edit or a delete applies to. Only ever asked
  // once an entry is part of a series.
  scope: 'one',
};

export default function RatioCalendar() {
  const { activeCenterId, profile, centerConfig, isOwnerLike, isSuperAdmin } = useAuth();
  // centerIntakes is owner-tier in the rules, deliberately: an assessment
  // carries a parent's name, email and phone, and Managers and Hosts are
  // kept off the PII routes everywhere else in the app.
  const canSeeFamilies = !!(isOwnerLike || isSuperAdmin);
  const [view, setView] = useState('week');
  const [cursor, setCursor] = useState(toISO(new Date()));
  const [entries, setEntries] = useState(null);
  const [events, setEvents] = useState([]);
  const [intakes, setIntakes] = useState([]);
  const [staff, setStaff] = useState([]);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  const [openIntake, setOpenIntake] = useState(null);
  const [intakesDenied, setIntakesDenied] = useState(false);

  const today = toISO(new Date());
  const holidays = useMemo(
    () => (Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : []),
    [centerConfig],
  );

  /* The window every listener is scoped to. A month view needs the
     leading and trailing days of the grid, so both take the wider one. */
  // `from`/`to` come back on the memo for callers that want the whole
  // week; the grid and its label both read `days`.
  const { days } = useMemo(() => {
    if (view === 'week') {
      const start = weekStartOf(cursor);
      return {
        from: start, to: addDays(start, 6),
        days: Array.from({ length: 7 }, (_, i) => addDays(start, i)),
      };
    }
    const d = asDate(cursor) || new Date();
    const first = toISO(new Date(d.getFullYear(), d.getMonth(), 1));
    const last = toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    const start = weekStartOf(first);
    const endDow = asDate(last).getDay();
    const end = addDays(last, 6 - endDow);
    const out = [];
    for (let c = start; c <= end; c = addDays(c, 1)) out.push(c);
    return { from: start, to: end, days: out };
  }, [view, cursor]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'calendar'),
      snap => setEntries(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setEntries([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'events'),
      snap => setEvents(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setEvents([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'centerIntakes'), where('centerId', '==', activeCenterId)),
      snap => { setIntakes(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setIntakesDenied(false); },
      // Refused rather than empty. Saying so beats an assessment layer
      // that silently shows nothing and reads as a quiet week.
      () => { setIntakes([]); setIntakesDenied(true); },
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setStaff(snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => u.approved && u.displayName)
        .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)))),
      () => setStaff([]),
    );
  }, [activeCenterId]);

  const byDate = useMemo(() => {
    const map = {};
    for (const d of days) {
      map[d] = rowsForDate({
        dateISO: d, entries: entries || [], events, intakes, holidays,
      }).filter(r => !hidden.has(r.source));
    }
    return map;
  }, [days, entries, events, intakes, holidays, hidden]);

  /* Every closure the centre has configured, as bare dates. The series
     generator skips these: a meeting does not happen on a day the centre
     is shut. Not windowed — a series runs a year ahead of the grid. */
  const closedDates = useMemo(() => new Set(Object.keys(closureMap(holidays))), [holidays]);

  /* What pressing save would create. Recomputed as the draft changes so
     the composer can say "38 entries, every week, through 23 Sep 2027"
     while there is still a Cancel button. */
  const seriesRun = useMemo(() => occurrenceDates({
    startISO: draft?.date, freq: draft?.repeat || 'none',
    untilISO: draft?.repeatUntil || null, skip: closedDates,
  }), [draft?.date, draft?.repeat, draft?.repeatUntil, closedDates]);

  /* Days the centre does not open at all. Without this a Saturday reads
     exactly like a quiet Tuesday, and someone books a meeting on one. */
  const closedDays = useMemo(
    () => new Set(days.filter(d => !isOperatingDay(asDate(d), centerConfig))),
    [days, centerConfig],
  );

  const importedUids = useMemo(() => new Set([
    ...(entries || []).map(e => e.sourceUid).filter(Boolean),
    ...(intakes || []).map(t => t.sourceUid).filter(Boolean),
  ]), [entries, intakes]);

  /* The week grid drops a day the centre never opens — Sunday at Langley —
     so the six that are left get the width back. But NOT if something is
     on it: the composer takes any date, so a hidden column would hide a
     real entry, and an entry you cannot see is worse than a narrow one.
     The column coming back is itself the signal that something is there. */
  const weekDays = useMemo(() => {
    const shown = days.filter(d => !closedDays.has(d) || (byDate[d] || []).length > 0);
    return shown.length ? shown : days;
  }, [days, closedDays, byDate]);

  const holdCount = useMemo(
    () => days.reduce((n, d) => n + byDate[d].filter(r => isEntry(r) && r.holdsBooking).length, 0),
    [days, byDate],
  );

  /* What a hold on the drafted day would actually take off the booking
     page. Shown while composing, because "Friday has one time left" is
     the thing someone needs before they save, not after. */
  const holdPreview = useMemo(() => {
    if (!draft?.holdsBooking || !draft.date) return null;
    const d = asDate(draft.date);
    if (!d) return null;
    const hours = resolveInstructionalHours(centerConfig, d) || {};
    const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const h = hours[DOW[d.getDay()]];
    const windows = h?.start && h?.end ? [{ start: h.start, end: h.end }] : [];
    const s = centerConfig?.intakeSettings || {};
    const blocked = blockedStarts({
      windows,
      startTime: draft.startTime, endTime: draft.endTime, allDay: draft.allDay,
      slotDurationMin: s.slotDurationMin || 60,
      slotIntervalMin: s.slotIntervalMin || 30,
    });
    const all = blockedStarts({
      windows, allDay: true,
      slotDurationMin: s.slotDurationMin || 60,
      slotIntervalMin: s.slotIntervalMin || 30,
    });
    const booked = intakes.filter(t => String(t.slot || '').slice(0, 10) === draft.date && t.status !== 'cancelled');
    const left = all.filter(t => !blocked.includes(t)
      && !booked.some(b => String(b.slot || '').slice(11, 16) === t));
    return { blocked, left, closure: closureMap(holidays)[draft.date] || null };
  }, [draft, centerConfig, intakes, holidays]);

  /** A row is editable where it lives: entries here, assessments as intakes. */
  const openRow = (r) => {
    if (isEntry(r)) { setDraft({ ...r }); return; }
    if (r.source === 'intake') {
      const full = (intakes || []).find(t => t.id === r.id);
      if (full) setOpenIntake(full);
    }
  };

  const openNew = (dateISO, startTime = '') => {
    setError('');
    setDraft({
      ...BLANK, date: dateISO || today,
      startTime, endTime: startTime ? hhmm(minutesOf(startTime) + 60) : '',
    });
  };

  /**
   * Saving.
   *
   * A series is MATERIALISED — one document per occurrence, sharing a
   * seriesId. See the note at the top of lib/ratioCalendar.js: the server
   * finds holds with a date-range query, so a rule on one document would
   * hold the first week and then silently stop.
   *
   * Four paths, and the scope picker decides between the middle two:
   *   new + repeats        → write the whole series
   *   editing, "all later" → update this occurrence and every later one
   *   one-off + repeats    → keep this document as the first and add the rest
   *   anything else        → update the one document
   */
  const save = async () => {
    const problem = validateEntry(draft);
    if (problem) { setError(problem); return; }
    setSaving(true);
    try {
      const col = collection(db, 'centers', activeCenterId, 'calendar');
      const who = profile?.displayName || profile?.email || null;
      // Deliberately WITHOUT `date`: each occurrence keeps its own, which
      // is the only thing distinguishing them.
      const fields = {
        title: draft.title.trim(),
        kind: draft.kind || 'task',
        allDay: !!draft.allDay,
        startTime: draft.allDay ? null : draft.startTime,
        endTime: draft.allDay ? null : draft.endTime,
        assignedTo: draft.assignedTo || [],
        assignedNames: draft.assignedNames || [],
        holdsBooking: !!draft.holdsBooking,
        note: (draft.note || '').trim(),
        updatedAt: new Date().toISOString(),
        updatedBy: who,
      };
      const repeat = isRepeating(draft.repeat) ? draft.repeat : null;
      const repeatUntil = repeat ? (draft.repeatUntil || defaultUntil(draft.date)) : null;
      const born = { createdAt: new Date().toISOString(), createdBy: who };

      if (draft.id && draft.scope === 'series' && draft.seriesId) {
        const later = (entries || []).filter(
          e => e.seriesId === draft.seriesId && e.date >= draft.date);
        const batch = writeBatch(db);
        for (const e of later) batch.update(doc(col, e.id), fields);
        await batch.commit();
        toast.success(`Updated ${later.length} ${later.length === 1 ? 'entry' : 'entries'}.`);
      } else if (draft.id && !draft.seriesId && repeat) {
        // Turning a one-off into a series. This document stays put and
        // becomes the first occurrence, so nothing anyone has already
        // looked at moves or changes id.
        const seriesId = draft.id;
        const batch = writeBatch(db);
        batch.update(doc(col, draft.id), { ...fields, seriesId, repeat, repeatUntil });
        for (const d of seriesRun.dates.slice(1)) {
          batch.set(doc(col), { ...fields, ...born, date: d, seriesId, repeat, repeatUntil });
        }
        await batch.commit();
        toast.success(`Repeats now — ${seriesRun.dates.length} entries.`);
      } else if (draft.id) {
        await updateDoc(doc(col, draft.id), { ...fields, date: draft.date });
        toast.success('Updated.');
      } else if (repeat) {
        const seriesId = doc(col).id;
        const batch = writeBatch(db);
        for (const d of seriesRun.dates) {
          batch.set(doc(col), { ...fields, ...born, date: d, seriesId, repeat, repeatUntil });
        }
        await batch.commit();
        toast.success(`Saved ${seriesRun.dates.length} entries.`);
      } else {
        await addDoc(col, { ...fields, ...born, date: draft.date, seriesId: null, repeat: null, repeatUntil: null });
        toast.success(fields.holdsBooking
          ? 'Saved — that time is now off the booking page.'
          : 'Saved.');
      }
      setDraft(null);
      setError('');
    } catch (e) {
      setError(e?.message || 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry, scope = 'one') => {
    const series = scope === 'series' && entry.seriesId;
    const later = series
      ? (entries || []).filter(e => e.seriesId === entry.seriesId && e.date >= entry.date)
      : [entry];
    const ok = await confirmDialog({
      title: series
        ? `Delete ${later.length} entries in "${entry.title}"?`
        : `Delete "${entry.title}"?`,
      message: entry.holdsBooking
        ? 'That time goes back on the public booking page straight away.'
        : 'This cannot be undone.',
      confirmText: 'Delete', cancelText: 'Keep it', danger: true,
    });
    if (!ok) return;
    try {
      const col = collection(db, 'centers', activeCenterId, 'calendar');
      if (series) {
        const batch = writeBatch(db);
        for (const e of later) batch.delete(doc(col, e.id));
        await batch.commit();
        toast.success(`Deleted ${later.length} entries.`);
      } else {
        await deleteDoc(doc(col, entry.id));
        toast.success('Deleted.');
      }
    } catch (e) { toast.error(e?.message || 'Could not delete that.'); }
  };

  const step = (n) => setCursor(view === 'week'
    ? addDays(cursor, 7 * n)
    : toISO(new Date(asDate(cursor).getFullYear(), asDate(cursor).getMonth() + n, 1)));

  // Reads off the days SHOWN, not the calendar week — "Sep 20 – Sep 26"
  // over a grid that starts on Monday the 21st is a small lie.
  const rangeLabel = view === 'week'
    ? `${asDate(weekDays[0]).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${asDate(weekDays[weekDays.length - 1]).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : asDate(cursor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const toggleLayer = (src) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(src)) next.delete(src); else next.add(src);
    return next;
  });

  return (
    <div className="nl mx-auto w-full max-w-7xl pb-28 lg:pb-6">
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <CalendarClock size={22} style={{ color: 'var(--nl-brand)' }} />
        <h1 className="nl-display text-[26px] font-semibold leading-tight">{PAGES.calendar.name}</h1>
        <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: 'var(--nl-raised)', color: 'var(--nl-ink2)' }}>
          {centerConfig?.name || activeCenterId}
        </span>
        {canSeeFamilies && (
        <button type="button" onClick={() => setImporting(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] font-semibold"
          style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
          <Upload size={14} /> Import
        </button>
        )}
        <button type="button" onClick={() => openNew(today)}
          className={canSeeFamilies ? '' : 'ml-auto'}
          className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12.5px] font-semibold text-white"
          style={{ background: 'var(--nl-brand)' }}>
          <Plus size={14} /> New entry
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="flex overflow-hidden rounded-lg border"
          style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
          <button type="button" onClick={() => step(-1)} className="px-2.5 py-1.5" aria-label="Previous">
            <ChevronLeft size={15} />
          </button>
          <button type="button" onClick={() => setCursor(today)}
            className="border-x px-3 py-1.5 text-[12px]" style={{ borderColor: 'var(--nl-rule)' }}>
            Today
          </button>
          <button type="button" onClick={() => step(1)} className="px-2.5 py-1.5" aria-label="Next">
            <ChevronRight size={15} />
          </button>
        </div>
        <span className="nl-display text-[15px] font-semibold">{rangeLabel}</span>

        <div className="ml-auto flex overflow-hidden rounded-lg border"
          style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
          {['week', 'month'].map(v => (
            <button key={v} type="button" onClick={() => setView(v)}
              className="px-3.5 py-1.5 text-[11.5px] font-medium capitalize"
              style={v === view
                ? { background: 'var(--nl-ink)', color: '#fff', fontWeight: 600 }
                : { color: 'var(--nl-muted)' }}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <LayerBar hidden={hidden} onToggle={toggleLayer} holdCount={holdCount} />

      {/* Not an empty week — a refused read. centerIntakes is owner-tier
          because an assessment carries a parent's name, email and phone,
          and Managers and Hosts are off the PII routes everywhere else.
          Saying so beats a layer that silently shows nothing. */}
      {intakesDenied && (
        <p className="mb-3 rounded-lg border px-3 py-2 text-[12px]"
          style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-muted)' }}>
          Booked assessments are not shown here — they carry families&rsquo; contact details, so
          they stay with owners, directors and the admin assistant.
        </p>
      )}

      {entries === null ? (
        <div className="flex items-center gap-2 rounded-2xl border p-6 text-[13px]"
          style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)', color: 'var(--nl-muted)' }}>
          <Loader2 size={15} className="animate-spin" /> Reading the calendar…
        </div>
      ) : view === 'week' ? (
        <WeekGrid days={weekDays} byDate={byDate} today={today} closedDays={closedDays}
          onNew={openNew} onOpen={openRow} />
      ) : (
        <MonthGrid days={days} byDate={byDate} today={today} cursor={cursor} closedDays={closedDays}
          onNew={openNew} onOpen={openRow} />
      )}

      {openIntake && (
        <AssessmentEditor intake={openIntake} intakes={intakes}
          centerConfig={centerConfig} canEdit={canSeeFamilies}
          onClose={() => setOpenIntake(null)} />
      )}

      {importing && (
        <CalendarImport
          centerId={activeCenterId} profile={profile}
          timeZone={centerConfig?.intakeSettings?.timezone || 'America/Vancouver'}
          existingUids={importedUids} onClose={() => setImporting(false)} />
      )}

      {draft && (
        <Composer
          draft={draft} setDraft={setDraft} staff={staff} error={error}
          saving={saving} onSave={save} onClose={() => { setDraft(null); setError(''); }}
          onDelete={draft.id ? () => { remove(draft, draft.scope); setDraft(null); } : null}
          preview={holdPreview} run={seriesRun}
        />
      )}
    </div>
  );
}

/* ── The layer bar ──────────────────────────────────────────────────── */

const LAYER_CHIPS = [
  { src: 'intake',  label: 'Assessments' },
  { src: 'entry',   label: 'Entries' },
  { src: 'event',   label: 'Centre events' },
  { src: 'closure', label: 'Closures' },
];

function LayerBar({ hidden, onToggle, holdCount }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      {LAYER_CHIPS.map(({ src, label }) => {
        const on = !hidden.has(src);
        const tone = SOURCE_TONE[src] || kindTone('meeting');
        return (
          <button key={src} type="button" onClick={() => onToggle(src)}
            className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium"
            style={on
              ? { borderColor: tone.color, background: tone.wash, color: tone.color }
              : { borderColor: 'var(--nl-rule)', color: 'var(--nl-muted)' }}>
            {src === 'closure' ? (
              <Lock size={10} style={{ opacity: on ? 1 : 0.5 }} />
            ) : (
              <span className="inline-block h-[7px] w-[7px] rounded-full"
                style={{ background: on ? tone.color : 'var(--nl-rule)' }} />
            )}
            {label}
          </button>
        );
      })}
      {holdCount > 0 && (
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11.5px]"
          style={{ color: 'var(--nl-muted)' }}>
          <Lock size={11} />
          {holdCount} {holdCount === 1 ? 'entry holds' : 'entries hold'} the booking page
        </span>
      )}
    </div>
  );
}

/* ── Week ───────────────────────────────────────────────────────────── */

function WeekGrid({ days, byDate, today, closedDays, onNew, onOpen }) {
  const all = days.flatMap(d => byDate[d]);
  const { from, to } = dayBounds(all);
  const span = to - from;
  const pct = (m) => ((m - from) / span) * 100;
  const hours = [];
  for (let h = from / 60; h * 60 < to; h += 1) hours.push(h);

  /* Sized to the days actually shown — a closed Sunday is dropped, so the
     rest of the week gets its width back. */
  const cols = `54px repeat(${days.length}, 1fr)`;

  /* Which lane each timed entry gets, per day. */
  const lanes = {};
  for (const d of days) lanes[d] = layoutOverlaps(byDate[d]);

  /* Where "now" falls, and only while it is on screen — a marker pinned to
     the top edge at 7am says nothing, and one on a week nobody is in says
     something false. */
  const clock = new Date();
  const nowMin = clock.getHours() * 60 + clock.getMinutes();
  const nowAt = (days.includes(today) && nowMin >= from && nowMin < to) ? nowMin : null;

  return (
    <div className="overflow-x-auto rounded-2xl border"
      style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
      <div style={{ minWidth: Math.max(620, 120 * days.length + 54) }}>
        {/* THE COLUMNS OF ALL THREE ROWS HAVE TO RESOLVE THE SAME WAY.
            `1fr` is minmax(auto, 1fr), and a grid item's automatic minimum
            is its min-content — which `truncate` (white-space: nowrap)
            makes the whole string. One long all-day title therefore widened
            its own column and squeezed the others, in that row only, while
            the header and hour rows stayed even because their content is
            short or absolutely positioned. `min-w-0` on every 1fr cell is
            what keeps the three in step. Same trap as LeadershipHome. */}
        <div className="grid border-b" style={{ gridTemplateColumns: cols, borderColor: 'var(--nl-rule)' }}>
          <div />
          {days.map(d => {
            const dt = asDate(d);
            const isToday = d === today;
            return (
              <div key={d} className="min-w-0 border-l py-2 text-center"
                style={{ borderColor: 'var(--nl-rule)', ...(isToday ? TODAY : null) }}>
                <div className="text-[9px] font-bold uppercase tracking-[0.1em]"
                  style={{ color: isToday ? 'var(--nl-ink)' : 'var(--nl-muted)' }}>
                  {dt.toLocaleDateString(undefined, { weekday: 'short' })}
                </div>
                {/* Filled INK, the same "selected" idiom as the Week /
                    Month toggle — not a fourth red thing on the page. The
                    month grid uses the identical pill. */}
                <div className="nl-display mx-auto mt-0.5 flex h-[26px] w-[30px] items-center justify-center rounded-lg text-[17px] font-semibold"
                  style={isToday ? { background: 'var(--nl-ink)', color: '#fff' } : undefined}>
                  {dt.getDate()}
                </div>
              </div>
            );
          })}
        </div>

        {/* All-day band: closures, fun days and all-day entries. */}
        <div className="grid border-b" style={{ gridTemplateColumns: cols, borderColor: 'var(--nl-rule)', background: 'var(--nl-paper)' }}>
          <div className="pr-2 pt-2 text-right text-[8.5px] font-bold uppercase tracking-[0.08em]"
            style={{ color: 'var(--nl-muted)' }}>All day</div>
          {days.map(d => (
            <div key={d} className="min-w-0 min-h-[30px] space-y-1 border-l p-1"
              style={{ borderColor: 'var(--nl-rule)' }}>
              {byDate[d].filter(r => r.allDay).map(r => {
                const tone = toneFor(r);
                return (
                  <button key={r.id} type="button" onClick={() => onOpen(r)}
                    className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[10px] font-semibold"
                    style={{ background: tone.wash, color: tone.color }}
                    title={r.note || r.title}>
                    {r.holdsBooking && <Lock size={8} className="mr-1 inline" />}
                    {r.title}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="relative grid" style={{ gridTemplateColumns: cols }}>
          <div className="relative" style={{ height: (span / 60) * HOUR_PX }}>
            {hours.map(h => (
              <span key={h} className="absolute right-2 -translate-y-1 text-[10px] font-semibold"
                style={{ top: (h - from / 60) * HOUR_PX, color: 'var(--nl-muted)' }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          {days.map(d => (
            <div key={d} className="relative min-w-0 border-l"
              style={{
                borderColor: 'var(--nl-rule)', height: (span / 60) * HOUR_PX,
                ...(closedDays.has(d) ? SHUT : null),
              }}>
              {closedDays.has(d) && (
                <span className="absolute inset-x-0 top-2 text-center text-[10px] font-semibold"
                  style={{ color: 'var(--nl-muted)' }}>Centre closed</span>
              )}
              {d === today && nowAt != null && (
                <div aria-hidden="true" data-now-line
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2"
                  style={{ top: `${pct(nowAt)}%`, borderColor: 'var(--nl-brand)' }}>
                  <span className="absolute -left-[3.5px] -top-[4.5px] block h-[7px] w-[7px] rounded-full"
                    style={{ background: 'var(--nl-brand)' }} />
                </div>
              )}
              {hours.map(h => (
                <button key={h} type="button"
                  onClick={() => onNew(d, hhmm(h * 60))}
                  className="absolute left-0 right-0 border-t"
                  style={{ top: (h - from / 60) * HOUR_PX, height: HOUR_PX, borderColor: 'var(--nl-hair)' }}
                  aria-label={`Add an entry at ${hourLabel(h)}`} />
              ))}
              {byDate[d].filter(r => !r.allDay).map(r => {
                const s = entrySpan(r);
                if (!s) return null;
                const tone = toneFor(r);
                const tall = (s.end - s.start) >= 50;
                // Two things at once sit side by side. Full width each
                // meant the later one covered the earlier one's time,
                // half its title and its click target.
                const { col = 0, cols = 1 } = lanes[d].get(r.id) || {};
                const w = 100 / cols;
                return (
                  <button key={r.id} type="button" onClick={() => onOpen(r)}
                    className="absolute overflow-hidden rounded px-1.5 py-1 text-left"
                    style={{
                      top: `${pct(s.start)}%`, height: `calc(${pct(s.end) - pct(s.start)}% - 3px)`,
                      left: `calc(${col * w}% + 3px)`, width: `calc(${w}% - 6px)`,
                      background: tone.wash, color: tone.color,
                      borderLeft: `3px solid ${tone.color}`,
                    }}
                    title={`${ampm(r.startTime)}–${ampm(r.endTime)} · ${r.title}`}>
                    <div className="flex items-start gap-1">
                      <span className="flex-1 truncate text-[11px] font-semibold">{r.title}</span>
                      {r.holdsBooking && <Lock size={9} className="mt-[2px] shrink-0 opacity-70" />}
                    </div>
                    {/* Three to a column leaves no room for a second line,
                        and a clipped half-line is worse than none. */}
                    {tall && cols < 3 && (
                      <div className="mt-0.5 truncate text-[10px] opacity-85">
                        {shortTime(r.startTime)}–{shortTime(r.endTime)}
                        {r.assignedNames?.length ? ` · ${r.assignedNames.join(', ')}` : ''}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Month ──────────────────────────────────────────────────────────── */

function MonthGrid({ days, byDate, today, cursor, closedDays, onNew, onOpen }) {
  const month = asDate(cursor).getMonth();
  return (
    <div className="overflow-hidden rounded-2xl border"
      style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
      <div className="grid border-b" style={{ gridTemplateColumns: 'repeat(7, 1fr)', borderColor: 'var(--nl-rule)' }}>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
          <div key={d} className="min-w-0 py-2 text-center text-[9px] font-bold uppercase tracking-[0.12em]"
            style={{ color: 'var(--nl-muted)' }}>{d}</div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
        {days.map(d => {
          const dt = asDate(d);
          const out = dt.getMonth() !== month;
          const rows = byDate[d];
          const closure = rows.find(r => r.source === 'closure');
          const rest = rows.filter(r => r.source !== 'closure');
          const show = rest.slice(0, 3);
          return (
            <div key={d}
              className="min-w-0 min-h-[118px] border-l border-t p-1.5"
              style={{
                borderColor: 'var(--nl-hair)',
                background: closure ? 'var(--nl-brandw)' : out ? 'var(--nl-paper)' : undefined,
                ...(!closure && closedDays.has(d) ? SHUT : null),
              }}>
              <button type="button" onClick={() => onNew(d)}
                className="nl-display mb-1 flex h-[22px] w-[24px] items-center justify-center rounded-md text-[13px] font-semibold"
                style={d === today
                  ? { background: 'var(--nl-ink)', color: '#fff' }
                  : { color: out ? 'var(--nl-rule)' : 'var(--nl-ink2)' }}>
                {dt.getDate()}
              </button>
              {closure && (
                <div className="mb-1 rounded-md px-1.5 py-1 text-[9.5px] font-bold leading-tight"
                  style={{ color: 'var(--nl-brand)', background: 'rgba(255,255,255,.6)' }}>
                  <Lock size={8} className="mr-1 inline" />{closure.title}
                  <div className="font-medium opacity-85">{closure.note}</div>
                </div>
              )}
              {!closure && show.map(r => {
                const tone = toneFor(r);
                return (
                  <button key={r.id} type="button" onClick={() => onOpen(r)}
                    className="mb-0.5 flex w-full items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-left text-[10px]"
                    style={{ background: tone.wash, color: tone.color }}
                    title={r.title}>
                    <span className="inline-block h-[5px] w-[5px] shrink-0 rounded-full"
                      style={{ background: tone.color }} />
                    <span className="truncate">{r.title}</span>
                  </button>
                );
              })}
              {!closure && rest.length > show.length && (
                <div className="px-1.5 text-[9.5px] font-semibold" style={{ color: 'var(--nl-muted)' }}>
                  +{rest.length - show.length} more
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Composer ───────────────────────────────────────────────────────── */

function Composer({ draft, setDraft, staff, error, saving, onSave, onClose, onDelete, preview, run }) {
  const [peopleSearch, setPeopleSearch] = useState('');
  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  /* Type to filter, the same shape the Student Scheduler uses: empty
     query shows everyone, otherwise a plain substring match on the name.
     ANYONE ALREADY TICKED STAYS IN THE LIST whatever the query says —
     tick somebody, type, and watching them disappear reads as "it did not
     save". They keep their place rather than jumping to the top, so the
     list does not reshuffle under the cursor. */
  const query = peopleSearch.trim().toLowerCase();
  const matches = query
    ? staff.filter(u => String(u.displayName || '').toLowerCase().includes(query))
    : staff;
  const chosen = new Set(draft.assignedTo || []);
  const visiblePeople = query
    ? staff.filter(u => chosen.has(u.id) || matches.includes(u))
    : staff;

  const togglePerson = (u) => {
    const has = (draft.assignedTo || []).includes(u.id);
    set({
      assignedTo: has ? draft.assignedTo.filter(x => x !== u.id) : [...(draft.assignedTo || []), u.id],
      assignedNames: has
        ? (draft.assignedNames || []).filter(x => x !== u.displayName)
        : [...(draft.assignedNames || []), u.displayName],
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8">
      <div className="nl w-full max-w-lg rounded-2xl border p-5 shadow-xl"
        style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
        <div className="mb-4 flex items-center">
          <h2 className="nl-display text-[19px] font-semibold">
            {draft.id ? 'Edit entry' : 'New entry'}
          </h2>
          <button type="button" onClick={onClose} className="ml-auto p-1" aria-label="Close">
            <X size={17} style={{ color: 'var(--nl-muted)' }} />
          </button>
        </div>

        <Field label="What is it">
          <input value={draft.title} onChange={e => set({ title: e.target.value })}
            placeholder="Radius training" autoFocus
            className="w-full rounded-lg border px-3 py-2.5 text-[15px] font-semibold outline-none"
            style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }} />
        </Field>

        <Field label="Type">
          <div className="flex flex-wrap gap-1.5">
            {KIND_LIST.map(k => {
              const on = draft.kind === k.key;
              const tone = kindTone(k.key);
              return (
                <button key={k.key} type="button" onClick={() => set({ kind: k.key })}
                  className="rounded-full border px-3 py-1.5 text-[11.5px] font-medium"
                  style={on
                    ? { background: tone.color, borderColor: tone.color, color: '#fff', fontWeight: 600 }
                    : { borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
                  {kindLabel(k.key)}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="When">
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={draft.date} onChange={e => set({ date: e.target.value })}
              className="rounded-lg border px-3 py-2 text-[13.5px]"
              style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }} />
            {!draft.allDay && (
              <>
                <input type="time" value={draft.startTime || ''} onChange={e => set({ startTime: e.target.value })}
                  className="rounded-lg border px-3 py-2 text-[13.5px]"
                  style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }} />
                <span style={{ color: 'var(--nl-muted)' }}>→</span>
                <input type="time" value={draft.endTime || ''} onChange={e => set({ endTime: e.target.value })}
                  className="rounded-lg border px-3 py-2 text-[13.5px]"
                  style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }} />
              </>
            )}
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12.5px]">
              <input type="checkbox" checked={!!draft.allDay}
                onChange={e => set({ allDay: e.target.checked })} />
              All day
            </label>
          </div>
        </Field>

        <Field label="Repeats">
          {draft.seriesId ? (
            /* Already a series. Re-cutting the pattern of a live series
               means deciding what happens to occurrences people have
               already been told about, so it is not offered here. */
            <div className="rounded-lg border p-2.5 text-[12.5px]"
              style={{ borderColor: 'var(--nl-rule)' }}>
              <b>Part of a series</b> — {repeatLabel(draft.repeat).toLowerCase()}
              {draft.repeatUntil ? `, through ${fmtLong(draft.repeatUntil)}` : ''}.
              <p className="mt-1 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
                To change the pattern, delete this and all later ones, then make it again.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {REPEAT_LIST.map(r => {
                  const on = (draft.repeat || 'none') === r.id;
                  return (
                    <button key={r.id} type="button" onClick={() => set({ repeat: r.id })}
                      className="rounded-full border px-3 py-1.5 text-[11.5px] font-medium"
                      style={on
                        ? { background: 'var(--nl-ink)', borderColor: 'var(--nl-ink)', color: '#fff', fontWeight: 600 }
                        : { borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
                      {r.label}
                    </button>
                  );
                })}
              </div>
              {isRepeating(draft.repeat) && (
                <div className="mt-2.5 rounded-lg border p-2.5"
                  style={{ borderColor: 'var(--nl-rule)' }}>
                  <label className="flex flex-wrap items-center gap-2 text-[12.5px]">
                    <span style={{ color: 'var(--nl-muted)' }}>Until</span>
                    <input type="date" value={draft.repeatUntil || defaultUntil(draft.date)}
                      onChange={e => set({ repeatUntil: e.target.value })}
                      className="rounded-lg border px-2.5 py-1.5 text-[13px]"
                      style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }} />
                  </label>
                  <p className="mt-2 text-[12px]" style={{ color: 'var(--nl-ink2)' }}>
                    {describeSeries(run, draft.repeat, draft.repeatUntil)}
                  </p>
                  {draft.holdsBooking && (run?.dates?.length || 0) > 1 && (
                    <p className="mt-1 text-[11.5px] font-semibold" style={{ color: 'var(--nl-warn)' }}>
                      Every one of them holds the booking page.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </Field>

        <Field label="Who is on it">
          <input value={peopleSearch} onChange={e => setPeopleSearch(e.target.value)}
            placeholder="Search staff by name…" aria-label="Search staff by name"
            className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
            style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }} />
          <div className="mt-1.5 max-h-[132px] overflow-y-auto rounded-lg border p-1.5"
            style={{ borderColor: 'var(--nl-rule)' }}>
            {staff.length === 0 && (
              <p className="px-1.5 py-1 text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                Nobody to assign yet.
              </p>
            )}
            {visiblePeople.map(u => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px]">
                <input type="checkbox" checked={(draft.assignedTo || []).includes(u.id)}
                  onChange={() => togglePerson(u)} />
                {u.displayName}
              </label>
            ))}
          </div>
          {peopleSearch.trim() && matches.length === 0 && (
            <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--nl-warn)' }}>
              Nobody matches &ldquo;{peopleSearch.trim()}&rdquo;.
            </p>
          )}
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--nl-muted)' }}>
            Leaving it unassigned is fine — it still shows on the centre&rsquo;s calendar.
          </p>
        </Field>

        {/* The one with teeth. */}
        <div className="mt-3 rounded-xl border p-3.5"
          style={draft.holdsBooking
            ? { borderColor: 'var(--nl-ok)', background: 'var(--nl-okw)', borderWidth: 1.5 }
            : { borderColor: 'var(--nl-rule)' }}>
          <label className="flex cursor-pointer items-center gap-2.5">
            <input type="checkbox" checked={!!draft.holdsBooking}
              onChange={e => set({ holdsBooking: e.target.checked })} />
            <span className="text-[13.5px] font-semibold"
              style={draft.holdsBooking ? { color: 'var(--nl-ok)' } : undefined}>
              Hold the booking page while this runs
            </span>
          </label>
          {draft.holdsBooking && preview && (
            <div className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
              {preview.closure ? (
                <>The centre is already closed that day ({preview.closure.name}), so nothing is bookable anyway.</>
              ) : preview.blocked.length === 0 ? (
                <>Nothing to hold — the centre isn&rsquo;t taking assessments then.</>
              ) : (
                <>
                  Families will not be offered{' '}
                  <b>{preview.blocked.map(t => ampm(t)).join(', ')}</b>.
                  <div className="mt-1.5 border-t pt-1.5 text-[11.5px]"
                    style={{ borderColor: 'rgba(23,121,94,.22)', color: 'var(--nl-warn)' }}>
                    {preview.left.length === 0
                      ? 'That day will have no bookable times left.'
                      : `That day will have ${preview.left.length} bookable ${preview.left.length === 1 ? 'time' : 'times'} left.`}
                  </div>
                </>
              )}
              <div className="mt-1.5 text-[11px]" style={{ color: 'var(--nl-muted)' }}>
                It does <b>not</b> use up the day&rsquo;s assessment limit — only real assessments count against that.
              </div>
            </div>
          )}
        </div>

        <Field label="Note">
          <textarea value={draft.note || ''} onChange={e => set({ note: e.target.value })}
            rows={2} placeholder="Anything the others need to know"
            className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
            style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }} />
        </Field>

        {error && (
          <p className="mt-2 text-[12.5px] font-medium" style={{ color: 'var(--nl-brand)' }}>{error}</p>
        )}

        {draft.seriesId && (
          <Field label="Apply to">
            <div className="flex flex-wrap gap-1.5">
              {[['one', 'Just this one'], ['series', 'This and all later ones']].map(([id, label]) => {
                const on = (draft.scope || 'one') === id;
                return (
                  <button key={id} type="button" onClick={() => set({ scope: id })}
                    className="rounded-full border px-3 py-1.5 text-[11.5px] font-medium"
                    style={on
                      ? { background: 'var(--nl-brand)', borderColor: 'var(--nl-brand)', color: '#fff', fontWeight: 600 }
                      : { borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--nl-muted)' }}>
              {draft.scope === 'series'
                ? 'Saving and deleting both apply to every later one. The date stays each entry’s own — moving it here moves only this one.'
                : 'Saving and deleting apply to this entry alone.'}
            </p>
          </Field>
        )}

        <div className="mt-4 flex items-center gap-2 border-t pt-4" style={{ borderColor: 'var(--nl-rule)' }}>
          {onDelete && (
            <button type="button" onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] font-semibold"
              style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-brand)' }}>
              <Trash2 size={13} /> Delete
            </button>
          )}
          <button type="button" onClick={onClose}
            className="ml-auto rounded-lg border px-4 py-2 text-[12.5px] font-semibold"
            style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-60"
            style={{ background: 'var(--nl-brand)' }}>
            {saving && <Loader2 size={13} className="animate-spin" />}
            {draft.id ? 'Save changes' : 'Save entry'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="mt-3.5">
      <div className="mb-1.5 text-[9.5px] font-bold uppercase tracking-[0.13em]"
        style={{ color: 'var(--nl-muted)' }}>{label}</div>
      {children}
    </div>
  );
}
