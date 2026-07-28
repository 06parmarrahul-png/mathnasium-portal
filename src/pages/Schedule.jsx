import { useState, useEffect, useMemo } from 'react';
import {
  collection, addDoc, deleteDoc, doc, onSnapshot,
  query, where, orderBy, runTransaction, setDoc, writeBatch,
  getDocs, updateDoc,
} from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { styleFor as subRoleStyleFor, sickStyleFor, flexStyleFor, requiredCapabilityForShift, hasCapability } from '../lib/subRoles';
import { isOperatingDay, isCenterClosedOn, closureReason, resolveInstructionalHours } from '../lib/centerConfig';
import { notifyShiftClaimed } from '../lib/emailService';
import {
  CalendarDays, ChevronLeft, ChevronRight,
  ArrowRightLeft, Plus, X, Check, AlertTriangle, Briefcase,
  Clock, Loader2, Repeat, Trash2, Building2, Laptop, Wifi,
  CalendarPlus, Copy, RotateCcw, Smartphone,
} from 'lucide-react';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval,
  getDay, addMonths, subMonths, isSameMonth,
} from 'date-fns';
import { toast } from '../lib/notify';

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

/**
 * True if this availability covers the whole day (Full Day sentinel
 * 00:00 – 23:59). Used to render "Full day" instead of a literal time
 * range anywhere availability is displayed.
 */
export function isFullDayAvail(startTime, endTime) {
  return startTime === '00:00' && (endTime === '23:59' || endTime === '24:00');
}

/**
 * Format an availability range for display. Returns "Full day" when the
 * range covers the whole 24h, otherwise "9:00 AM – 5:00 PM"-style.
 */
export function fmtAvailRange(startTime, endTime) {
  if (isFullDayAvail(startTime, endTime)) return 'Full day';
  return `${fmtTime(startTime)} – ${fmtTime(endTime)}`;
}

const DAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// How far back the live listeners load. Older docs still exist in Firestore
// — they just don't stream into the calendar on every page load, which would
// scale linearly with centre-age across the network and Firestore bill.
// 180 days covers the calendar's normal Prev/Next navigation comfortably
// (about 6 months back). Bump this if a future "year-end report" feature
// needs to look further; for the live calendar this is plenty.
const LISTENER_WINDOW_DAYS = 180;
function listenerWindowStart() {
  const d = new Date();
  d.setDate(d.getDate() - LISTENER_WINDOW_DAYS);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── Shift-type (location) helpers ─────────────────────────────────────
// shiftType describes WHERE the instructor is working that shift — distinct
// from subRole which describes WHAT they're teaching.
const SHIFT_TYPE_STYLES = {
  'In-Centre': {
    label: 'In-Centre',
    icon: Building2,
    pillBg: 'bg-blue-100',
    pillText: 'text-blue-800',
    pillBorder: 'border-blue-200',
    dot: 'bg-blue-500',
  },
  'Online': {
    label: 'Online',
    icon: Laptop,
    pillBg: 'bg-indigo-100',
    pillText: 'text-indigo-800',
    pillBorder: 'border-indigo-200',
    dot: 'bg-indigo-500',
  },
  'Both': {
    label: 'In-Centre + Online',
    icon: Wifi,
    pillBg: 'bg-purple-100',
    pillText: 'text-purple-800',
    pillBorder: 'border-purple-200',
    dot: 'bg-purple-500',
  },
};
// Treat missing shiftType as 'In-Centre' (legacy data + the default for new shifts).
function shiftTypeStyle(shiftType) {
  return SHIFT_TYPE_STYLES[shiftType] || SHIFT_TYPE_STYLES['In-Centre'];
}

// Default operating-hours map (JS getDay() 1=Mon..6=Sat). Used as fallback
// when no per-center config is loaded. The actual values flow in from the
// active center's `centerConfig.operatingHours` (passed via props) so each
// Mathnasium location can have its own hours.
const DEFAULT_FULL_DAY_BY_DOW = {
  1: { start: '10:00', end: '20:00' }, // Mon
  2: { start: '10:00', end: '20:00' }, // Tue
  3: { start: '10:00', end: '20:00' }, // Wed
  4: { start: '10:00', end: '20:00' }, // Thu
  5: { start: '10:00', end: '19:00' }, // Fri
  6: { start: '09:00', end: '15:00' }, // Sat
};

// Convert the center config's day-name-keyed operatingHours into the
// JS-getDay()-keyed shape used by the modals.
function buildFullDayByDow(centerConfig) {
  const op = centerConfig?.operatingHours;
  if (!op) return DEFAULT_FULL_DAY_BY_DOW;
  return {
    1: op.Monday    || DEFAULT_FULL_DAY_BY_DOW[1],
    2: op.Tuesday   || DEFAULT_FULL_DAY_BY_DOW[2],
    3: op.Wednesday || DEFAULT_FULL_DAY_BY_DOW[3],
    4: op.Thursday  || DEFAULT_FULL_DAY_BY_DOW[4],
    5: op.Friday    || DEFAULT_FULL_DAY_BY_DOW[5],
    6: op.Saturday  || DEFAULT_FULL_DAY_BY_DOW[6],
  };
}

// ─── Cell Modal ──────────────────────────────────────────────────────────────

function DayModal({ date, myAvailability, myShift, openShifts, timeOffMap, fullDayByDow, centerConfig, isClosedDay, onClose, onSaveAvail, onDeleteAvail, onPostSwap, onClaimOpenShift, onRequestTimeOff, mySubRoles = [] }) {
  const [mode, setMode] = useState('main');
  // Default the time inputs to this centre's configured instructional
  // hours for the picked date's day-of-week. Falls back to 15:00–20:00
  // only if config is missing or doesn't have hours for this weekday.
  const dayDefault = (() => {
    const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dayName = DOW[date.getDay()];
    // resolveInstructionalHours respects any active date-bound override
    // (e.g. summerHours2026) so picking July 7 returns 10–14 for Tue/Thu
    // instead of the year-round 15–19.
    const h = resolveInstructionalHours(centerConfig, date)?.[dayName];
    return h?.start && h?.end ? h : { start: '15:00', end: '20:00' };
  })();
  const [startTime, setStartTime] = useState(dayDefault.start);
  const [endTime, setEndTime] = useState(dayDefault.end);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  // Per-day preference: where do you want to work today?
  // 'either' = scheduler uses profile default (current behaviour).
  // 'centre' / 'online' = override the profile default for this day only.
  // The scheduler honours this via effectiveTrack() in src/lib/scheduler.js.
  const [preferredAssignment, setPreferredAssignment] = useState('either');
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
      await onSaveAvail(dateStr, startTime, endTime, comment, preferredAssignment);
    } catch {
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
    } catch {
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
              {/* My Shift — burgundy treatment when this shift is marked
                  as Sick Pay so the instructor instantly sees they're
                  not expected in but are still getting paid. */}
              {myShift && (
                <div className={myShift.sickPay
                  ? 'rounded-xl bg-red-50 border border-red-300 p-4'
                  : 'rounded-xl bg-blue-50 border border-blue-200 p-4'}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center ${myShift.sickPay ? 'bg-red-900' : 'bg-blue-500'}`}>
                      <Briefcase size={12} className="text-white" />
                    </div>
                    <span className={`text-xs font-bold uppercase tracking-widest ${myShift.sickPay ? 'text-red-900' : 'text-blue-700'}`}>
                      {myShift.sickPay ? 'Sick Pay' : 'Your Shift'}
                    </span>
                  </div>
                  <p className={`text-base font-bold ${myShift.sickPay ? 'text-red-900' : 'text-blue-900'}`}>{fmtTime(myShift.startTime)} – {fmtTime(myShift.endTime)}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {/* Where: in-centre vs online — most important info for the instructor */}
                    {(() => {
                      const st = shiftTypeStyle(myShift.shiftType);
                      const StIcon = st.icon;
                      return (
                        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${st.pillBg} ${st.pillText} border ${st.pillBorder}`}>
                          <StIcon size={11} />
                          {st.label}
                        </span>
                      );
                    })()}
                    {myShift.role && <p className="text-xs text-blue-500 font-medium">{myShift.role}</p>}
                    {(() => {
                      const s = subRoleStyleFor(myShift.subRole);
                      if (!s) return null;
                      return (
                        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${s.pillBg} ${s.pillText}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                          {s.label}
                        </span>
                      );
                    })()}
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
                  <div className="rounded-xl bg-teal-50 border border-teal-200 p-3 flex items-center gap-2">
                    <Check size={14} className="text-teal-600 shrink-0" />
                    <span className="text-xs font-semibold text-teal-700">Time Off Approved ✓</span>
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
                  {openShifts.map(s => {
                    const required = requiredCapabilityForShift(s);
                    const canClaim = !required || mySubRoles.includes(required);
                    return (
                    <div key={s.id} className="rounded-xl bg-orange-50 border border-orange-200 p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-bold text-orange-900">{fmtTime(s.startTime)} – {fmtTime(s.endTime)}</p>
                          {s.role && <p className="text-xs text-orange-600 font-medium">{s.role}</p>}
                        </div>
                        {canClaim ? (
                          <button
                            onClick={() => onClaimOpenShift(s)}
                            className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-orange-600 active:scale-95 transition-all"
                          >
                            Claim
                          </button>
                        ) : (
                          <span
                            className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-400"
                            title={required === 'Host' ? 'Only staff who can host can take this' : `Requires the ${required} sub-role`}
                          >
                            {required === 'Host' ? 'Host only' : `Requires ${required}`}
                          </span>
                        )}
                      </div>
                    </div>
                    );
                  })}
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
            // Presets are derived from the day's EFFECTIVE instructional
            // hours (dayDefault above) so summer-hours overrides for
            // Tue/Thu in July/August automatically produce the correct
            // options instead of the year-round 3-7pm defaults. That
            // avoids instructors saving 3-7 on a day the centre now
            // opens at 10 for summer.
            const fullDayLabel = 'Full Day';
            const fmtTime = (t) => {
              // Turn "15:00" into "3:00 PM"
              if (!t) return '';
              const [hs, ms] = t.split(':');
              let h = parseInt(hs, 10);
              const m = parseInt(ms, 10);
              const ampm = h >= 12 ? 'PM' : 'AM';
              if (h > 12) h -= 12;
              if (h === 0) h = 12;
              return m === 0 ? `${h}:00 ${ampm}` : `${h}:${String(m).padStart(2, '0')} ${ampm}`;
            };
            const addMin = (t, mins) => {
              const [hs, ms] = t.split(':').map(n => parseInt(n, 10));
              const total = hs * 60 + ms + mins;
              const h = Math.floor(total / 60);
              const m = total % 60;
              return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            };
            // Build up to 6 realistic presets from the effective window:
            // full range, arrive-30min-late, leave-30min-early, both,
            // arrive-1hr-late, both-with-1hr-late-arrival. Dedupe on
            // start/end so a short 3-hour day doesn't produce silly
            // duplicates.
            const s = dayDefault.start, e = dayDefault.end;
            const rawPresets = [
              { start: s,             end: e },
              { start: addMin(s, 30), end: e },
              { start: s,             end: addMin(e, -30) },
              { start: addMin(s, 30), end: addMin(e, -30) },
              { start: addMin(s, 60), end: e },
              { start: addMin(s, 60), end: addMin(e, -30) },
            ];
            const seen = new Set();
            const timePresets = rawPresets
              .filter(p => {
                const [ph, pm] = p.start.split(':').map(Number);
                const [qh, qm] = p.end.split(':').map(Number);
                // Drop presets that flipped past end (short summer days).
                if (ph * 60 + pm >= qh * 60 + qm) return false;
                const k = `${p.start}-${p.end}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              })
              .map(p => ({ ...p, label: `${fmtTime(p.start)} – ${fmtTime(p.end)}` }));
            const PRESETS = isClosedDay ? [] : [
              { label: fullDayLabel, start: '00:00', end: '23:59', fullDay: true },
              ...timePresets,
            ];

            return (
              <>
                <div className="flex items-center gap-2 mb-3">
                  <Clock size={15} className="text-green-600" />
                  <p className="text-sm font-semibold text-gray-800">Set your availability</p>
                </div>

                {isClosedDay ? (
                  <p className="text-sm text-gray-400 text-center py-4">This center is closed on this day.</p>
                ) : !useCustom ? (
                  <>
                    <div className="space-y-2 mb-3">
                      {PRESETS.map(p => {
                        const selected = startTime === p.start && endTime === p.end;
                        if (p.fullDay) {
                          return (
                            <button
                              key={p.label}
                              onClick={() => { setStartTime(p.start); setEndTime(p.end); }}
                              className={`w-full flex items-center justify-between gap-2 rounded-xl border-2 px-4 py-3 text-sm font-bold transition-colors
                                ${selected
                                  ? 'border-emerald-500 bg-emerald-50 text-emerald-800 shadow-sm'
                                  : 'border-emerald-300 bg-emerald-50/40 text-emerald-700 hover:border-emerald-400 hover:bg-emerald-50'}`}
                            >
                              <span className="flex items-center gap-2">
                                <span className="text-base">⏰</span>
                                Full Day
                              </span>
                              <span className="text-xs font-medium text-emerald-600/70">
                                Anytime
                              </span>
                            </button>
                          );
                        }
                        return (
                          <button
                            key={p.label}
                            onClick={() => { setStartTime(p.start); setEndTime(p.end); }}
                            className={`w-full text-left rounded-xl border-2 px-4 py-2.5 text-sm font-medium transition-colors
                              ${selected
                                ? 'border-green-500 bg-green-50 text-green-800'
                                : 'border-gray-200 text-gray-700 hover:border-green-300 hover:bg-green-50/50'}`}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => setUseCustom(true)}
                        className="w-full text-left rounded-xl border-2 border-dashed border-gray-200 px-4 py-2.5 text-sm text-gray-400 hover:border-gray-300 hover:text-gray-600 transition-colors">
                        Custom time…
                      </button>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 mb-1.5">
                        Where today? <span className="font-normal text-gray-400">(scheduler uses this)</span>
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { v: 'either', label: 'Either',   hint: 'Use profile default' },
                          { v: 'centre', label: 'In-centre', hint: 'Schedule me on the floor' },
                          { v: 'online', label: 'Online',    hint: 'Schedule me online today' },
                        ].map(opt => (
                          <button
                            key={opt.v}
                            type="button"
                            onClick={() => setPreferredAssignment(opt.v)}
                            title={opt.hint}
                            className={`rounded-xl border-2 px-2 py-2 text-xs font-bold transition-all ${
                              preferredAssignment === opt.v
                                ? 'border-green-500 bg-green-50 text-green-700'
                                : 'border-gray-200 text-gray-500 hover:border-gray-300'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-500 mb-1.5">
                        Note for admin <span className="font-normal text-gray-400">(optional)</span>
                      </label>
                      <textarea
                        value={comment}
                        onChange={e => setComment(e.target.value)}
                        placeholder="e.g. Available earlier if needed, prefer HS side..."
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


// ─── Weekly Availability Modal ───────────────────────────────────────────────

const WEEK_DAYS = [
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

const RECURRENCE_OPTIONS = [
  { value: 'every',       label: 'Every week' },
  { value: 'odd',         label: 'Odd weeks (1, 3, 5)' },
  { value: 'even',        label: 'Even weeks (2, 4)' },
  { value: 'week1',       label: 'Week 1 only' },
  { value: 'week2',       label: 'Week 2 only' },
  { value: 'week3',       label: 'Week 3 only' },
  { value: 'week4',       label: 'Week 4 only' },
];

function getWeekOfMonth(date) {
  return Math.ceil(date.getDate() / 7);
}

function weekMatchesRecurrence(date, recurrence) {
  const w = getWeekOfMonth(date);
  if (recurrence === 'every') return true;
  if (recurrence === 'odd')   return w % 2 !== 0;
  if (recurrence === 'even')  return w % 2 === 0;
  if (recurrence === 'week1') return w === 1;
  if (recurrence === 'week2') return w === 2;
  if (recurrence === 'week3') return w === 3;
  if (recurrence === 'week4') return w === 4;
  return false;
}

function WeeklyAvailabilityModal({ currentMonth, availability, profile, fullDayByDow, centerConfig, onClose, onSaveBulk }) {
  const [selectedDays, setSelectedDays] = useState([]);
  const [recurrence, setRecurrence] = useState('every');
  // Default custom-time inputs to this centre's Monday instructional
  // hours — the most common case for staff filling out availability.
  // The user can change them; per-day variation comes from "Full Day".
  // Resolver respects active date-bound overrides (Monday isn't part of
  // the summer override today, so behaviour is unchanged — using the
  // resolver keeps the call uniform with the rest of the codebase).
  const weeklyDefault = resolveInstructionalHours(centerConfig, new Date())?.Monday;
  const [startTime, setStartTime] = useState(weeklyDefault?.start || '15:00');
  const [endTime, setEndTime] = useState(weeklyDefault?.end || '20:00');
  const [useFullDay, setUseFullDay] = useState(false);
  const [scope, setScope] = useState('thisMonth'); // 'thisMonth' | 'nextMonth' | 'both'
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Dates the user has X'd out from the preview before saving — they
  // submit availability for everything else. Cleared when the inputs
  // change so excludes don't quietly persist across edits.
  const [excludedDates, setExcludedDates] = useState(() => new Set());
  // Optional note (e.g. "Can stay later if needed", "Online only this week").
  // Mirrors the single-day modal's `comment` field. When non-empty AND
  // `noteAppliesToAll` is true (the default), every preview date in the
  // batch gets the note written into Firestore's `comment` field. Owner /
  // admin sees it when they open Schedule the same way they see single-
  // day notes today — no separate read path needed.
  const [note, setNote] = useState('');
  const [noteAppliesToAll, setNoteAppliesToAll] = useState(true);
  // Per-date opt-out. Only consulted when noteAppliesToAll is FALSE and
  // the user has manually deselected specific dates. When all-on, this
  // set is ignored. Reset on the same triggers as excludedDates.
  const [noteExcludedDates, setNoteExcludedDates] = useState(() => new Set());
  // Per-day routing preference applied to every selected date in this
  // batch. 'either' = scheduler uses profile default (no override).
  // Centre / Online apply for every date in the preview.
  const [weeklyPreferredAssignment, setWeeklyPreferredAssignment] = useState('either');

  // Build preview as [{date, startTime, endTime}] — per-day times when "Full Day"
  // is on (Saturday's 10–2 differs from Monday's 3–7), or the modal's chosen
  // start/end repeated across every selected date when off.
  const preview = useMemo(() => {
    if (selectedDays.length === 0) return [];

    const months = [];
    if (scope === 'thisMonth' || scope === 'both') months.push(currentMonth);
    if (scope === 'nextMonth' || scope === 'both') {
      const next = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
      months.push(next);
    }

    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const items = [];

    for (const month of months) {
      const start = startOfMonth(month);
      const end   = endOfMonth(month);
      const allDays = eachDayOfInterval({ start, end });
      for (const d of allDays) {
        const dow = getDay(d); // 0=Sun
        if (!selectedDays.includes(dow)) continue;
        if (!weekMatchesRecurrence(d, recurrence)) continue;
        const ds = format(d, 'yyyy-MM-dd');
        if (ds < todayStr) continue;

        // Skip dates the user X'd out from the preview.
        if (excludedDates.has(ds)) continue;
        // Apply the note to this date if a note is entered AND either
        // "apply to all" is on, or the user hasn't opted this specific
        // date out of the note.
        const noteForThis = note.trim() && (noteAppliesToAll || !noteExcludedDates.has(ds))
          ? note.trim()
          : '';
        if (useFullDay) {
          // Full Day = the whole 24h window. Admin can schedule the
          // instructor anywhere they want within the day. (Closed days
          // are filtered out via isOperatingDay on the day-toggle row,
          // so anything that makes it here is a valid operating day.)
          items.push({ date: ds, startTime: '00:00', endTime: '23:59', dow, comment: noteForThis, preferredAssignment: weeklyPreferredAssignment });
        } else {
          items.push({ date: ds, startTime, endTime, dow, comment: noteForThis, preferredAssignment: weeklyPreferredAssignment });
        }
      }
    }
    return items;
  }, [selectedDays, recurrence, scope, currentMonth, useFullDay, startTime, endTime, fullDayByDow, excludedDates, note, noteAppliesToAll, noteExcludedDates, weeklyPreferredAssignment]);

  // Reset the excluded-dates set when the generators change — otherwise
  // an old exclude on Aug 19 would silently apply if the user later
  // switches days/recurrence/scope. Per-note opt-outs reset on the same
  // triggers for the same reason.
  useEffect(() => {
    setExcludedDates(new Set());
    setNoteExcludedDates(new Set());
  }, [selectedDays, recurrence, scope]);

  const toggleDay = (dow) => {
    setSelectedDays(prev =>
      prev.includes(dow) ? prev.filter(d => d !== dow) : [...prev, dow]
    );
  };

  const existingDates = new Set(
    availability.filter(a => a.userId === profile?.uid).map(a => a.date)
  );
  const overwriteCount = preview.filter(item => existingDates.has(item.date)).length;

  const handleSave = async () => {
    setError('');
    if (selectedDays.length === 0) { setError('Select at least one day.'); return; }
    if (!useFullDay) {
      if (!startTime || !endTime) { setError('Set a start and end time.'); return; }
      if (startTime >= endTime)   { setError('End time must be after start time.'); return; }
    }
    if (preview.length === 0)     { setError('No matching dates found — try different settings.'); return; }
    setSaving(true);
    try {
      await onSaveBulk(preview);
    } catch {
      setError('Failed to save. Please try again.');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
        style={{ animation: 'slideUp 0.2s ease-out', maxHeight: '90vh', overflowY: 'auto' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 bg-gradient-to-r from-emerald-50 to-white sticky top-0">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-emerald-100 p-1.5 text-emerald-600">
              <Repeat size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Set Weekly Availability</h3>
              <p className="text-xs text-gray-500">Apply to multiple days at once</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-full w-8 h-8 flex items-center justify-center hover:bg-gray-100 text-gray-400">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {error && (
            <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              <AlertTriangle size={14} className="shrink-0" /> {error}
            </div>
          )}

          {/* Day picker */}
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Days of the Week</label>
            <div className="flex gap-2 flex-wrap">
              {WEEK_DAYS.filter(({ value }) => isOperatingDay(value, centerConfig)).map(({ label, value }) => {
                const active = selectedDays.includes(value);
                return (
                  <button
                    key={value}
                    onClick={() => toggleDay(value)}
                    className={`w-12 h-12 rounded-xl text-sm font-bold border-2 transition-all active:scale-95 ${
                      active
                        ? 'bg-emerald-500 border-emerald-500 text-white shadow-sm'
                        : 'bg-white border-gray-200 text-gray-500 hover:border-emerald-300 hover:text-emerald-600'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Time */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest">Time</label>
              <label className="flex items-center gap-2 text-xs font-semibold text-emerald-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={useFullDay}
                  onChange={e => { setUseFullDay(e.target.checked); setError(''); }}
                  className="accent-emerald-600 h-4 w-4"
                />
                Full day for each
              </label>
            </div>

            {useFullDay ? (
              <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50/60 p-3 text-xs">
                <p className="flex items-center gap-2 font-semibold text-emerald-800">
                  <span className="text-base">⏰</span>
                  Available all day — admin can schedule you anytime.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">From</label>
                  <input type="time" value={startTime} onChange={e => { setStartTime(e.target.value); setError(''); }}
                    className="w-full rounded-xl border-2 border-gray-200 px-3 py-2.5 text-sm font-medium focus:border-emerald-500 focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">To</label>
                  <input type="time" value={endTime} onChange={e => { setEndTime(e.target.value); setError(''); }}
                    className="w-full rounded-xl border-2 border-gray-200 px-3 py-2.5 text-sm font-medium focus:border-emerald-500 focus:outline-none" />
                </div>
              </div>
            )}
          </div>

          {/* Where for this batch — scheduler reads it via effectiveTrack().
              Applies to every selected day in the preview. Per-day overrides
              are a single-day modal feature; the weekly batch keeps one
              value to stay simple. Owner can edit individual days after. */}
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Where</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { v: 'either', label: 'Either',    hint: 'Scheduler uses my profile default' },
                { v: 'centre', label: 'In-centre', hint: 'Schedule me on the floor every selected day' },
                { v: 'online', label: 'Online',    hint: 'Schedule me online every selected day' },
              ].map(opt => (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setWeeklyPreferredAssignment(opt.v)}
                  title={opt.hint}
                  className={`rounded-xl px-3 py-2.5 text-xs font-bold border-2 transition-all ${
                    weeklyPreferredAssignment === opt.v
                      ? 'bg-emerald-50 border-emerald-400 text-emerald-700'
                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Note (optional) — same field name as single-day modal so admins
              see it in exactly the same place when reviewing availability. */}
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Note (optional)</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. Online only this week · Can stay later if needed · Prefer HS side"
              className="w-full rounded-xl border-2 border-gray-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
            {note.trim() && (
              <label className="mt-2 flex items-center gap-2 text-xs font-semibold text-emerald-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={noteAppliesToAll}
                  onChange={e => setNoteAppliesToAll(e.target.checked)}
                  className="accent-emerald-600 h-4 w-4"
                />
                Apply this note to every selected day
                {!noteAppliesToAll && (
                  <span className="ml-1 font-normal text-gray-500">
                    — click date chips below to toggle individually
                  </span>
                )}
              </label>
            )}
          </div>

          {/* Recurrence */}
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Repeats</label>
            <div className="grid grid-cols-2 gap-2">
              {RECURRENCE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setRecurrence(opt.value)}
                  className={`rounded-xl px-3 py-2.5 text-xs font-semibold border-2 text-left transition-all ${
                    recurrence === opt.value
                      ? 'bg-blue-50 border-blue-400 text-blue-700'
                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Scope */}
          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Apply To</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: 'thisMonth', label: format(currentMonth, 'MMM') },
                { value: 'nextMonth', label: format(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1), 'MMM') },
                { value: 'both',      label: 'Both' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setScope(opt.value)}
                  className={`rounded-xl px-3 py-2.5 text-xs font-bold border-2 transition-all ${
                    scope === opt.value
                      ? 'bg-purple-50 border-purple-400 text-purple-700'
                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          {preview.length > 0 && (
            <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-gray-600 uppercase tracking-widest">
                  Preview — {preview.length} day{preview.length !== 1 ? 's' : ''}
                </span>
                <div className="flex items-center gap-3">
                  {excludedDates.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setExcludedDates(new Set())}
                      className="text-xs font-semibold text-blue-600 hover:text-blue-800 transition-colors"
                    >
                      Restore {excludedDates.size} removed
                    </button>
                  )}
                  {overwriteCount > 0 && (
                    <span className="text-xs text-orange-600 font-semibold">
                      ⚠ Overwrites {overwriteCount} existing
                    </span>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-gray-500 mb-2">Click the × on any date to skip it.</p>
              {/* Per-date toggle is enabled only when the user has typed a
                  note AND turned OFF "apply to all". A small dot on each
                  chip shows whether the note applies; clicking the chip
                  body toggles it. The × button still removes the date
                  from the batch entirely (independent of the note). */}
              {note.trim() && !noteAppliesToAll && (
                <p className="text-[11px] text-gray-500 mb-2">
                  Click a date to toggle whether the note applies. Dot = note on.
                </p>
              )}
              <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                {preview.map(item => {
                  const isOverwrite = existingDates.has(item.date);
                  const noteOn = !!item.comment;
                  const perDateToggleEnabled = note.trim() && !noteAppliesToAll;
                  const toggleNote = () => {
                    if (!perDateToggleEnabled) return;
                    setNoteExcludedDates(prev => {
                      const next = new Set(prev);
                      if (next.has(item.date)) next.delete(item.date);
                      else next.add(item.date);
                      return next;
                    });
                  };
                  return (
                    <span
                      key={item.date}
                      title={`${fmtTime(item.startTime)} – ${fmtTime(item.endTime)}${item.comment ? ` · note: ${item.comment}` : ''}`}
                      onClick={toggleNote}
                      className={`group inline-flex items-center gap-1 rounded-lg pl-2 pr-1 py-1 text-xs font-medium ${
                        isOverwrite
                          ? 'bg-orange-100 text-orange-700'
                          : 'bg-emerald-100 text-emerald-700'
                      } ${perDateToggleEnabled ? 'cursor-pointer' : ''}`}
                    >
                      {noteOn && (
                        <span className={`h-1.5 w-1.5 rounded-full ${isOverwrite ? 'bg-orange-500' : 'bg-emerald-600'}`} />
                      )}
                      {new Date(item.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setExcludedDates(prev => new Set(prev).add(item.date)); }}
                        title="Remove this date from the batch"
                        className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold transition-colors ${
                          isOverwrite
                            ? 'text-orange-500 hover:bg-orange-200 hover:text-orange-800'
                            : 'text-emerald-500 hover:bg-emerald-200 hover:text-emerald-800'
                        }`}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {preview.length === 0 && selectedDays.length > 0 && (
            <div className="rounded-xl bg-yellow-50 border border-yellow-200 px-4 py-3 text-xs text-yellow-700 font-medium">
              No upcoming dates match your selection.
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || preview.length === 0}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50 active:scale-95 transition-all"
            >
              {saving
                ? <><Loader2 size={14} className="animate-spin" /> Saving {preview.length} days…</>
                : <><Check size={14} /> Save {preview.length > 0 ? `${preview.length} days` : ''}</>
              }
            </button>
            <button
              onClick={onClose}
              className="rounded-xl border-2 border-gray-200 px-5 py-3 text-sm font-semibold text-gray-500 hover:bg-gray-50 active:scale-95 transition-all"
            >
              Cancel
            </button>
          </div>
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

// ─── Calendar Sync Modal ─────────────────────────────────────────────────
// Gives each user a private iCal subscription link (served by
// /api/calendar/<token>.ics) that Apple / Google Calendar can subscribe to.
// The token lives on their own user doc; resetting it rotates the token and
// invalidates old subscriptions. See api/calendar/[token].js.
function CalendarSyncModal({ profile, onClose }) {
  const [token, setToken] = useState(profile?.calendarToken || '');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const httpsUrl = token ? `${origin}/api/calendar/${token}.ics` : '';
  const webcalUrl = httpsUrl.replace(/^https?:\/\//i, 'webcal://');

  const genToken = () => (
    (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );

  const saveToken = async (newToken) => {
    if (!profile?.uid) return;
    setBusy(true);
    try {
      await updateDoc(doc(db, 'users', profile.uid), { calendarToken: newToken });
      setToken(newToken);
    } catch (err) {
      toast.error(err?.message || 'Could not update your calendar link.');
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    const ok = window.confirm('Reset your calendar link? Any device already subscribed with the old link will stop updating and will need the new one.');
    if (ok) await saveToken(genToken());
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(httpsUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the field is selectable to copy manually */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 bg-gradient-to-r from-blue-50 to-white">
          <div className="flex items-center gap-2">
            <CalendarPlus size={18} className="text-blue-600" />
            <h3 className="text-base font-bold text-gray-900">Sync to your calendar</h3>
          </div>
          <button onClick={onClose} className="rounded-full w-8 h-8 flex items-center justify-center hover:bg-gray-100 text-gray-400">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600">
            Add your Ratio shifts and approved time off to Apple or Google Calendar. It keeps itself
            up to date — your calendar app re-checks the link every few hours.
          </p>

          {!token ? (
            <button
              onClick={() => saveToken(genToken())}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />}
              Generate my calendar link
            </button>
          ) : (
            <>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Your private calendar link</label>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={httpsUrl}
                    onFocus={e => e.target.select()}
                    className="flex-1 rounded-lg border px-3 py-2 text-xs font-mono text-gray-700 bg-gray-50"
                  />
                  <button
                    onClick={handleCopy}
                    className="shrink-0 flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                  </button>
                </div>
                <p className="mt-1 text-xs text-amber-600">Keep this private — anyone with the link can see your schedule.</p>
              </div>

              <a
                href={webcalUrl}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-800"
              >
                <Smartphone size={15} /> Add to Apple Calendar
              </a>

              <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 text-xs text-gray-600 space-y-1">
                <p className="font-semibold text-gray-700">Google Calendar (on a computer)</p>
                <p>Next to <b>Other calendars</b> click <b>+</b> → <b>From URL</b> → paste the link → <b>Add calendar</b>.</p>
                <p className="font-semibold text-gray-700 mt-2">iPhone / Apple Calendar</p>
                <p>Tap <b>Add to Apple Calendar</b> above, or Settings → Calendar → Accounts → Add Account → Other → <b>Add Subscribed Calendar</b>, then paste the link.</p>
              </div>

              <button
                onClick={handleReset}
                disabled={busy}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-red-600 disabled:opacity-50"
              >
                <RotateCcw size={13} /> Reset link (breaks old subscriptions)
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Schedule() {
  const { profile, mySubRoles, activeCenterId, centerConfig } = useAuth();
  const fullDayByDow = useMemo(() => buildFullDayByDow(centerConfig), [centerConfig]);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);
  const [showWeeklyModal, setShowWeeklyModal] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [availability, setAvailability] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [openShifts, setOpenShifts] = useState([]);
  const [timeOffRequests, setTimeOffRequests] = useState([]);
  // Inline edit state for a PENDING time-off request. null = not editing.
  // Holds a working copy so the instructor can tweak dates/reason before
  // saving; approved/denied requests can never enter this state.
  const [editTO, setEditTO] = useState(null); // { id, startDate, endDate, reason, error, saving }

  // ── Firestore listeners — all scoped to the active center and
  //    bounded by a sliding date window so reads don't scale with
  //    centre-age. See LISTENER_WINDOW_DAYS for the cutoff.
  const windowStart = listenerWindowStart();

  useEffect(() => onSnapshot(
    query(
      collection(db, 'availability'),
      where('centerId', '==', activeCenterId),
      where('date', '>=', windowStart),
      orderBy('date'),
    ),
    snap => setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId, windowStart]);

  useEffect(() => onSnapshot(
    query(
      collection(db, 'shifts'),
      where('centerId', '==', activeCenterId),
      where('date', '>=', windowStart),
      orderBy('date'),
    ),
    snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId, windowStart]);

  useEffect(() => onSnapshot(
    query(
      collection(db, 'openShifts'),
      where('centerId', '==', activeCenterId),
      where('date', '>=', windowStart),
    ),
    snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId, windowStart]);

  // Time-off requests are low-volume per centre (a few per month at most)
  // and don't have a `date` field on the doc — the date range lives in
  // startDate/endDate. We leave this listener unbounded for now; revisit
  // if a centre ever piles up thousands.
  useEffect(() => onSnapshot(
    query(collection(db, 'timeOffRequests'), where('centerId', '==', activeCenterId)),
    snap => setTimeOffRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId]);

  // ── Calendar grid ──
  const monthStart = startOfMonth(currentMonth);
  const monthEnd   = endOfMonth(currentMonth);
  const days       = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPad   = getDay(monthStart);

  // ── My data ──
  // Drafts (status === 'draft') are hidden from instructors — they only see
  // shifts the owner has explicitly published. Legacy shifts with no status
  // field stay visible (treated as live).
  const myShifts = useMemo(
    () => shifts.filter(s => s.userId === profile?.uid && s.status !== 'draft'),
    [shifts, profile],
  );
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

  // Deterministic id makes availability writes idempotent: writing the same
  // (user, date) pair just overwrites — no delete-then-add race window.
  const availDocId = (uid, dateStr) => `${uid}_${dateStr}`;

  // ── Handlers (throw on error so modal can catch) ──
  const handleSaveAvail = async (dateStr, startTime, endTime, comment, preferredAssignment) => {
    const id = availDocId(profile.uid, dateStr);
    // If a legacy doc with a random ID exists for this date, remove it
    // so we don't end up with two records for the same (user, date).
    const existing = myAvailMap[dateStr];
    if (existing && existing.id !== id) {
      await deleteDoc(doc(db, 'availability', existing.id));
    }
    await setDoc(doc(db, 'availability', id), {
      userId: profile.uid,
      userName: profile.displayName,
      centerId: activeCenterId,
      date: dateStr,
      startTime,
      endTime,
      comment: comment || '',
      // Per-day routing preference — scheduler.effectiveTrack() reads it.
      // 'either' is the no-op default; 'centre' / 'online' override the
      // instructor's profile track for this one day.
      preferredAssignment: preferredAssignment || 'either',
    });
    setSelectedDate(null);
  };

  // Items shape: [{date, startTime, endTime}]. Per-day times let the weekly
  // modal apply different hours to different days (e.g., Saturday's full-day
  // range vs weekday's full-day range when "Full Day" is on).
  const handleSaveBulk = async (items) => {
    // Use a batched write: all-or-nothing, no partial state if it fails.
    // Firestore batch limit is 500 ops, so chunk if we somehow exceed that.
    const CHUNK = 200; // leave headroom for possible legacy deletes within a chunk
    for (let i = 0; i < items.length; i += CHUNK) {
      const batch = writeBatch(db);
      for (const item of items.slice(i, i + CHUNK)) {
        const id = availDocId(profile.uid, item.date);
        // Clean up any legacy random-id doc for this date in the same batch
        const existing = myAvailMap[item.date];
        if (existing && existing.id !== id) {
          batch.delete(doc(db, 'availability', existing.id));
        }
        batch.set(doc(db, 'availability', id), {
          userId: profile.uid,
          userName: profile.displayName,
          centerId: activeCenterId,
          date: item.date,
          startTime: item.startTime,
          endTime: item.endTime,
          // Same field name as the single-day modal so admins read it
          // identically. Empty string when the user didn't opt this date
          // into the note (or didn't enter one at all).
          comment: item.comment || '',
          // Same field name as the single-day modal so the scheduler
          // honours the override identically on bulk-set days.
          preferredAssignment: item.preferredAssignment || 'either',
          bulkSet: true,
        });
      }
      await batch.commit();
    }
    setShowWeeklyModal(false);
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
      centerId: activeCenterId,
      createdAt: serverTimestamp(),
      type: 'shift_swap',
      shiftId: shift.id,
      shiftDate: shift.date,
      shiftStartTime: shift.startTime,
      shiftEndTime: shift.endTime,
      shiftRole: shift.role || '',
      // Capability required to take this shift. Host shifts require the Host
      // capability (not the teaching level), so only staff tagged Host can
      // take them; teaching shifts still require the matching sub-role.
      shiftSubRole: requiredCapabilityForShift(shift),
      swapStatus: 'open',
      acceptedBy: null,
      acceptedByName: null,
    });
    setSelectedDate(null);
    const cap = requiredCapabilityForShift(shift);
    const who = cap === 'Host' ? 'staff who can host' : cap ? `staff tagged ${cap}` : 'other staff';
    toast.success(`Posted to the Shift Board! Only ${who} can take it.`);
  };

  const handleClaimOpenShift = async (openShift) => {
    if (openShift.status !== 'open') {
      toast.error('This shift has already been claimed.');
      return;
    }
    // Capability gate — a Host shift can only be claimed by staff tagged
    // Host; teaching shifts require the matching sub-role. Guards every
    // claim path (Shift Board + this Day modal).
    const required = requiredCapabilityForShift(openShift);
    if (required && !hasCapability(mySubRoles, required)) {
      toast.error(required === 'Host'
        ? 'Only staff who can host can claim this shift.'
        : `This shift requires the ${required} sub-role — you don't have it.`);
      return;
    }
    try {
      // Atomically: re-check the openShift is still open, mark it claimed,
      // and create the matching shifts doc in one transaction. Prevents two
      // instructors clicking "Claim" at the same time from both succeeding.
      const newShiftRef = doc(collection(db, 'shifts'));
      await runTransaction(db, async (tx) => {
        const openRef = doc(db, 'openShifts', openShift.id);
        const openSnap = await tx.get(openRef);
        if (!openSnap.exists()) throw new Error('This open shift no longer exists.');
        const data = openSnap.data();
        if (data.status !== 'open') {
          throw new Error('This shift has already been claimed.');
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

      const dateFormatted = new Date(openShift.date + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'short', day: 'numeric',
      });
      await addDoc(collection(db, 'chat'), {
        text: `✅ ${profile.displayName} has claimed the open shift on ${dateFormatted} (${fmtTime(openShift.startTime)} – ${fmtTime(openShift.endTime)}).`,
        userId: 'system',
        userName: centerConfig?.name || 'Mathnasium',
        userRole: 'system',
        centerId: openShift.centerId || activeCenterId,
        createdAt: serverTimestamp(),
        type: 'shift_confirmation',
      });
      setSelectedDate(null);
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

  const handleRequestTimeOff = async (startDate, endDate, reason) => {
    await addDoc(collection(db, 'timeOffRequests'), {
      userId: profile.uid,
      userName: profile.displayName,
      centerId: activeCenterId,
      startDate,
      endDate,
      reason,
      status: 'pending',
      createdAt: serverTimestamp(),
    });
    setSelectedDate(null);
    toast.success('Time off request submitted! The admin team will review it.');
  };

  // Edit a PENDING time-off request in place. Guarded to pending only —
  // an approved/denied request is locked. Stamps `edited`/`editedAt` so
  // the admin review screen can flag that the instructor changed it after
  // submitting.
  const handleUpdateTimeOff = async () => {
    if (!editTO) return;
    const { id, startDate, endDate, reason } = editTO;
    if (!startDate || !endDate) {
      setEditTO(e => ({ ...e, error: 'Pick both a start and end date.' }));
      return;
    }
    if (endDate < startDate) {
      setEditTO(e => ({ ...e, error: 'End date can’t be before the start date.' }));
      return;
    }
    if (!reason.trim()) {
      setEditTO(e => ({ ...e, error: 'Please enter a reason.' }));
      return;
    }
    // Only allow editing while still pending (defends against a stale
    // client whose request was approved/denied in another tab).
    const current = timeOffRequests.find(r => r.id === id);
    if (current && current.status !== 'pending') {
      setEditTO(null);
      toast.error('This request was already reviewed and can no longer be edited.');
      return;
    }
    setEditTO(e => ({ ...e, saving: true, error: '' }));
    try {
      await updateDoc(doc(db, 'timeOffRequests', id), {
        startDate,
        endDate,
        reason: reason.trim(),
        edited: true,
        editedAt: serverTimestamp(),
      });
      setEditTO(null);
      toast.success('Time off request updated. The admin team will see your changes.');
    } catch (err) {
      setEditTO(e => ({ ...e, saving: false, error: err?.message || 'Failed to update request.' }));
    }
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
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-blue-100 p-2.5 text-blue-600">
            <CalendarDays size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">My Schedule</h1>
            <p className="text-sm text-gray-500">View shifts, set availability, and manage time off</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSyncModal(true)}
            className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-bold text-gray-700 shadow-sm hover:bg-gray-50 active:scale-95 transition-all"
            title="Sync your shifts to Apple or Google Calendar"
          >
            <CalendarPlus size={15} /> Sync Calendar
          </button>
          <button
            onClick={() => setShowWeeklyModal(true)}
            className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 active:scale-95 transition-all"
          >
            <Repeat size={15} /> Set Weekly
          </button>
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
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-2.5 border-b border-gray-100 bg-gray-50/50">
          {[
            { color: 'bg-lime-500',    label: 'Elementary' },
            { color: 'bg-cyan-500',    label: 'Highschool' },
            { color: 'bg-indigo-700',  label: 'Online Subject' },
            { color: 'bg-emerald-500', label: 'Available' },
            { color: 'bg-orange-400',  label: 'Open Shift' },
            { color: 'bg-yellow-400',  label: 'Time Off (Pending)' },
            { color: 'bg-teal-500',    label: 'Time Off (Approved)' },
          ].map(item => (
            <span key={item.label} className="flex items-center gap-1.5 text-xs text-gray-500 font-medium">
              <span className={`w-2.5 h-2.5 rounded-sm inline-block ${item.color}`} />
              {item.label}
            </span>
          ))}
          <span className="text-gray-300 mx-1">|</span>
          <span className="flex items-center gap-1 text-xs text-gray-500 font-medium">
            <Building2 size={12} /> In-Centre
          </span>
          <span className="flex items-center gap-1 text-xs text-gray-500 font-medium">
            <Laptop size={12} /> Online
          </span>
          <span className="flex items-center gap-1 text-xs text-gray-500 font-medium">
            <Wifi size={12} /> Both
          </span>
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
            const isClosed = isCenterClosedOn(day, centerConfig);
            const closedLabel = isClosed ? closureReason(day, centerConfig) : null;

            let cellBg = 'bg-white hover:bg-gray-50/80';
            let content = null;
            let clickable = !isPast;

            if (state.type === 'shift') {
              // Color the shift block by sub-role so an instructor can scan
              // their calendar and see at a glance whether each day is
              // Elementary / Highschool / Online. Sick Pay overrides every
              // sub-role colour with deep burgundy so it's instantly
              // distinguishable from a regular working day.
              const sickStyle = sickStyleFor(state.shift);
              // Flex roles (STEAM / Summer Camp) get their own loud colour so
              // the calendar shows who's off the teaching floor. Sick Pay
              // still wins (attendance state) if somehow both are set.
              const sStyle = sickStyle || flexStyleFor(state.shift) || subRoleStyleFor(state.shift.subRole);
              const blockBg     = sStyle ? sStyle.blockBg     : 'bg-blue-500';
              const blockText   = sStyle ? sStyle.blockText   : 'text-white';
              const blockSubText= sStyle ? sStyle.blockSubText: 'text-blue-100';
              const blockMuted  = sStyle ? sStyle.blockSubText: 'text-blue-200';
              // shiftType icon — tells the instructor WHERE they're working.
              const stStyle = shiftTypeStyle(state.shift.shiftType);
              const StIcon  = stStyle.icon;
              cellBg = 'bg-gray-50/60 hover:bg-gray-50 cursor-pointer';
              content = (
                <div className={`mt-1 rounded-lg px-1.5 py-1 shadow-sm ${blockBg}`}>
                  <div className="flex items-center gap-1">
                    <p className={`text-xs font-bold leading-tight ${blockText} flex-1`}>
                      {fmtTime(state.shift.startTime)}
                    </p>
                    {/* Tiny shiftType icon in the top-right of the block. */}
                    <StIcon size={10} className={blockText} aria-label={stStyle.label} />
                  </div>
                  <p className={`text-xs leading-tight ${blockSubText}`}>
                    {fmtTime(state.shift.endTime)}
                  </p>
                  {sStyle && (
                    <p className={`text-xs font-bold uppercase tracking-wide leading-tight mt-0.5 ${blockMuted}`} style={{ fontSize: '10px' }}>
                      {sStyle.label}
                    </p>
                  )}
                </div>
              );
            } else if (state.type === 'available') {
              cellBg = 'bg-emerald-50/60 hover:bg-emerald-50 cursor-pointer';
              const isFull = isFullDayAvail(state.avail.startTime, state.avail.endTime);
              content = (
                <div className="mt-1 rounded-lg bg-emerald-500 px-1.5 py-1 shadow-sm">
                  <p className="text-white text-xs font-bold leading-tight">Available</p>
                  <p className="text-emerald-100 text-xs leading-tight">
                    {isFull ? 'Full day' : fmtTime(state.avail.startTime)}
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
              cellBg = state.approved ? 'bg-teal-50/60 cursor-pointer' : 'bg-red-50/60 cursor-pointer';
              content = state.approved ? (
                <div className="mt-1 rounded-lg bg-teal-500 px-1.5 py-1 shadow-sm flex items-center gap-1">
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

            // Closed days (non-operating weekday OR a configured holiday)
            // — greyed and locked so nobody can add availability or shifts.
            // We show the closure reason when there's one (e.g. the holiday
            // name) so staff understand why the day is unavailable.
            if (isClosed) {
              clickable = false;
              cellBg = 'bg-gray-100/70';
              if (!content) content = (
                <p className="mt-2 text-center text-[10px] font-medium uppercase tracking-wide text-gray-400">
                  {closedLabel || 'Closed'}
                </p>
              );
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
          approved: { label: 'Approved', bg: 'bg-teal-100',   text: 'text-teal-700',   dot: 'bg-teal-500'  },
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

                // Inline edit form — pending requests only.
                if (editTO?.id === req.id) {
                  return (
                    <div key={req.id} className="rounded-xl border border-yellow-300 bg-yellow-50/40 p-4 shadow-sm">
                      <div className="flex items-center gap-2 mb-3">
                        <CalendarDays size={14} className="text-gray-400 shrink-0" />
                        <span className="text-sm font-semibold text-gray-800">Editing request</span>
                        <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-yellow-100 text-yellow-700">Pending</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 mb-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Start date</label>
                          <input type="date" value={editTO.startDate}
                            onChange={e => setEditTO(v => ({ ...v, startDate: e.target.value, error: '' }))}
                            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">End date</label>
                          <input type="date" value={editTO.endDate}
                            onChange={e => setEditTO(v => ({ ...v, endDate: e.target.value, error: '' }))}
                            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
                        </div>
                      </div>
                      <label className="block text-xs text-gray-500 mb-1">Reason</label>
                      <textarea value={editTO.reason} rows={2}
                        onChange={e => setEditTO(v => ({ ...v, reason: e.target.value, error: '' }))}
                        className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
                      {editTO.error && <p className="mt-1 text-xs text-red-600">{editTO.error}</p>}
                      <div className="mt-3 flex gap-2">
                        <button onClick={handleUpdateTimeOff} disabled={editTO.saving}
                          className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-colors">
                          {editTO.saving ? 'Saving…' : 'Save changes'}
                        </button>
                        <button onClick={() => setEditTO(null)} disabled={editTO.saving}
                          className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors">
                          Cancel
                        </button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={req.id} className={`rounded-xl border bg-white p-4 shadow-sm flex items-start justify-between gap-4 ${req.status === 'denied' ? 'opacity-60' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <CalendarDays size={14} className="text-gray-400 shrink-0" />
                        <span className="text-sm font-semibold text-gray-800">
                          {sameDay ? startLabel : `${startLabel} – ${endLabel}`}
                        </span>
                        {req.edited && (
                          <span className="text-[10px] text-gray-400 italic">· edited</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mb-2 truncate">
                        <span className="font-medium text-gray-600">Reason:</span> {req.reason}
                      </p>
                      {req.status === 'denied' && (
                        <p className="text-xs text-red-500 font-medium">This request was denied — dates are available again.</p>
                      )}
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-2 h-2 rounded-full ${s.dot}`} />
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${s.bg} ${s.text}`}>
                          {s.label}
                        </span>
                      </div>
                      {req.status === 'pending' && (
                        <button
                          onClick={() => setEditTO({ id: req.id, startDate: req.startDate, endDate: req.endDate, reason: req.reason || '', error: '', saving: false })}
                          className="text-xs font-semibold text-gray-500 hover:text-gray-800 underline underline-offset-2">
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Weekly Availability Modal */}
      {showWeeklyModal && (
        <WeeklyAvailabilityModal
          currentMonth={currentMonth}
          availability={availability}
          profile={profile}
          fullDayByDow={fullDayByDow}
          centerConfig={centerConfig}
          onClose={() => setShowWeeklyModal(false)}
          onSaveBulk={handleSaveBulk}
        />
      )}

      {/* Calendar Sync Modal */}
      {showSyncModal && (
        <CalendarSyncModal profile={profile} onClose={() => setShowSyncModal(false)} />
      )}

      {/* Day Modal */}
      {selectedDate && (
        <DayModal
          date={selectedDate}
          myAvailability={myAvailMap[format(selectedDate, 'yyyy-MM-dd')]}
          myShift={myShifts.find(s => s.date === format(selectedDate, 'yyyy-MM-dd'))}
          openShifts={openShifts.filter(s => s.date === format(selectedDate, 'yyyy-MM-dd') && s.status === 'open')}
          timeOffMap={myTimeOffMap}
          fullDayByDow={fullDayByDow}
          centerConfig={centerConfig}
          isClosedDay={isCenterClosedOn(selectedDate, centerConfig)}
          onClose={() => setSelectedDate(null)}
          onSaveAvail={handleSaveAvail}
          onDeleteAvail={handleDeleteAvail}
          onPostSwap={handlePostSwap}
          onClaimOpenShift={handleClaimOpenShift}
          onRequestTimeOff={handleRequestTimeOff}
          mySubRoles={mySubRoles}
        />
      )}
    </div>
  );
}
