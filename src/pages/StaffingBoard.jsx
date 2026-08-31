/**
 * StaffingBoard — the shifts the bookings call for, and who fills them.
 *
 * THE IDEA
 *   Pick a day or a week. The board reads the students actually booked on
 *   those dates, works out how many instructors each half-hour needs, and
 *   turns that curve into concrete SHIFTS — "Tue Sep 8, 3:00–7:00" — with a
 *   slot for a person in each one.
 *
 *   Then you fill them. Everyone with availability that day sits on the bench
 *   underneath; click a person, click a slot. The board never assigns anybody
 *   behind your back — Auto-fill is a button you press, and every placement it
 *   makes can be undone with one click.
 *
 * WHY A BOARD AND NOT A TABLE
 *   The old flow buried this in the scheduler config: a table of ratio maths
 *   that told you a day wanted 6 people and then stopped, leaving you to work
 *   out who. The shifts are the unit of the decision, so they're the unit of
 *   the interface.
 *
 * WHAT IT DOESN'T DO
 *   It doesn't publish. Saving writes `status: 'draft'` shifts, same as the
 *   auto-scheduler, and you publish from the weekly grid as always.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { collection, query, where, orderBy, onSnapshot, writeBatch, doc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import { format, startOfWeek, addDays } from 'date-fns';
import {
  CalendarDays, Wand2, Save, X, Users, AlertTriangle, Loader2, RotateCcw,
} from 'lucide-react';
import { inCentreDemandBySlot, requiredForSlot } from '../lib/demand-staffing';
import { blocksFromCurve, toMinutes, toHHMM } from '../lib/shift-shaping';
import { DEFAULT_TARGET_RATIO } from '../lib/subRoles';
import { buildTimeOffIndex, timeOffOn, isOffOn } from '../lib/timeOff';
import Avatar from '../components/Avatar';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Management is fixed staff, scheduled outside this system entirely.
const MANAGEMENT_ROLES = new Set(['owner', 'super_admin', 'director']);

/** Lower sorts first: Leads outrank Instructors. Nothing else ranks. */
const rankOf = (u) => (u?.instructorType || '').trim().toLowerCase() === 'lead' ? 0 : 1;

/** Trainees and volunteers are on the floor but never fill a ratio slot. */
function coversSlots(u) {
  if (u?.isVolunteer === true) return false;
  const t = (u?.instructorType || '').trim().toLowerCase();
  return t !== 'training' && t !== 'volunteer';
}

function fmt12(hhmm) {
  const m = toMinutes(hhmm);
  if (m == null) return hhmm;
  const h = Math.floor(m / 60), min = m % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return min === 0 ? `${h12}${ampm}` : `${h12}:${String(min).padStart(2, '0')}${ampm}`;
}

export default function StaffingBoard() {
  const { activeCenterId, centerConfig } = useAuth();

  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [ratio, setRatio] = useState(DEFAULT_TARGET_RATIO);
  const [minShiftHours, setMinShiftHours] = useState(2);

  const [users, setUsers] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [timeOff, setTimeOff] = useState([]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [board, setBoard] = useState(null);   // { days: [{ date, ... , slots: [] }] }
  const [picked, setPicked] = useState(null); // uid currently selected on the bench
  const [error, setError] = useState('');

  // ── Range ────────────────────────────────────────────────────────────────
  const range = useMemo(() => {
    if (mode === 'day') return { start: anchor, end: anchor };
    const monday = startOfWeek(new Date(anchor + 'T00:00:00'), { weekStartsOn: 1 });
    return {
      start: format(monday, 'yyyy-MM-dd'),
      end: format(addDays(monday, 6), 'yyyy-MM-dd'),
    };
  }, [mode, anchor]);

  // ── Live staff + availability ────────────────────────────────────────────
  useEffect(() => {
    if (!activeCenterId) return;
    const u1 = onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => setError(err.message),
    );
    const u2 = onSnapshot(
      query(
        collection(db, 'availability'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', range.start),
        orderBy('date'),
      ),
      snap => setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => setError(err.message),
    );
    // Unbounded like the Admin page: low volume per centre, and there's no
    // single `date` field to range-filter on (it lives in startDate/endDate).
    const u3 = onSnapshot(
      query(collection(db, 'timeOffRequests'), where('centerId', '==', activeCenterId)),
      snap => setTimeOff(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setTimeOff([]),
    );
    return () => { u1(); u2(); u3(); };
  }, [activeCenterId, range.start]);

  const timeOffIndex = useMemo(() => buildTimeOffIndex(timeOff), [timeOff]);

  // Everyone the board may place: approved centre floor staff, no management.
  const floorStaff = useMemo(() => users.filter(u =>
    u.approved && !MANAGEMENT_ROLES.has(u.role) && coversSlots(u)
  ), [users]);

  /**
   * Who is free on a date, and for what window.
   *
   * APPROVED time off removes someone outright — a granted day off must never
   * be fillable. A PENDING request leaves them on the bench but flagged, since
   * an undecided request shouldn't quietly shrink the roster; approve it first.
   */
  const availableOn = useCallback((dateStr) => {
    const out = [];
    for (const u of floorStaff) {
      if (isOffOn(timeOffIndex, u.uid, dateStr)) continue;
      const a = availability.find(x => x.userId === u.uid && x.date === dateStr);
      if (!a?.startTime || !a?.endTime) continue;
      const s = toMinutes(a.startTime), e = toMinutes(a.endTime);
      if (s == null || e == null || e <= s) continue;
      const pending = timeOffOn(timeOffIndex, u.uid, dateStr);
      out.push({
        uid: u.uid, name: u.displayName, user: u,
        availStart: s, availEnd: e,
        pendingTimeOff: pending ? (pending.reason || 'Time off requested') : null,
      });
    }
    return out.sort((a, b) =>
      (rankOf(a.user) - rankOf(b.user)) || a.name.localeCompare(b.name));
  }, [floorStaff, availability, timeOffIndex]);

  // ── Build the board from real bookings ───────────────────────────────────
  const generate = async () => {
    if (!activeCenterId) return;
    setLoading(true); setError(''); setPicked(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not signed in.');

      const res = await fetch(
        `/api/scheduler/appointments?centerId=${encodeURIComponent(activeCenterId)}` +
        `&start=${range.start}&end=${range.end}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || 'Could not read bookings.');
      if (payload?.warning) toast.error(payload.warning);

      const holidays = new Set(
        (Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [])
          .map(h => h?.date).filter(Boolean),
      );

      const minSlots = Math.max(1, Math.round((minShiftHours * 60) / 30));

      const days = (payload.days || []).map(grouped => {
        const date = grouped.day;
        const dayName = DAY_NAMES[new Date(date + 'T12:00:00').getDay()];

        if (holidays.has(date)) {
          return { date, dayName, closed: true, reason: 'Centre closed', slots: [], peakStudents: 0 };
        }

        const demand = inCentreDemandBySlot(grouped);
        if (demand.length === 0) {
          return {
            date, dayName, closed: false, empty: true,
            reason: 'No bookings — nothing to staff', slots: [], peakStudents: 0,
          };
        }

        const slotKeys = demand.map(d => d.slot);
        const required = demand.map(d => requiredForSlot(d.students, ratio));
        const blocks = blocksFromCurve(required, slotKeys, minSlots);

        // The host desk runs the whole day and sits outside the ratio, so it's
        // its own slot rather than one of the coverage blocks.
        const dayStart = toMinutes(slotKeys[0]);
        const dayEnd = toMinutes(slotKeys[slotKeys.length - 1]) + 30;

        const slots = [
          {
            id: `${date}-host`,
            kind: 'host',
            start: toHHMM(dayStart),
            end: toHHMM(dayEnd),
            assigned: null,
          },
          ...blocks.map((b, i) => ({
            id: `${date}-b${i}`,
            kind: 'coverage',
            start: b.start,
            end: b.end,
            widened: b.widened,
            assigned: null,
          })),
        ];

        return {
          date, dayName, closed: false, empty: false,
          window: { start: slotKeys[0], end: toHHMM(dayEnd) },
          peakStudents: Math.max(...demand.map(d => d.students)),
          peakRequired: Math.max(...required),
          curve: demand.map((d, i) => ({ slot: d.slot, students: d.students, required: required[i] })),
          slots,
        };
      });

      setBoard({ range, days, ratio, minShiftHours });
      const total = days.reduce((a, d) => a + d.slots.filter(s => s.kind === 'coverage').length, 0);
      toast.success(`${total} shift${total === 1 ? '' : 's'} built from bookings. Assign your instructors.`);
    } catch (err) {
      console.error('[StaffingBoard] generate failed:', err);
      setError(err.message || 'Could not build the board.');
    } finally {
      setLoading(false);
    }
  };

  // ── Assignment ───────────────────────────────────────────────────────────
  const canCover = (person, slot) =>
    person.availStart <= toMinutes(slot.start) && person.availEnd >= toMinutes(slot.end);

  const assignedElsewhere = (day, uid, slotId) =>
    day.slots.some(s => s.id !== slotId && s.assigned?.uid === uid);

  const place = (dateStr, slotId, person) => {
    setBoard(b => ({
      ...b,
      days: b.days.map(d => d.date !== dateStr ? d : {
        ...d,
        slots: d.slots.map(s => s.id !== slotId ? s : {
          ...s,
          assigned: person ? { uid: person.uid, name: person.name, role: person.user?.instructorType || 'Instructor' } : null,
        }),
      }),
    }));
  };

  const onSlotClick = (day, slot) => {
    if (slot.assigned) { place(day.date, slot.id, null); setPicked(null); return; }
    if (!picked) return;
    const person = availableOn(day.date).find(p => p.uid === picked);
    if (!person) return;
    if (!canCover(person, slot)) {
      toast.error(`${person.name} isn't available ${fmt12(slot.start)}–${fmt12(slot.end)}.`);
      return;
    }
    if (assignedElsewhere(day, person.uid, slot.id)) {
      toast.error(`${person.name} already has a shift that day.`);
      return;
    }
    place(day.date, slot.id, person);
  };

  /**
   * Fill every empty slot the way the rules say: the designated host first,
   * then Leads before Instructors, then whoever has the fewest hours on the
   * board so far. Never overwrites a placement you made by hand.
   */
  const autoFill = () => {
    if (!board) return;
    const hours = {};
    // Seed from placements already on the board so manual choices count
    // toward fairness rather than being ignored by it.
    for (const d of board.days) {
      for (const s of d.slots) {
        if (!s.assigned) continue;
        hours[s.assigned.uid] = (hours[s.assigned.uid] || 0) +
          (toMinutes(s.end) - toMinutes(s.start)) / 60;
      }
    }

    const autoHostNames = (Array.isArray(centerConfig?.autoHostNames) && centerConfig.autoHostNames.length
      ? centerConfig.autoHostNames : ['Rahul Parmar']).map(n => String(n).toLowerCase());

    const days = board.days.map(day => {
      if (day.closed || day.empty) return day;
      const pool = availableOn(day.date);
      const taken = new Set(day.slots.filter(s => s.assigned).map(s => s.assigned.uid));

      const slots = day.slots.map(slot => {
        if (slot.assigned) return slot;

        let candidates = pool.filter(p =>
          !taken.has(p.uid) && canCover(p, slot));

        if (slot.kind === 'host') {
          // The designated host whenever they're free; otherwise anyone
          // host-capable. Never a plain instructor.
          const designated = candidates.filter(p => autoHostNames.includes(p.name.toLowerCase()));
          const hostCapable = candidates.filter(p =>
            (p.user?.instructorType || '').toLowerCase() === 'host');
          candidates = designated.length ? designated : hostCapable;
        } else {
          // The host doesn't take coverage shifts — they're out of rotation.
          candidates = candidates.filter(p =>
            (p.user?.instructorType || '').toLowerCase() !== 'host');
        }

        if (!candidates.length) return slot;

        candidates.sort((a, b) =>
          (rankOf(a.user) - rankOf(b.user)) ||
          ((hours[a.uid] || 0) - (hours[b.uid] || 0)) ||
          a.name.localeCompare(b.name));

        const chosen = candidates[0];
        taken.add(chosen.uid);
        hours[chosen.uid] = (hours[chosen.uid] || 0) +
          (toMinutes(slot.end) - toMinutes(slot.start)) / 60;
        return {
          ...slot,
          assigned: { uid: chosen.uid, name: chosen.name, role: chosen.user?.instructorType || 'Instructor' },
        };
      });

      return { ...day, slots };
    });

    setBoard(b => ({ ...b, days }));
    const filled = days.reduce((a, d) => a + d.slots.filter(s => s.assigned).length, 0);
    const total = days.reduce((a, d) => a + d.slots.length, 0);
    toast.success(`Filled ${filled} of ${total} slots. Click any of them to change it.`);
  };

  const clearAll = () => {
    if (!board) return;
    setBoard(b => ({
      ...b,
      days: b.days.map(d => ({ ...d, slots: d.slots.map(s => ({ ...s, assigned: null })) })),
    }));
    setPicked(null);
  };

  // ── Save ─────────────────────────────────────────────────────────────────
  const save = async () => {
    if (!board) return;
    const filled = board.days.flatMap(d =>
      d.slots.filter(s => s.assigned).map(s => ({ day: d, slot: s })));
    if (filled.length === 0) { toast.error('Nothing assigned yet.'); return; }

    setSaving(true);
    try {
      const batch = writeBatch(db);
      for (const { day, slot } of filled) {
        const ref = doc(collection(db, 'shifts'));
        batch.set(ref, {
          userId: slot.assigned.uid,
          userName: slot.assigned.name,
          centerId: activeCenterId,
          date: day.date,
          startTime: slot.start,
          endTime: slot.end,
          role: slot.kind === 'host' ? 'Host' : (slot.assigned.role || 'Instructor'),
          subRole: 'Elementary',
          status: 'draft',
          autoScheduled: false,
          fromStaffingBoard: true,
        });
      }
      await batch.commit();
      toast.success(`${filled.length} shifts saved as drafts. Publish them from the weekly grid.`);
    } catch (err) {
      console.error('[StaffingBoard] save failed:', err);
      toast.error(err.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!board) return null;
    const all = board.days.flatMap(d => d.slots);
    return {
      total: all.length,
      filled: all.filter(s => s.assigned).length,
      hours: all.filter(s => s.assigned)
        .reduce((a, s) => a + (toMinutes(s.end) - toMinutes(s.start)) / 60, 0),
    };
  }, [board]);

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-7">
      {/* Title */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight text-gray-900">Staffing Board</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Builds the shifts your bookings actually call for. You decide who works them.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Range
            </label>
            <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
              {[['day', 'Day'], ['week', 'Week']].map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-md px-3.5 py-1.5 text-sm font-semibold transition-all ${
                    mode === m
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
              {mode === 'day' ? 'Date' : 'Week of'}
            </label>
            <input
              type="date" value={anchor} onChange={e => setAnchor(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm tabular-nums focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-100"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Ratio
            </label>
            <div className="flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1.5 focus-within:border-purple-500 focus-within:ring-2 focus-within:ring-purple-100">
              <span className="text-sm text-gray-400">1:</span>
              <input
                type="number" step="0.5" min="1" value={ratio}
                onChange={e => setRatio(Number(e.target.value) || DEFAULT_TARGET_RATIO)}
                className="w-12 border-0 p-0 text-sm tabular-nums focus:outline-none focus:ring-0"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Min shift
            </label>
            <div className="flex items-center gap-1 rounded-lg border border-gray-300 px-2.5 py-1.5 focus-within:border-purple-500 focus-within:ring-2 focus-within:ring-purple-100">
              <input
                type="number" step="0.5" min="0.5" value={minShiftHours}
                onChange={e => setMinShiftHours(Number(e.target.value) || 2)}
                className="w-10 border-0 p-0 text-sm tabular-nums focus:outline-none focus:ring-0"
              />
              <span className="text-sm text-gray-400">h</span>
            </div>
          </div>

          <button
            onClick={generate}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-gray-800 disabled:opacity-50"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <CalendarDays size={15} />}
            Build shifts from bookings
          </button>

          <span className="ml-auto text-xs tabular-nums text-gray-400">
            {range.start === range.end ? range.start : `${range.start} → ${range.end}`}
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Sticky action bar — stays reachable while scrolling a week. */}
      {board && stats && (
        <div className="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-white/95 px-4 py-2.5 shadow-sm backdrop-blur">
          <div className="flex items-center gap-2.5">
            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-gray-200">
              <div
                className={`h-full rounded-full transition-all ${
                  stats.filled === stats.total ? 'bg-emerald-500' : 'bg-amber-500'}`}
                style={{ width: `${stats.total ? (stats.filled / stats.total) * 100 : 0}%` }}
              />
            </div>
            <span className="text-sm tabular-nums text-gray-700">
              <b className={stats.filled === stats.total ? 'text-emerald-700' : 'text-amber-700'}>
                {stats.filled}
              </b>
              <span className="text-gray-400"> / {stats.total} filled</span>
              <span className="mx-1.5 text-gray-300">·</span>
              <span className="text-gray-500">{stats.hours}h</span>
            </span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button onClick={autoFill}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:border-purple-400 hover:text-purple-700">
              <Wand2 size={13} /> Auto-fill
            </button>
            <button onClick={clearAll}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800">
              <RotateCcw size={13} /> Clear
            </button>
            <button onClick={save} disabled={saving || stats.filled === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-purple-700 disabled:opacity-40">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save as drafts
            </button>
          </div>
        </div>
      )}

      {board?.days.map(day => (
        <DayBoard
          key={day.date}
          day={day}
          bench={availableOn(day.date)}
          picked={picked}
          setPicked={setPicked}
          onSlotClick={onSlotClick}
          canCover={canCover}
        />
      ))}

      {!board && !loading && (
        <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50/40 px-6 py-16 text-center">
          <CalendarDays size={30} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm font-semibold text-gray-600">No shifts built yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-gray-400">
            Pick a day or a week and hit <b className="text-gray-500">Build shifts from bookings</b>.
            The board reads the students actually booked on those dates and lays out the
            shifts they call for — then you assign your instructors.
          </p>
        </div>
      )}
    </div>
  );
}


/**
 * One day, drawn as a timeline.
 *
 * Shifts are bars laid across the day's real opening window, so the shape of
 * the staffing is visible at a glance — you can see the deep cover over the
 * rush and the thin tail at close, instead of inferring it from a list of
 * times. The demand sparkline sits directly above on the same axis, which is
 * what makes the bars legible as a response to something.
 */
function DayBoard({ day, bench, picked, setPicked, onSlotClick, canCover }) {
  if (day.closed || day.empty) {
    return (
      <div className="mb-2 flex items-center gap-3 rounded-xl border border-gray-200/80 bg-gray-50/70 px-4 py-2.5">
        <span className="text-sm font-semibold text-gray-400">
          {day.dayName.slice(0, 3)} {new Date(day.date + 'T12:00:00').getDate()}
        </span>
        <span className="text-xs text-gray-400">{day.reason}</span>
      </div>
    );
  }

  const dayStart = toMinutes(day.window.start);
  const dayEnd = toMinutes(day.window.end);
  const span = Math.max(1, dayEnd - dayStart);
  const pct = (mins) => ((mins - dayStart) / span) * 100;

  const host = day.slots.find(s => s.kind === 'host');
  const coverage = day.slots.filter(s => s.kind === 'coverage');
  const ordered = [...(host ? [host] : []), ...coverage];

  const unfilled = day.slots.filter(s => !s.assigned).length;
  const pickedPerson = bench.find(p => p.uid === picked);
  const peakStudents = Math.max(1, ...day.curve.map(c => c.students));

  // Hour ticks across the open window.
  const ticks = [];
  for (let t = Math.ceil(dayStart / 60) * 60; t <= dayEnd; t += 60) ticks.push(t);

  const d = new Date(day.date + 'T12:00:00');

  return (
    <section className="mb-4 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-gray-100 px-5 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-bold tracking-tight text-gray-900">
            {day.dayName.slice(0, 3)} {d.getDate()}
          </span>
          <span className="text-xs font-medium text-gray-400">
            {d.toLocaleDateString('en-US', { month: 'long' })}
          </span>
        </div>
        <span className="text-xs text-gray-400">
          {fmt12(day.window.start)} – {fmt12(day.window.end)}
        </span>

        <span className="ml-auto flex items-center gap-3">
          <span className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-800 ring-1 ring-inset ring-blue-200">
            {day.peakStudents} students at peak
            <span className="mx-1 text-blue-300">·</span>
            needs {day.peakRequired}
          </span>
          {unfilled > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700 ring-1 ring-inset ring-amber-200">
              <AlertTriangle size={11} /> {unfilled} to fill
            </span>
          ) : (
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200">
              Fully staffed
            </span>
          )}
        </span>
      </header>

      <div className="grid gap-0 lg:grid-cols-[1fr_248px]">
        {/* Timeline */}
        <div className="min-w-0 px-5 py-4">
          {/* Students booked, on the same axis as the shifts below. Labelled,
              because an unlabelled strip of bars is decoration — the whole
              point is that the shifts are a response to THIS. */}
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-500">
              Students booked
            </span>
            <span className="text-[10px] tabular-nums text-gray-400">
              peak {day.peakStudents}
            </span>
          </div>
          <div className="relative mb-0 flex items-end gap-px rounded-t-md bg-blue-50/60 px-px pt-px" style={{ height: 46 }}>
            {day.curve.map((c) => (
              <div
                key={c.slot}
                title={`${fmt12(c.slot)} · ${c.students} students · needs ${c.required}`}
                className="flex-1 rounded-t-[2px] bg-blue-400/80 transition-colors hover:bg-blue-500"
                style={{ height: `${Math.max(8, (c.students / peakStudents) * 100)}%` }}
              />
            ))}
          </div>

          {/* Axis */}
          <div className="relative mb-2 h-4 border-t border-gray-300">
            {ticks.map(t => (
              <span
                key={t}
                className="absolute -translate-x-1/2 pt-0.5 text-[10px] tabular-nums text-gray-400"
                style={{ left: `${pct(t)}%` }}
              >
                {fmt12(toHHMM(t))}
              </span>
            ))}
          </div>

          {/* Shift bars, over hour gridlines so a bar's start and end read
              against the clock instead of floating. */}
          <div className="relative space-y-1.5">
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              {ticks.map(t => (
                <span
                  key={t}
                  className="absolute inset-y-0 w-px bg-gray-100"
                  style={{ left: `${pct(t)}%` }}
                />
              ))}
            </div>
            {ordered.map(slot => {
              const eligible = pickedPerson ? canCover(pickedPerson, slot) : null;
              return (
                <ShiftBar
                  key={slot.id}
                  slot={slot}
                  left={pct(toMinutes(slot.start))}
                  width={pct(toMinutes(slot.end)) - pct(toMinutes(slot.start))}
                  eligible={eligible}
                  onClick={() => onSlotClick(day, slot)}
                />
              );
            })}
          </div>

          {pickedPerson && (
            <p className="mt-3 rounded-lg bg-purple-50 px-3 py-2 text-xs text-purple-800 ring-1 ring-inset ring-purple-200">
              <b>{pickedPerson.name}</b> is selected — click a highlighted shift to place them.
              Faded shifts fall outside their availability.
            </p>
          )}
        </div>

        {/* Bench */}
        <aside className="border-t border-gray-100 px-5 py-4 lg:border-l lg:border-t-0">
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
            <Users size={11} /> Available · {bench.length}
          </p>
          {bench.length === 0 ? (
            <p className="text-xs italic leading-relaxed text-gray-400">
              Nobody submitted availability for this date.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {bench.map(p => {
                const on = day.slots.find(s => s.assigned?.uid === p.uid);
                const isPicked = picked === p.uid;
                return (
                  <button
                    key={p.uid}
                    onClick={() => setPicked(isPicked ? null : p.uid)}
                    disabled={!!on}
                    className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all ${
                      on
                        ? 'cursor-default bg-emerald-50/70 ring-1 ring-inset ring-emerald-200'
                        : isPicked
                          ? 'bg-purple-600 text-white shadow-sm'
                          : 'hover:bg-gray-100'
                    }`}
                  >
                    <Avatar user={p.user} size={26} roleColored={false} />
                    <span className="min-w-0 flex-1">
                      <span className={`flex items-center gap-1 truncate text-xs font-semibold ${
                        isPicked ? 'text-white' : 'text-gray-900'}`}>
                        {p.name}
                        {rankOf(p.user) === 0 && (
                          <span className={`rounded px-1 text-[9px] font-bold uppercase ${
                            isPicked ? 'bg-white/25 text-white' : 'bg-blue-100 text-blue-700'}`}>
                            Lead
                          </span>
                        )}
                      </span>
                      <span className={`block truncate text-[10px] tabular-nums ${
                        isPicked ? 'text-purple-100' : on ? 'text-emerald-700' : 'text-gray-400'}`}>
                        {on
                          ? `On ${fmt12(on.start)}–${fmt12(on.end)}`
                          : `${fmt12(toHHMM(p.availStart))}–${fmt12(toHHMM(p.availEnd))}`}
                      </span>
                      {p.pendingTimeOff && !on && (
                        <span className={`mt-0.5 block truncate text-[10px] ${
                          isPicked ? 'text-amber-100' : 'text-amber-600'}`}>
                          ⏳ time off pending
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

/**
 * One shift, positioned on the day's timeline.
 *
 * Empty slots stay visible as dashed outlines rather than blank space — an
 * unfilled 5pm shift is the most important thing on the page, so it should
 * read as a hole, not as absence.
 */
function ShiftBar({ slot, left, width, eligible, onClick }) {
  const filled = !!slot.assigned;
  const dim = eligible === false && !filled;
  const target = eligible === true && !filled;
  const isHost = slot.kind === 'host';

  return (
    <div className="relative h-9">
      <button
        onClick={onClick}
        style={{ left: `${left}%`, width: `${Math.max(width, 6)}%` }}
        title={filled
          ? `${slot.assigned.name} · ${fmt12(slot.start)}–${fmt12(slot.end)} — click to unassign`
          : `${fmt12(slot.start)}–${fmt12(slot.end)} — unassigned`}
        className={`group absolute inset-y-0 flex items-center gap-1.5 overflow-hidden rounded-lg px-2.5 text-left transition-all ${
          filled
            ? isHost
              ? 'bg-violet-600 text-white shadow-sm hover:bg-violet-700'
              : 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700'
            : target
              ? 'bg-purple-100 text-purple-900 ring-2 ring-purple-500'
              : dim
                ? 'border border-dashed border-gray-200 bg-gray-50 text-gray-300'
                : 'border border-dashed border-gray-300 bg-white text-gray-400 hover:border-purple-400 hover:bg-purple-50/50 hover:text-purple-700'
        }`}
      >
        {isHost && (
          <span className={`shrink-0 rounded px-1 text-[9px] font-bold uppercase tracking-wide ${
            filled ? 'bg-white/25' : 'bg-violet-100 text-violet-700'}`}>
            Host
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">
          {filled ? slot.assigned.name : 'Unassigned'}
        </span>
        <span className={`hidden shrink-0 text-[10px] tabular-nums sm:inline ${
          filled ? 'text-white/70' : 'text-gray-400'}`}>
          {fmt12(slot.start)}–{fmt12(slot.end)}
        </span>
        {filled && (
          <X size={12} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>
    </div>
  );
}
