import { useState, useEffect, useMemo } from 'react';
import {
  collection, addDoc, deleteDoc, doc, onSnapshot,
  query, orderBy, updateDoc,
} from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  CalendarDays, ChevronLeft, ChevronRight,
  ArrowRightLeft, Plus, X, Check, AlertTriangle, Briefcase,
  Clock, Loader2,
} from 'lucide-react';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  getDay, addMonths, subMonths, isSameMonth,
} from 'date-fns';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── Cell Modal ──────────────────────────────────────────────────────────────

function DayModal({ date, myAvailability, myShift, openShifts, timeOffMap, onClose, onSaveAvail, onDeleteAvail, onPostSwap, onClaimOpenShift, onRequestTimeOff }) {
  const [mode, setMode] = useState('main');
  const [startTime, setStartTime] = useState('15:00');
  const [endTime, setEndTime] = useState('20:00');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [toStart, setToStart] = useState(format(date, 'yyyy-MM-dd'));
  const [toEnd, setToEnd] = useState(format(date, 'yyyy-MM-dd'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [useCustom, setUseCustom] = useState(false);

  const dateStr = format(date, 'yyyy-MM-dd');
  const timeOffStatus = timeOffMap.get(dateStr); // 'pending' | 'approved' | undefined
  const hasTimeOff = !!timeOffStatus;

  const handleSave = async () => {
    setError('');
    if (!startTime || !endTime) {
      setError('Please select both a start and end time.');
      return;
    }
    if (startTime >= endTime) {
      setError('End time must be after start time.');
      return;
    }
    setSaving(true);
    try {
      await onSaveAvail(dateStr, startTime, endTime, comment);
    } catch (err) {
      setError('Failed to save availability. Please try again.');
      setSaving(false);
    }
  };

  const handleTimeOffSubmit = async () => {
    setError('');
    if (!reason.trim()) {
      setError('Please enter a reason.');
      return;
    }
    if (toStart > toEnd) {
      setError('End date must be on or after start date.');
      return;
    }
    setSaving(true);
    try {
      await onRequestTimeOff(toStart, toEnd, reason.trim());
    } catch (err) {
      setError('Failed to submit request. Please try again.');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white shadow-2xl overflow-hidden animate-slide-up"
        onClick={e => e.stopPropagation()}
        style={{ animation: 'slideUp 0.2s ease-out' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 bg-gradient-to-r from-gray-50 to-white">
          <div>
            <p className="text-xs font-semibold text-red-500 uppercase tracking-widest">{format(date, 'EEEE')}</p>
            <h3 className="text-xl font-bold text-gray-900 mt-0.5">{format(date, 'MMMM d, yyyy')}</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-full w-8 h-8 flex items-center justify-center hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          {/* Error banner */}
          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              <AlertTriangle size={15} className="shrink-0" />
              {error}
            </div>
          )}

          {mode === 'main' && (
            <>
              {/* My Shift */}
              {myShift && (
                <div className="rounded-xl bg-blue-50 border border-blue-200 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-6 h-6 rounded-full bg-blue-500 flex items-center justify-center">
                      <Briefcase size={12} className="text-white" />
                    </div>
                    <span className="text-xs font-bold text-blue-700 uppercase tracking-widest">Your Shift</span>
                  </div>
                  <p className="text-base font-bold text-blue-900">{fmtTime(myShift.startTime)} – {fmtTime(myShift.endTime)}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {myShift.role && <p className="text-xs text-blue-500 font-medium">{myShift.role}</p>}
                    {myShift.subRoleLabel && myShift.subRoleLabel !== 'Instructor' && (
                      <span className="rounded-full bg-blue-200 px-2 py-0.5 text-xs font-bold text-blue-800">
                        {myShift.subRoleLabel}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => onPostSwap(myShift)}
                    className="mt-3 w-full flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-3 py-2 text-xs font-bold text-white hover:bg-orange-600 active:scale-95 transition-all"
                  >
                    <ArrowRightLeft size={12} /> Post for Swap
                  </button>
                </div>
              )}

              {/* Time Off badge */}
              {hasTimeOff && (
                timeOffStatus === 'approved' ? (
                  <div className="rounded-xl bg-green-50 border border-green-200 p-3 flex items-center gap-2">
                    <Check size={14} className="text-green-600 shrink-0" />
                    <span className="text-xs font-semibold text-green-700">Time Off Approved ✓</span>
                  </div>
                ) : (
                  <div className="rounded-xl bg-yellow-50 border border-yellow-200 p-3 flex items-center gap-2">
                    <AlertTriangle size={14} className="text-yellow-500 shrink-0" />
                    <span className="text-xs font-semibold text-yellow-700">Time Off — Pending Approval</span>
                  </div>
                )
              )}

              {/* My Availability */}
              {myAvailability ? (
                <div className="rounded-xl bg-green-50 border border-green-200 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">
                          <Check size={12} className="text-white" />
                        </div>
                        <span className="text-xs font-bold text-green-700 uppercase tracking-widest">Available</span>
                      </div>
                      <p className="text-base font-bold text-green-900">{fmtTime(myAvailability.startTime)} – {fmtTime(myAvailability.endTime)}</p>
                    </div>
                    <button
                      onClick={() => onDeleteAvail(myAvailability.id)}
                      className="rounded-full w-8 h-8 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ) : !myShift && !hasTimeOff && (
                <button
                  onClick={() => { setMode('avail'); setError(''); }}
                  className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-green-300 px-4 py-3.5 text-sm font-semibold text-green-700 hover:bg-green-50 hover:border-green-400 active:scale-95 transition-all"
                >
                  <Plus size={15} /> Set Availability
                </button>
              )}

              {/* Open Shifts */}
              {openShifts.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-widest px-1">Open Shifts</p>
                  {openShifts.map(s => (
                    <div key={s.id} className="rounded-xl bg-orange-50 border border-orange-200 p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-bold text-orange-900">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</p>
                          {s.role && <p className="text-xs text-orange-600 font-medium">{s.role}</p>}
                        </div>
                        <button
                          onClick={() => onClaimOpenShift(s)}
                          className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-orange-600 active:scale-95 transition-all"
                        >
                          Claim
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Request Time Off */}
              {!hasTimeOff && (
                <button
                  onClick={() => { setMode('timeoff'); setError(''); }}
                  className="w-full flex items-center justify-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 active:scale-95 transition-all"
                >
                  <AlertTriangle size={14} /> Request Time Off
                </button>
              )}
            </>
          )}

          {mode === 'avail' && (() => {
            const dow = date.getDay();
            const isFri = dow === 5;
            const isSat = dow === 6;
            const isSun = dow === 0;

            const PRESETS = isSun ? [] : isSat ? [
              { label: '10:00 AM – 2:00 PM', start: '10:00', end: '14:00' },
              { label: '10:30 AM – 2:00 PM', start: '10:30', end: '14:00' },
              { label: '10:00 AM – 1:30 PM', start: '10:00', end: '13:30' },
              { label: '10:30 AM – 1:30 PM', start: '10:30', end: '13:30' },
            ] : isFri ? [
              { label: '3:00 PM – 6:00 PM', start: '15:00', end: '18:00' },
              { label: '3:30 PM – 6:00 PM', start: '15:30', end: '18:00' },
              { label: '3:00 PM – 5:30 PM', start: '15:00', end: '17:30' },
              { label: '3:30 PM – 5:30 PM', start: '15:30', end: '17:30' },
              { label: '4:00 PM – 6:00 PM', start: '16:00', end: '18:00' },
            ] : [
              { label: '3:00 PM – 7:00 PM', start: '15:00', end: '19:00' },
              { label: '3:30 PM – 7:00 PM', start: '15:30', end: '19:00' },
              { label: '3:00 PM – 6:30 PM', start: '15:00', end: '18:30' },
              { label: '3:30 PM – 6:30 PM', start: '15:30', end: '18:30' },
              { label: '4:00 PM – 7:00 PM', start: '16:00', end: '19:00' },
              { label: '4:00 PM – 6:30 PM', start: '16:00', end: '18:30' },
            ];

            return (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <Clock size={15} className="text-green-600" />
                  <p className="text-sm font-semibold text-gray-800">Set your availability</p>
                </div>

                {isSun ? (
                  <p className="text-sm text-gray-400 text-center py-4">Mathnasium is closed on Sundays.</p>
                ) : !useCustom ? (
                  <>
                    <div className="space-y-2 mb-3">
                      {PRESETS.map(p => (
                        <button
                          key={p.label}
                          onClick={() => { setStartTime(p.start); setEndTime(p.end); }}
                          className={`w-full text-left rounded-xl border-2 px-4 py-2.5 text-sm font-medium transition-colors
                            ${startTime === p.start && endTime === p.end
                              ? 'border-green-500 bg-green-50 text-green-800'
                              : 'border-gray-200 text-gray-700 hover:border-green-300 hover:bg-green-50/50'}`}
                        >
                          {p.label}
                        </button>
                      ))}
                      <button
                        onClick={() => setUseCustom(true)}
                        className="w-full text-left rounded-xl border-2 border-dashed border-gray-200 px-4 py-2.5 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600 transition-colors">
                        Custom time…
                      </button>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 mb-1.5">
                        Note for admin <span className="font-normal text-gray-400">(optional)</span>
                      </label>
                      <textarea
                        value={comment}
                        onChange={e => setComment(e.target.value)}
                        placeholder="e.g. Prefer online this day, available earlier if needed..."
                        rows={2}
                        className="w-full rounded-xl border-2 border-gray-200 px-3 py-2 text-sm resize-none focus:border-green-500 focus:outline-none"
                      />
                    </div>
                    {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-green-600 py-2.5 text-sm font-bold text-white hover:bg-green-700 disabled:opacity-60 transition-all">
                        {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : <><Check size={14} /> Save</>}
                      </button>
                      <button onClick={() => { setMode('main'); setError(''); }}
                        className="flex-1 rounded-xl border-2 border-gray-200 py-2.5 text-sm font-semibold text-gray-500 hover:bg-gray-50 transition-all">
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1.5">From</label>
                        <input type="time" value={startTime}
                          onChange={e => { setStartTime(e.target.value); setError(''); }}
                          className="w-full rounded-xl border-2 border-gray-200 px-3 py-2.5 text-sm font-medium focus:border-green-500 focus:outline-none transition-colors" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1.5">To</label>
                        <input type="time" value={endTime}
                          onChange={e => { setEndTime(e.target.value); setError(''); }}
                          className="w-full rounded-xl border-2 border-gray-200 px-3 py-2.5 text-sm font-medium focus:border-green-500 focus:outline-none transition-colors" />
                      </div>
                    </div>
                    {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
                    <div className="flex gap-2">
                      <button onClick={handleSave} disabled={saving}
                        className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-green-600 py-2.5 text-sm font-bold text-white hover:bg-green-700 disabled:opacity-60 transition-all">
                        {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : <><Check size={14} /> Save</>}
                      </button>
                      <button onClick={() => setUseCustom(false)}
                        className="flex-1 rounded-xl border-2 border-gray-200 py-2.5 text-sm font-semibold text-gray-500 hover:bg-gray-50 transition-all">
                        ← Presets
                      </button>
                    </div>
                  </>
                )}
              </>
            );
          })()}

          {mode === 'timeoff' && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle size={15} className="text-red-500" />
                <p className="text-sm font-semibold text-gray-800">Request time off</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">From</label>
                  <input
                    type="date"
                    value={toStart}
                    onChange={e => { setToStart(e.target.value); setError(''); }}
                    className="w-full rounded-xl border-2 border-gray-200 px-3 py-2.5 text-sm font-medium focus:border-red-500 focus:outline-none transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1.5">To</label>
                  <input
                    type="date"
                    value={toEnd}
                    onChange={e => { setToEnd(e.target.value); setError(''); }}
                    className="w-full rounded-xl border-2 border-gray-200 px-3 py-2.5 text-sm font-medium focus:border-red-500 focus:outline-none transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1.5">
                  Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  rows={3}
                  value={reason}
                  onChange={e => { setReason(e.target.value); setError(''); }}
                  placeholder="e.g. Family event, exam, personal…"
                  className="w-full rounded-xl border-2 border-gray-200 px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none resize-none transition-colors"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleTimeOffSubmit}
                  disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-700 disabled:opacity-60 active:scale-95 transition-all"
                >
                  {saving ? <><Loader2 size={14} className="animate-spin" /> Submitting…</> : 'Submit Request'}
                </button>
                <button
                  onClick={() => { setMode('main'); setError(''); }}
                  className="flex-1 rounded-xl border-2 border-gray-200 py-2.5 text-sm font-semibold text-gray-500 hover:bg-gray-50 active:scale-95 transition-all"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Schedule() {
  const { profile } = useAuth();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [openShifts, setOpenShifts] = useState([]);
  const [timeOffRequests, setTimeOffRequests] = useState([]);

  // ── Firestore listeners ──
  useEffect(() => onSnapshot(query(collection(db, 'availability'), orderBy('date')), snap =>
    setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  useEffect(() => onSnapshot(query(collection(db, 'shifts'), orderBy('date')), snap =>
    setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  useEffect(() => onSnapshot(query(collection(db, 'openShifts')), snap =>
    setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  useEffect(() => onSnapshot(collection(db, 'timeOffRequests'), snap =>
    setTimeOffRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), []);

  // ── Calendar grid ──
  const monthStart = startOfMonth(currentMonth);
  const monthEnd   = endOfMonth(currentMonth);
  const days       = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPad   = getDay(monthStart);

  // ── My data ──
  const myShifts = useMemo(() => shifts.filter(s => s.userId === profile?.uid), [shifts, profile]);
  const myAvailMap = useMemo(() => {
    const m = {};
    availability.filter(a => a.userId === profile?.uid).forEach(a => { m[a.date] = a; });
    return m;
  }, [availability, profile]);

  const myTimeOffMap = useMemo(() => {
    const map = new Map();
    timeOffRequests
      .filter(r => r.userId === profile?.uid && r.status !== 'denied' && r.startDate && r.endDate)
      .forEach(r => {
        let d = new Date(r.startDate + 'T00:00:00');
        const end = new Date(r.endDate + 'T00:00:00');
        while (d <= end) {
          map.set(format(d, 'yyyy-MM-dd'), r.status); // 'pending' or 'approved'
          d.setDate(d.getDate() + 1);
        }
      });
    return map;
  }, [timeOffRequests, profile]);

  // ── Handlers (now throw on error so modal can catch) ──
  const handleSaveAvail = async (dateStr, startTime, endTime, comment) => {
    const existing = myAvailMap[dateStr];
    if (existing) await deleteDoc(doc(db, 'availability', existing.id));
    await addDoc(collection(db, 'availability'), {
      userId: profile.uid,
      userName: profile.displayName,
      date: dateStr,
      startTime,
      endTime,
      comment: comment || '',
    });
    setSelectedDate(null);
  };

  const handleDeleteAvail = async (id) => {
    await deleteDoc(doc(db, 'availability', id));
    setSelectedDate(null);
  };

  const handlePostSwap = async (shift) => {
    const dateFormatted = new Date(shift.date + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    });
    await addDoc(collection(db, 'chat'), {
      text: `Is anyone able to swap or take my shift?\n\nShift: ${dateFormatted}, ${fmtTime(shift.startTime)} – ${fmtTime(shift.endTime)}${shift.role ? ` (${shift.role})` : ''}`,
      userId: profile.uid,
      userName: profile.displayName,
      userRole: profile.role,
      createdAt: serverTimestamp(),
      type: 'shift_swap',
      shiftId: shift.id,
      shiftDate: shift.date,
      shiftStartTime: shift.startTime,
      shiftEndTime: shift.endTime,
      shiftRole: shift.role || '',
      swapStatus: 'open',
      acceptedBy: null,
      acceptedByName: null,
    });
    setSelectedDate(null);
    alert('Shift posted to chat for swap!');
  };

  const handleClaimOpenShift = async (openShift) => {
    if (openShift.status !== 'open') {
      alert('This shift has already been claimed.');
      return;
    }
    await updateDoc(doc(db, 'openShifts', openShift.id), {
      status: 'claimed',
      claimedBy: profile.uid,
      claimedByName: profile.displayName,
    });
    await addDoc(collection(db, 'shifts'), {
      userId: profile.uid,
      userName: profile.displayName,
      date: openShift.date,
      startTime: openShift.startTime,
      endTime: openShift.endTime,
      role: openShift.role || profile.instructorType || 'Instructor',
      status: 'live',
      autoScheduled: false,
    });
    const dateFormatted = new Date(openShift.date + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    });
    await addDoc(collection(db, 'chat'), {
      text: `✅ ${profile.displayName} has claimed the open shift on ${dateFormatted} (${fmtTime(openShift.startTime)} – ${fmtTime(openShift.endTime)}).`,
      userId: 'system',
      userName: 'Mathnasium Langley',
      userRole: 'system',
      createdAt: serverTimestamp(),
      type: 'shift_confirmation',
    });
    setSelectedDate(null);
    alert('Shift claimed! It has been added to your schedule.');
  };

  const handleRequestTimeOff = async (startDate, endDate, reason) => {
    await addDoc(collection(db, 'timeOffRequests'), {
      userId: profile.uid,
      userName: profile.displayName,
      startDate,
      endDate,
      reason,
      status: 'pending',
      createdAt: serverTimestamp(),
    });
    setSelectedDate(null);
    alert('Time off request submitted! The admin team will review it.');
  };

  // ── Cell state logic ──
  const getCellState = (dateStr) => {
    const shift = myShifts.find(s => s.date === dateStr);
    if (shift) return { type: 'shift', shift };
    const toStatus = myTimeOffMap.get(dateStr);
    if (toStatus) return { type: 'timeoff', approved: toStatus === 'approved' };
    const avail = myAvailMap[dateStr];
    if (avail) return { type: 'available', avail };
    const dayOpenShifts = openShifts.filter(s => s.date === dateStr && s.status === 'open');
    if (dayOpenShifts.length > 0) return { type: 'open', openShifts: dayOpenShifts };
    return { type: 'empty' };
  };

  const todayStr = format(new Date(), 'yyyy-MM-dd');

  // ── Monthly stats ──
  const monthShifts = myShifts.filter(s =>
    s.date >= format(monthStart, 'yyyy-MM-dd') && s.date <= format(monthEnd, 'yyyy-MM-dd')
  );
  const monthHours = monthShifts.reduce((sum, s) => {
    if (!s.startTime || !s.endTime) return sum;
    const [sh, sm] = s.startTime.split(':').map(Number);
    const [eh, em] = s.endTime.split(':').map(Number);
    return sum + ((eh + em / 60) - (sh + sm / 60));
  }, 0);
  const monthOpenShifts = openShifts.filter(s =>
    s.status === 'open' &&
    s.date >= format(monthStart, 'yyyy-MM-dd') &&
    s.date <= format(monthEnd, 'yyyy-MM-dd')
  ).length;

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-xl bg-blue-100 p-2.5 text-blue-600">
          <CalendarDays size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">My Schedule</h1>
          <p className="text-sm text-gray-500">View shifts, set availability, and manage time off</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="mb-5 grid grid-cols-3 gap-3">
        {[
          { label: 'Shifts This Month', value: monthShifts.length, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-100' },
          { label: 'Hours This Month', value: `${monthHours.toFixed(1)}h`, color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-100' },
          { label: 'Open Shifts', value: monthOpenShifts, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-100' },
        ].map(stat => (
          <div key={stat.label} className={`rounded-xl border ${stat.border} ${stat.bg} p-4 text-center`}>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
            <p className="text-xs text-gray-500 mt-0.5 font-medium">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Calendar */}
      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        {/* Month nav */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5 bg-white">
          <button
            onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
            className="rounded-xl w-8 h-8 flex items-center justify-center hover:bg-gray-100 transition-colors text-gray-500"
          >
            <ChevronLeft size={18} />
          </button>
          <h2 className="text-base font-bold text-gray-900">{format(currentMonth, 'MMMM yyyy')}</h2>
          <button
            onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
            className="rounded-xl w-8 h-8 flex items-center justify-center hover:bg-gray-100 transition-colors text-gray-500"
          >
            <ChevronRight size={18} />
          </button>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 px-5 py-2.5 border-b border-gray-100 bg-gray-50/50">
          {[
            { color: 'bg-blue-500', label: 'Assigned Shift' },
            { color: 'bg-emerald-500', label: 'Available' },
            { color: 'bg-orange-400', label: 'Open Shift' },
            { color: 'bg-yellow-400', label: 'Time Off (Pending)' },
            { color: 'bg-green-500', label: 'Time Off (Approved)' },
          ].map(item => (
            <span key={item.label} className="flex items-center gap-1.5 text-xs text-gray-500 font-medium">
              <span className={`w-2.5 h-2.5 rounded-sm inline-block ${item.color}`} />
              {item.label}
            </span>
          ))}
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-gray-100">
          {DAY_HEADERS.map(d => (
            <div key={d} className="py-2.5 text-center text-xs font-bold text-gray-400 uppercase tracking-widest">
              {d}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div className="grid grid-cols-7">
          {/* Padding cells */}
          {Array.from({ length: startPad }).map((_, i) => (
            <div key={`pad-${i}`} className="min-h-[88px] border-b border-r border-gray-100 bg-gray-50/30" />
          ))}

          {/* Day cells */}
          {days.map((day) => {
            const dateStr = format(day, 'yyyy-MM-dd');
            const isToday = dateStr === todayStr;
            const inMonth = isSameMonth(day, currentMonth);
            const state = getCellState(dateStr);
            const isPast = dateStr < todayStr;

            let cellBg = 'bg-white hover:bg-gray-50/80';
            let content = null;
            let clickable = !isPast;

            if (state.type === 'shift') {
              cellBg = 'bg-blue-50/60 hover:bg-blue-50 cursor-pointer';
              content = (
                <div className="mt-1 rounded-lg bg-blue-500 px-1.5 py-1 shadow-sm">
                  <p className="text-white text-xs font-bold leading-tight">
                    {fmtTime(state.shift.startTime)}
                  </p>
                  <p className="text-blue-100 text-xs leading-tight">
                    {fmtTime(state.shift.endTime)}
                  </p>
                  {state.shift.subRoleLabel && state.shift.subRoleLabel !== 'Instructor' && (
                    <p className="text-blue-200 text-xs font-bold uppercase tracking-wide leading-tight mt-0.5" style={{ fontSize: '10px' }}>
                      {state.shift.subRoleLabel}
                    </p>
                  )}
                </div>
              );
            } else if (state.type === 'available') {
              cellBg = 'bg-emerald-50/60 hover:bg-emerald-50 cursor-pointer';
              content = (
                <div className="mt-1 rounded-lg bg-emerald-500 px-1.5 py-1 shadow-sm">
                  <p className="text-white text-xs font-bold leading-tight">Available</p>
                  <p className="text-emerald-100 text-xs leading-tight">
                    {fmtTime(state.avail.startTime)}
                  </p>
                </div>
              );
            } else if (state.type === 'open') {
              cellBg = 'bg-orange-50/60 hover:bg-orange-50 cursor-pointer';
              content = (
                <div className="mt-1 rounded-lg bg-orange-400 px-1.5 py-1 shadow-sm">
                  <p className="text-white text-xs font-bold leading-tight">
                    {state.openShifts.length} Open
                  </p>
                </div>
              );
            } else if (state.type === 'timeoff') {
              cellBg = state.approved ? 'bg-green-50/60 cursor-pointer' : 'bg-red-50/60 cursor-pointer';
              content = state.approved ? (
                <div className="mt-1 rounded-lg bg-green-500 px-1.5 py-1 shadow-sm flex items-center gap-1">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 5l2.5 2.5 4.5-4.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  <p className="text-white text-xs font-bold leading-tight">Approved</p>
                </div>
              ) : (
                <div className="mt-1 rounded-lg bg-yellow-400 px-1.5 py-1 shadow-sm">
                  <p className="text-white text-xs font-bold leading-tight">Time Off</p>
                </div>
              );
            } else if (!isPast) {
              cellBg = 'bg-white hover:bg-gray-50 cursor-pointer';
            } else {
              clickable = false;
            }

            return (
              <div
                key={dateStr}
                onClick={() => clickable && setSelectedDate(day)}
                className={`
                  min-h-[88px] border-b border-r border-gray-100 p-1.5 transition-colors
                  ${cellBg}
                  ${!inMonth ? 'opacity-25' : ''}
                  ${isToday ? 'ring-2 ring-inset ring-red-400' : ''}
                  ${isPast && state.type === 'empty' ? 'bg-gray-50/50' : ''}
                `}
              >
                <span className={`
                  inline-flex items-center justify-center text-xs font-bold w-6 h-6 rounded-full
                  ${isToday ? 'bg-red-500 text-white' : 'text-gray-600'}
                `}>
                  {format(day, 'd')}
                </span>
                {content}
              </div>
            );
          })}
        </div>
      </div>

      {/* My Requests */}
      {(() => {
        const myRequests = timeOffRequests
          .filter(r => r.userId === profile?.uid)
          .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0));

        if (myRequests.length === 0) return null;

        const statusConfig = {
          pending:  { label: 'Pending',  bg: 'bg-yellow-100', text: 'text-yellow-700', dot: 'bg-yellow-400' },
          approved: { label: 'Approved', bg: 'bg-green-100',  text: 'text-green-700',  dot: 'bg-green-500' },
          denied:   { label: 'Denied',   bg: 'bg-red-100',    text: 'text-red-600',    dot: 'bg-red-400'   },
        };

        return (
          <div className="mt-6">
            <h2 className="text-base font-bold text-gray-900 mb-3 flex items-center gap-2">
              <AlertTriangle size={16} className="text-orange-500" />
              My Time Off Requests
            </h2>
            <div className="space-y-3">
              {myRequests.map(req => {
                const s = statusConfig[req.status] || statusConfig.pending;
                const startLabel = req.startDate ? new Date(req.startDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
                const endLabel   = req.endDate   ? new Date(req.endDate   + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';
                const sameDay = req.startDate === req.endDate;

                return (
                  <div key={req.id} className={`rounded-xl border bg-white p-4 shadow-sm flex items-start justify-between gap-4 ${req.status === 'denied' ? 'opacity-60' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <CalendarDays size={14} className="text-gray-400 shrink-0" />
                        <span className="text-sm font-semibold text-gray-800">
                          {sameDay ? startLabel : `${startLabel} – ${endLabel}`}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mb-2 truncate">
                        <span className="font-medium text-gray-600">Reason:</span> {req.reason}
                      </p>
                      {req.status === 'denied' && (
                        <p className="text-xs text-red-500 font-medium">This request was denied — dates are available again.</p>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${s.dot}`} />
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${s.bg} ${s.text}`}>
                        {s.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Day Modal */}
      {selectedDate && (
        <DayModal
          date={selectedDate}
          myAvailability={myAvailMap[format(selectedDate, 'yyyy-MM-dd')]}
          myShift={myShifts.find(s => s.date === format(selectedDate, 'yyyy-MM-dd'))}
          openShifts={openShifts.filter(s => s.date === format(selectedDate, 'yyyy-MM-dd') && s.status === 'open')}
          timeOffMap={myTimeOffMap}
          onClose={() => setSelectedDate(null)}
          onSaveAvail={handleSaveAvail}
          onDeleteAvail={handleDeleteAvail}
          onPostSwap={handlePostSwap}
          onClaimOpenShift={handleClaimOpenShift}
          onRequestTimeOff={handleRequestTimeOff}
        />
      )}
    </div>
  );
}
