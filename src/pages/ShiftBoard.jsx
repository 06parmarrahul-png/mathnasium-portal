import { useState, useEffect, useMemo } from 'react';
import {
  collection, addDoc, doc, onSnapshot, query, orderBy, limit,
  runTransaction,
} from 'firebase/firestore';
import { format } from 'date-fns';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Briefcase, ArrowRightLeft, Clock, CheckCircle, AlertTriangle, Lock,
  CalendarDays,
} from 'lucide-react';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUB_ROLE_STYLES = {
  Elementary: { bg: 'bg-blue-100',   text: 'text-blue-700',   dot: 'bg-blue-500'   },
  Highschool: { bg: 'bg-purple-100', text: 'text-purple-700', dot: 'bg-purple-500' },
  Online:     { bg: 'bg-teal-100',   text: 'text-teal-700',   dot: 'bg-teal-500'   },
};

const HIDE_INELIGIBLE_KEY = 'shiftBoard.hideIneligible';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

/**
 * Eligibility rule:
 *  - If the shift has no `subRole` (legacy data), anyone with at least one
 *    sub-role can take it. Users with zero sub-roles are still locked out.
 *  - If the shift has a `subRole`, the user must have that exact sub-role
 *    in their profile.subRoles array.
 */
function canTake(shiftSubRole, userSubRoles) {
  const subs = userSubRoles || [];
  if (subs.length === 0) return false; // user has no sub-roles → locked out
  if (!shiftSubRole) return true;       // legacy shift, no restriction
  return subs.includes(shiftSubRole);
}

// ─── Card components ──────────────────────────────────────────────────────────

function SubRolePill({ subRole }) {
  if (!subRole) {
    return (
      <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-500">
        Untagged
      </span>
    );
  }
  const style = SUB_ROLE_STYLES[subRole] || SUB_ROLE_STYLES.Elementary;
  return (
    <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.bg} ${style.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {subRole}
    </span>
  );
}

function CardShell({ children, eligible, isMine }) {
  const ringClass = eligible ? 'border-gray-200' : 'border-gray-200 opacity-70';
  return (
    <div className={`rounded-xl border bg-white p-4 shadow-sm transition-shadow hover:shadow-md ${ringClass} ${isMine ? 'ring-2 ring-orange-200' : ''}`}>
      {children}
    </div>
  );
}

function OpenShiftCard({ shift, profile, onClaim }) {
  const [busy, setBusy] = useState(false);
  const eligible = canTake(shift.subRole, profile?.subRoles);
  const handleClick = async () => {
    setBusy(true);
    try { await onClaim(shift); }
    finally { setBusy(false); }
  };
  return (
    <CardShell eligible={eligible}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <p className="text-xs uppercase tracking-widest font-bold text-orange-600">Open Shift</p>
          <p className="text-base font-bold text-gray-900 mt-0.5">{fmtDate(shift.date)}</p>
        </div>
        <SubRolePill subRole={shift.subRole} />
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-700 mb-1">
        <Clock size={14} className="text-gray-400" />
        <span className="font-medium">{fmtTime(shift.startTime)} – {fmtTime(shift.endTime)}</span>
      </div>
      {shift.role && (
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-3">
          <Briefcase size={12} className="text-gray-400" />
          <span>{shift.role}</span>
        </div>
      )}
      {eligible ? (
        <button
          onClick={handleClick}
          disabled={busy}
          className="w-full rounded-lg bg-orange-500 px-3 py-2 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-50 transition-colors"
        >
          {busy ? 'Claiming…' : 'Claim Shift'}
        </button>
      ) : (
        <button
          disabled
          title={`Requires ${shift.subRole || 'a'} sub-role`}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-400 cursor-not-allowed"
        >
          <Lock size={13} />
          Requires {shift.subRole || 'a sub-role'}
        </button>
      )}
    </CardShell>
  );
}

function SwapCard({ swap, profile, onTake }) {
  const [busy, setBusy] = useState(false);
  const isMine = swap.userId === profile?.uid;
  const eligible = !isMine && canTake(swap.shiftSubRole, profile?.subRoles);
  const handleClick = async () => {
    setBusy(true);
    try { await onTake(swap); }
    finally { setBusy(false); }
  };
  return (
    <CardShell eligible={eligible || isMine} isMine={isMine}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <p className="text-xs uppercase tracking-widest font-bold text-orange-600 flex items-center gap-1.5">
            <ArrowRightLeft size={11} /> Swap
          </p>
          <p className="text-base font-bold text-gray-900 mt-0.5">{fmtDate(swap.shiftDate)}</p>
        </div>
        <SubRolePill subRole={swap.shiftSubRole} />
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-700 mb-1">
        <Clock size={14} className="text-gray-400" />
        <span className="font-medium">{fmtTime(swap.shiftStartTime)} – {fmtTime(swap.shiftEndTime)}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-3">
        <span>Posted by <span className="font-semibold text-gray-700">{swap.userName}</span></span>
        {swap.shiftRole && <span className="text-gray-300">·</span>}
        {swap.shiftRole && <span>{swap.shiftRole}</span>}
      </div>
      {isMine ? (
        <div className="rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 text-xs text-yellow-800 text-center">
          Waiting for someone to take this shift…
        </div>
      ) : eligible ? (
        <button
          onClick={handleClick}
          disabled={busy}
          className="w-full rounded-lg bg-green-600 px-3 py-2 text-sm font-bold text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
        >
          {busy ? 'Taking…' : 'Take This Shift'}
        </button>
      ) : (
        <button
          disabled
          title={swap.shiftSubRole ? `Requires ${swap.shiftSubRole} sub-role` : 'You don\'t have a sub-role assigned'}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-400 cursor-not-allowed"
        >
          <Lock size={13} />
          Requires {swap.shiftSubRole || 'a sub-role'}
        </button>
      )}
    </CardShell>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ShiftBoard() {
  const { profile } = useAuth();
  const [openShifts, setOpenShifts] = useState([]);
  const [chatDocs, setChatDocs] = useState([]);
  const [hideIneligible, setHideIneligible] = useState(() => {
    try { return localStorage.getItem(HIDE_INELIGIBLE_KEY) === '1'; }
    catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(HIDE_INELIGIBLE_KEY, hideIneligible ? '1' : '0'); }
    catch { /* ignore */ }
  }, [hideIneligible]);

  // Subscribe: open shifts (admin-posted)
  useEffect(() => onSnapshot(
    query(collection(db, 'openShifts'), orderBy('date', 'asc')),
    snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  // Subscribe: most recent chat docs (we'll filter to shift_swap status === 'open' below)
  useEffect(() => onSnapshot(
    query(collection(db, 'chat'), orderBy('createdAt', 'desc'), limit(200)),
    snap => setChatDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  const todayStr = format(new Date(), 'yyyy-MM-dd');

  // Filter + sort open shifts
  const visibleOpen = useMemo(() => {
    const list = openShifts
      .filter(s => s.status === 'open')
      .filter(s => s.date >= todayStr);
    return list.sort((a, b) => a.date.localeCompare(b.date));
  }, [openShifts, todayStr]);

  // Pull active swap requests from chat
  const visibleSwaps = useMemo(() => {
    const list = chatDocs
      .filter(m => m.type === 'shift_swap')
      .filter(m => m.swapStatus === 'open')
      .filter(m => !m.shiftDate || m.shiftDate >= todayStr);
    return list.sort((a, b) => (a.shiftDate || '').localeCompare(b.shiftDate || ''));
  }, [chatDocs, todayStr]);

  // Apply "hide ineligible" toggle
  const filteredOpen = useMemo(() => (
    hideIneligible
      ? visibleOpen.filter(s => canTake(s.subRole, profile?.subRoles))
      : visibleOpen
  ), [visibleOpen, hideIneligible, profile]);

  const filteredSwaps = useMemo(() => (
    hideIneligible
      ? visibleSwaps.filter(s => s.userId === profile?.uid || canTake(s.shiftSubRole, profile?.subRoles))
      : visibleSwaps
  ), [visibleSwaps, hideIneligible, profile]);

  // Counters for the empty / hidden states
  const hiddenOpenCount  = visibleOpen.length  - filteredOpen.length;
  const hiddenSwapCount  = visibleSwaps.length - filteredSwaps.length;

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleClaim = async (openShift) => {
    if (!canTake(openShift.subRole, profile?.subRoles)) {
      alert('You don\'t have the right teaching sub-role to claim this shift.');
      return;
    }
    try {
      const newShiftRef = doc(collection(db, 'shifts'));
      await runTransaction(db, async (tx) => {
        const openRef = doc(db, 'openShifts', openShift.id);
        const openSnap = await tx.get(openRef);
        if (!openSnap.exists()) throw new Error('This open shift no longer exists.');
        const data = openSnap.data();
        if (data.status !== 'open') throw new Error('This shift has already been claimed.');
        // Re-check sub-role inside the transaction too, defense-in-depth
        if (!canTake(data.subRole, profile?.subRoles)) {
          throw new Error('You don\'t have the right sub-role for this shift.');
        }

        tx.update(openRef, {
          status: 'claimed',
          claimedBy: profile.uid,
          claimedByName: profile.displayName,
          claimedAt: serverTimestamp(),
        });

        tx.set(newShiftRef, {
          userId: profile.uid,
          userName: profile.displayName,
          date: openShift.date,
          startTime: openShift.startTime,
          endTime: openShift.endTime,
          role: openShift.role || profile.instructorType || 'Instructor',
          subRole: openShift.subRole || 'Elementary',
          status: 'live',
          autoScheduled: false,
          fromOpenShiftId: openShift.id,
        });
      });

      // Confirmation message in chat (keeps the audit trail)
      await addDoc(collection(db, 'chat'), {
        text: `✅ ${profile.displayName} claimed the open shift on ${fmtDate(openShift.date)} (${fmtTime(openShift.startTime)} – ${fmtTime(openShift.endTime)}).`,
        userId: 'system',
        userName: 'Mathnasium Langley',
        userRole: 'system',
        createdAt: serverTimestamp(),
        type: 'shift_confirmation',
      });

      alert('Shift claimed! It has been added to your schedule.');
    } catch (err) {
      alert(err?.message || 'Failed to claim shift. Please try again.');
    }
  };

  const handleTakeSwap = async (swap) => {
    if (swap.userId === profile?.uid) return;
    if (!canTake(swap.shiftSubRole, profile?.subRoles)) {
      alert('You don\'t have the right teaching sub-role to take this shift.');
      return;
    }
    try {
      await runTransaction(db, async (tx) => {
        const chatRef = doc(db, 'chat', swap.id);
        const chatSnap = await tx.get(chatRef);
        if (!chatSnap.exists()) throw new Error('Swap request no longer exists.');
        const data = chatSnap.data();
        if (data.swapStatus !== 'open') throw new Error('This shift has already been taken.');
        if (!canTake(data.shiftSubRole, profile?.subRoles)) {
          throw new Error('You don\'t have the right sub-role for this shift.');
        }

        tx.update(chatRef, {
          swapStatus: 'accepted',
          acceptedBy: profile.uid,
          acceptedByName: profile.displayName,
        });

        if (swap.shiftId) {
          const shiftRef = doc(db, 'shifts', swap.shiftId);
          const shiftSnap = await tx.get(shiftRef);
          if (shiftSnap.exists()) {
            tx.update(shiftRef, {
              userId: profile.uid,
              userName: profile.displayName,
            });
          }
        }
      });

      await addDoc(collection(db, 'chat'), {
        text: `${profile.displayName} took ${swap.userName}'s shift on ${fmtDate(swap.shiftDate)} (${fmtTime(swap.shiftStartTime)} – ${fmtTime(swap.shiftEndTime)}).`,
        userId: 'system',
        userName: 'System',
        userRole: 'system',
        createdAt: serverTimestamp(),
        type: 'shift_confirmation',
      });
    } catch (err) {
      alert(err?.message || 'Failed to take shift. It may have already been taken.');
    }
  };

  // ─── No-sub-roles warning banner ──────────────────────────────────────────

  const userHasNoSubRoles = (profile?.subRoles || []).length === 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-orange-100 p-2 text-orange-600">
            <CalendarDays size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Shift Board</h1>
            <p className="text-sm text-gray-500">Open shifts and swap requests across the team</p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={hideIneligible}
            onChange={e => setHideIneligible(e.target.checked)}
            className="accent-orange-500 h-4 w-4"
          />
          Hide ones I can&apos;t take
        </label>
      </div>

      {userHasNoSubRoles && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800">
            <p className="font-semibold mb-0.5">No teaching sub-role assigned</p>
            <p className="text-xs">
              You need at least one teaching sub-role (Elementary / Highschool / Online) before you can claim shifts here.
              Ask the center owner to set one in the admin panel.
            </p>
          </div>
        </div>
      )}

      {/* Open Shifts */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-orange-500" />
            Open Shifts
            {visibleOpen.length > 0 && (
              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">
                {visibleOpen.length}
              </span>
            )}
          </h2>
        </div>
        {filteredOpen.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 p-8 text-center">
            <CheckCircle size={28} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-500 font-medium">
              {hiddenOpenCount > 0
                ? `No eligible open shifts (${hiddenOpenCount} hidden — uncheck the toggle to see them).`
                : 'No open shifts right now.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {filteredOpen.map(s => (
              <OpenShiftCard key={s.id} shift={s} profile={profile} onClaim={handleClaim} />
            ))}
          </div>
        )}
      </section>

      {/* Swap Requests */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <ArrowRightLeft size={14} className="text-orange-500" />
            Swap Requests
            {visibleSwaps.length > 0 && (
              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-700">
                {visibleSwaps.length}
              </span>
            )}
          </h2>
        </div>
        {filteredSwaps.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 p-8 text-center">
            <CheckCircle size={28} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-500 font-medium">
              {hiddenSwapCount > 0
                ? `No eligible swaps (${hiddenSwapCount} hidden — uncheck the toggle to see them).`
                : 'No active swap requests.'}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {filteredSwaps.map(s => (
              <SwapCard key={s.id} swap={s} profile={profile} onTake={handleTakeSwap} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
