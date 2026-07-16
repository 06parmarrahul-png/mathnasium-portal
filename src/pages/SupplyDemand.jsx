import { useState, useEffect, useMemo, useCallback } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Activity, ChevronLeft, ChevronRight, Loader2, AlertTriangle, RotateCcw, Sparkles,
  Save, Check, TrendingUp,
} from 'lucide-react';
import { format, addDays, subDays } from 'date-fns';
import { getSnapshot, saveSnapshot, computeTypicalDemand } from '../lib/demand-snapshots';
import { resolveInstructionalHours } from '../lib/centerConfig';
import { toast } from '../lib/notify';

/**
 * Supply & Demand — per-slot student-to-instructor coverage visualization.
 *
 * Rebuild of Andy's standalone HTML tool, ported into Ratio proper so it
 * reads LIVE data instead of hand-typed numbers:
 *   - Demand per slot = student appointments categorized HS / EM / Online
 *     from the Acuity iCal feed (via /api/scheduler/appointments)
 *   - Supply per slot = scheduled instructors overlapping that slot,
 *     categorized by sub-role
 *
 * The instructor can pick any date, override demand cells (walk-ins that
 * haven't been booked yet), and adjust the Target Ratio to see
 * ratio status per slot (Matched / X Under / X Over) and how many
 * students are affected in under-staffed windows.
 */

// 30-minute slot resolution. The WINDOW (start hour + slot count) is
// no longer hard-coded — it comes from the centre's instructional
// hours for the selected day (which honours summer overrides). Andy's
// original 3-7pm was baked in; Ratio now honours whatever hours are
// live so summer Tue/Thu (10am–2pm) renders as 8 slots starting at
// 10am instead of 10 slots starting at 3pm.
const SLOT_MIN = 30;

const SIDES = [
  { key: 'EM', label: 'Elementary',  subRoles: ['Elementary'],             defaultRatio: 3, accent: 'bg-emerald-500', tint: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  { key: 'HS', label: 'High School', subRoles: ['Highschool', 'High School'], defaultRatio: 4, accent: 'bg-blue-500',    tint: 'bg-blue-50 border-blue-200 text-blue-700' },
];

// Build the day's slot window from a `{ start, end }` hours object.
// Returns startMin, slotCount, plus a slotKeys array so we can match
// API-returned slots by their "HH:MM" key rather than by index.
function buildDayWindow(hours) {
  const parse = (t) => {
    const [h, m] = (t || '15:00').split(':').map(n => parseInt(n, 10));
    return h * 60 + m;
  };
  const startMin = parse(hours?.start || '15:00');
  const endMin   = parse(hours?.end || '20:00');
  const slotCount = Math.max(1, Math.ceil((endMin - startMin) / SLOT_MIN));
  const slotKeys = [];
  for (let i = 0; i < slotCount; i++) {
    const t = startMin + i * SLOT_MIN;
    const h = Math.floor(t / 60);
    const m = t % 60;
    slotKeys.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return { startMin, slotCount, slotKeys };
}

function slotLabelFromMin(totalMin) {
  const h24 = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  let h = h24 % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}
function slotLabelForIndex(startMin, i) {
  return slotLabelFromMin(startMin + i * SLOT_MIN);
}

// Minutes since midnight → shift.startTime "HH:MM" helper.
function timeToMin(t) {
  if (!t || typeof t !== 'string') return null;
  const [h, m] = t.split(':').map(n => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// "On the floor" filter — matches Student Scheduler's meaning of
// supply: someone teaching in-centre students right now.
//
// The distinction that matters: SHIFT TYPE, not instructor capability.
// An instructor whose profile subRole is 'Online' can still take an
// in-centre shift — their SHIFT is what tells us whether they're
// helping in-centre students. So we check s.role (which the auto-
// scheduler stamps as 'Online Instructor' for online shifts and as
// Instructor/Lead/Manager for centre shifts), NOT s.subRole.
//
// Include roles: Instructor / Lead / Manager  (all teach or float the floor)
// Exclude:
//   - role 'Online Instructor'  (the SHIFT is online, not in-centre)
//   - role 'Host'                (front-of-house, doesn't teach unless promoted)
//   - role 'Center Director', 'Dir. of Education', 'Admin'  (off-floor)
//   - draft / cancelled shifts, and sickPay=true days
// The matchesSide check in computeSupply further narrows to shifts
// whose subRole is Elementary or Highschool (the shift's assignment).
const ON_FLOOR_ROLES = new Set(['Instructor', 'Lead', 'Manager']);

function isOnFloor(s) {
  if (s.status === 'draft' || s.status === 'cancelled') return false;
  if (s.sickPay === true) return false;
  // If the shift has an explicit role, honour our whitelist. If it
  // doesn't (legacy shifts pre-migration), default-allow so we don't
  // silently drop legit instructors.
  if (s.role && !ON_FLOOR_ROLES.has(s.role)) return false;
  return true;
}

function computeSupply(shifts, subRoleMatchers, dayWindow) {
  const { startMin: winStart, slotCount } = dayWindow;
  const counts = new Array(slotCount).fill(0);
  const uniqueNames = new Set();
  const matchesSide = (s) => {
    const sub = (s.subRole || '').toLowerCase();
    return subRoleMatchers.some(m => sub === m.toLowerCase());
  };
  for (const s of shifts) {
    if (!isOnFloor(s)) continue;
    if (!matchesSide(s)) continue;
    const startMin = timeToMin(s.startTime);
    const endMin   = timeToMin(s.endTime);
    if (startMin == null || endMin == null) continue;
    let touchedAnySlot = false;
    for (let i = 0; i < slotCount; i++) {
      const slotStart = winStart + i * SLOT_MIN;
      const slotEnd   = slotStart + SLOT_MIN;
      const overlap = Math.max(0, Math.min(endMin, slotEnd) - Math.max(startMin, slotStart));
      if (overlap >= SLOT_MIN / 2) { counts[i]++; touchedAnySlot = true; }
    }
    if (touchedAnySlot) uniqueNames.add(s.userName || s.userId || 'unknown');
  }
  return { counts, uniqueNames };
}

// Union of unique instructor names actually on the floor for the day
// (across both EM and HS). Prevents the Whole Centre "Total Staff"
// tile from double-counting instructors who covered both sides.
// eslint-disable-next-line no-unused-vars
function computeUniqueOnFloor(shifts, dayWindow) {
  const names = new Set();
  for (const s of shifts) {
    if (!isOnFloor(s)) continue;
    const sub = (s.subRole || '').toLowerCase();
    if (sub !== 'elementary' && sub !== 'highschool' && sub !== 'high school') continue;
    if (s.userName || s.userId) names.add(s.userName || s.userId);
  }
  return names;
}

// Per-slot classification. Mirrors Andy's logic:
//   over/under ratio = (supply − demand) / forecastRatio
//   |ratio| < 0.5  → matched
//   ratio  <  0    → understaffed
//   ratio  >  0    → overstaffed
function classifySlots(demand, supply, forecastRatio) {
  const fr = Number(forecastRatio) || 1;
  return demand.map((d, i) => {
    const s = supply[i] ?? 0;
    const diff = s - d / fr;
    const overUnderRatio = fr > 0 ? diff / (1) : 0;
    const abs = Math.abs(overUnderRatio);
    let status = 'matched';
    if (abs >= 0.5) status = overUnderRatio > 0 ? 'overstaffed' : 'understaffed';
    return { i, demand: d, supply: s, capacity: s * fr, overUnderRatio, status };
  });
}

export default function SupplyDemand() {
  const { activeCenterId, centerConfig, canSeeCenterSettings } = useAuth();
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [apptData, setApptData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState(null);

  // Day window comes from the centre's instructional hours for THIS
  // date. `resolveInstructionalHours` honours summer overrides, so
  // summer Tue/Thu automatically render as 10am–2pm slots. The rest
  // of the file reads slotCount / startMin from here instead of
  // hard-coded constants.
  const dayWindow = useMemo(() => {
    const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const d = new Date(date + 'T12:00:00');
    const dayName = DOW[d.getDay()];
    const hours = resolveInstructionalHours(centerConfig, d)?.[dayName];
    return buildDayWindow(hours);
  }, [date, centerConfig]);
  const SLOT_COUNT = dayWindow.slotCount;

  // Live shifts for the selected date.
  const [shifts, setShifts] = useState([]);
  useEffect(() => {
    if (!activeCenterId || !date) return;
    const q = query(
      collection(db, 'shifts'),
      where('centerId', '==', activeCenterId),
      where('date', '==', date),
    );
    return onSnapshot(q, snap => setShifts(snap.docs.map(d => d.data())));
  }, [activeCenterId, date]);

  // Live check-ins for real-time demand — Student Scheduler stamps
  // status='noshow' / 'cancel' when a student doesn't turn up, and
  // status='in' / 'late' when they arrive. We subtract no-shows and
  // cancellations from the base Acuity demand so the numbers reflect
  // what actually happened, not just what was booked.
  const [checkIns, setCheckIns] = useState({});
  useEffect(() => {
    if (!activeCenterId || !date) return;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'schedulerCheckIns', date, 'students'),
      snap => {
        const map = {};
        snap.forEach(d => { map[d.id] = d.data(); });
        setCheckIns(map);
      },
      () => setCheckIns({}),
    );
  }, [activeCenterId, date]);

  // Live walk-ins — students added on the day who don't have an
  // Acuity appointment. Same source the Student Scheduler reads.
  const [walkIns, setWalkIns] = useState([]);
  useEffect(() => {
    if (!activeCenterId || !date) return;
    return onSnapshot(
      collection(db, 'centers', activeCenterId, 'walkIns', date, 'entries'),
      snap => setWalkIns(snap.docs.map(d => d.data())),
      () => setWalkIns([]),
    );
  }, [activeCenterId, date]);

  // Fetch the appointments for the selected date. Same endpoint the
  // Student Scheduler uses — categorizes into HS/EM/Online per slot.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!activeCenterId || !date) return;
      setLoading(true); setApiError(null);
      try {
        const token = await auth.currentUser?.getIdToken();
        const r = await fetch(
          `/api/scheduler/appointments?centerId=${encodeURIComponent(activeCenterId)}&date=${encodeURIComponent(date)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (alive) setApptData(j);
      } catch (e) {
        if (alive) setApiError(e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [activeCenterId, date]);

  // Per-side manual overrides — TWO tracks now: demand and supply.
  // Cleared + reloaded on date change from Firestore snapshot (if one
  // exists). Cell value undefined = "use live number" (Acuity for
  // demand, shifts for supply). Cell value set = "owner said this".
  const [overrides, setOverrides] = useState({
    EM: { demand: {}, supply: {} },
    HS: { demand: {}, supply: {} },
  });
  const [ratios, setRatios] = useState({ EM: 3, HS: 4 });
  const [snapshotDirty, setSnapshotDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [typical, setTypical] = useState({}); // dayName -> per-side avg

  // Load saved snapshot on date change. Populates both demand and supply
  // overrides + target ratios if the owner has ever saved for this day.
  useEffect(() => {
    let alive = true;
    setSnapshotDirty(false);
    setLastSavedAt(null);
    (async () => {
      if (!activeCenterId || !date) return;
      const snap = await getSnapshot(activeCenterId, date);
      if (!alive) return;
      if (!snap) {
        // No saved override → reset to empty; live numbers will fill in.
        setOverrides({ EM: { demand: {}, supply: {} }, HS: { demand: {}, supply: {} } });
        return;
      }
      // Convert saved arrays back into slotIdx→value maps so cells
      // downstream still know which are user-set vs. live-derived.
      const rebuild = (arr) => Object.fromEntries(
        arr.map((v, i) => [i, v]).filter(([, v]) => v != null && v !== 0),
      );
      setOverrides({
        EM: { demand: rebuild(snap.EM.demand), supply: rebuild(snap.EM.supply) },
        HS: { demand: rebuild(snap.HS.demand), supply: rebuild(snap.HS.supply) },
      });
      if (snap.EM.forecastRatio || snap.HS.forecastRatio) {
        setRatios(r => ({
          EM: snap.EM.forecastRatio || r.EM,
          HS: snap.HS.forecastRatio || r.HS,
        }));
      }
    })();
    return () => { alive = false; };
  }, [activeCenterId, date]);

  // Compute the "typical for this weekday" averages once per centre.
  // Runs when the centre or date changes so the panel stays fresh
  // without polling.
  useEffect(() => {
    let alive = true;
    if (!activeCenterId) return;
    computeTypicalDemand(activeCenterId).then(t => { if (alive) setTypical(t); });
    return () => { alive = false; };
  }, [activeCenterId, date]);

  const setOverride = useCallback((sideKey, track, slotIdx, value) => {
    setSnapshotDirty(true);
    setOverrides(prev => {
      const nextSide = { ...prev[sideKey] };
      const nextTrack = { ...(nextSide[track] || {}) };
      if (value === '' || value == null) delete nextTrack[slotIdx];
      else {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) nextTrack[slotIdx] = n;
      }
      nextSide[track] = nextTrack;
      return { ...prev, [sideKey]: nextSide };
    });
  }, []);

  const resetOverrides = useCallback((sideKey) => {
    setSnapshotDirty(true);
    setOverrides(prev => ({ ...prev, [sideKey]: { demand: {}, supply: {} } }));
  }, []);

  // handleSaveSnapshot is declared before sideData in source order but
  // only INVOKED after render, so the closure captures the latest
  // sideData by reference each render (useCallback re-creates whenever
  // deps change).
  const handleSaveSnapshot = useCallback(async () => {
    if (!activeCenterId) return;
    setSaving(true);
    try {
      const build = (sideKey) => {
        const sd = sideData?.[sideKey];
        if (!sd) return null;
        return {
          demand: sd.demand.slice(0, SLOT_COUNT),
          supply: sd.supply.slice(0, SLOT_COUNT),
          forecastRatio: Number(ratios[sideKey]) || null,
        };
      };
      await saveSnapshot(activeCenterId, date, {
        EM: build('EM'),
        HS: build('HS'),
        updatedBy: auth.currentUser?.uid,
      });
      setSnapshotDirty(false);
      setLastSavedAt(new Date());
      toast.success('Saved — auto-scheduler will use this next run');
    } catch (err) {
      console.error('[SupplyDemand] save failed:', err);
      toast.error('Save failed — try again');
    } finally {
      setSaving(false);
    }
    // sideData intentionally excluded — closure captures at render time
    // and sideData rebuilds every render anyway. eslint-disable next line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCenterId, date, ratios]);

  // Per-side derived data (memoized so cell edits don't re-run everything).
  const sideData = useMemo(() => {
    if (!apptData) return null;
    const out = {};
    // Build no-show / cancellation adjustments per slot per side from
    // check-ins. Then also build walk-in additions per slot per side.
    // Applied on top of the Acuity base demand. Indexing is by
    // dayWindow slot index, but we look up the API's slots by KEY
    // (HH:MM) so a summer 10am–2pm day maps API slots that start at
    // 10:00 correctly instead of assuming they start at 3pm.
    const noShowsBySide = { EM: new Array(SLOT_COUNT).fill(0), HS: new Array(SLOT_COUNT).fill(0) };
    const walkInsBySide = { EM: new Array(SLOT_COUNT).fill(0), HS: new Array(SLOT_COUNT).fill(0) };
    const apiSlotsByKey = new Map();
    for (const row of (apptData.slots || [])) {
      if (row?.slot) apiSlotsByKey.set(row.slot, row);
    }
    for (let i = 0; i < SLOT_COUNT; i++) {
      const key = dayWindow.slotKeys[i];
      const apiRow = apiSlotsByKey.get(key);
      if (!apiRow) continue;
      for (const sideKey of ['EM', 'HS']) {
        const bucket = apiRow.students?.[sideKey];
        if (!bucket) continue;
        const all = [...(bucket.onHour || []), ...(bucket.halfHour || [])];
        for (const student of all) {
          const sKey = student.id || student.uniqueId;
          const status = checkIns[sKey]?.status;
          if (status === 'noshow' || status === 'cancel') noShowsBySide[sideKey][i]++;
        }
      }
    }
    for (const w of walkIns) {
      if (!w?.slot || !w?.side) continue;
      const [wh, wm] = w.slot.split(':').map(Number);
      const slotIdx = ((wh * 60 + wm) - dayWindow.startMin) / SLOT_MIN;
      if (slotIdx < 0 || slotIdx >= SLOT_COUNT) continue;
      if (w.side === 'HS' || w.side === 'EM') walkInsBySide[w.side][slotIdx]++;
    }
    for (const side of SIDES) {
      const baseDemand = new Array(SLOT_COUNT).fill(0);
      for (let i = 0; i < SLOT_COUNT; i++) {
        const key = dayWindow.slotKeys[i];
        const apiRow = apiSlotsByKey.get(key);
        const booked  = apiRow?.counts?.[side.key] || 0;
        const noShow  = noShowsBySide[side.key][i] || 0;
        const walkIn  = walkInsBySide[side.key][i] || 0;
        baseDemand[i] = Math.max(0, booked - noShow + walkIn);
      }
      const sideOv = overrides[side.key] || { demand: {}, supply: {} };
      const demandOv = sideOv.demand || {};
      const supplyOv = sideOv.supply || {};
      const demand = baseDemand.map((v, i) => (i in demandOv ? demandOv[i] : v));
      const { counts: supplyLive, uniqueNames } = computeSupply(shifts, side.subRoles, dayWindow);
      // Merge supply overrides on top of live per-slot counts. Overrides
      // are useful when a shift covers the slot but the instructor isn't
      // actually helping students there (prep time, etc.), or vice versa.
      const supply = supplyLive.map((v, i) => (i in supplyOv ? supplyOv[i] : v));
      const rows   = classifySlots(demand, supply, ratios[side.key]);
      // Unique student count: sum of demand isn't quite right either
      // (a 60-min appointment shows up in 2 slots), but iCal appts are
      // stamped only once per booking in the API's `students` arrays.
      // For a top-line "how busy is today" we sum, since each student
      // usually only fills one 30-min slot at Langley.
      const stats = {
        peakDemand:      Math.max(0, ...demand),
        peakSupply:      Math.max(0, ...supply),
        uniqueSupply:    uniqueNames.size,
        matchedCount:    rows.filter(r => r.status === 'matched').length,
        underCount:      rows.filter(r => r.status === 'understaffed').length,
        overCount:       rows.filter(r => r.status === 'overstaffed').length,
        impactStudents:  rows
          .filter(r => r.status === 'understaffed')
          .reduce((sum, r) => sum + Math.max(0, r.demand - r.capacity), 0),
      };
      out[side.key] = {
        baseDemand, demand, supply, rows, stats,
        hasOverrides: Object.keys(demandOv).length + Object.keys(supplyOv).length > 0,
        demandOverriddenSlots: new Set(Object.keys(demandOv).map(Number)),
        supplyOverriddenSlots: new Set(Object.keys(supplyOv).map(Number)),
      };
    }
    // Attach the day-wide union of instructor names — Whole Centre
    // card reads this instead of summing per-side counts (which
    // double-counts anyone who covered both sides).
    out._uniqueOnFloor = computeUniqueOnFloor(shifts, dayWindow);
    return out;
  }, [apptData, shifts, overrides, ratios, checkIns, walkIns, dayWindow, SLOT_COUNT]);

  // Match Demand: for each slot, fill Staff to the minimum needed to
  // hit the target ratio — i.e. staff = ceil(demand ÷ target ratio).
  // This matches Andy's original tool. It writes into the SUPPLY
  // override map so the change is treated as a manual edit (purple
  // highlight, saved with snapshot). Ratio stays where the owner set
  // it — they picked the target for a reason.
  const matchDemand = useCallback((sideKey) => {
    if (!sideData) return;
    const { demand } = sideData[sideKey];
    const ratio = Number(ratios[sideKey]) || 1;
    setSnapshotDirty(true);
    setOverrides(prev => {
      const nextSide = { ...prev[sideKey] };
      const nextSupply = { ...(nextSide.supply || {}) };
      for (let i = 0; i < demand.length; i++) {
        const needed = Math.ceil(demand[i] / ratio);
        nextSupply[i] = needed;
      }
      nextSide.supply = nextSupply;
      return { ...prev, [sideKey]: nextSide };
    });
  }, [sideData, ratios]);

  if (!canSeeCenterSettings) {
    return (
      <div className="mx-auto max-w-md text-center py-16">
        <AlertTriangle size={36} className="mx-auto text-gray-300 mb-3" />
        <h2 className="text-lg font-bold text-gray-800 mb-1">Not authorized</h2>
        <p className="text-sm text-gray-500">Supply &amp; Demand is owner / super-admin only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-emerald-100 p-2 text-emerald-700"><Activity size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Staffing Supply &amp; Demand</h1>
            <p className="text-sm text-gray-500">
              Per-slot student-to-instructor coverage, live from Acuity + your posted schedule.
            </p>
          </div>
        </div>

        {/* Date nav */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setDate(d => format(subDays(new Date(d + 'T00:00:00'), 1), 'yyyy-MM-dd'))}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            title="Previous day"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <button
            onClick={() => setDate(d => format(addDays(new Date(d + 'T00:00:00'), 1), 'yyyy-MM-dd'))}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            title="Next day"
          >
            <ChevronRight size={16} />
          </button>
          <button
            onClick={() => setDate(format(new Date(), 'yyyy-MM-dd'))}
            className="ml-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            Today
          </button>
        </div>
      </div>

      {/* Loading / error states */}
      {loading && (
        <div className="flex items-center gap-2 rounded-xl border bg-white px-4 py-3 text-sm text-gray-500 shadow-sm">
          <Loader2 size={14} className="animate-spin" /> Loading appointments…
        </div>
      )}
      {apiError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle size={14} /> {apiError}
        </div>
      )}

      {/* Plain-English "how to read this" panel — sits above the cards so
          a new owner doesn't have to guess what the colours mean. */}
      <div className="rounded-xl border border-blue-200 bg-blue-50/40 px-4 py-3 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">How to read this</p>
        <p>
          Each bar shows how many <b>students</b> are booked in that 30-min slot. The black line above it is your <b>capacity</b> — instructors on shift × target ratio.
          {' '}<span className="text-emerald-700 font-semibold">Green</span> = capacity matches demand ·
          {' '}<span className="text-red-700 font-semibold">Red</span> = short on staff (students beyond capacity) ·
          {' '}<span className="text-amber-700 font-semibold">Amber</span> = over-staffed (paying for empty seats).
        </p>
      </div>

      {/* Save bar — appears once anything is dirty. Explicit save (not
          autosave) so the owner controls exactly which numbers get
          stamped as "the truth" for retrospect + auto-scheduler use. */}
      {sideData && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50/40 px-4 py-2.5">
          <p className="text-xs text-emerald-900">
            <b>Saved snapshots</b> feed the auto-scheduler&apos;s staffing recommendations. Edit any Demand or Supply cell, tweak Target Ratios, then Save.
            {lastSavedAt && !snapshotDirty && (
              <span className="ml-2 text-emerald-700 italic">Saved {format(lastSavedAt, 'h:mm a')}</span>
            )}
          </p>
          <button
            onClick={handleSaveSnapshot}
            disabled={saving || !snapshotDirty}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              snapshotDirty
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-white text-emerald-700 border border-emerald-300 opacity-60 cursor-not-allowed'
            }`}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : snapshotDirty ? <Save size={12} /> : <Check size={12} />}
            {saving ? 'Saving…' : snapshotDirty ? 'Save snapshot' : 'Saved'}
          </button>
        </div>
      )}

      {/* Per-side sections */}
      {sideData && SIDES.map(side => (
        <SideCard
          key={side.key}
          side={side}
          data={sideData[side.key]}
          dayWindow={dayWindow}
          typical={typical[new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' })]?.[side.key]}
          weekdayLabel={new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' })}
          forecastRatio={ratios[side.key]}
          onRatioChange={(v) => { setSnapshotDirty(true); setRatios(r => ({ ...r, [side.key]: v })); }}
          onDemandChange={(idx, v) => setOverride(side.key, 'demand', idx, v)}
          onSupplyChange={(idx, v) => setOverride(side.key, 'supply', idx, v)}
          onResetOverrides={() => resetOverrides(side.key)}
          onMatchDemand={() => matchDemand(side.key)}
        />
      ))}

      {/* Whole-Centre aggregate — adds EM + HS per slot into a single
          chart. Capacity uses a blended ratio: each side keeps its own
          target ratio, so combined capacity = EMsupply×EMratio +
          HSsupply×HSratio. That's more accurate than picking one ratio,
          since HS students genuinely need less hand-holding than EM. */}
      {sideData && (
        <CombinedCard
          emData={sideData.EM}
          hsData={sideData.HS}
          uniqueOnFloor={sideData._uniqueOnFloor}
          dayWindow={dayWindow}
          emRatio={ratios.EM}
          hsRatio={ratios.HS}
          dateLabel={format(new Date(date + 'T00:00:00'), 'EEE MMM d')}
        />
      )}
    </div>
  );
}

// ─── Whole-Centre aggregate ─────────────────────────────────────────────

function CombinedCard({ emData, hsData, uniqueOnFloor, dayWindow, emRatio, hsRatio, dateLabel }) {
  const SLOT_COUNT = dayWindow?.slotCount || emData?.demand?.length || 10;
  const startMin = dayWindow?.startMin || 15 * 60;
  const slotLabel = (i) => slotLabelForIndex(startMin, i);
  const combined = useMemo(() => {
    const demand = new Array(SLOT_COUNT).fill(0).map((_, i) => emData.demand[i] + hsData.demand[i]);
    const supply = new Array(SLOT_COUNT).fill(0).map((_, i) => emData.supply[i] + hsData.supply[i]);
    // Blended capacity per slot — each side's supply weighted by its own
    // target ratio, then summed. This is honest math; averaging the two
    // ratios first would double-count if one side has zero supply.
    const capacity = new Array(SLOT_COUNT).fill(0).map((_, i) =>
      emData.supply[i] * emRatio + hsData.supply[i] * hsRatio,
    );
    const rows = demand.map((d, i) => {
      const c = capacity[i];
      const diff = c - d;
      const abs = Math.abs(diff);
      let status = 'matched';
      // Threshold in students: within 1 student of capacity = matched.
      if (abs >= 1) status = c > d ? 'overstaffed' : 'understaffed';
      return { i, demand: d, supply: supply[i], capacity: c, overUnderRatio: diff, status };
    });
    const totalDemand = demand.reduce((a, b) => a + b, 0);
    // Use the pre-computed day-wide union so instructors who cover
    // both EM and HS are only counted once.
    const uniqueSupply = uniqueOnFloor?.size ?? (emData.stats.uniqueSupply + hsData.stats.uniqueSupply);
    const peakDemand = Math.max(0, ...demand);
    const peakSupply = Math.max(0, ...supply);
    const impactStudents = rows
      .filter(r => r.status === 'understaffed')
      .reduce((sum, r) => sum + Math.max(0, r.demand - r.capacity), 0);
    return { demand, supply, capacity, rows, totalDemand, uniqueSupply, peakDemand, peakSupply, impactStudents };
  }, [emData, hsData, emRatio, hsRatio, uniqueOnFloor, SLOT_COUNT]);

  const maxY = Math.max(1, ...combined.demand, ...combined.capacity) * 1.1;

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-3">
        <h2 className="text-base font-bold text-gray-900">Whole Centre — {dateLabel}</h2>
        <p className="text-xs text-gray-500">
          Elementary + High School combined. Capacity is blended: EM supply × {emRatio} + HS supply × {hsRatio}.
        </p>
      </div>

      {/* Same chart component the per-side cards use. */}
      <Chart demand={combined.demand} rows={combined.rows} maxY={maxY} forecastRatio={Math.max(emRatio, hsRatio)} slotLabel={slotLabel} />

      {/* ── RATIO STATUS + IMPACT ─────────────────────────────────────
          Same column-aligned layout as the EM/HS cards. Uses blended
          capacity per slot (EM×emRatio + HS×hsRatio) so the status
          reflects the reality that EM and HS have different target
          ratios. Coverage labels shown as ± seats / students. */}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full text-xs table-fixed border-separate border-spacing-x-0.5">
          <colgroup>
            <col style={{ width: 90 }} />
            {combined.rows.map(r => <col key={r.i} />)}
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-gray-500">
              <th className="text-left pb-1 pr-2 font-bold">Slot</th>
              {combined.rows.map(r => (
                <th key={r.i} className="text-center pb-1 font-medium">{slotLabel(r.i).toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="pr-2 py-2 text-left align-top">
                <div className="text-[10px] font-bold uppercase tracking-wide text-gray-700">Ratio Status</div>
              </td>
              {combined.rows.map(r => {
                const spareSeats = Math.max(0, Math.round(r.capacity - r.demand));
                const shortStudents = Math.max(0, Math.round(r.demand - r.capacity));
                let label = 'Matched';
                if (r.status === 'understaffed') label = `-${shortStudents} student${shortStudents === 1 ? '' : 's'}`;
                else if (r.status === 'overstaffed') label = `+${spareSeats} seat${spareSeats === 1 ? '' : 's'}`;
                const cls = r.status === 'matched'
                  ? 'bg-emerald-200/70 text-emerald-900'
                  : r.status === 'understaffed'
                    ? 'bg-orange-100 text-orange-700 border border-orange-300'
                    : 'bg-red-100 text-red-700 border border-red-200';
                return (
                  <td key={r.i} className="p-0 align-middle">
                    <div className={`rounded-md py-2 text-center text-xs font-semibold ${cls}`}>{label}</div>
                  </td>
                );
              })}
            </tr>
            <tr>
              <td className="pr-2 py-2 text-left align-top">
                <div className="text-[10px] font-bold uppercase tracking-wide text-gray-700">Impact</div>
                <div className="text-[9px] font-normal text-gray-500 leading-tight"># of<br/>Students<br/>Affected</div>
              </td>
              {combined.rows.map(r => {
                const shortStudents = Math.max(0, Math.round(r.demand - r.capacity));
                return (
                  <td key={r.i} className="text-center align-middle py-2">
                    {r.status === 'understaffed' && shortStudents > 0
                      ? <span className="text-orange-600 font-bold text-base">{shortStudents}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Slot Detail (read-only for the aggregate) ─────────────────
          Same layout as the EM/HS cards' Slot Detail but the rows are
          derived (Demand = EM+HS demand, Staff = EM+HS staff, Supply
          = blended capacity) so they aren't editable — go to the
          per-side card to tweak individual cells. */}
      <div className="mt-5 border-t pt-4">
        <h3 className="text-sm font-bold text-gray-900 mb-3">Slot Detail (blended, read-only)</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs table-fixed border-separate border-spacing-x-0.5">
          <colgroup>
            <col style={{ width: 90 }} />
            {combined.rows.map(r => <col key={r.i} />)}
          </colgroup>
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-1.5 pr-2 font-medium">Slot</th>
              {combined.rows.map(r => (
                <th key={r.i} className="py-1.5 px-1 font-medium text-center whitespace-nowrap">{slotLabel(r.i).toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody className="[&_td]:py-1 [&_td]:px-1 [&_td]:text-center">
            <tr className="border-b">
              <td className="pr-3 py-1.5 text-left align-top">
                <div className="font-bold text-emerald-700 text-xs uppercase tracking-wide">Demand</div>
                <div className="text-[10px] font-normal text-gray-500"># of Students</div>
              </td>
              {combined.rows.map(r => (
                <td key={r.i} className="text-sm font-medium text-gray-800">{r.demand}</td>
              ))}
            </tr>
            <tr className="border-b">
              <td className="pr-3 py-1.5 text-left align-top">
                <div className="font-bold text-gray-700 text-xs uppercase tracking-wide">Staff</div>
                <div className="text-[10px] font-normal text-gray-500"># of Staff</div>
              </td>
              {combined.rows.map(r => (
                <td key={r.i} className="text-sm font-medium text-gray-800">{r.supply}</td>
              ))}
            </tr>
            <tr className="border-b">
              <td className="pr-3 py-2 text-left align-top">
                <div className="font-bold text-emerald-700 text-xs uppercase tracking-wide">Supply</div>
                <div className="text-[10px] font-normal text-gray-500">Blended Capacity</div>
              </td>
              {combined.rows.map(r => (
                <td key={r.i} className="text-sm font-semibold text-gray-800">{r.capacity.toFixed(1)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-600">
        <span>
          <b>{combined.totalDemand}</b> student appointment{combined.totalDemand === 1 ? '' : 's'} · <b>{combined.uniqueSupply}</b> instructors on shift today
          {combined.peakSupply > 0 && <span className="text-gray-400"> (peak {combined.peakSupply} at once)</span>}
        </span>
        {combined.impactStudents > 0 && (
          <span className="text-red-700 font-semibold">
            ~{Math.round(combined.impactStudents)} students beyond blended capacity
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Section card ────────────────────────────────────────────────────────

function SideCard({ side, data, dayWindow, typical, weekdayLabel, forecastRatio, onRatioChange, onDemandChange, onSupplyChange, onResetOverrides, onMatchDemand }) {
  const startMin = dayWindow?.startMin || 15 * 60;
  const slotLabel = (i) => slotLabelForIndex(startMin, i);
  const slotCount = dayWindow?.slotCount || data?.demand?.length || 10;
  const { demand, supply, rows, stats, hasOverrides, demandOverriddenSlots, supplyOverriddenSlots } = data;
  const maxY = Math.max(1, ...demand, ...supply.map(s => s * forecastRatio)) * 1.1;
  const typicalDemand = typical?.demand || null;
  const typicalSamples = typical?.samples || 0;

  // Boss-style aggregate stats — one card per box in the "Shift
  // Statistics" strip below the tables. Each slot is 30 minutes so
  // shift-hours = staff × 0.5 summed.
  const totalShiftHours = supply.reduce((sum, s) => sum + s * 0.5, 0);
  const totalDemand     = demand.reduce((a, b) => a + b, 0);
  const totalCapacity   = supply.reduce((sum, s) => sum + s * forecastRatio, 0);
  const peakStaff       = Math.max(0, ...supply);
  const ratiosPerSlot   = rows.map(r => r.supply > 0 ? r.demand / r.supply : 0);
  const nonEmpty        = ratiosPerSlot.filter((_, i) => rows[i].supply > 0);
  const avgRatio        = nonEmpty.length > 0 ? nonEmpty.reduce((a, b) => a + b, 0) / nonEmpty.length : 0;

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-gray-900">{side.label} — Supply vs. Demand</h2>
          <p className="text-xs text-gray-500">
            Demand: students booked · Supply: instructors on shift · Capacity: supply × target ratio
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">
            Target Ratio
            <input
              type="number"
              min={1}
              step={0.5}
              value={forecastRatio}
              onChange={e => onRatioChange(Number(e.target.value) || 1)}
              className="ml-2 w-16 rounded border border-gray-300 px-2 py-1 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </label>
          <button
            onClick={onMatchDemand}
            title="Suggest a ratio that makes today's supply match demand"
            className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
          >
            <Sparkles size={11} /> Match Demand
          </button>
          {hasOverrides && (
            <button
              onClick={onResetOverrides}
              title="Reset any manual demand cell overrides to the Acuity numbers"
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              <RotateCcw size={11} /> Reset overrides
            </button>
          )}
        </div>
      </div>

      {/* Bar chart */}
      <Chart demand={demand} rows={rows} maxY={maxY} forecastRatio={forecastRatio} slotLabel={slotLabel} />

      {/* ── RATIO STATUS + IMPACT ──────────────────────────────────────
          Directly under the chart, exactly like Andy's boss's tool:
          per-slot coloured boxes (Matched green, X.X Over pink, X.X
          Under orange) with a matching "# of Students Affected" row.
          Uses a single wide table so every cell aligns column-for-
          column with the chart bars above. */}
      <div className="mt-5 overflow-x-auto">
        <table className="w-full text-xs table-fixed border-separate border-spacing-x-0.5">
          <colgroup>
            <col style={{ width: 90 }} />
            {rows.map(r => <col key={r.i} />)}
          </colgroup>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-gray-500">
              <th className="text-left pb-1 pr-2 font-bold">Slot</th>
              {rows.map(r => (
                <th key={r.i} className="text-center pb-1 font-medium">{slotLabel(r.i).toUpperCase().replace('AM', 'AM').replace('PM', 'PM')}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* RATIO STATUS row — one full-width coloured pill per slot.
                Values format: "Matched" or "0.5 Over" / "0.5 Under" —
                the signed decimal is (capacity − demand) ÷ target ratio,
                capped to one decimal place. */}
            <tr>
              <td className="pr-2 py-2 text-left align-top">
                <div className="text-[10px] font-bold uppercase tracking-wide text-gray-700">Ratio Status</div>
              </td>
              {rows.map(r => {
                const val = forecastRatio > 0 ? (r.capacity - r.demand) / forecastRatio : 0;
                const abs = Math.abs(val).toFixed(1);
                let label = 'Matched';
                if (r.status === 'overstaffed')      label = `${abs} Over`;
                else if (r.status === 'understaffed') label = `${abs} Under`;
                const cls = r.status === 'matched'
                  ? 'bg-emerald-200/70 text-emerald-900'
                  : r.status === 'understaffed'
                    ? 'bg-orange-100 text-orange-700 border border-orange-300'
                    : 'bg-red-100 text-red-700 border border-red-200';
                return (
                  <td key={r.i} className="p-0 align-middle">
                    <div className={`rounded-md py-2 text-center text-xs font-semibold ${cls}`}>
                      {label}
                    </div>
                  </td>
                );
              })}
            </tr>
            {/* IMPACT row — students beyond capacity in understaffed
                slots. Non-understaffed slots show "—" so the row reads
                as a comparison, not a data table. */}
            <tr>
              <td className="pr-2 py-2 text-left align-top">
                <div className="text-[10px] font-bold uppercase tracking-wide text-gray-700">Impact</div>
                <div className="text-[9px] font-normal text-gray-500 leading-tight"># of<br/>Students<br/>Affected</div>
              </td>
              {rows.map(r => {
                const shortStudents = Math.max(0, Math.round(r.demand - r.capacity));
                return (
                  <td key={r.i} className="text-center align-middle py-2">
                    {r.status === 'understaffed' && shortStudents > 0
                      ? <span className="text-orange-600 font-bold text-base">{shortStudents}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Slot Detail (editable) ─────────────────────────────────────
          Same rows as Andy's original tool: Demand and Staff (both
          editable inputs), plus a derived Supply row showing staff ×
          target ratio so the owner can see capacity headroom at a
          glance. Overridden cells are tinted purple. */}
      <div className="mt-5 border-t pt-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-bold text-gray-900">Slot Detail (editable)</h3>
          {hasOverrides && (
            <button
              onClick={onResetOverrides}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              <RotateCcw size={11} /> Reset overrides
            </button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs table-fixed border-separate border-spacing-x-0.5">
          <colgroup>
            <col style={{ width: 90 }} />
            {rows.map(r => <col key={r.i} />)}
          </colgroup>
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-1.5 pr-2 font-medium">Slot</th>
              {rows.map(r => (
                <th key={r.i} className="py-1.5 px-1 font-medium text-center whitespace-nowrap">{slotLabel(r.i).toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody className="[&_td]:py-1 [&_td]:px-1 [&_td]:text-center">
            <tr className="border-b">
              <td className="pr-3 py-1.5 text-left align-top">
                <div className="font-bold text-emerald-700 text-xs uppercase tracking-wide">Demand</div>
                <div className="text-[10px] font-normal text-gray-500">
                  # of Students
                </div>
              </td>
              {rows.map(r => {
                const overridden = demandOverriddenSlots?.has(r.i);
                return (
                  <td key={r.i} className="py-1.5">
                    <input
                      type="number"
                      min={0}
                      value={r.demand}
                      onChange={e => onDemandChange(r.i, e.target.value)}
                      className={`w-14 rounded border px-1.5 py-1.5 text-center text-sm font-medium focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 ${
                        overridden
                          ? 'border-purple-300 bg-purple-50 text-purple-800'
                          : 'border-gray-300 bg-white text-gray-800 hover:border-gray-400'
                      }`}
                      title={overridden
                        ? 'Manual override — click Reset to revert to Acuity'
                        : 'Click to override this slot\'s demand'}
                    />
                  </td>
                );
              })}
            </tr>
            <tr className="border-b">
              <td className="pr-3 py-1.5 text-left align-top">
                <div className="font-bold text-gray-700 text-xs uppercase tracking-wide">Staff</div>
                <div className="text-[10px] font-normal text-gray-500">
                  # of Staff
                </div>
              </td>
              {rows.map(r => {
                const overridden = supplyOverriddenSlots?.has(r.i);
                return (
                  <td key={r.i} className="py-1.5">
                    <input
                      type="number"
                      min={0}
                      value={r.supply}
                      onChange={e => onSupplyChange(r.i, e.target.value)}
                      className={`w-14 rounded border px-1.5 py-1.5 text-center text-sm font-medium focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 ${
                        overridden
                          ? 'border-purple-300 bg-purple-50 text-purple-800'
                          : 'border-gray-300 bg-white text-gray-800 hover:border-gray-400'
                      }`}
                      title={overridden
                        ? 'Manual override — click Reset to revert to the posted schedule count'
                        : 'Click to override this slot\'s instructor count'}
                    />
                  </td>
                );
              })}
            </tr>
            <tr className="border-b">
              <td className="pr-3 py-2 text-left align-top">
                <div className="font-bold text-emerald-700 text-xs uppercase tracking-wide">Supply</div>
                <div className="text-[10px] font-normal text-gray-500">
                  Instructor Capacity
                </div>
              </td>
              {rows.map(r => (
                <td key={r.i} className="text-center text-sm font-semibold text-gray-800">
                  {r.capacity.toFixed(1)}
                </td>
              ))}
            </tr>
            {typicalDemand && typicalSamples > 0 && (
              <tr className="bg-blue-50/40">
                <td className="pr-3 py-1.5 text-left align-top">
                  <div className="font-semibold text-blue-700 text-xs uppercase tracking-wide inline-flex items-center gap-1">
                    <TrendingUp size={11} /> Typical {weekdayLabel}
                  </div>
                  <div className="text-[10px] font-normal text-blue-500">avg of {typicalSamples}</div>
                </td>
                {rows.map((r, i) => (
                  <td key={r.i} className="text-center text-blue-700">
                    {typicalDemand[i]?.toFixed(0) ?? '—'}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* (Removed) Ratio Analysis section — the RATIO STATUS pill row
          above already conveys per-slot status in plain English. The
          raw D÷Staff and (S−D)÷TR numbers were more noise than signal
          for owners, so they've been dropped. */}

      {/* ── Shift Statistics — 6 stat boxes matching the boss's layout ── */}
      <div className="mt-5 border-t pt-4">
        <h3 className="text-sm font-bold text-gray-900 mb-3">Shift Statistics</h3>
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatBox label="Total Shift Hours"     value={`${totalShiftHours.toFixed(1)} hours`} />
          <StatBox label="Total Demand"          value={`${totalDemand} students`} />
          <StatBox label="Total Staff"           value={`${stats.uniqueSupply} instructor${stats.uniqueSupply === 1 ? '' : 's'}`} sub={peakStaff > 0 ? `peak ${peakStaff}` : ''} />
          <StatBox label="Total Supply Capacity" value={`${totalCapacity.toFixed(0)} students`} />
          <StatBox label="Avg Ratio Actual"      value={avgRatio > 0 ? `${avgRatio.toFixed(2)}:1` : '—'} />
          <StatBox label="Matched Slots"         value={`${stats.matchedCount} / ${slotCount}`} tone="good" />
          <StatBox label="Understaffed Slots"    value={`${stats.underCount} / ${slotCount}`} tone={stats.underCount > 0 ? 'bad' : 'neutral'} />
          <StatBox label="Overstaffed Slots"     value={`${stats.overCount} / ${slotCount}`} tone={stats.overCount > 2 ? 'warn' : 'neutral'} />
        </div>
        {stats.impactStudents > 0 && (
          <p className="mt-3 text-xs text-red-700 font-semibold">
            ~{Math.round(stats.impactStudents)} students beyond capacity at target ratio {forecastRatio}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Shift Statistics tile ───────────────────────────────────────────────
function StatBox({ label, value, sub, tone }) {
  const toneCls =
    tone === 'good' ? 'border-emerald-200 bg-emerald-50/40' :
    tone === 'warn' ? 'border-amber-200 bg-amber-50/40' :
    tone === 'bad'  ? 'border-red-200 bg-red-50/40' :
    'border-gray-200 bg-gray-50/50';
  return (
    <div className={`rounded-xl border p-3 ${toneCls}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 leading-tight">{label}</p>
      <p className="mt-1 text-lg font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-gray-500">{sub}</p>}
    </div>
  );
}

// ─── SVG bar chart ───────────────────────────────────────────────────────
// Two series per slot: green bar = demand (students), overlaid line = supply
// capacity (supply × forecastRatio). Bars re-tint red/amber when supply
// can't meet demand at the target ratio. Compact so we can fit 10 slots in
// a single row without horizontal scroll on desktop.

function Chart({ demand, rows, maxY, forecastRatio, slotLabel }) {
  const W = 780, H = 260, PADL = 40, PADB = 32, PADT = 14, PADR = 12;
  const chartW = W - PADL - PADR;
  const chartH = H - PADT - PADB;
  const barW   = chartW / demand.length * 0.62;
  const groupW = chartW / demand.length;
  const yScale = (v) => PADT + chartH - (v / maxY) * chartH;

  // Y-axis step = target ratio. So a ratio of 3 gives ticks at 3, 6,
  // 9, … and a ratio of 4 gives 4, 8, 12, …. Each tick = "one more
  // instructor's worth of capacity", which is the language owners
  // actually think in. Aim for ~6-8 visible ticks; if the target
  // ratio is high enough that a plain step overshoots (e.g. ratio
  // 10 with maxY 12), fall back to that ratio value.
  const baseStep = Math.max(1, Math.round(Number(forecastRatio) || 1));
  const targetTicks = 6;
  let tickStep = baseStep;
  while (maxY / tickStep > targetTicks + 2) tickStep += baseStep;

  const GREEN_FILL = '#a7d5a3';   // demand-served (light green)
  const OVER_FILL  = '#f8c9c9';   // extra capacity (pink)
  const UNDER_FILL = '#cdb98b';   // students beyond capacity (tan)
  const GREEN_LINE = '#166534';   // matched marker
  const UNDER_LINE = '#ea580c';   // understaffed marker
  const OVER_LINE  = '#dc2626';   // overstaffed marker

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Y-axis title */}
      <text x={10} y={PADT + chartH / 2} transform={`rotate(-90 10 ${PADT + chartH / 2})`} textAnchor="middle" fontSize="10" fill="#6b7280">
        Students
      </text>
      {/* Y grid + labels */}
      {Array.from({ length: Math.ceil(maxY / tickStep) + 1 }, (_, i) => {
        const val = i * tickStep;
        if (val > maxY + tickStep) return null;
        const y = yScale(val);
        return (
          <g key={i}>
            <line x1={PADL} x2={W - PADR} y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />
            <text x={PADL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#6b7280">{val}</text>
          </g>
        );
      })}

      {rows.map((r, i) => {
        const x = PADL + i * groupW + (groupW - barW) / 2;
        const barTopVal = Math.max(r.demand, r.capacity);
        const overlapVal = Math.min(r.demand, r.capacity);
        const barTopY   = yScale(barTopVal);
        const overlapY  = yScale(overlapVal);
        const baseY     = yScale(0);
        const barH      = baseY - barTopY;
        const greenH    = baseY - overlapY;
        const capY      = yScale(r.capacity);

        // Colour scheme depends on how the mismatch resolves.
        const isOver  = r.status === 'overstaffed';
        const isUnder = r.status === 'understaffed';
        const upperFill = isOver ? OVER_FILL : (isUnder ? UNDER_FILL : 'transparent');
        const markerColor = r.status === 'matched' ? GREEN_LINE : (isUnder ? UNDER_LINE : OVER_LINE);

        return (
          <g key={i}>
            {/* Upper "mismatch" portion — extra capacity (pink) or shortfall (tan) */}
            {barTopVal !== overlapVal && (
              <rect x={x} y={barTopY} width={barW} height={overlapY - barTopY} fill={upperFill} />
            )}
            {/* Green portion = served */}
            <rect x={x} y={overlapY} width={barW} height={greenH} fill={GREEN_FILL} />
            {/* Bar outline for visual crispness */}
            <rect x={x} y={barTopY} width={barW} height={barH} fill="none" stroke="#a3a3a3" strokeWidth="0.5" opacity="0.6" />
            {/* Capacity marker line */}
            <line x1={x - 3} x2={x + barW + 3} y1={capY} y2={capY} stroke={markerColor} strokeWidth="2.5" />
            {/* Demand value above the bar */}
            <text x={x + barW / 2} y={barTopY - 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="#111827">
              {r.demand}
            </text>
            {/* Slot label */}
            <text x={x + barW / 2} y={H - PADB + 14} textAnchor="middle" fontSize="10" fill="#6b7280">
              {slotLabel(i)}
            </text>
          </g>
        );
      })}

      {/* Legend at the bottom — matches the boss's screenshot ordering. */}
      <g transform={`translate(${PADL}, ${H - 2})`}>
        <rect x="0" y="-9" width="10" height="9" fill={GREEN_FILL} />
        <text x="14" y="-1" fontSize="10" fill="#4b5563">Demand (students)</text>
        <line x1="130" y1="-5" x2="146" y2="-5" stroke={GREEN_LINE} strokeWidth="2.5" />
        <text x="150" y="-1" fontSize="10" fill="#4b5563">Supply — matched</text>
        <line x1="248" y1="-5" x2="264" y2="-5" stroke={UNDER_LINE} strokeWidth="2.5" />
        <text x="268" y="-1" fontSize="10" fill="#4b5563">Supply — understaffed</text>
        <line x1="378" y1="-5" x2="394" y2="-5" stroke={OVER_LINE} strokeWidth="2.5" />
        <text x="398" y="-1" fontSize="10" fill="#4b5563">Supply — overstaffed</text>
      </g>
    </svg>
  );
}
