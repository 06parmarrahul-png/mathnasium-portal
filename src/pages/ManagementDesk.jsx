import { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection, onSnapshot, addDoc, updateDoc, doc, query, where, getDocs,
} from 'firebase/firestore';
import {
  StickyNote, Gift, Receipt, Users, Star, Plus, Search, Check,
  CornerDownRight, RotateCcw, X, Pencil, Send,
} from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import { resolveRoles } from '../lib/roles';
import { staffTypeColorHex } from '../lib/centerConfig';
import {
  NOTE_VIEWS, filterNotes, myOpenCount, validateNote, recipientNames,
  isOpen, initialsOf, deskMembers, canUseDesk,
} from '../lib/deskNotes';
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

// ─── Notes ────────────────────────────────────────────────────────────────

function NotesTab({ profile, centerId, centerConfig, canImport }) {
  const [notes, setNotes] = useState(null);        // open notes, live
  const [archive, setArchive] = useState(null);    // settled, fetched on demand
  const [people, setPeople] = useState([]);
  const [view, setView] = useState('mine');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState(null);
  const uid = profile?.uid;

  // ── What gets loaded, and when ──────────────────────────────────────
  //
  // 1,730 of the 1,750 notes are settled. Reading all of them on every
  // visit would be a megabyte of history to answer a question about
  // twenty live notes, so the live subscription is OPEN notes only.
  //
  // The archive is fetched once, and only when somebody actually asks for
  // it: opening Settled, or typing in the search box. Searching the
  // history is the reason it was imported, so a search has to reach it —
  // but it does not have to be paid for by everyone who opens the page.
  useEffect(() => {
    if (!centerId) return undefined;
    return onSnapshot(
      query(collection(db, 'centers', centerId, 'notes'), where('status', '==', 'open')),
      snap => setNotes(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setNotes([]),
    );
  }, [centerId]);

  // Fetched once per centre. The "have we started" flag is a REF, not
  // state, and not the archive itself: setting state the effect depends on
  // re-runs it, which tears down the in-flight fetch through its own
  // cleanup and drops the result on the floor. The archive then never
  // arrives and Settled stays permanently empty. (It did. A render test
  // caught it.)
  const wantsArchive = view === 'closed' || q.trim().length > 0;
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

  const centreRoles = useMemo(
    () => resolveRoles(centerConfig, (name) => staffTypeColorHex(name, centerConfig)),
    [centerConfig],
  );

  useEffect(() => {
    if (!centerId) return undefined;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', centerId)),
      snap => setPeople(snap.docs.map(d => ({ uid: d.id, ...d.data() }))),
      () => setPeople([]),
    );
  }, [centerId]);

  const members = useMemo(
    () => deskMembers(people, centerId, centreRoles), [people, centerId, centreRoles]);
  const nameByUid = useMemo(
    () => Object.fromEntries(members.map(m => [m.uid, m.displayName || m.email || 'Someone'])),
    [members]);

  const everything = useMemo(
    () => [...(notes || []), ...(archive || [])], [notes, archive]);
  const rows = useMemo(
    () => filterNotes(everything, { view, uid, q }), [everything, view, uid, q]);
  const mineCount = useMemo(() => myOpenCount(notes || [], uid), [notes, uid]);

  const save = async () => {
    const problem = validateNote(draft);
    if (problem) { setDraft(d => ({ ...d, error: problem })); return; }
    try {
      await addDoc(collection(db, 'centers', centerId, 'notes'), {
        toUids: draft.toAll ? [] : draft.toUids,
        toLabel: draft.toAll ? 'Everyone'
          : draft.toUids.map(u => initialsOf(nameByUid[u])).join('/'),
        toAll: !!draft.toAll,
        fromUid: uid,
        fromName: profile?.displayName || profile?.email || 'Someone',
        fromInitials: initialsOf(profile?.displayName),
        subject: draft.subject.trim(),
        body: draft.body.trim(),
        loggedAt: draft.loggedAt,
        createdAt: new Date().toISOString(),
        status: 'open',
        replies: [],
      });
      setDraft(null);
      toast.success('Note posted.');
    } catch (e) {
      setDraft(d => ({ ...d, error: e?.message || 'Could not post that.' }));
    }
  };

  const reply = async (note, text) => {
    if (!text.trim()) return;
    // Read-modify-write rather than arrayUnion: two people replying at the
    // same second is not a thing that happens on a note addressed to one
    // of them, and this keeps the shape of the array under our control.
    const next = [...(note.replies || []), {
      uid,
      name: profile?.displayName || 'Someone',
      initials: initialsOf(profile?.displayName),
      text: text.trim(),
      at: new Date().toISOString(),
    }];
    await updateDoc(doc(db, 'centers', centerId, 'notes', note.id), { replies: next });
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
        <div className="flex flex-1 flex-wrap gap-1">
          {Object.values(NOTE_VIEWS).map(v => (
            <button key={v.key} onClick={() => setView(v.key)}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors ${
                view === v.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {v.label}
              {v.key === 'mine' && mineCount > 0 && (
                <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] ${
                  view === 'mine' ? 'bg-white/25' : 'bg-red-600 text-white'}`}>{mineCount}</span>
              )}
            </button>
          ))}
        </div>
        <SearchBox value={q} onChange={setQ} />
        {!draft && (
          <button onClick={() => setDraft({ toUids: [], toAll: false, subject: '', body: '', loggedAt: todayISO() })}
            className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-red-700">
            <Plus size={15} /> New note
          </button>
        )}
      </div>

      {draft && (
        <Compose draft={draft} setDraft={setDraft} members={members} onSave={save}
          onCancel={() => setDraft(null)} />
      )}

      {notes === null ? (
        <p className="py-10 text-center text-sm text-gray-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyNotes view={view} q={q} />
      ) : (
        <div className="space-y-3">
          {rows.map(n => (
            <NoteCard key={n.id} note={n} uid={uid} nameByUid={nameByUid}
              onReply={reply} onStatus={setStatus} />
          ))}
        </div>
      )}

      {/* Owner-tier only. It writes about 1,900 documents, which is not a
          thing to leave on a button every manager can reach. */}
      {canImport && (
        <DeskImport centerId={centerId} members={members}
          existingCount={everything.length} />
      )}
    </div>
  );
}

function EmptyNotes({ view, q }) {
  const msg = q
    ? 'Nothing matches that.'
    : view === 'mine' ? 'Nothing is waiting on you. '
    : view === 'sent' ? 'You haven’t posted a note yet.'
    : view === 'closed' ? 'Nothing settled yet.'
    : 'No open notes.';
  return (
    <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 py-12 text-center">
      <Check size={26} className="mx-auto mb-2 text-gray-300" />
      <p className="text-sm font-medium text-gray-500">{msg}</p>
      {view === 'mine' && !q && (
        <p className="mt-1 text-xs text-gray-400">That’s the whole point of the page.</p>
      )}
    </div>
  );
}

function NoteCard({ note, uid, nameByUid, onReply, onStatus }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const open = isOpen(note);
  const replies = note.replies || [];

  const send = async () => {
    setBusy(true);
    try { await onReply(note, text); setText(''); }
    catch (e) { toast.error(e?.message || 'Could not add that reply.'); }
    finally { setBusy(false); }
  };

  return (
    <div className={`rounded-xl border bg-white p-4 ${open ? 'border-gray-200' : 'border-gray-100 bg-gray-50/60'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-[15px] font-bold ${open ? 'text-gray-900' : 'text-gray-500'}`}>
            {note.subject}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            <b className="text-gray-700">{note.fromName || note.fromInitials || 'Someone'}</b>
            {' → '}
            <b className="text-gray-700">{recipientNames(note, nameByUid)}</b>
            {' · '}{fmtDate(note.loggedAt)}
          </p>
        </div>
        {open
          ? <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-700">Open</span>
          : <span className="shrink-0 rounded-full bg-gray-200 px-2.5 py-0.5 text-[11px] font-bold text-gray-600">Settled</span>}
      </div>

      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-gray-700">{note.body}</p>

      {replies.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-gray-200 pl-3">
          {replies.map((r, i) => (
            <div key={`${r.at}-${i}`}>
              <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">
                {r.name || r.initials || 'Someone'}
                {r.at ? ` · ${fmtDate(String(r.at).slice(0, 10))}` : ''}
              </p>
              <p className="whitespace-pre-line text-[13px] leading-relaxed text-gray-700">{r.text}</p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-gray-200 px-2.5 py-1.5 focus-within:border-red-400">
          <CornerDownRight size={13} className="shrink-0 text-gray-400" />
          <input value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && text.trim()) send(); }}
            placeholder="Reply…"
            className="w-full text-[13px] focus:outline-none" />
          {text.trim() && (
            <button onClick={send} disabled={busy} title="Send reply"
              className="shrink-0 rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-50">
              <Send size={13} />
            </button>
          )}
        </div>
        {open ? (
          <button onClick={() => onStatus(note, 'closed')}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-[13px] font-bold text-white hover:bg-emerald-700">
            <Check size={14} /> Settle it
          </button>
        ) : (
          <button onClick={() => onStatus(note, 'open')}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-[13px] font-semibold text-gray-600 hover:bg-gray-100">
            <RotateCcw size={13} /> Reopen
          </button>
        )}
      </div>

      {!open && note.settledByName && (
        <p className="mt-2 text-[11px] text-gray-400">
          Settled by {note.settledByName}
          {note.settledAt ? ` on ${fmtDate(String(note.settledAt).slice(0, 10))}` : ''}
        </p>
      )}

      {uid && note.fromUid === uid && open && replies.length === 0 && (
        <p className="mt-2 text-[11px] text-gray-400">Waiting on them.</p>
      )}
    </div>
  );
}

function Compose({ draft, setDraft, members, onSave, onCancel }) {
  const toggle = (uid) => setDraft(d => ({
    ...d,
    toAll: false,
    toUids: d.toUids.includes(uid) ? d.toUids.filter(x => x !== uid) : [...d.toUids, uid],
    error: '',
  }));

  return (
    <div className="mb-4 rounded-xl border border-gray-300 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-gray-900">New note</h2>
        <button onClick={onCancel} className="rounded p-1 text-gray-400 hover:bg-gray-100"><X size={16} /></button>
      </div>

      <p className="mb-1.5 text-xs font-semibold text-gray-600">Who is it for?</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button onClick={() => setDraft(d => ({ ...d, toAll: !d.toAll, toUids: [], error: '' }))}
          className={`rounded-full px-3 py-1.5 text-[13px] font-semibold ${
            draft.toAll ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
          Everyone
        </button>
        {members.map(m => (
          <button key={m.uid} onClick={() => toggle(m.uid)}
            className={`rounded-full px-3 py-1.5 text-[13px] font-semibold ${
              draft.toUids.includes(m.uid) ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {m.displayName || m.email}
          </button>
        ))}
        {members.length === 0 && (
          <p className="text-[13px] text-gray-400">Nobody else has desk access yet.</p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="sm:col-span-2">
          <span className="mb-1 block text-xs font-semibold text-gray-600">
            What’s it about? <span className="font-normal text-gray-400">— an account, a student, a topic</span>
          </span>
          <input value={draft.subject} autoFocus
            onChange={e => setDraft(d => ({ ...d, subject: e.target.value, error: '' }))}
            placeholder="Account: Manjeet Kaur"
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
        </label>
        <label>
          <span className="mb-1 block text-xs font-semibold text-gray-600">Date logged</span>
          <input type="date" value={draft.loggedAt}
            onChange={e => setDraft(d => ({ ...d, loggedAt: e.target.value, error: '' }))}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
        </label>
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-semibold text-gray-600">The note</span>
        <textarea value={draft.body} rows={3}
          onChange={e => setDraft(d => ({ ...d, body: e.target.value, error: '' }))}
          placeholder="Card was declined for this month’s payment — they said they’d come in with cash later in the week."
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
      </label>

      {draft.error && <p className="mt-2 text-sm font-semibold text-red-600">{draft.error}</p>}

      <div className="mt-3 flex gap-2">
        <button onClick={onSave}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700">
          Post it
        </button>
        <button onClick={onCancel}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
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
