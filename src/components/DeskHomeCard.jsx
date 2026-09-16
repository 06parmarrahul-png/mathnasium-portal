import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { StickyNote, ArrowRight, Flag } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { PAGES } from '../lib/pageNames';
import {
  canUseDesk, deskSummary, dueState, dueLabel, initialsOf, firstNameOrLabel,
  LIVE_STATUSES, ymdOf,
} from '../lib/deskNotes';
import { personColor } from '../lib/personColor';

/**
 * What's waiting on you at the Management Desk, on your home page.
 *
 * WHY IT EXISTS: a note is addressed to a person, and until now the only
 * way to find out you had one was to open the desk and look. The sidebar
 * badge helped, but the sidebar is behind a hamburger on a phone — and
 * Managers and Hosts, who carry most of the notes, are exactly the people
 * on the phone-first home.
 *
 * TWO SKINS, ONE SET OF NUMBERS. The desk's people are split across both
 * homes — Managers and Hosts get the phone-first one, the owner, directors
 * and the admin assistant keep the classic one — so this renders either,
 * and the counting happens once either way.
 *
 * ONLY DESK PEOPLE SEE IT, asked exactly the way the Firestore rules ask
 * it (canUseDesk). An instructor's home is unchanged, and their read would
 * be refused anyway.
 */
export default function DeskHomeCard({ variant = 'nl' }) {
  const auth = useAuth();
  const { profile, activeCenterId } = auth;
  const [notes, setNotes] = useState(null);
  const today = ymdOf(new Date());

  const canOpenDesk = canUseDesk({
    platformRole: profile?.role,
    instructorType: auth.myInstructorType,
    permissions: auth.permissions,
  });

  useEffect(() => {
    if (!canOpenDesk || !activeCenterId) return undefined;
    // The same query the desk and the sidebar badge run, so Firebase
    // dedupes it rather than paying for a third listener.
    return onSnapshot(
      query(
        collection(db, 'centers', activeCenterId, 'notes'),
        where('status', 'in', LIVE_STATUSES),
      ),
      snap => setNotes(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setNotes([]),
    );
  }, [canOpenDesk, activeCenterId]);

  const summary = useMemo(
    () => deskSummary(notes || [], profile?.uid, today),
    [notes, profile?.uid, today],
  );

  // Nothing at all until the data is in: a card that flashes "nothing
  // waiting" and then fills up reads as a bug.
  if (!canOpenDesk || notes === null) return null;

  const shown = summary.items.filter(n => dueState(n, today)).slice(0, 2);
  const rest = summary.onYou - shown.length;

  if (variant === 'classic') {
    return (
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <b className="flex items-center gap-1.5 text-[15px] text-gray-900">
              <StickyNote size={15} className="text-amber-500" />
              {PAGES.desk.name}
            </b>
            <p className="mt-0.5 text-[13px] text-gray-500">
              {summary.onYou === 0
                ? 'Nothing waiting on you.'
                : <>
                    {summary.onYou} on you
                    {summary.overdue > 0 && <>, <b className="text-red-600">{summary.overdue} overdue</b></>}
                    {summary.oldestDays > 0 && <> · oldest is {summary.oldestDays} days</>}
                  </>}
            </p>
          </div>
          {summary.onYou > 0 && (
            <Link to={PAGES.desk.path}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-red-700">
              Open the desk <ArrowRight size={14} />
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border p-4" style={{ background: 'var(--nl-card)', borderColor: 'var(--nl-rule)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <b className="block text-[14.5px]">On your desk</b>
          <span className="mt-0.5 block text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
            {summary.onYou === 0
              ? 'Nothing waiting on you.'
              : <>
                  {summary.onYou} waiting on you
                  {summary.overdue > 0 && <> · <b style={{ color: 'var(--nl-brand)' }}>{summary.overdue} overdue</b></>}
                </>}
          </span>
        </div>
        {summary.onYou > 0 && (
          <Link to={PAGES.desk.path}
            className="inline-flex items-center justify-center gap-2 rounded-xl px-3 py-1.5 text-[13px] font-bold"
            style={{ background: 'transparent', color: 'var(--nl-brand)', border: '1.5px solid var(--nl-brand)' }}>
            Open the desk
          </Link>
        )}
      </div>

      {/* Only the dated ones are listed. A due date is the thing that makes
          one note more pressing than another, and a list of everything is
          the desk — which is one tap away. */}
      {shown.map(note => {
        const state = dueState(note, today);
        return (
          <div key={note.id} className="mt-2 flex items-center gap-2.5 border-t pt-2"
            style={{ borderColor: 'var(--nl-rule)' }}>
            {/* Everything on this card is addressed to YOU, so the useful
                face is the sender's — in the same colour they carry on the
                desk, so a person looks like themselves on both surfaces. */}
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ background: personColor(note.fromUid) }}>
              {note.fromInitials || initialsOf(note.fromName) || '—'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px]">{note.subject || note.body}</span>
              <span className="block text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
                from {firstNameOrLabel(note)}
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
              style={state === 'overdue'
                ? { background: 'var(--nl-brandw)', color: 'var(--nl-brand)' }
                : { background: 'var(--nl-raised)', color: 'var(--nl-ink2)' }}>
              {state === 'overdue' && <Flag size={10} />}
              {dueLabel(note, today)}
            </span>
          </div>
        );
      })}

      {rest > 0 && (
        <p className="mt-2 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
          + {rest} more with no due date
        </p>
      )}
    </div>
  );
}
