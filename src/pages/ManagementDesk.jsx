import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection, onSnapshot, addDoc, updateDoc, doc, query, where, getDocs,
} from 'firebase/firestore';
import {
  StickyNote, Gift, Receipt, Users, Star, Plus, Search, Check,
  RotateCcw, X, Pencil, Send, ArrowRight,
} from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import { resolveRoles } from '../lib/roles';
import { staffTypeColorHex } from '../lib/centerConfig';
import {
  isOpen, initialsOf, deskMembers, canUseDesk, matchesQuery,
} from '../lib/deskNotes';
import { parseNote, canSend, addressLabel, firstNameOf } from '../lib/deskParse';
import { suggestStudents } from '../lib/deskLink';
import { rowMatches, parseAmount } from '../lib/deskTrackers';
import { TRACKER_LIST, TRACKERS } from '../lib/deskConfig';
import DeskImport from '../components/DeskImport';

/**
 * The Management Desk — what used to be a shared spreadsheet called
 * "Management Team Post It Notes".
 *
 * Nine tabs went in; five come out. Time off and sick days are already in
 * Ratio, follow-ups and parking plates were dead, and "Settled Notes" was
 * never a separate thing — it was the same notes with Closed typed in a
 * column, so here it is a filter.
 *
 * WHAT THE SPREADSHEET COULD NOT DO
 *   Answer "what is waiting on ME". 121 live rows and 1,732 settled ones,
 *   and finding your own initials meant reading the sheet. That question
 *   is the first thing on this page and the only reason for the badge in
 *   the sidebar.
 *
 * ONE LIST COMPONENT, FOUR TRACKERS
 *   Gift cards, receipts, referrals and student of the month are the same
 *   shape — rows, a few done/not-done flags, one thing worth seeing at a
 *   glance. They are described in deskConfig.js and rendered by the same
 *   table, so a fix to one is a fix to all four.
 */

const TAB_ICON = {
  notes: StickyNote,
  giftCards: Gift,
  receipts: Receipt,
  referrals: Users,
  studentOfMonth: Star,
};

const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** "1 Sep 2026" from an ISO date. Local-noon so the day never slips. */
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return new Date(y, m - 1, d, 12).toLocaleDateString('en-CA', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export default function ManagementDesk() {
  const { profile, activeCenterId, centerConfig, permissions, canSeeCenterSettings,
    myInstructorType } = useAuth();
  const [tab, setTab] = useState('notes');
  const allowed = canUseDesk({
    platformRole: profile?.role, instructorType: myInstructorType, permissions,
  });

  if (!allowed) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border bg-white p-6 text-center">
        <StickyNote size={22} className="mx-auto mb-2 text-gray-300" />
        <p className="text-sm text-gray-600">
          The Management Desk is for the management team. If you need access,
          ask an owner to grant it from Manage Roles.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl pb-24 lg:pb-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Management Desk</h1>
        <p className="mt-1 text-sm text-gray-500">
          Notes between the team, and the trackers that used to live beside them.
        </p>
      </div>

      {/* Tabs scroll sideways on a phone rather than wrapping into a
          second row that pushes the content off screen. */}
      <div className="-mx-1 mb-4 flex gap-1 overflow-x-auto pb-1">
        {[{ key: 'notes', title: 'Notes' }, ...TRACKER_LIST].map(t => {
          const Icon = TAB_ICON[t.key] || StickyNote;
          const on = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                on ? 'bg-red-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>
              <Icon size={14} /> {t.title}
            </button>
          );
        })}
      </div>

      {tab === 'notes'
        ? <NotesTab profile={profile} centerId={activeCenterId} centerConfig={centerConfig}
            canImport={canSeeCenterSettings} />
        : <TrackerTab key={tab} spec={TRACKERS[tab]} centerId={activeCenterId} profile={profile} />}
    </div>
  );
}

// ─── Notes: the chain ─────────────────────────────────────────────────────

/**
 * The chain.
 *
 * It reads like a text thread because that is what it already was: of the
 * 1,750 notes brought over, 76% have at least one reply and 55% are under
 * 200 characters. People were texting each other through a spreadsheet.
 *
 * BUT IT BEHAVES LIKE A LIST, and that is the whole design.
 * 98.9% of those notes end up SETTLED. A group chat has no idea what
 * settled means — things scroll away and nobody finds out for three weeks
 * that the care call never happened. Ratio already has a team chat; the
 * post-its existed beside it precisely because a chat could not hold a
 * state. So every message addressed to somebody carries one, wears a rail
 * until it is cleared, and counts in a filter.
 */
/**
 * Open, Settled, and yours — the spreadsheet's own shape.
 *
 * "General" and "Settled Notes" were its two tabs, and General was never
 * everybody's notes, it was everybody's LIVE notes. Opening on Open is
 * therefore the habit the team already has, and it happens to be the
 * cheaper default too: the settled archive is 1,730 of the 1,750 rows, and
 * this way it is never fetched until somebody presses Settled or searches.
 *
 * There is no separate "everyone" view because there was never a question
 * it answered — Open already is everyone's.
 */
const VIEWS = [
  { key: 'open', label: 'Open' },
  { key: 'done', label: 'Settled' },
];

function NotesTab({ profile, centerId, centerConfig, canImport }) {
  const [open, setOpen] = useState(null);        // open notes, live
  const [archive, setArchive] = useState(null);  // settled, fetched on demand
  const [people, setPeople] = useState([]);
  const [students, setStudents] = useState([]);
  const [view, setView] = useState('open');
  const [q, setQ] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const uid = profile?.uid;

  useEffect(() => {
    if (!centerId) return undefined;
    return onSnapshot(
      query(collection(db, 'centers', centerId, 'notes'), where('status', '==', 'open')),
      snap => setOpen(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setOpen([]),
    );
  }, [centerId]);

  // The settled archive is 1,730 of the 1,750. Fetched once, and only when
  // somebody asks for it — by opening Settled, or by searching, which has
  // to reach the history because looking things up in it is the reason it
  // was imported.
  const wantsArchive = view === 'done' || q.trim().length > 0;
  const fetchedFor = useRef(null);
  useEffect(() => {
    if (!wantsArchive || !centerId || fetchedFor.current === centerId) return undefined;
    fetchedFor.current = centerId;
    let gone = false;
    getDocs(query(collection(db, 'centers', centerId, 'notes'), where('status', '==', 'closed')))
      .then(snap => { if (!gone) setArchive(snap.docs.map(d => ({ id: d.id, ...d.data() }))); })
      .catch(() => { if (!gone) setArchive([]); });
    return () => { gone = true; };
  }, [wantsArchive, centerId]);

  useEffect(() => {
    if (!centerId) return undefined;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', centerId)),
      snap => setPeople(snap.docs.map(d => ({ uid: d.id, ...d.data() }))),
      () => setPeople([]),
    );
  }, [centerId]);

  // Students, for "who is this about". A separate roster from the staff one
  // ON PURPOSE: a lot of the volunteers are also students here, so a single
  // pool would let a teenage volunteer be read as a manager.
  useEffect(() => {
    if (!centerId) return undefined;
    return onSnapshot(
      collection(db, 'centers', centerId, 'schedulerStudents'),
      snap => setStudents(snap.docs.map(d => d.data()?.name).filter(Boolean)),
      () => setStudents([]),
    );
  }, [centerId]);

  const centreRoles = useMemo(
    () => resolveRoles(centerConfig, (name) => staffTypeColorHex(name, centerConfig)),
    [centerConfig],
  );
  const members = useMemo(
    () => deskMembers(people, centerId, centreRoles), [people, centerId, centreRoles]);
  const nameByUid = useMemo(
    () => Object.fromEntries(members.map(m => [m.uid, m.displayName || m.email || 'Someone'])),
    [members]);

  const parsed = useMemo(
    () => parseNote(text, { staff: members, students }), [text, members, students]);

  const all = useMemo(() => [...(open || []), ...(archive || [])], [open, archive]);

  // A note to the whole team is in everybody's list — that is what
  // addressing it to everyone means.
  const forMe = (n) => !!n.toAll || (n.toUids || []).includes(uid);

  const rows = useMemo(() => {
    const kept = all.filter(n => matchesQuery(n, q)).filter(n =>
      view === 'mine' ? (forMe(n) && isOpen(n))
      : view === 'done' ? !isOpen(n)
      : isOpen(n));
    // Oldest first: a chain reads downwards, and the composer is at the end.
    return kept.sort((a, b) =>
      String(a.createdAt || a.loggedAt || '').localeCompare(String(b.createdAt || b.loggedAt || '')));
  }, [all, view, q, uid]);        // eslint-disable-line react-hooks/exhaustive-deps

  // Searching from Open would otherwise hide the answer: the thing you are
  // looking up is usually SETTLED — that is what settled means. Rather than
  // quietly widening the view (which would contradict the chip that says
  // "Open"), say how many are through there and offer the one click.
  const hiddenSettled = useMemo(() => {
    if (!q.trim() || view === 'done') return 0;
    return (archive || []).filter(n => matchesQuery(n, q)).length;
  }, [archive, q, view]);

  const counts = useMemo(() => ({
    mine: (open || []).filter(forMe).length,
    open: (open || []).length,
    // Unknown until the archive has been fetched, and it is not fetched
    // until somebody asks. A count nobody needed is not worth 1,730 reads.
    done: archive ? archive.length : null,
  }), [open, archive, uid]);  // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!canSend(parsed) || sending) return;
    setSending(true);
    try {
      await addDoc(collection(db, 'centers', centerId, 'notes'), {
        toUids: parsed.toUids,
        toLabel: addressLabel(parsed),
        toAll: parsed.toAll,
        unknownCodes: parsed.unknownCodes,
        fromUid: uid,
        fromName: profile?.displayName || profile?.email || 'Someone',
        fromInitials: initialsOf(profile?.displayName),
        // The chain has no separate subject line. Who it is about is the
        // subject when there is one; otherwise the note speaks for itself.
        subject: parsed.about || parsed.body.slice(0, 60),
        about: parsed.about || null,
        family: parsed.family,
        topic: parsed.topic,
        labels: parsed.labels,
        body: parsed.body,
        loggedAt: todayISO(),
        createdAt: new Date().toISOString(),
        status: 'open',
        replies: [],
      });
      setText('');
    } catch (e) {
      toast.error(e?.message || 'Could not send that.');
    } finally {
      setSending(false);
    }
  };

  const reply = async (note, body) => {
    if (!body.trim()) return;
    const next = [...(note.replies || []), {
      uid,
      name: profile?.displayName || 'Someone',
      initials: initialsOf(profile?.displayName),
      text: body.trim(),
      at: new Date().toISOString(),
    }];
    await updateDoc(doc(db, 'centers', centerId, 'notes', note.id), { replies: next });
  };

  /**
   * Who a note is about, set by hand.
   *
   * The archive links 21% of notes to a student on its own and names
   * another 23%; the rest are topics, or a parent spelled a way nothing
   * recognises. Twenty open notes can be tidied in a couple of minutes,
   * and every automatic guess needs a way to be corrected anyway.
   */
  const setAbout = async (note, name, linked) => {
    await updateDoc(doc(db, 'centers', centerId, 'notes', note.id), {
      about: name || null,
      aboutLinked: !!linked,
      aboutHow: name ? 'by-hand' : 'none',
    });
  };

  const setStatus = async (note, status) => {
    await updateDoc(doc(db, 'centers', centerId, 'notes', note.id), {
      status,
      settledAt: status === 'closed' ? new Date().toISOString() : null,
      settledByName: status === 'closed' ? (profile?.displayName || 'Someone') : null,
    });
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {VIEWS.map(v => (
          <Chip key={v.key} on={view === v.key} onClick={() => setView(v.key)}
            label={v.label} n={counts[v.key]} />
        ))}
        {/* "For me" sits apart from the two that describe the whole board,
            because it asks a different question: not what is live, but
            what is live AND waiting on you. */}
        <span className="flex-1" />
        <Chip on={view === 'mine'} onClick={() => setView('mine')}
          label="For me" n={counts.mine} accent />
        <SearchBox value={q} onChange={setQ} />
      </div>

      {hiddenSettled > 0 && (
        <button onClick={() => setView('done')}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 bg-white px-3 py-2 text-[13px] font-semibold text-gray-600 hover:bg-gray-50">
          {hiddenSettled} more {hiddenSettled === 1 ? 'match' : 'matches'} in Settled
          <ArrowRight size={13} />
        </button>
      )}

      {open === null ? (
        <p className="py-10 text-center text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 py-12 text-center">
          <Check size={26} className="mx-auto mb-2 text-gray-300" />
          <p className="text-sm font-medium text-gray-500">
            {q ? 'Nothing matches that.'
              : view === 'mine' ? 'Nothing is waiting on you.'
              : view === 'done' ? 'Nothing settled yet.'
              : 'Nothing open. Everything has been dealt with.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {rows.map(n => (
            <Msg key={n.id} note={n} uid={uid} nameByUid={nameByUid}
              students={students} onReply={reply} onStatus={setStatus}
              onSetAbout={setAbout} />
          ))}
        </div>
      )}

      <Composer text={text} setText={setText} parsed={parsed} onSend={send}
        sending={sending} me={profile?.displayName} />

      {canImport && (
        <DeskImport centerId={centerId} members={members} students={students}
          existingCount={all.length} />
      )}
    </div>
  );
}

/** Who a note is for, whatever shape it arrived in. */
function toLine(note, nameByUid) {
  if (note.toAll) return 'Everyone';
  const named = (note.toUids || []).map(u => nameByUid[u]).filter(Boolean).map(firstNameOf);
  const codes = note.unknownCodes || [];
  const words = [...named, ...codes];
  if (words.length) return words.join(', ');
  return note.toLabel || 'Unassigned';
}

function Msg({ note, uid, nameByUid, students, onReply, onStatus, onSetAbout }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const live = isOpen(note);
  const mine = live && (note.toAll || (note.toUids || []).includes(uid));
  const replies = note.replies || [];
  const labels = note.labels || [];

  const send = async () => {
    setBusy(true);
    try { await onReply(note, draft); setDraft(''); }
    catch (e) { toast.error(e?.message || 'Could not add that reply.'); }
    finally { setBusy(false); }
  };

  // The rail is the piece of state a chat normally loses: red when it is
  // yours to clear, amber when it is somebody else's, gone once settled.
  const rail = !live ? 'border-l-gray-200'
    : mine ? 'border-l-red-500' : 'border-l-amber-400';

  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-gray-100 text-[11px] font-bold text-gray-600">
        {note.fromInitials || initialsOf(note.fromName) || '—'}
      </span>
      <div className={`min-w-0 flex-1 rounded-r-xl rounded-bl-xl border border-l-[3px] p-3 ${rail} ${
        live ? 'bg-white' : 'border-dashed bg-gray-50/70'}`}>
        <div className="flex flex-wrap items-baseline gap-1.5 text-xs text-gray-500">
          <b className="text-[13.5px] text-gray-900">{firstNameOf(note.fromName) || note.fromInitials || '—'}</b>
          <ArrowRight size={11} className="text-gray-400" />
          <b className="text-[13.5px] text-gray-900">{toLine(note, nameByUid)}</b>
          <span className="ml-auto whitespace-nowrap text-[11.5px]">{fmtDate(note.loggedAt)}</span>
        </div>

        <p className={`mt-1 whitespace-pre-line text-[14.5px] leading-relaxed ${
          live ? 'text-gray-700' : 'text-gray-500'}`}>{note.body}</p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {note.about ? (
              <button onClick={() => setEditing(true)} title="Change who this is about"
                className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${
                  note.aboutLinked
                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    : 'border border-dashed border-emerald-300 text-emerald-700 hover:bg-emerald-50'}`}>
                {note.about}{note.family ? ' · family' : ''}
              </button>
            ) : (
              /* The whole point of the ask: an old note that names nobody
                 can be given a name in one click. */
              <button onClick={() => setEditing(true)}
                className="rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-[11.5px] font-medium text-gray-400 hover:border-gray-400 hover:text-gray-600">
                + who's this about?
              </button>
            )}
            {note.topic && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11.5px] font-semibold text-red-700">
                {note.topic}
              </span>
            )}
            {labels.map(l => (
              <span key={l} className="rounded-full border bg-gray-50 px-2 py-0.5 text-[11.5px] font-medium text-gray-500">
                {l}
              </span>
            ))}
        </div>

        {editing && (
          <AboutPicker note={note} students={students}
            onPick={(name, linked) => { onSetAbout(note, name, linked); setEditing(false); }}
            onCancel={() => setEditing(false)} />
        )}

        {replies.length > 0 && (
          <div className="mt-2.5 space-y-1.5 border-t border-dashed pt-2">
            {replies.map((r, i) => (
              <p key={`${r.at}-${i}`} className="text-[13.5px] leading-relaxed text-gray-700">
                <b className="mr-1.5 text-[12px] font-bold text-gray-500">
                  {firstNameOf(r.name) || r.initials || 'Someone'}
                </b>
                {r.text}
              </p>
            ))}
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <span className={`text-[11px] font-bold uppercase tracking-wide ${
            live ? 'text-amber-600' : 'text-emerald-700'}`}>
            {live ? 'Open' : '✓ Settled'}
          </span>
          {live ? (
            <button onClick={() => onStatus(note, 'closed')}
              className="rounded-lg border border-emerald-600 bg-emerald-50 px-3 py-1.5 text-[12.5px] font-bold text-emerald-700 hover:bg-emerald-100">
              Mark done
            </button>
          ) : (
            <button onClick={() => onStatus(note, 'open')}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-[12.5px] font-semibold text-gray-600 hover:bg-gray-100">
              <RotateCcw size={12} /> Reopen
            </button>
          )}
          {!live && note.settledByName && (
            <span className="text-[11px] text-gray-400">by {firstNameOf(note.settledByName)}</span>
          )}
        </div>

        <div className="mt-2 flex gap-1.5">
          <input value={draft} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && draft.trim()) send(); }}
            placeholder="Reply…"
            className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[13px] focus:border-red-400 focus:outline-none" />
          {draft.trim() && (
            <button onClick={send} disabled={busy} title="Send reply"
              className="shrink-0 rounded-lg px-2 text-red-600 hover:bg-red-50 disabled:opacity-50">
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Who is this about?
 *
 * It offers the student list, because a linked name spells the same way
 * every time and groups every note about that child together. But it also
 * takes whatever is typed: a third of the archive is about a PARENT, and
 * Ratio holds no parent list — refusing the name because there is no
 * record to point at would throw away the thing worth keeping.
 */
function AboutPicker({ note, students, onPick, onCancel }) {
  const [q, setQ] = useState(note.about || '');
  const hits = useMemo(() => suggestStudents(q, students), [q, students]);
  const exact = students.includes(q.trim());

  return (
    <div className="mt-2 rounded-lg border bg-gray-50 p-2.5">
      <input value={q} onChange={e => setQ(e.target.value)} autoFocus
        placeholder="Student, parent, or account name…"
        onKeyDown={e => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && q.trim()) onPick(q.trim(), exact);
        }}
        className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-[13px] focus:border-red-400 focus:outline-none" />

      {hits.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {hits.map(n => (
            <button key={n} onClick={() => onPick(n, true)}
              className="rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-semibold text-emerald-700 hover:bg-emerald-100">
              {n}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {q.trim() && !exact && (
          <button onClick={() => onPick(q.trim(), false)}
            className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-[12px] font-semibold text-gray-600 hover:bg-gray-100">
            Use “{q.trim()}”
          </button>
        )}
        {note.about && (
          <button onClick={() => onPick(null, false)}
            className="text-[12px] font-semibold text-gray-400 hover:text-gray-600">Clear</button>
        )}
        <button onClick={onCancel}
          className="ml-auto text-[12px] font-semibold text-gray-400 hover:text-gray-600">Cancel</button>
      </div>
      {!note.aboutLinked && note.about && (
        <p className="mt-1.5 text-[11px] text-gray-400">
          Not linked to a student record — Ratio holds no parent list, so this is the name as written.
        </p>
      )}
    </div>
  );
}

/**
 * The composer.
 *
 * It shows what it understood BEFORE anything is sent, because a wrong
 * guess you do not notice is worse than a form you had to fill in.
 */
function Composer({ text, setText, parsed, onSend, sending, me }) {
  const ready = canSend(parsed);
  const who = addressLabel(parsed);

  return (
    <div className="sticky bottom-0 mt-4 bg-gradient-to-b from-transparent via-gray-50 to-gray-50 pb-2 pt-3">
      <div className="overflow-hidden rounded-2xl border-[1.5px] border-gray-300 bg-white shadow-sm focus-within:border-red-500">
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
          onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSend(); } }}
          placeholder="NG, can you please complete a care call for…"
          className="w-full resize-none px-4 py-3 text-[15.5px] leading-relaxed focus:outline-none" />

        <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 border-t border-dashed bg-gray-50 px-3 py-2">
          {!text.trim() ? (
            <span className="text-[12.5px] text-gray-500">
              Start with initials — <b>NG</b>, <b>VB/NG</b>, or <b>Everyone</b>.
            </span>
          ) : (
            <>
              <span className="text-[13px] font-bold text-blue-800">
                {firstNameOf(me) || 'You'} → {who || 'who?'}
              </span>
              {parsed.about && (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-700">
                  {parsed.about}{parsed.family ? ' · family' : ''}
                </span>
              )}
              {parsed.nearMiss && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold text-amber-700">
                  {parsed.nearMiss.typed} — did you mean {parsed.nearMiss.suggestion}?
                </span>
              )}
              {parsed.unknownCodes.map(c => (
                <span key={c} className="rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-semibold text-amber-700">
                  {c} — no Ratio account yet
                </span>
              ))}
              {parsed.topic && (
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11.5px] font-semibold text-red-700">
                  {parsed.topic}
                </span>
              )}
              {parsed.labels.map(l => (
                <span key={l} className="rounded-full border bg-white px-2 py-0.5 text-[11.5px] font-medium text-gray-500">
                  {l}
                </span>
              ))}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <button onClick={onSend} disabled={!ready || sending}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-40">
            {sending ? 'Sending…' : 'Send'}
          </button>
          <span className="text-[11px] text-gray-400">⌘↵ to send</span>
        </div>
      </div>
    </div>
  );
}

// ─── Trackers ─────────────────────────────────────────────────────────────

function TrackerTab({ spec, centerId }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('outstanding');
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (!centerId) return undefined;
    return onSnapshot(
      collection(db, 'centers', centerId, spec.collection),
      snap => setRows(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setRows([]),
    );
  }, [centerId, spec.collection]);

  const visible = useMemo(() => {
    const all = (rows || [])
      .filter(r => rowMatches(spec.searchFields(r), q))
      .filter(r => (only === 'all' ? true
        : only === 'outstanding' ? spec.isOutstanding(r)
        : !spec.isOutstanding(r)));
    return all.sort((a, b) => String(spec.sortKey(b)).localeCompare(String(spec.sortKey(a))));
  }, [rows, q, only, spec]);

  const outstandingCount = useMemo(
    () => (rows || []).filter(spec.isOutstanding).length, [rows, spec]);

  const save = async () => {
    const problem = spec.validate(draft);
    if (problem) { setDraft(d => ({ ...d, _error: problem })); return; }
    const body = {};
    for (const f of spec.fields) body[f.id] = draft[f.id] ?? null;
    try {
      if (draft.id) {
        await updateDoc(doc(db, 'centers', centerId, spec.collection, draft.id), body);
        toast.success('Saved.');
      } else {
        await addDoc(collection(db, 'centers', centerId, spec.collection), {
          ...body, createdAt: new Date().toISOString(),
        });
        toast.success('Added.');
      }
      setDraft(null);
    } catch (e) {
      setDraft(d => ({ ...d, _error: e?.message || 'Could not save that.' }));
    }
  };

  /** A checkbox in the table writes straight through — no edit round trip. */
  const toggleField = async (row, fieldId) => {
    try {
      await updateDoc(doc(db, 'centers', centerId, spec.collection, row.id),
        { [fieldId]: !row[fieldId] });
    } catch (e) { toast.error(e?.message || 'Could not update that.'); }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-1 flex-wrap gap-1">
          {[
            { k: 'outstanding', label: spec.outstandingLabel, n: outstandingCount },
            { k: 'done', label: spec.doneLabel },
            { k: 'all', label: 'Everything' },
          ].map(f => (
            <button key={f.k} onClick={() => setOnly(f.k)}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                only === f.k ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {f.label}
              {f.n > 0 && (
                <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] ${
                  only === f.k ? 'bg-white/25' : 'bg-red-600 text-white'}`}>{f.n}</span>
              )}
            </button>
          ))}
        </div>
        <SearchBox value={q} onChange={setQ} />
        {!draft && (
          <button onClick={() => setDraft({ ...spec.blank })}
            className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-red-700">
            <Plus size={15} /> Add
          </button>
        )}
      </div>

      {draft && (
        <RowForm spec={spec} draft={draft} setDraft={setDraft} onSave={save}
          onCancel={() => setDraft(null)} />
      )}

      {rows === null ? (
        <p className="py-10 text-center text-sm text-gray-500">Loading…</p>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 py-12 text-center">
          <Check size={26} className="mx-auto mb-2 text-gray-300" />
          <p className="text-sm font-medium text-gray-500">
            {q ? 'Nothing matches that.'
              : only === 'outstanding' ? `Nothing ${spec.outstandingLabel.toLowerCase()}.`
              : 'Nothing here yet.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left">
                {spec.columns.map(c => (
                  <th key={c.id} className={`px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-500 ${c.numeric ? 'text-right' : ''}`}>
                    {c.label}
                  </th>
                ))}
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.id} className={i > 0 ? 'border-t' : ''}>
                  {spec.columns.map(c => (
                    <td key={c.id} className={`px-3 py-2.5 ${c.numeric ? 'text-right tabular-nums' : ''} ${c.strong ? 'font-semibold text-gray-900' : 'text-gray-600'} ${c.wide ? 'min-w-[220px]' : ''}`}>
                      <Cell row={r} col={c} onToggle={() => toggleField(r, c.id)} />
                    </td>
                  ))}
                  <td className="px-2">
                    <button onClick={() => setDraft({ ...spec.blank, ...r })} title="Edit"
                      className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                      <Pencil size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * One cell.
 *
 * A boolean renders as a real checkbox that writes on click. Ticking
 * "prize collected" is the single commonest thing anyone does on these
 * tabs, and making that a three-step edit is how a tracker stops being
 * kept up to date.
 */
function Cell({ row, col, onToggle }) {
  if (col.type === 'bool') {
    return (
      <button onClick={onToggle} title={col.label}
        className={`flex h-6 w-6 items-center justify-center rounded border transition-colors ${
          row[col.id] ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-gray-300 bg-white hover:border-gray-400'}`}>
        {row[col.id] && <Check size={13} />}
      </button>
    );
  }
  const value = col.render ? col.render(row) : row[col.id];
  if (col.type === 'date') {
    return value ? <span>{fmtDate(value)}</span>
      : <span className="text-gray-300">{col.empty || '—'}</span>;
  }
  return value ? <span>{value}</span> : <span className="text-gray-300">—</span>;
}

function RowForm({ spec, draft, setDraft, onSave, onCancel }) {
  const set = (id, v) => setDraft(d => ({ ...d, [id]: v, _error: '' }));
  return (
    <div className="mb-4 rounded-xl border border-gray-300 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-gray-900">
          {draft.id ? 'Edit' : 'Add'} — {spec.title.replace(/s$/, '')}
        </h2>
        <button onClick={onCancel} className="rounded p-1 text-gray-400 hover:bg-gray-100"><X size={16} /></button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {spec.fields.map(f => (
          <label key={f.id} className={f.span === 2 ? 'sm:col-span-2' : ''}>
            <span className="mb-1 block text-xs font-semibold text-gray-600">
              {f.label}{f.hint && <span className="font-normal text-gray-400"> — {f.hint}</span>}
            </span>
            {f.type === 'bool' ? (
              <button type="button" onClick={() => set(f.id, !draft[f.id])}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium ${
                  draft[f.id] ? 'border-emerald-600 bg-emerald-50 text-emerald-700' : 'border-gray-300 text-gray-500'}`}>
                <span className={`flex h-4 w-4 items-center justify-center rounded border ${
                  draft[f.id] ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-gray-300'}`}>
                  {draft[f.id] && <Check size={11} />}
                </span>
                {draft[f.id] ? 'Yes' : 'No'}
              </button>
            ) : f.type === 'select' ? (
              <select value={draft[f.id] ?? ''} onChange={e => set(f.id, e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none">
                {f.options.map(o => (
                  <option key={o} value={o}>{f.render ? f.render(o) : o}</option>
                ))}
              </select>
            ) : f.type === 'money' ? (
              <input inputMode="decimal" value={draft[f.id] ?? ''}
                onChange={e => set(f.id, parseAmount(e.target.value))}
                placeholder="15.00"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
            ) : (
              <input type={f.type === 'date' ? 'date' : f.type === 'month' ? 'month' : 'text'}
                value={draft[f.id] ?? ''} autoFocus={f.autoFocus}
                onChange={e => set(f.id, e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
            )}
          </label>
        ))}
      </div>

      {draft._error && <p className="mt-2 text-sm font-semibold text-red-600">{draft._error}</p>}

      <div className="mt-3 flex gap-2">
        <button onClick={onSave}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700">
          {draft.id ? 'Save changes' : 'Add it'}
        </button>
        <button onClick={onCancel}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Chip({ on, onClick, label, n, accent }) {
  return (
    <button onClick={onClick}
      className={`shrink-0 rounded-full px-3 py-1.5 text-[13px] font-semibold transition-colors ${
        on ? 'bg-gray-900 text-white'
        : accent && n > 0 ? 'bg-red-50 text-red-700 hover:bg-red-100'
        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
      {label}
      {n > 0 && (
        <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] ${
          on ? 'bg-white/25' : 'bg-red-600 text-white'}`}>{n}</span>
      )}
    </button>
  );
}

function SearchBox({ value, onChange }) {
  return (
    <div className="flex w-full items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-2 focus-within:border-red-400 sm:w-52">
      <Search size={14} className="shrink-0 text-gray-400" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder="Search…"
        className="w-full text-[13px] focus:outline-none" />
      {value && (
        <button onClick={() => onChange('')} className="shrink-0 text-gray-400 hover:text-gray-600">
          <X size={13} />
        </button>
      )}
    </div>
  );
}
