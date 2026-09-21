import { useState, useEffect, useMemo, useCallback } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { useTimeFormat } from '../lib/useTimeFormat';
import { PAGES } from '../lib/pageNames';
import {
  Activity, ChevronLeft, ChevronRight, Loader2, AlertTriangle, RotateCcw, Sparkles,
  Save, Check, TrendingUp, RefreshCw,
} from 'lucide-react';
import { format, addDays, subDays } from 'date-fns';
import { getSnapshot, saveSnapshot, computeTypicalDemand } from '../lib/demand-snapshots';
import { watchFeedDay, requestFeedRefresh, describeAge } from '../lib/schedulerFeed';
import { watchCheckIns, watchWalkIns } from '../lib/scheduler-data';
import { demandBySide } from '../lib/slotDemand';
import { resolveInstructionalHours } from '../lib/centerConfig';
import { toast } from '../lib/notify';
import { DEFAULT_TARGET_RATIO } from '../lib/subRoles';
import { floorSupply, uniqueOnFloor, SIDE_LABELS } from '../lib/floorSupply';
import { resolveUserForCenter } from '../lib/centerMembership';
import SlotBarChart from '../components/SlotBarChart';

/**
 * Supply & Demand — per-slot student-to-instructor coverage visualization.
 *
 * Rebuild of Andy's standalone HTML tool, ported into Ratio proper so it
 * reads LIVE data instead of hand-typed numbers:
 * ONE CHART PER SIDE — Elementary / Middle and High School:
 *   - Demand per slot = that side's student appointments from the Acuity
 *     feed, less no-shows and cancellations, plus the day's walk-ins
 *   - Supply per slot = the instructors the Student Scheduler puts on
 *     that side for that half hour (src/lib/floorSupply.js), falling back
 *     to the posted shifts on a day whose sides aren't set yet
 *
 * The two sides are counted apart because an instructor stands on one of
 * them at a time. Counting the whole centre at once made four instructors
 * on Elementary look like help for nine high schoolers, and the page read
 * over-staffed nearly every half hour.
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

// ONE CHART PER SIDE. Elementary and High School are two floors with two
// sets of students, and an instructor stands on one of them at a time —
// so a single combined chart counted every instructor against every
// student and read over-staffed nearly every half hour. Supply now comes
// from the Student Scheduler's own side assignments (src/lib/floorSupply.js).
const SIDES = [
  {
    key: 'EM',
    label: SIDE_LABELS.EM,
    defaultRatio: DEFAULT_TARGET_RATIO,
    accent: 'bg-emerald-500',
    tint: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  },
  {
    key: 'HS',
    label: SIDE_LABELS.HS,
    defaultRatio: DEFAULT_TARGET_RATIO,
    accent: 'bg-indigo-500',
    tint: 'bg-indigo-50 border-indigo-200 text-indigo-700',
  },
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

// Column headers are the narrow width — every half hour gets a label and
// a space would cost a column. The reader's clock decides 3:00PM vs 15:00.
function slotLabelForIndex(startMin, i, fmtTime) {
  return fmtTime.compact(startMin + i * SLOT_MIN);
}

// Per-slot classification, counted in WHOLE INSTRUCTORS.
//
// You cannot roster 0.7 of a person, so the requirement is rounded UP:
// 7 students at 1:3 needs 3 instructors, not 2.33. The surplus is then
// supply − required, always a whole number, and always something you could
// actually act on (send someone home / call someone in).
//
//   required = ceil(demand ÷ target ratio)
//   diff     = supply − required
//   diff = 0 → matched · diff < 0 → understaffed · diff > 0 → overstaffed
//
// The old version compared supply against the UNROUNDED demand ÷ ratio and
// flagged anything ≥ 0.5 away as off-target. That reported "0.7 Over" for a
// slot that was exactly right — worse, it contradicted the "match demand"
// button below, which has always used ceil(). Pressing that button left
// slots glowing red because it staffed 3 and the status wanted 2.33.
function classifySlots(demand, supply, forecastRatio) {
  const fr = Number(forecastRatio) || 1;
  return demand.map((d, i) => {
    const s = supply[i] ?? 0;
    const required = fr > 0 ? Math.ceil(d / fr) : 0;
    const diff = s - required;
    let status = 'matched';
    if (diff > 0) status = 'overstaffed';
    else if (diff < 0) status = 'understaffed';
    return { i, demand: d, supply: s, required, capacity: s * fr, overUnderRatio: diff, status };
  });
}

export default function SupplyDemand() {
  const { activeCenterId, centerConfig, canSeeCenterSettings } = useAuth();
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [apptData, setApptData] = useState(null);
  const [feedRefreshedAt, setFeedRefreshedAt] = useState(null);
  const [feedRefreshing, setFeedRefreshing] = useState(false);
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

  // Check-ins and walk-ins come through the Student Scheduler's OWN
  // watchers. This page used to read two paths that don't exist —
  // `walkIns/{date}/entries` and a `schedulerCheckIns/{date}/students`
  // sub-collection — so every walk-in was missing from the bars and no
  // no-show ever came off them. Reading through scheduler-data.js means
  // the two screens can't drift apart again.
  const [checkIns, setCheckIns] = useState({});
  useEffect(() => {
    if (!activeCenterId || !date) return undefined;
    return watchCheckIns(activeCenterId, date, setCheckIns);
  }, [activeCenterId, date]);

  // Walk-ins and call-ins: centers/{id}/scheduleAddOns/{date}, keyed
  // "<side>|<HH:MM>" — the people staff add on the day.
  const [addOns, setAddOns] = useState({});
  useEffect(() => {
    if (!activeCenterId || !date) return undefined;
    return watchWalkIns(activeCenterId, date, setAddOns);
  }, [activeCenterId, date]);

  // Fetch the appointments for the selected date. Same endpoint the
  // Student Scheduler uses — categorizes into HS/EM/Online per slot.
  useEffect(() => {
    // Subscribed to the parsed day cache, not fetched from Acuity. The feed
    // itself is 6.8 MB and takes 26-53 seconds; this paints immediately and
    // updates itself when a refresh writes a new version.
    if (!activeCenterId || !date) return undefined;
    setLoading(true); setApiError(null);
    return watchFeedDay(activeCenterId, date, ({ grouped, refreshedAt: at, loading: l, error: e }) => {
      setApptData(grouped);
      setFeedRefreshedAt(at);
      setLoading(l);
      setApiError(e || null);
    });
  }, [activeCenterId, date]);

  // The Student Scheduler's side assignments for this date — the source
  // of truth for supply. "<side>|<HH:MM>" → display names.
  const [assignments, setAssignments] = useState(null);
  useEffect(() => {
    if (!activeCenterId || !date) return undefined;
    return onSnapshot(
      doc(db, 'centers', activeCenterId, 'schedulerInstructorAssignments', date),
      snap => setAssignments(snap.exists() ? snap.data() : {}),
      () => setAssignments({}),
    );
  }, [activeCenterId, date]);

  // The roster, to keep trainees and volunteers out of the ratio count —
  // they are on the sheet, and they are not a ratio slot.
  const [roster, setRoster] = useState([]);
  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setRoster(snap.docs.map(d => ({ uid: d.id, ...d.data() }))),
      () => setRoster([]),
    );
  }, [activeCenterId]);

  // (name) => why they don't count, or null. Anyone the sheet names who
  // isn't on the roster still counts: the sheet is what happened, and a
  // spelling we can't match is not evidence of a trainee.
  const skipFromRatio = useMemo(() => {
    const byName = new Map();
    for (const u of roster) {
      const at = resolveUserForCenter(u, activeCenterId);
      const name = String(u.displayName || '').trim().toLowerCase();
      if (!name) continue;
      if (at?.isVolunteer === true) byName.set(name, 'Volunteer');
      else if (at?.instructorType === 'Training') byName.set(name, 'Trainee');
    }
    return (name) => byName.get(String(name || '').trim().toLowerCase()) || null;
  }, [roster, activeCenterId]);

  // Per-side manual overrides — TWO tracks: demand and supply. Cleared
  // and reloaded on date change from the saved snapshot. Cell undefined =
  // "use the live number" (Acuity for demand, the Student Scheduler for
  // supply); a value set = "the owner said this".
  const [overrides, setOverrides] = useState({
    EM: { demand: {}, supply: {} },
    HS: { demand: {}, supply: {} },
  });
  const [ratios, setRatios] = useState({ EM: DEFAULT_TARGET_RATIO, HS: DEFAULT_TARGET_RATIO });
  const [snapshotDirty, setSnapshotDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [typical, setTypical] = useState({}); // dayName -> per-side avg

  // Load the saved snapshot on date change: demand and supply overrides,
  // plus the target ratios, per side.
  useEffect(() => {
    let alive = true;
    setSnapshotDirty(false);
    setLastSavedAt(null);
    (async () => {
      if (!activeCenterId || !date) return;
      const snap = await getSnapshot(activeCenterId, date);
      if (!alive) return;
      const blank = { EM: { demand: {}, supply: {} }, HS: { demand: {}, supply: {} } };
      if (!snap) { setOverrides(blank); return; }
      const rebuild = (arr) => Object.fromEntries(
        (arr || []).map((v, i) => [i, v]).filter(([, v]) => v != null && v !== 0),
      );
      const next = { ...blank };
      for (const side of ['EM', 'HS']) {
        next[side] = { demand: rebuild(snap[side]?.demand), supply: rebuild(snap[side]?.supply) };
      }
      setOverrides(next);
      setRatios(r => ({
        EM: snap.EM?.forecastRatio || r.EM,
        HS: snap.HS?.forecastRatio || r.HS,
      }));
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
      // One bucket per side, which is the shape saveSnapshot has always
      // taken. The single-card version sent { ALL: … }, which that function
      // doesn't read, so every snapshot saved since was written as zeros —
      // and the auto-scheduler's "typical Monday" learnt nothing.
      const pack = (sd, ratio) => (sd ? {
        demand: sd.demand.slice(0, SLOT_COUNT),
        supply: sd.supply.slice(0, SLOT_COUNT),
        forecastRatio: Number(ratio) || null,
      } : null);
      await saveSnapshot(activeCenterId, date, {
        EM: pack(sideData?.EM, ratios.EM),
        HS: pack(sideData?.HS, ratios.HS),
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

    // Demand: bookings fanned across their full length, no-shows and
    // cancellations taken off, walk-ins and call-ins added — the same
    // three sources the Student Scheduler shows (src/lib/slotDemand.js).
    const demandSource = demandBySide({
      slots: apptData.slots || [],
      checkIns,
      addOns,
      dayWindow,
    });

    // Supply: the sides Neeru set in the Student Scheduler for this day,
    // falling back to the posted shifts for a day nobody has filled in yet.
    const supplySource = floorSupply({ assignments, shifts, dayWindow, skip: skipFromRatio });

    for (const side of SIDES) {
      const baseDemand = demandSource[side.key].counts;
      const sideOv = overrides[side.key] || { demand: {}, supply: {} };
      const demandOv = sideOv.demand || {};
      const supplyOv = sideOv.supply || {};
      const demand = baseDemand.map((v, i) => (i in demandOv ? demandOv[i] : v));
      const supplyLive = supplySource[side.key].counts;
      const supplyNames = supplySource[side.key].names;
      // Overrides sit on top of the live count — for when somebody is on
      // the sheet but not actually helping students in that half hour.
      const supply = supplyLive.map((v, i) => (i in supplyOv ? supplyOv[i] : v));
      const rows   = classifySlots(demand, supply, ratios[side.key]);
      const uniqueNames = new Set(supplyNames.flat().map(n => n.toLowerCase()));
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
        baseDemand, demand, supply, supplyNames, rows, stats,
        students: demandSource[side.key].students,
        supplySource: supplySource.source,
        skippedFromRatio: supplySource.skipped,
        outsideWindow: supplySource.outsideWindow,
        hasOverrides: Object.keys(demandOv).length + Object.keys(supplyOv).length > 0,
        demandOverriddenSlots: new Set(Object.keys(demandOv).map(Number)),
        supplyOverriddenSlots: new Set(Object.keys(supplyOv).map(Number)),
      };
    }
    // Everyone on the floor that day, once each — someone who works both
    // sides is one person, not two.
    out._uniqueOnFloor = uniqueOnFloor(supplySource);
    out._walkIns = demandSource.walkIns;
    return out;
  }, [apptData, shifts, assignments, skipFromRatio, overrides, ratios, checkIns, addOns, dayWindow]);

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
            <h1 className="text-2xl font-bold text-gray-900">{PAGES.supplyDemand.name}</h1>
            <p className="text-sm text-gray-500">
              Students booked against the instructors on that side, per half hour.
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
          {/* Bookings come from a parsed cache — Acuity's own feed takes
              26-53 seconds to generate, so no page load waits for it. This
              says how fresh the numbers are and lets someone force a check. */}
          <button
            onClick={async () => { setFeedRefreshing(true); try { await requestFeedRefresh(activeCenterId); } finally { setFeedRefreshing(false); } }}
            disabled={feedRefreshing}
            title="Re-read Acuity now. The page updates by itself when it lands."
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-60"
          >
            <RefreshCw size={15} className={feedRefreshing ? 'animate-spin' : ''} />
          </button>
          <span className="text-xs text-gray-400" title={feedRefreshedAt || ''}>
            updated {describeAge(feedRefreshedAt)}
          </span>
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
          One chart per side, because an instructor can only stand on one of them. Each bar is the <b>students</b> booked on that side in that 30-min slot; the line above it is <b>capacity</b> — the instructors on that side × the target ratio.
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

      {/* Single centre-wide card. EM and HS are still tracked
          internally (perTrack in sideData) so the expand-slot-detail
          panel can show the source breakdown for cross-checking. */}
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

    </div>
  );
}

function SideCard({ side, data, dayWindow, typical, weekdayLabel, forecastRatio, onRatioChange, onDemandChange, onSupplyChange, onResetOverrides, onMatchDemand }) {
  const fmtTime = useTimeFormat();
  const startMin = dayWindow?.startMin || 15 * 60;
  const slotLabel = (i) => slotLabelForIndex(startMin, i, fmtTime);
  const slotCount = dayWindow?.slotCount || data?.demand?.length || 10;
  const { demand, supply, rows, stats, hasOverrides, demandOverriddenSlots, supplyOverriddenSlots } = data;

  // Who is in each number, for this side: the students (already counted
  // once, in slotDemand.js) and the instructors the Student Scheduler put
  // on this side.
  const [expanded, setExpanded] = useState(false);
  const slotRoster = useMemo(() => {
    if (!expanded) return null;
    return (dayWindow?.slotKeys || []).map((slotKey, i) => ({
      slotKey,
      label: slotLabel(i),
      students: data.students?.[i] || [],
      staff: data.supplyNames?.[i] || [],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, dayWindow, data.students, data.supplyNames]);
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
            Demand: students on this side · Supply: instructors on this side · Capacity: supply × target ratio
          </p>
          {/* Where supply came from. On a day whose sides aren't set the
              numbers are a guess from the schedule, and saying so is the
              difference between a forecast and a fact. */}
          <p className="mt-0.5 text-[11px] text-gray-500">
            {data.supplySource === 'scheduler' ? (
              <>Supply from the <b>Student Scheduler</b> — who is on this side, half hour by half hour.</>
            ) : (
              <span className="text-amber-700">
                Sides aren’t set for this day yet — showing who is <b>on shift</b> for this side instead.
              </span>
            )}
            {data.skippedFromRatio?.length > 0 && (
              <span className="text-gray-400">
                {' '}Not counted: {data.skippedFromRatio.map(p => `${p.name} (${p.why.toLowerCase()})`).join(', ')}.
              </span>
            )}
            {data.outsideWindow > 0 && (
              <span className="text-gray-400">
                {' '}{data.outsideWindow} assignment{data.outsideWindow === 1 ? '' : 's'} outside today’s hours.
              </span>
            )}
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
      <Chart rows={rows} maxY={maxY} forecastRatio={forecastRatio} slotLabel={slotLabel} />

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
                Values format: "Matched" or "2 Over" / "1 Under", counted in
                whole instructors (supply − ceil(demand ÷ ratio)). Never a
                fraction: half a person isn't an action anyone can take. */}
            <tr>
              <td className="pr-2 py-2 text-left align-top">
                <div className="text-[10px] font-bold uppercase tracking-wide text-gray-700">Ratio Status</div>
              </td>
              {rows.map(r => {
                // r.overUnderRatio is already a whole number of instructors.
                const abs = Math.abs(r.overUnderRatio);
                let label = 'Matched';
                if (r.status === 'overstaffed')       label = `${abs} Over`;
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

      {/* Expand toggle — reveals the actual names behind every slot's
          Demand + Supply numbers, split into Elementary / High School
          so an owner can cross-check against Acuity + the schedule. */}
      <div className="mt-5 border-t pt-3">
        <button
          onClick={() => setExpanded(v => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
        >
          {expanded ? '▾ Hide slot detail' : '▸ Show slot detail (who\'s in each number)'}
        </button>
      </div>

      {expanded && slotRoster && (
        <div className="mt-4 space-y-3">
          {slotRoster.map(slot => {
            const students = slot.students.length;
            const staff = slot.staff.length;
            if (students === 0 && staff === 0) return null;
            return (
              <div key={slot.slotKey} className="rounded-lg border border-gray-200 bg-gray-50/40 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-bold text-gray-800">{slot.label}</span>
                  <span className="text-[10px] text-gray-500">
                    {students} student{students === 1 ? '' : 's'} · {staff} instructor{staff === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                      Students ({students})
                    </p>
                    {students === 0 ? (
                      <p className="text-xs italic text-gray-400">Nobody booked on this side.</p>
                    ) : (
                      <ul className="space-y-0.5">
                        {slot.students.map((st, idx) => (
                          <li key={idx} className={`text-xs ${st.status === 'noshow' || st.status === 'cancel' ? 'text-red-600 line-through' : 'text-gray-700'}`}>
                            {st.name}
                            <span className="ml-1 text-[10px] text-gray-400">· {st.source}</span>
                            {st.status === 'noshow' && <span className="ml-1 text-[10px] font-semibold text-red-600">no-show</span>}
                            {st.status === 'cancel' && <span className="ml-1 text-[10px] font-semibold text-red-600">cancelled</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-purple-700">
                      On this side ({staff})
                    </p>
                    {staff === 0 ? (
                      <p className="text-xs italic text-gray-400">Nobody on this side.</p>
                    ) : (
                      <ul className="space-y-0.5">
                        {slot.staff.map((name, idx) => (
                          <li key={idx} className="text-xs text-gray-700">{name}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
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
// The drawing lives in components/SlotBarChart.jsx now, so the Coverage
// view is the SAME chart rather than a second one that drifts from this.
// What stays here is what is specific to this page: demand is the bar,
// capacity (supply × target ratio) is the marker line, and the y-axis is
// counted in students.

function Chart({ rows, maxY, forecastRatio, slotLabel }) {
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

  return (
    <SlotBarChart
      items={rows.map((r, i) => ({
        label: slotLabel(i), value: r.demand, marker: r.capacity, status: r.status,
      }))}
      maxY={maxY}
      tickStep={tickStep}
      axisTitle="Students"
      legend={{
        fill: 'Demand (students)',
        matched: 'Supply — matched',
        under: 'Supply — understaffed',
        over: 'Supply — overstaffed',
      }}
    />
  );
}
