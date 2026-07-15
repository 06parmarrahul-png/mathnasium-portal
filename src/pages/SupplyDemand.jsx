import { useState, useEffect, useMemo, useCallback } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Activity, ChevronLeft, ChevronRight, Loader2, AlertTriangle, RotateCcw, Sparkles,
} from 'lucide-react';
import { format, addDays, subDays } from 'date-fns';

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
 * haven't been booked yet), and adjust the target Forecast Ratio to see
 * ratio status per slot (Matched / X Under / X Over) and how many
 * students are affected in under-staffed windows.
 */

// 30-minute slots covering 3pm-8pm (10 slots). Same window as Andy's tool
// and Ratio's Student Scheduler.
const START_HOUR = 15;
const SLOT_COUNT = 10;
const SLOT_MIN = 30;

const SIDES = [
  { key: 'EM', label: 'Elementary',  subRoles: ['Elementary'],             defaultRatio: 3, accent: 'bg-emerald-500', tint: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  { key: 'HS', label: 'High School', subRoles: ['Highschool', 'High School'], defaultRatio: 4, accent: 'bg-blue-500',    tint: 'bg-blue-50 border-blue-200 text-blue-700' },
];

function slotLabel(i) {
  const totalMin = START_HOUR * 60 + i * SLOT_MIN;
  const h24 = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  let h = h24 % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

// Minutes since midnight → shift.startTime "HH:MM" helper.
function timeToMin(t) {
  if (!t || typeof t !== 'string') return null;
  const [h, m] = t.split(':').map(n => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Count how many instructors of the given side are on shift at each 30-min slot.
// Also returns the set of unique instructor names so callers can show
// "5 instructors booked" (unique headcount) rather than the sum of per-slot
// counts (which would be inflated by 10× because each instructor covers
// multiple slots).
function computeSupply(shifts, subRoleMatchers) {
  const counts = new Array(SLOT_COUNT).fill(0);
  const uniqueNames = new Set();
  const matchesSide = (s) => {
    const sub = (s.subRole || '').toLowerCase();
    return subRoleMatchers.some(m => sub === m.toLowerCase());
  };
  for (const s of shifts) {
    if (!matchesSide(s)) continue;
    const startMin = timeToMin(s.startTime);
    const endMin   = timeToMin(s.endTime);
    if (startMin == null || endMin == null) continue;
    let touchedAnySlot = false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slotStart = START_HOUR * 60 + i * SLOT_MIN;
      const slotEnd   = slotStart + SLOT_MIN;
      // Instructor counts as "on" the slot if their shift covers ≥ half of it.
      const overlap = Math.max(0, Math.min(endMin, slotEnd) - Math.max(startMin, slotStart));
      if (overlap >= SLOT_MIN / 2) { counts[i]++; touchedAnySlot = true; }
    }
    if (touchedAnySlot) uniqueNames.add(s.userName || s.userId || 'unknown');
  }
  return { counts, uniqueNames };
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
  const { activeCenterId, canSeeCenterSettings } = useAuth();
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [apptData, setApptData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState(null);

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

  // Per-side demand override map. Cleared automatically on date change.
  const [overrides, setOverrides] = useState({}); // { EM: {slotIdx: n}, HS: {...} }
  useEffect(() => { setOverrides({}); }, [date]);

  // Per-side forecast ratio state. Defaults per SIDES definition.
  const [ratios, setRatios] = useState({ EM: 3, HS: 4 });

  const setOverride = useCallback((sideKey, slotIdx, value) => {
    setOverrides(prev => {
      const next = { ...prev };
      const sideMap = { ...(next[sideKey] || {}) };
      if (value === '' || value == null) delete sideMap[slotIdx];
      else {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) sideMap[slotIdx] = n;
      }
      if (Object.keys(sideMap).length === 0) delete next[sideKey];
      else next[sideKey] = sideMap;
      return next;
    });
  }, []);

  const resetOverrides = useCallback((sideKey) => {
    setOverrides(prev => {
      const next = { ...prev };
      delete next[sideKey];
      return next;
    });
  }, []);

  // Per-side derived data (memoized so cell edits don't re-run everything).
  const sideData = useMemo(() => {
    if (!apptData) return null;
    const out = {};
    for (const side of SIDES) {
      const baseDemand = new Array(SLOT_COUNT).fill(0);
      const slots = apptData.slots || [];
      // Slots from the API start at APPT_START_HOUR (server-side constant).
      // We assume it matches START_HOUR; if not, first-slot alignment will
      // just be off by an offset — visible to the owner and easy to spot.
      for (let i = 0; i < Math.min(SLOT_COUNT, slots.length); i++) {
        baseDemand[i] = slots[i]?.counts?.[side.key] || 0;
      }
      const ovMap = overrides[side.key] || {};
      const demand = baseDemand.map((v, i) => (i in ovMap ? ovMap[i] : v));
      const { counts: supply, uniqueNames } = computeSupply(shifts, side.subRoles);
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
      out[side.key] = { baseDemand, demand, supply, rows, stats, hasOverrides: Object.keys(ovMap).length > 0 };
    }
    return out;
  }, [apptData, shifts, overrides, ratios]);

  // Match Demand: bump the forecast ratio so today's supply exactly meets
  // today's demand. Read as "what ratio would we need to be at, given the
  // supply we have, to serve this demand?" — informational, not a save.
  const matchDemand = useCallback((sideKey) => {
    if (!sideData) return;
    const { demand, supply } = sideData[sideKey];
    const totalD = demand.reduce((a, b) => a + b, 0);
    // Use average supply during hours that have demand — using peak alone
    // over-inflates the divisor when the last hour has 1 instructor and 0
    // students.
    const productiveSlots = demand.map((d, i) => d > 0 ? supply[i] : 0);
    const avgSupply = productiveSlots.filter(v => v > 0).reduce((a, b) => a + b, 0) / Math.max(1, productiveSlots.filter(v => v > 0).length);
    if (avgSupply === 0) return;
    const suggested = Math.max(1, Math.round((totalD / demand.filter(d => d > 0).length / avgSupply) * 10) / 10);
    setRatios(r => ({ ...r, [sideKey]: suggested }));
  }, [sideData]);

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
          Each bar shows how many <b>students</b> are booked in that 30-min slot. The black line above it is your <b>capacity</b> — instructors on shift × forecast ratio.
          {' '}<span className="text-emerald-700 font-semibold">Green</span> = capacity matches demand ·
          {' '}<span className="text-red-700 font-semibold">Red</span> = short on staff (students beyond capacity) ·
          {' '}<span className="text-amber-700 font-semibold">Amber</span> = over-staffed (paying for empty seats).
        </p>
      </div>

      {/* Per-side sections */}
      {sideData && SIDES.map(side => (
        <SideCard
          key={side.key}
          side={side}
          data={sideData[side.key]}
          forecastRatio={ratios[side.key]}
          onRatioChange={(v) => setRatios(r => ({ ...r, [side.key]: v }))}
          onOverrideChange={(idx, v) => setOverride(side.key, idx, v)}
          onResetOverrides={() => resetOverrides(side.key)}
          onMatchDemand={() => matchDemand(side.key)}
        />
      ))}

      {/* Whole-Centre aggregate — adds EM + HS per slot into a single
          chart. Capacity uses a blended ratio: each side keeps its own
          forecast ratio, so combined capacity = EMsupply×EMratio +
          HSsupply×HSratio. That's more accurate than picking one ratio,
          since HS students genuinely need less hand-holding than EM. */}
      {sideData && (
        <CombinedCard
          emData={sideData.EM}
          hsData={sideData.HS}
          emRatio={ratios.EM}
          hsRatio={ratios.HS}
          dateLabel={format(new Date(date + 'T00:00:00'), 'EEE MMM d')}
        />
      )}
    </div>
  );
}

// ─── Whole-Centre aggregate ─────────────────────────────────────────────

function CombinedCard({ emData, hsData, emRatio, hsRatio, dateLabel }) {
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
    const uniqueSupply = emData.stats.uniqueSupply + hsData.stats.uniqueSupply;
    const peakDemand = Math.max(0, ...demand);
    const peakSupply = Math.max(0, ...supply);
    const impactStudents = rows
      .filter(r => r.status === 'understaffed')
      .reduce((sum, r) => sum + Math.max(0, r.demand - r.capacity), 0);
    return { demand, supply, capacity, rows, totalDemand, uniqueSupply, peakDemand, peakSupply, impactStudents };
  }, [emData, hsData, emRatio, hsRatio]);

  const maxY = Math.max(1, ...combined.demand, ...combined.capacity) * 1.1;

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-3">
        <h2 className="text-base font-bold text-gray-900">Whole Centre — {dateLabel}</h2>
        <p className="text-xs text-gray-500">
          Elementary + High School combined. Capacity is blended: EM supply × {emRatio} + HS supply × {hsRatio}.
        </p>
      </div>

      {/* Same chart component the per-side cards use — blended ratio is
          passed just for the legend label. */}
      <Chart demand={combined.demand} rows={combined.rows} maxY={maxY} forecastRatio={`${emRatio}/${hsRatio}`} />

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-1.5 pr-2 font-medium">Slot</th>
              {combined.rows.map(r => (
                <th key={r.i} className="py-1.5 px-1 font-medium text-center whitespace-nowrap">{slotLabel(r.i)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="[&_td]:py-1 [&_td]:px-1 [&_td]:text-center">
            <tr className="border-b">
              <td className="pr-2 text-left font-medium text-gray-700">Students (EM + HS)</td>
              {combined.rows.map(r => <td key={r.i} className="font-semibold">{r.demand}</td>)}
            </tr>
            <tr className="border-b bg-gray-50/50">
              <td className="pr-2 text-left font-medium text-gray-700">Instructors</td>
              {combined.rows.map(r => <td key={r.i} className="font-semibold text-gray-800">{r.supply}</td>)}
            </tr>
            <tr className="border-b">
              <td className="pr-2 text-left font-medium text-gray-500">Blended Capacity</td>
              {combined.rows.map(r => <td key={r.i} className="text-gray-500">{Math.round(r.capacity)}</td>)}
            </tr>
            <tr>
              <td className="pr-2 text-left font-medium text-gray-700">Coverage</td>
              {combined.rows.map(r => {
                const spareSeats = Math.max(0, Math.round(r.capacity - r.demand));
                const shortStudents = Math.max(0, Math.round(r.demand - r.capacity));
                let label = 'Matched';
                if (r.status === 'understaffed') label = `-${shortStudents} student${shortStudents === 1 ? '' : 's'}`;
                else if (r.status === 'overstaffed') label = `+${spareSeats} seat${spareSeats === 1 ? '' : 's'}`;
                return (
                  <td key={r.i}>
                    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${
                      r.status === 'matched'      ? 'bg-emerald-100 text-emerald-700'
                      : r.status === 'understaffed' ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                    }`}>
                      {label}
                    </span>
                  </td>
                );
              })}
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

function SideCard({ side, data, forecastRatio, onRatioChange, onOverrideChange, onResetOverrides, onMatchDemand }) {
  const { demand, supply, rows, stats, hasOverrides } = data;
  const maxY = Math.max(1, ...demand, ...supply.map(s => s * forecastRatio)) * 1.1;

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-gray-900">{side.label} — Supply vs. Demand</h2>
          <p className="text-xs text-gray-500">
            Demand: students booked · Supply: instructors on shift · Capacity: supply × forecast ratio
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-gray-600">
            Forecast Ratio
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
      <Chart demand={demand} supply={supply} rows={rows} maxY={maxY} forecastRatio={forecastRatio} accent={side.accent} />

      {/* Data table — Demand / Supply / Capacity / Status / Impact */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b">
              <th className="py-1.5 pr-2 font-medium">Slot</th>
              {rows.map(r => (
                <th key={r.i} className="py-1.5 px-1 font-medium text-center whitespace-nowrap">{slotLabel(r.i)}</th>
              ))}
            </tr>
          </thead>
          <tbody className="[&_td]:py-1 [&_td]:px-1 [&_td]:text-center">
            <tr className="border-b">
              <td className="pr-2 text-left font-medium text-gray-700">Demand</td>
              {rows.map(r => (
                <td key={r.i}>
                  <input
                    type="number"
                    min={0}
                    value={r.demand}
                    onChange={e => onOverrideChange(r.i, e.target.value)}
                    className="w-11 rounded border border-transparent bg-transparent px-1 py-0.5 text-center focus:border-emerald-500 focus:bg-white focus:outline-none hover:border-gray-200"
                    title="Click to override this slot's demand (walk-ins, cancellations, etc.)"
                  />
                </td>
              ))}
            </tr>
            <tr className="border-b bg-gray-50/50">
              <td className="pr-2 text-left font-medium text-gray-700">Supply (instructors)</td>
              {rows.map(r => (
                <td key={r.i} className="font-semibold text-gray-800">{r.supply}</td>
              ))}
            </tr>
            <tr className="border-b">
              <td className="pr-2 text-left font-medium text-gray-500">Capacity (supply × ratio)</td>
              {rows.map(r => (
                <td key={r.i} className="text-gray-500">{r.capacity.toFixed(0)}</td>
              ))}
            </tr>
            <tr className="border-b">
              <td className="pr-2 text-left font-medium text-gray-700">Coverage</td>
              {rows.map(r => {
                // Convert the ratio-space diff into a human number:
                // over = spare seats (capacity − demand), under = students
                // beyond capacity (demand − capacity). Owners think in
                // students, not "0.7 Over".
                const spareSeats = Math.max(0, Math.round(r.capacity - r.demand));
                const shortStudents = Math.max(0, Math.round(r.demand - r.capacity));
                let label = 'Matched';
                if (r.status === 'understaffed') label = `-${shortStudents} student${shortStudents === 1 ? '' : 's'}`;
                else if (r.status === 'overstaffed') label = `+${spareSeats} seat${spareSeats === 1 ? '' : 's'}`;
                return (
                  <td key={r.i}>
                    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${
                      r.status === 'matched'      ? 'bg-emerald-100 text-emerald-700'
                      : r.status === 'understaffed' ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'
                    }`}>
                      {label}
                    </span>
                  </td>
                );
              })}
            </tr>
            <tr>
              <td className="pr-2 text-left font-medium text-gray-500">Impact (# students)</td>
              {rows.map(r => (
                <td key={r.i} className={r.status === 'understaffed' ? 'font-bold text-red-600' : 'text-gray-400'}>
                  {r.status === 'understaffed' ? Math.max(0, Math.round(r.demand - r.capacity)) : '—'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Summary strip — uses the FIXED unique-instructor count now,
          plus the total student count summed across slots. */}
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-600">
        <span>
          <b>{demand.reduce((a, b) => a + b, 0)}</b> student appointment{demand.reduce((a, b) => a + b, 0) === 1 ? '' : 's'} · <b>{stats.uniqueSupply}</b> instructor{stats.uniqueSupply === 1 ? '' : 's'} on shift today
          {stats.peakSupply > 0 && (
            <span className="text-gray-400"> (peak {stats.peakSupply} at once)</span>
          )}
        </span>
        <span className="text-emerald-700">{stats.matchedCount} matched slots</span>
        <span className="text-red-700">{stats.underCount} short</span>
        <span className="text-amber-700">{stats.overCount} over</span>
        {stats.impactStudents > 0 && (
          <span className="text-red-700 font-semibold">
            ~{Math.round(stats.impactStudents)} students beyond capacity at ratio {forecastRatio}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── SVG bar chart ───────────────────────────────────────────────────────
// Two series per slot: green bar = demand (students), overlaid line = supply
// capacity (supply × forecastRatio). Bars re-tint red/amber when supply
// can't meet demand at the target ratio. Compact so we can fit 10 slots in
// a single row without horizontal scroll on desktop.

function Chart({ demand, rows, maxY, forecastRatio }) {
  const W = 720, H = 220, PADL = 32, PADB = 28, PADT = 10, PADR = 8;
  const chartW = W - PADL - PADR;
  const chartH = H - PADT - PADB;
  const barW = chartW / demand.length * 0.7;
  const groupW = chartW / demand.length;
  const yScale = (v) => PADT + chartH - (v / maxY) * chartH;

  const yTicks = 4;
  const tickStep = Math.max(1, Math.ceil(maxY / yTicks));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Y grid + labels */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const val = i * tickStep;
        const y = yScale(val);
        return (
          <g key={i}>
            <line x1={PADL} x2={W - PADR} y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />
            <text x={PADL - 4} y={y + 3} textAnchor="end" fontSize="9" fill="#6b7280">{val}</text>
          </g>
        );
      })}

      {/* Bars: demand height, tinted by ratio status */}
      {rows.map((r, i) => {
        const x = PADL + i * groupW + (groupW - barW) / 2;
        const y = yScale(r.demand);
        const h = Math.max(0, PADT + chartH - y);
        const capY = yScale(r.capacity);
        const fill = r.status === 'matched'      ? '#10b981'
                  : r.status === 'understaffed' ? '#ef4444'
                  : '#f59e0b';
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={h} rx="2" fill={fill} opacity="0.85" />
            {/* Capacity marker (short black line across the top of the bar) */}
            <line
              x1={x - 2} x2={x + barW + 2}
              y1={capY}  y2={capY}
              stroke="#111827" strokeWidth="2"
            />
            <text x={x + barW / 2} y={y - 3} textAnchor="middle" fontSize="9" fill="#374151">
              {r.demand}
            </text>
            {/* X-axis label */}
            <text x={x + barW / 2} y={H - PADB + 12} textAnchor="middle" fontSize="9" fill="#6b7280">
              {slotLabel(i)}
            </text>
          </g>
        );
      })}

      {/* Legend */}
      <g transform={`translate(${PADL}, ${H - 4})`}>
        <rect x="0" y="-8" width="8" height="8" fill="#10b981" />
        <text x="12" y="-1" fontSize="9" fill="#6b7280">matched</text>
        <rect x="66" y="-8" width="8" height="8" fill="#ef4444" />
        <text x="78" y="-1" fontSize="9" fill="#6b7280">understaffed</text>
        <rect x="150" y="-8" width="8" height="8" fill="#f59e0b" />
        <text x="162" y="-1" fontSize="9" fill="#6b7280">overstaffed</text>
        <line x1="230" y1="-4" x2="242" y2="-4" stroke="#111827" strokeWidth="2" />
        <text x="246" y="-1" fontSize="9" fill="#6b7280">capacity (supply × {forecastRatio})</text>
      </g>
    </svg>
  );
}
