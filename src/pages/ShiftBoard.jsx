import { useState, useEffect, useMemo } from 'react';
import {
  collection, addDoc, doc, onSnapshot, query, where, orderBy, limit,
  runTransaction, getDocs, updateDoc, deleteDoc,
} from 'firebase/firestore';
import { format } from 'date-fns';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { styleFor as subRoleStyleFor, requiredCapabilityForShift, hasCapability } from '../lib/subRoles';
import { notifyShiftClaimed } from '../lib/emailService';
import {
  ArrowRightLeft, Clock, CheckCircle, AlertTriangle, Lock,
  CalendarDays, Briefcase, Pencil, Trash2, X,
} from 'lucide-react';
import { toast, confirmDialog } from '../lib/notify';
import { SUB_ROLES } from '../lib/subRoles';

// ─── Constants ────────────────────────────────────────────────────────────────

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
 *  - If the shift has a `subRole`, the user must hold that capability.
 *
 * Matching is delegated to hasCapability() so 'Highschool' and
 * 'High School' are treated as the same thing — an exact === here used to
 * lock qualified people out of shifts they could clearly work.
 */
const canTake = (shiftSubRole, userSubRoles) => hasCapability(userSubRoles, shiftSubRole);

// ─── Card components ──────────────────────────────────────────────────────────

function SubRolePill({ subRole }) {
  const style = subRoleStyleFor(subRole);
  if (!style) {
    return (
      <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-500">
        Untagged
      </span>
    );
  }
  return (
    <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.pillBg} ${style.pillText}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      {style.label}
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

function OpenShiftCard({ shift, mySubRoles, onClaim, canAdmin, onEdit, onDelete }) {
  const [busy, setBusy] = useState(false);
  const eligible = canTake(requiredCapabilityForShift(shift), mySubRoles);
  const handleClick = async () => {
    setBusy(true);
    try { await onClaim(shift); }
    finally { setBusy(false); }
  };
  return (
    <CardShell eligible={eligible}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest font-bold text-orange-600">Open Shift</p>
          <p className="text-base font-bold text-gray-900 mt-0.5">{fmtDate(shift.date)}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <SubRolePill subRole={requiredCapabilityForShift(shift)} />
          {canAdmin && (
            <>
              <button
                onClick={() => onEdit(shift)}
                title="Edit this open shift"
                className="rounded-md border border-gray-200 bg-white p-1 text-gray-400 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => onDelete(shift)}
                title="Take this open shift down"
                className="rounded-md border border-gray-200 bg-white p-1 text-gray-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
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

function SwapCard({ swap, profile, mySubRoles, onTake, canAdmin, onDelete }) {
  const [busy, setBusy] = useState(false);
  const isMine = swap.userId === profile?.uid;
  const eligible = !isMine && canTake(swap.shiftSubRole, mySubRoles);
  const handleClick = async () => {
    setBusy(true);
    try { await onTake(swap); }
    finally { setBusy(false); }
  };
  return (
    <CardShell eligible={eligible || isMine} isMine={isMine}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest font-bold text-orange-600 flex items-center gap-1.5">
            <ArrowRightLeft size={11} /> Swap
          </p>
          <p className="text-base font-bold text-gray-900 mt-0.5">{fmtDate(swap.shiftDate)}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <SubRolePill subRole={swap.shiftSubRole} />
          {canAdmin && (
            <button
              onClick={() => onDelete(swap)}
              title="Cancel this swap request"
              className="rounded-md border border-gray-200 bg-white p-1 text-gray-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
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

// ─── Admin: edit-open-shift modal ─────────────────────────────────────────────

/**
 * Compact modal for editing an existing open shift's time + teaching level.
 * Lives here (not in Admin.jsx) so admins can edit straight from the Shift
 * Board without round-tripping through the admin panel. Sub-role / time
 * updates write directly to the openShifts doc; the rules already allow
 * any signed-in user to update openShifts (needed for the claim flow), so
 * no rules change is required.
 */
function EditOpenShiftModal({ shift, onClose, onSave }) {
  const [startTime, setStartTime] = useState(shift.startTime || '15:00');
  const [endTime,   setEndTime]   = useState(shift.endTime   || '19:00');
  const [subRole,   setSubRole]   = useState(shift.subRole   || 'Elementary');
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try { await onSave({ startTime, endTime, subRole }); onClose(); }
    finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 px-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-gray-900">Edit open shift</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <p className="text-xs text-gray-500 mb-4">{fmtDate(shift.date)}</p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Start Time</label>
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-orange-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">End Time</label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-orange-500 focus:outline-none" />
          </div>
        </div>
        <div className="mb-4">
          <label className="block text-xs text-gray-500 mb-1">Teaching Level</label>
          <select value={subRole} onChange={e => setSubRole(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-orange-500 focus:outline-none">
            {SUB_ROLES.map(sr => <option key={sr} value={sr}>{sr}</option>)}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50">Cancel</button>
          <button onClick={submit} disabled={saving}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ShiftBoard() {
  const { profile, mySubRoles, activeCenterId, canSeeAdminPanel, centerConfig } = useAuth();
  const [editingOpenShift, setEditingOpenShift] = useState(null);
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

  // Subscribe: open shifts at the active center (admin-posted)
  useEffect(() => onSnapshot(
    query(
      collection(db, 'openShifts'),
      where('centerId', '==', activeCenterId),
      orderBy('date', 'asc'),
    ),
    snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId]);

  // Subscribe: most recent chat docs at the active center (we'll filter to
  // shift_swap status === 'open' below)
  useEffect(() => onSnapshot(
    query(
      collection(db, 'chat'),
      where('centerId', '==', activeCenterId),
      orderBy('createdAt', 'desc'),
      limit(200),
    ),
    snap => setChatDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId]);

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
      ? visibleOpen.filter(s => canTake(requiredCapabilityForShift(s), mySubRoles))
      : visibleOpen
  ), [visibleOpen, hideIneligible, profile]);

  const filteredSwaps = useMemo(() => (
    hideIneligible
      ? visibleSwaps.filter(s => s.userId === profile?.uid || canTake(s.shiftSubRole, mySubRoles))
      : visibleSwaps
  ), [visibleSwaps, hideIneligible, profile]);

  // Counters for the empty / hidden states
  const hiddenOpenCount  = visibleOpen.length  - filteredOpen.length;
  const hiddenSwapCount  = visibleSwaps.length - filteredSwaps.length;

  // ─── Actions ──────────────────────────────────────────────────────────────

  const handleClaim = async (openShift) => {
    if (!canTake(openShift.subRole, mySubRoles)) {
      toast.error('You don\'t have the right teaching sub-role to claim this shift.');
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
        if (!canTake(data.subRole, mySubRoles)) {
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
          centerId: openShift.centerId || activeCenterId,
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

      // Confirmation message in chat (keeps the audit trail). userName
      // mirrors the active centre's display name so multi-centre staff
      // and Doug/Sylvia at Chilliwack don't see "Mathnasium Langley" on
      // their system messages.
      await addDoc(collection(db, 'chat'), {
        text: `✅ ${profile.displayName} claimed the open shift on ${fmtDate(openShift.date)} (${fmtTime(openShift.startTime)} – ${fmtTime(openShift.endTime)}).`,
        userId: 'system',
        userName: centerConfig?.name || 'Mathnasium',
        userRole: 'system',
        centerId: openShift.centerId || activeCenterId,
        createdAt: serverTimestamp(),
        type: 'shift_confirmation',
      });

      toast.success('Shift claimed! It has been added to your schedule.');

      // Email confirmation to claimer + CC admins/owners. Fire-and-forget.
      try {
        const usersSnap = await getDocs(collection(db, 'users'));
        const adminRecipients = [];
        usersSnap.forEach(u => {
          const d = u.data();
          if (d.email && ['admin', 'owner', 'super_admin'].includes(d.role)) {
            adminRecipients.push({ email: d.email, displayName: d.displayName });
          }
        });
        notifyShiftClaimed(
          openShift,
          { email: profile.email, displayName: profile.displayName },
          adminRecipients,
        );
      } catch { /* email failure shouldn't disrupt UX */ }
    } catch (err) {
      toast.error(err?.message || 'Failed to claim shift. Please try again.');
    }
  };

  const handleTakeSwap = async (swap) => {
    if (swap.userId === profile?.uid) return;
    if (!canTake(swap.shiftSubRole, mySubRoles)) {
      toast.error(swap.shiftSubRole === 'Host'
        ? 'Only staff who can host can take this shift.'
        : 'You don\'t have the required sub-role to take this shift.');
      return;
    }
    // 15-minute grace period so the poster has time to retract without
    // someone else snapping it up first. Only the poster can delete
    // during this window (delete permission already checks userId).
    const GRACE_MS = 15 * 60 * 1000;
    const postedAtMs = swap.createdAt?.toMillis?.()
      ?? (swap.createdAt?.seconds ? swap.createdAt.seconds * 1000 : 0);
    if (postedAtMs > 0 && (Date.now() - postedAtMs) < GRACE_MS) {
      const secsLeft = Math.ceil((GRACE_MS - (Date.now() - postedAtMs)) / 1000);
      const mins = Math.floor(secsLeft / 60);
      const secs = secsLeft % 60;
      toast.error(`This swap was just posted. Available to take in ${mins}m ${String(secs).padStart(2, '0')}s (15-min grace period so the poster can retract).`);
      return;
    }
    try {
      await runTransaction(db, async (tx) => {
        // Firestore rule: ALL reads must happen BEFORE any writes inside
        // a transaction. The previous version interleaved them
        // (read chat → write chat → read shift → write shift) which threw
        // "Firestore transactions require all reads to be executed before
        // all writes." Hoisting both reads to the top fixes it.
        const chatRef   = doc(db, 'chat', swap.id);
        const chatSnap  = await tx.get(chatRef);
        const shiftRef  = swap.shiftId ? doc(db, 'shifts', swap.shiftId) : null;
        const shiftSnap = shiftRef ? await tx.get(shiftRef) : null;

        if (!chatSnap.exists()) throw new Error('Swap request no longer exists.');
        const data = chatSnap.data();
        if (data.swapStatus !== 'open') throw new Error('This shift has already been taken.');
        if (!canTake(data.shiftSubRole, mySubRoles)) {
          throw new Error(data.shiftSubRole === 'Host'
            ? 'Only staff who can host can take this shift.'
            : 'You don\'t have the required sub-role for this shift.');
        }

        tx.update(chatRef, {
          swapStatus: 'accepted',
          acceptedBy: profile.uid,
          acceptedByName: profile.displayName,
        });

        if (shiftRef && shiftSnap?.exists()) {
          tx.update(shiftRef, {
            userId: profile.uid,
            userName: profile.displayName,
          });
        }
      });

      await addDoc(collection(db, 'chat'), {
        text: `${profile.displayName} took ${swap.userName}'s shift on ${fmtDate(swap.shiftDate)} (${fmtTime(swap.shiftStartTime)} – ${fmtTime(swap.shiftEndTime)}).`,
        userId: 'system',
        userName: 'System',
        userRole: 'system',
        centerId: swap.centerId || activeCenterId,
        createdAt: serverTimestamp(),
        type: 'shift_confirmation',
      });
    } catch (err) {
      toast.error(err?.message || 'Failed to take shift. It may have already been taken.');
    }
  };

  // ─── Admin actions (visible only when canSeeAdminPanel) ──────────────────

  const handleAdminEditOpenShift = async (patch) => {
    if (!editingOpenShift) return;
    try {
      await updateDoc(doc(db, 'openShifts', editingOpenShift.id), {
        startTime: patch.startTime,
        endTime:   patch.endTime,
        subRole:   patch.subRole,
      });
      toast.success('Open shift updated.');
    } catch (err) {
      toast.error(err?.message || 'Failed to update open shift.');
    }
  };

  const handleAdminDeleteOpenShift = async (shift) => {
    const ok = await confirmDialog({
      title: 'Take this open shift down?',
      message: `${fmtDate(shift.date)} · ${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)}\n\nIt will be removed from the board and from anyone's claim list.`,
      confirmText: 'Take down',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'openShifts', shift.id));
      toast.success('Open shift removed.');
    } catch (err) {
      toast.error(err?.message || 'Failed to remove open shift.');
    }
  };

  const handleAdminDeleteSwap = async (swap) => {
    const ok = await confirmDialog({
      title: 'Cancel this swap request?',
      message: `${swap.userName}'s swap for ${fmtDate(swap.shiftDate)} (${fmtTime(swap.shiftStartTime)} – ${fmtTime(swap.shiftEndTime)}).\n\nThe shift stays with the original instructor. The request is removed from the board.`,
      confirmText: 'Cancel request',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'chat', swap.id));
      toast.success('Swap request cancelled.');
    } catch (err) {
      toast.error(err?.message || 'Failed to cancel swap request.');
    }
  };

  // ─── No-sub-roles warning banner ──────────────────────────────────────────

  const userHasNoSubRoles = (mySubRoles || []).length === 0;

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
              <OpenShiftCard
                key={s.id}
                shift={s}
                mySubRoles={mySubRoles}
                onClaim={handleClaim}
                canAdmin={canSeeAdminPanel}
                onEdit={setEditingOpenShift}
                onDelete={handleAdminDeleteOpenShift}
              />
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
              <SwapCard
                key={s.id}
                swap={s}
                profile={profile}
                mySubRoles={mySubRoles}
                onTake={handleTakeSwap}
                canAdmin={canSeeAdminPanel}
                onDelete={handleAdminDeleteSwap}
              />
            ))}
          </div>
        )}
      </section>

      {editingOpenShift && (
        <EditOpenShiftModal
          shift={editingOpenShift}
          onClose={() => setEditingOpenShift(null)}
          onSave={handleAdminEditOpenShift}
        />
      )}
    </div>
  );
}
