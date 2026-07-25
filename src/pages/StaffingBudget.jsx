import { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, query, where, doc, setDoc, deleteField, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { resolveUserForCenter } from '../lib/centerMembership';
import { resolveInstructionalHours, holidayFor } from '../lib/centerConfig';
import { BUDGET_BUCKETS, WEEKDAY_DEFAULTS, weekdayBudgetTotal, bucketHoursForShift } from '../lib/budgetBuckets';
import { format, addDays, subDays } from 'date-fns';
import {
  Wallet, ChevronLeft, ChevronRight, ChevronDown, Save, Check, Users, GraduationCap, TrendingUp, CalendarDays, RotateCcw,
} from 'lucide-react';

/**
 * Staffing Budget — Budget vs Actual, aligned to the centre's PAYROLL PERIODS
 * (the 11th–25th and the 26th–10th), straight off Ratio's shift data.
 *
 * Hours split by role, each vs an editable target (per-role, seeded from the
 * July 2026 model). Visual bars + numbers, plus a per-day over/under view and
 * a multi-period trend. Salaried staff + volunteers are excluded to match
 * Manage Payroll. Targets live on centerConfig.staffingBudget.
 */

// Paid hours — matches Manage Payroll (no-show = 0, payHoursOverride wins).
function paidHours(s) {
  if (s.noShow) return 0;
  if (typeof s.payHoursOverride === 'number' && isFinite(s.payHoursOverride)) return Math.max(0, s.payHoursOverride);
  if (!s.startTime || !s.endTime) return 0;
  const [sh, sm] = s.startTime.split(':').map(Number);
  const [eh, em] = s.endTime.split(':').map(Number);
  const h = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
  return isNaN(h) || h < 0 ? 0 : h;
}

// Category rows = the shared work-type buckets.
const CATEGORIES = BUDGET_BUCKETS;

// Normalise a display name so the staff count de-dupes name variants
// ("Benjamin Gong" vs "benjamin gong ") — same as Manage Payroll.
const normName = (n) => (n || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Does this shift count toward WORKED budget hours? Mirrors Manage Payroll's
// filter: skip drafts, role=Volunteer shifts, and the excluded people
// (salaried / volunteer-flagged / hidden-from-ops). Sick + no-show handled
// separately by the caller.
function countsAsWork(s, excluded) {
  if (s.status === 'draft') return false;
  if (s.role === 'Volunteer') return false;
  if (excluded && excluded.has(s.userName)) return false;
  return true;
}

// Per-period default targets — the centre's current model, 623h total.
// Used for any pay period that hasn't had its own targets saved (see the
// resolution chain below). Update these when the underlying model changes;
// periods already saved under byPeriod are unaffected.
const DEFAULT_TARGETS = {
  instructional: 315, online: 54, steam: 46, summerCamp: 54,
  adminHours: 68, adminAssistant: 40, host: 46,
  kpi: 1.8, // instructional hours per student
};
const TARGET_KEYS = Object.keys(DEFAULT_TARGETS);

// WEEKDAY_DEFAULTS (the centre's day model) is imported from budgetBuckets
// so Manage Schedule's header ratio and this page's extra-day pricing can't
// drift apart. Each extra day is seeded from its weekday there and stays
// editable per period.

// ── Per-period targets ──────────────────────────────────────────────────
// Targets are saved AGAINST A PAY PERIOD, keyed by that period's start date
// ('2026-07-11'). Editing next period's budget therefore leaves this
// period's alone — before this, every period shared one global set, so
// changing one changed them all.
//
// Resolution order for whichever period you're viewing:
//   1. targets saved for that exact period → use them
//   2. periods on/before LEGACY_TARGETS_THROUGH → the centre's old single
//      global set, so already-reviewed history keeps the budget line it
//      was measured against
//   3. anything later → DEFAULT_TARGETS, the July 2026 model. A brand-new
//      period starts from the model rather than silently inheriting
//      whatever happened to be set months ago.
//
// The constant is the start date of the pay period during which per-period
// targets shipped. It's deliberately frozen rather than derived from
// "today" — otherwise periods would silently change which budget they were
// compared against as time passed.
const LEGACY_TARGETS_THROUGH = '2026-07-11';

// Keep only real target keys — the stored staffingBudget object also holds
// extraDays and byPeriod, which must never leak into a targets object.
function pickTargets(src) {
  const out = {};
  if (!src) return out;
  for (const k of TARGET_KEYS) if (src[k] != null && src[k] !== '') out[k] = src[k];
  return out;
}

// Weekday order for the per-day budget editor.
const WEEKDAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// Indexed by Date#getDay().
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// `windowFor(dateStr)` → { start, end } instructional window for that day (or null),
// used to split floor shifts into Instructional (in-window) vs Admin Hours (out).
function aggregate(shifts, loStr, hiStr, excluded, windowFor) {
  const byCat = {};
  for (const b of BUDGET_BUCKETS) byCat[b.key] = 0;
  const staff = new Set();
  let total = 0;
  let sick = 0; // paid, but kept OUT of worked buckets (like Manage Payroll)
  for (const s of shifts) {
    if (!s.date || s.date < loStr || s.date > hiStr) continue;
    if (!countsAsWork(s, excluded)) continue;
    const hrs = paidHours(s);
    if (hrs <= 0) continue;
    if (s.sickPay) { sick += hrs; continue; } // sick tracked separately
    const alloc = bucketHoursForShift(s, hrs, windowFor(s.date));
    for (const k in alloc) byCat[k] = (byCat[k] || 0) + alloc[k];
    total += hrs;
    if (s.userName) staff.add(normName(s.userName));
  }
  return { byCat, total, staffCount: staff.size, sick };
}

function perDayHours(shifts, loStr, hiStr, excluded, windowFor) {
  const byDate = new Map();
  for (const s of shifts) {
    if (!s.date || s.date < loStr || s.date > hiStr) continue;
    if (!countsAsWork(s, excluded)) continue;
    const hrs = paidHours(s);
    if (hrs <= 0) continue;
    if (s.sickPay) continue; // sick not in worked day totals
    let rec = byDate.get(s.date);
    if (!rec) { rec = { total: 0, byCat: {} }; byDate.set(s.date, rec); }
    rec.total += hrs;
    const alloc = bucketHoursForShift(s, hrs, windowFor(s.date));
    for (const k in alloc) rec.byCat[k] = (rec.byCat[k] || 0) + alloc[k];
  }
  return byDate;
}

const round1 = (n) => Math.round(n * 10) / 10;

// ── Payroll periods: 11th–25th, and 26th–10th (crosses month end) ───────────
function payrollStartFor(d) {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  if (day >= 11 && day <= 25) return new Date(y, m, 11);
  if (day >= 26) return new Date(y, m, 26);
  return new Date(y, m - 1, 26); // 1st–10th belongs to the prior 26th
}
function periodEndFor(start) {
  return start.getDate() === 11
    ? new Date(start.getFullYear(), start.getMonth(), 25)
    : new Date(start.getFullYear(), start.getMonth() + 1, 10);
}
function nextPeriodStart(s) {
  return s.getDate() === 11 ? new Date(s.getFullYear(), s.getMonth(), 26) : new Date(s.getFullYear(), s.getMonth() + 1, 11);
}
function prevPeriodStart(s) {
  return s.getDate() === 11 ? new Date(s.getFullYear(), s.getMonth() - 1, 26) : new Date(s.getFullYear(), s.getMonth(), 11);
}

// ── Small presentational bar (actual fill + target tick) ────────────────────
function HBar({ value, target, scale, over }) {
  const w = scale > 0 ? Math.min(100, (value / scale) * 100) : 0;
  const tick = scale > 0 ? Math.min(100, (target / scale) * 100) : 0;
  return (
    <div className="relative h-2.5 w-full rounded-full bg-gray-100">
      <div className="h-2.5 rounded-full transition-all" style={{ width: `${w}%`, backgroundColor: over ? '#ef4444' : '#10b981' }} />
      {target > 0 && (
        <div className="absolute -top-1 h-[18px] w-0.5 rounded bg-gray-700" style={{ left: `calc(${tick}% - 1px)` }} title={`Target ${round1(target)}`} />
      )}
    </div>
  );
}

export default function StaffingBudget() {
  const { activeCenterId, centerConfig, canSeeAdminPanel, activeCenterName } = useAuth();
  const [shifts, setShifts] = useState([]);
  const [studentCount, setStudentCount] = useState(0);
  const [users, setUsers] = useState([]);
  const [showTargets, setShowTargets] = useState(false);

  const excludedNames = useMemo(() => {
    const set = new Set(Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : []);
    for (const u of users) {
      const resolved = resolveUserForCenter(u, activeCenterId);
      // Volunteers (per-centre flag) — unpaid, off the hourly budget.
      if (resolved?.isVolunteer === true && resolved.displayName) set.add(resolved.displayName);
      // Hidden-from-ops accounts — same set Manage Payroll drops.
      const hidden = u.role === 'owner' || u.role === 'super_admin' || u.role === 'director'
        || u.internal === true || u.displayName === 'Admin Team';
      if (hidden && u.displayName) set.add(u.displayName);
    }
    return set;
  }, [centerConfig, users, activeCenterId]);

  // Instructional window for a given date — used to split floor shifts into
  // Instructional (inside the window) vs Admin Hours (outside). Honours summer
  // overrides via resolveInstructionalHours.
  const windowFor = useMemo(() => {
    const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return (dateStr) => {
      const d = new Date(dateStr + 'T12:00:00');
      const map = resolveInstructionalHours(centerConfig, d) || {};
      return map[DOW[d.getDay()]] || null;
    };
  }, [centerConfig]);

  // Payroll period. Default: the one containing today.
  const [periodStart, setPeriodStart] = useState(() => payrollStartFor(new Date()));
  const periodEnd = periodEndFor(periodStart);
  const loStr = format(periodStart, 'yyyy-MM-dd');
  const hiStr = format(periodEnd, 'yyyy-MM-dd');

  const budgetCfg = useMemo(() => centerConfig?.staffingBudget || {}, [centerConfig]);

  // `targetsFor(periodKey)` — resolve a period's
  // budget through the saved → legacy → default chain described up top.
  // Exposed as functions (not just this period's value) so the trend chart
  // can compare each of its 6 bars to that bar's own budget.
  const targetsFor = useMemo(() => {
    const byPeriod = budgetCfg.byPeriod || {};
    return (key) => {
      if (byPeriod[key]) return { ...DEFAULT_TARGETS, ...pickTargets(byPeriod[key]) };
      if (key <= LEGACY_TARGETS_THROUGH) return { ...DEFAULT_TARGETS, ...pickTargets(budgetCfg) };
      return { ...DEFAULT_TARGETS };
    };
  }, [budgetCfg]);
  // Per-period overrides for the extra day's category budget, keyed by
  // weekday. Absent → fall back to WEEKDAY_DEFAULTS.
  const extraDaysFor = useMemo(() => {
    const byPeriod = budgetCfg.byPeriod || {};
    return (key) => byPeriod[key]?.extraDays || {};
  }, [budgetCfg]);

  // Where this period's numbers came from — drives the badge in the Targets
  // panel so it's never ambiguous whether you're looking at saved figures.
  const targetSource = (budgetCfg.byPeriod || {})[loStr]
    ? 'saved'
    : (loStr <= LEGACY_TARGETS_THROUGH ? 'legacy' : 'default');

  const savedTargets = useMemo(() => targetsFor(loStr), [targetsFor, loStr]);
  const [targets, setTargets] = useState(savedTargets);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  // Re-seeds whenever you page to another period, so the boxes always show
  // THAT period's budget rather than carrying your unsaved edits across.
  useEffect(() => { setTargets(savedTargets); }, [savedTargets]);

  const [expandedDay, setExpandedDay] = useState(null); // day row index whose category breakdown is open

  const savedExtraDays = useMemo(() => extraDaysFor(loStr), [extraDaysFor, loStr]);
  const [extraDays, setExtraDays] = useState(() => savedExtraDays || {});
  useEffect(() => { setExtraDays(savedExtraDays || {}); }, [savedExtraDays]);
  const setExtraCat = (weekday, key, value) => setExtraDays(prev => ({
    ...prev,
    [weekday]: { ...(WEEKDAY_DEFAULTS[weekday] || {}), ...(prev[weekday] || {}), [key]: value },
  }));
  const resetExtraDay = (weekday) => setExtraDays(prev => {
    const next = { ...prev };
    delete next[weekday];
    return next;
  });

  useEffect(() => {
    if (!activeCenterId) return;
    const windowStart = format(subDays(new Date(), 220), 'yyyy-MM-dd');
    return onSnapshot(
      query(collection(db, 'shifts'), where('centerId', '==', activeCenterId)),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.date && s.date >= windowStart)),
      () => setShifts([]),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return;
    return onSnapshot(
      query(collection(db, 'students'), where('centerId', '==', activeCenterId)),
      snap => setStudentCount(snap.docs.filter(d => (d.data()?.status || 'active') !== 'inactive').length),
      () => setStudentCount(0),
    );
  }, [activeCenterId]);

  useEffect(() => {
    if (!activeCenterId) return;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setUsers(snap.docs.map(d => ({ uid: d.id, ...d.data() }))),
      () => setUsers([]),
    );
  }, [activeCenterId]);

  const period = useMemo(() => aggregate(shifts, loStr, hiStr, excludedNames, windowFor), [shifts, loStr, hiStr, excludedNames, windowFor]);
  const kpi = studentCount > 0 ? period.byCat.instructional / studentCount : null;

  const opDays = useMemo(() => (
    (Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length)
      ? centerConfig.operatingDays
      : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  ), [centerConfig]);

  // Hoisted so both the by-day view and the extra-day mix read the same
  // per-date buckets instead of recomputing them.
  const byDateHours = useMemo(
    () => perDayHours(shifts, loStr, hiStr, excludedNames, windowFor),
    [shifts, loStr, hiStr, excludedNames, windowFor],
  );

  // Base budget = the 14-day cycle the targets are written against.
  const baseTarget = useMemo(() => CATEGORIES.reduce((n, c) => n + (Number(targets[c.key]) || 0), 0), [targets]);

  // ── The 15th (and sometimes 16th) day ──────────────────────────────────
  // Pay periods run 15 days (11th–25th) or 15–16 days (26th–10th), but the
  // staffing budget is built on a 14-day cycle. That leaves one or two
  // weekdays running a THIRD time in the period which the base targets
  // don't pay for — so a 15-day period read over budget through no fault of
  // the schedule.
  //
  // The extra days are simply the first (length − 14) days of the period.
  // Each carries its OWN category budget, seeded from WEEKDAY_DEFAULTS and
  // editable per period — same seven boxes as the cycle above, so a 3rd
  // Wednesday buys Wednesday-shaped hours and a 3rd Saturday buys
  // Saturday-shaped ones. A 3rd Sunday costs nothing (closed), which is why
  // the 16-day 26th–10th periods that pick up Sunday + Monday only really
  // pay for the Monday.
  const extra = useMemo(() => {
    const periodDays = Math.round((periodEnd - periodStart) / 86400000) + 1;
    const days = [];
    for (let i = 0; i < Math.max(0, periodDays - 14); i++) {
      const d = addDays(periodStart, i);
      const weekday = DOW_NAMES[d.getDay()];
      const saved = extraDays[weekday];
      const seed = WEEKDAY_DEFAULTS[weekday] || {};
      const cats = {};
      for (const c of CATEGORIES) {
        const raw = saved && saved[c.key] != null && saved[c.key] !== ''
          ? saved[c.key]
          : (seed[c.key] || 0);
        cats[c.key] = Number(raw) || 0;
      }
      days.push({
        weekday,
        label: format(d, 'EEE MMM d'),
        dayNo: 15 + i,
        cats,
        total: CATEGORIES.reduce((n, c) => n + cats[c.key], 0),
        isCustom: !!saved,
        isOpen: opDays.includes(weekday),
      });
    }
    const alloc = {};
    for (const d of days) {
      for (const c of CATEGORIES) if (d.cats[c.key] > 0) alloc[c.key] = (alloc[c.key] || 0) + d.cats[c.key];
    }
    return { days, alloc, hours: days.reduce((n, d) => n + d.total, 0), periodDays };
  }, [periodStart, periodEnd, opDays, extraDays]);

  // What every bar on this page actually measures against: base + top-up.
  const effTargets = useMemo(() => {
    const out = {};
    for (const c of CATEGORIES) out[c.key] = (Number(targets[c.key]) || 0) + (extra.alloc[c.key] || 0);
    return out;
  }, [targets, extra]);
  const totalTarget = useMemo(() => CATEGORIES.reduce((n, c) => n + (effTargets[c.key] || 0), 0), [effTargets]);

  const catScale = useMemo(
    () => Math.max(1, ...CATEGORIES.map(c => Math.max(period.byCat[c.key], effTargets[c.key] || 0))) * 1.1,
    [period, effTargets],
  );

  // Each day is measured against its weekday's budget from the centre's day
  // model — the same numbers Manage Schedule puts in its column headers, so
  // a Monday reads the same on both pages. No per-period daily editor: the
  // model is the single source, edited in lib/budgetBuckets.
  const perDay = useMemo(() => {
    const rows = [];
    let opCount = 0;
    let d = periodStart;
    while (format(d, 'yyyy-MM-dd') <= hiStr) {
      const ds = format(d, 'yyyy-MM-dd');
      const weekday = DOW_NAMES[d.getDay()];
      // A configured holiday closes the centre just like a non-operating
      // weekday, so it greys out and carries no budget.
      const holiday = holidayFor(ds, centerConfig);
      const isOp = opDays.includes(weekday) && !holiday;
      if (isOp) opCount++;
      const rec = byDateHours.get(ds) || { total: 0, byCat: {} };
      rows.push({
        label: format(d, 'EEE MMM d'), weekday, isOp,
        holiday: holiday?.name || null,
        total: rec.total, byCat: rec.byCat,
      });
      d = addDays(d, 1);
    }
    // Closed days and holidays carry no budget; everything else takes its
    // weekday's figure. modelTotal is what the model says this whole period
    // should cost, surfaced in the header so it can be compared against the
    // period target rather than quietly disagreeing with it.
    let modelTotal = 0;
    for (const r of rows) {
      r.budget = r.isOp ? weekdayBudgetTotal(r.weekday) : 0;
      modelTotal += r.budget;
    }
    return { rows, opCount, modelTotal };
  }, [byDateHours, hiStr, periodStart, opDays, centerConfig]);
  const dayScale = useMemo(
    () => Math.max(1, ...perDay.rows.map(r => Math.max(r.total, r.budget || 0))) * 1.05,
    [perDay],
  );

  // Total budget for ANY period — that period's saved targets plus its own
  // extra-day top-up. Used by the trend so each bar compares to a budget
  // built for its own length, not this period's.
  const periodBudgetTotal = useMemo(() => (st) => {
    const key = format(st, 'yyyy-MM-dd');
    const t = targetsFor(key);
    const base = CATEGORIES.reduce((n, c) => n + (Number(t[c.key]) || 0), 0);
    const en = periodEndFor(st);
    const len = Math.round((en - st) / 86400000) + 1;
    const saved = extraDaysFor(key);
    let topUp = 0;
    for (let i = 0; i < Math.max(0, len - 14); i++) {
      const wd = DOW_NAMES[addDays(st, i).getDay()];
      const src = saved[wd] || WEEKDAY_DEFAULTS[wd] || {};
      for (const c of CATEGORIES) topUp += Number(src[c.key]) || 0;
    }
    return base + topUp;
  }, [targetsFor, extraDaysFor]);

  const trend = useMemo(() => {
    const starts = [];
    let s = periodStart;
    for (let i = 0; i < 6; i++) { starts.unshift(s); s = prevPeriodStart(s); }
    return starts.map(st => {
      const key = format(st, 'yyyy-MM-dd');
      const en = periodEndFor(st);
      const a = aggregate(shifts, key, format(en, 'yyyy-MM-dd'), excludedNames, windowFor);
      // Each bar is measured against ITS OWN period's budget — a single
      // shared line would be wrong now that targets vary period to period,
      // and each period tops up for its own extra day(s).
      const budget = periodBudgetTotal(st);
      return { label: format(st, 'MMM d'), total: a.total, instructional: a.byCat.instructional, budget };
    });
  }, [shifts, periodStart, excludedNames, windowFor, periodBudgetTotal]);
  const trendMax = useMemo(
    () => Math.max(1, ...trend.map(t => Math.max(t.total, t.budget || 0))) * 1.08,
    [trend],
  );

  // Normalised so '30' (freshly typed) and 30 (loaded from Firestore) don't
  // read as a change.
  const normExtra = (o) => JSON.stringify(WEEKDAY_ORDER.reduce((acc, wd) => {
    if (o?.[wd]) acc[wd] = CATEGORIES.reduce((m, c) => ({ ...m, [c.key]: Number(o[wd][c.key]) || 0 }), {});
    return acc;
  }, {}));
  const dirty = TARGET_KEYS.some(k => Number(targets[k]) !== Number(savedTargets[k]))
    || normExtra(extraDays) !== normExtra(savedExtraDays);

  // Writes ONLY the period currently on screen, under
  // staffingBudget.byPeriod['<period start>']. setDoc + merge deep-merges
  // map fields, so every other period's saved budget is untouched.
  const saveTargets = async () => {
    if (!activeCenterId) return;
    setSaving(true);
    try {
      const clean = {};
      for (const k of TARGET_KEYS) clean[k] = Number(targets[k]) || 0;
      // Only weekdays actually edited are stored; the rest keep falling back
      // to WEEKDAY_DEFAULTS, so changing the model updates untouched periods.
      const cleanExtra = {};
      for (const wd of WEEKDAY_ORDER) {
        if (!extraDays[wd]) continue;
        cleanExtra[wd] = CATEGORIES.reduce((m, c) => ({ ...m, [c.key]: Number(extraDays[wd][c.key]) || 0 }), {});
      }
      clean.extraDays = cleanExtra;
      await setDoc(doc(db, 'centers', activeCenterId, 'config', 'main'),
        { staffingBudget: { byPeriod: { [loStr]: clean } }, updatedAt: serverTimestamp() },
        { merge: true });
      setSavedAt(true); setTimeout(() => setSavedAt(false), 2500);
    } finally { setSaving(false); }
  };

  // Drop this period's saved budget so it falls back down the chain again
  // (legacy set for old periods, DEFAULT_TARGETS for new ones).
  const clearPeriodTargets = async () => {
    if (!activeCenterId) return;
    setSaving(true);
    try {
      await setDoc(doc(db, 'centers', activeCenterId, 'config', 'main'),
        { staffingBudget: { byPeriod: { [loStr]: deleteField() } }, updatedAt: serverTimestamp() },
        { merge: true });
    } finally { setSaving(false); }
  };

  if (!canSeeAdminPanel) {
    return <div className="p-6"><h1 className="text-xl font-bold text-gray-900">Staffing Budget</h1><p className="text-sm text-gray-500">Owner / admin only.</p></div>;
  }

  const VarPill = ({ diff }) => {
    const over = diff > 0.5, under = diff < -0.5;
    return (
      <span className={`inline-block min-w-[52px] rounded-full px-2 py-0.5 text-center text-xs font-bold ${
        over ? 'bg-red-100 text-red-700' : under ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
        {diff >= 0 ? '+' : ''}{round1(diff)}
      </span>
    );
  };

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-amber-100 p-2.5 text-amber-600"><Wallet size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Staffing Budget</h1>
            <p className="text-sm text-gray-500">Budget vs actual · payroll periods · {activeCenterName || activeCenterId}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-xl border bg-white px-2 py-1.5 shadow-sm">
          <button onClick={() => setPeriodStart(prevPeriodStart(periodStart))} className="rounded-lg p-1.5 hover:bg-gray-100"><ChevronLeft size={16} /></button>
          <div className="min-w-[168px] text-center">
            <div className="text-sm font-bold text-gray-800">{format(periodStart, 'MMM d')} – {format(periodEnd, 'MMM d')}</div>
            <div className="text-[10px] uppercase tracking-wide text-gray-400">Pay period {periodStart.getDate() === 11 ? '11–25' : '26–10'}</div>
          </div>
          <button onClick={() => setPeriodStart(nextPeriodStart(periodStart))} className="rounded-lg p-1.5 hover:bg-gray-100"><ChevronRight size={16} /></button>
        </div>
      </div>

      {/* Headline cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Total hours</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-3xl font-bold text-gray-900">{round1(period.total)}</span>
            <span className="text-xs text-gray-400">/ {round1(totalTarget)}</span>
          </div>
          <div className="mt-2"><HBar value={period.total} target={totalTarget} scale={Math.max(period.total, totalTarget) * 1.1} over={period.total > totalTarget} /></div>
          <div className="mt-1.5 flex items-center gap-2">
            <VarPill diff={period.total - totalTarget} />
            {period.sick > 0 && <span className="text-[10px] text-gray-400">+{round1(period.sick)}h sick (separate)</span>}
          </div>
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Instructional</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-3xl font-bold text-emerald-700">{round1(period.byCat.instructional)}</span>
            <span className="text-xs text-gray-400">/ {round1(effTargets.instructional)}</span>
          </div>
          <div className="mt-2"><HBar value={period.byCat.instructional} target={effTargets.instructional} scale={Math.max(period.byCat.instructional, effTargets.instructional) * 1.1} over={period.byCat.instructional > effTargets.instructional} /></div>
          <div className="mt-1.5"><VarPill diff={period.byCat.instructional - effTargets.instructional} /></div>
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500"><TrendingUp size={13} /> Instr ÷ student</div>
          <div className="mt-1 text-3xl font-bold text-gray-900">{kpi == null ? '—' : round1(kpi)}</div>
          <p className="mt-1 text-xs text-gray-400">target {round1(targets.kpi)}</p>
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500"><Users size={12} /> Staff</div>
              <div className="text-2xl font-bold text-gray-900">{period.staffCount}</div>
            </div>
            <div>
              <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500"><GraduationCap size={12} /> Students</div>
              <div className="text-2xl font-bold text-gray-900">{studentCount}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Budget by role — bars */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-bold text-gray-900">Hours by category vs budget</h3>
        <div className="space-y-3.5">
          {CATEGORIES.map(c => {
            const actual = period.byCat[c.key];
            const target = effTargets[c.key] || 0;   // base + extra-day top-up
            const over = actual > target;
            return (
              <div key={c.key} className="grid grid-cols-[110px_1fr_120px] items-center gap-3">
                <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: c.color }}>
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} /> {c.label}
                </div>
                <HBar value={actual} target={target} scale={catScale} over={over} />
                <div className="flex items-center justify-end gap-2">
                  <span className="font-mono text-sm text-gray-700">{round1(actual)}<span className="text-gray-300"> / {round1(target)}</span></span>
                  <VarPill diff={actual - target} />
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-4 border-t pt-2 text-xs text-gray-400">
          Bar = actual hours, tick = budget target. Red = over, green = under. Floor shifts split by the clock — time <b>inside</b> instructional hours counts as Instructional, time <b>outside</b> (setup / prep / office) as Admin Hours — so someone who teaches and does admin lands in both. Matches Manage Payroll: no-shows count 0, pay overrides honoured, and salaried staff, volunteers, hidden-from-ops accounts, and <b>sick pay</b> are all kept out of these worked hours (sick shown separately on the Total card).
        </p>
      </div>

      {/* By day — bars */}
      <div className="mt-5 rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-gray-900"><CalendarDays size={15} /> By day — which days ran over / under</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-400">
              Mon/Wed {weekdayBudgetTotal('Monday')}h · Tue/Thu {weekdayBudgetTotal('Tuesday')}h ·
              Fri {weekdayBudgetTotal('Friday')}h · Sat {weekdayBudgetTotal('Saturday')}h
            </span>
            {Math.abs(perDay.modelTotal - totalTarget) > 1 && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800"
                title="The weekday model and the period targets are two different numbers for the same period. Reconcile them or the day bars and the headline will keep disagreeing.">
                weekday model = {round1(perDay.modelTotal)}h vs period target {round1(totalTarget)}h
              </span>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          {perDay.rows.map((r, i) => {
            const diff = r.total - (r.budget || 0);
            const over = (r.budget || 0) > 0 && diff > 2;
            const showBar = r.isOp || r.total > 0 || (r.budget || 0) > 0;
            const canExpand = r.total > 0;
            const isExpanded = expandedDay === i;
            return (
              <div key={i}>
                <div className={`grid grid-cols-[96px_1fr_150px] items-center gap-3 ${!showBar ? 'opacity-40' : ''}`}>
                  <div className="text-xs font-medium text-gray-600">{r.label}</div>
                  {showBar
                    ? <HBar value={r.total} target={r.budget || 0} scale={dayScale} over={over} />
                    : <div className="text-[11px] text-gray-300">
                        {r.holiday ? <>closed — <span className="font-medium text-gray-400">{r.holiday}</span></> : 'closed'}
                      </div>}
                  <div className="flex items-center justify-end gap-1.5">
                    <span className="font-mono text-xs text-gray-600">{round1(r.total)}h</span>
                    {showBar && (r.budget || 0) > 0 ? <VarPill diff={diff} /> : <span className="min-w-[52px]" />}
                    {canExpand
                      ? <button onClick={() => setExpandedDay(isExpanded ? null : i)} title="Category breakdown"
                          className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                          <ChevronDown size={14} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                      : <span className="w-[18px]" />}
                  </div>
                </div>
                {isExpanded && (
                  <div className="mb-1 ml-[108px] mr-1 rounded-lg border border-gray-100 bg-gray-50/70 px-3 py-2">
                    {CATEGORIES.filter(c => (r.byCat?.[c.key] || 0) > 0.05)
                      .map(c => {
                        const a = r.byCat[c.key];
                        // Compare to this category's own typical operating day this
                        // period — surfaces the category that ran hotter than usual.
                        const avg = perDay.opCount > 0 ? (period.byCat[c.key] || 0) / perDay.opCount : 0;
                        return { c, a, cv: a - avg };
                      })
                      .sort((x, y) => y.cv - x.cv)
                      .map(({ c, a, cv }) => (
                        <div key={c.key} className="flex items-center justify-between py-0.5 text-xs">
                          <span className="flex items-center gap-1.5 font-medium" style={{ color: c.color }}>
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.color }} />{c.label}
                          </span>
                          <span className="flex items-center gap-3">
                            <span className="font-mono text-gray-600">{round1(a)}h</span>
                            <span className={`min-w-[42px] text-right font-bold ${cv > 0.5 ? 'text-red-600' : cv < -0.5 ? 'text-emerald-600' : 'text-gray-400'}`}>
                              {cv >= 0 ? '+' : ''}{round1(cv)}
                            </span>
                          </span>
                        </div>
                      ))}
                    <p className="mt-1 border-t border-gray-200 pt-1 text-[10px] text-gray-400">Hours by category · +/- vs this category's typical day this period (red = ran hotter than usual — the likely driver).</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Trend — 6 periods */}
      <div className="mt-5 rounded-2xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-gray-900">Trend — last 6 pay periods</h3>
        <div className="flex items-end justify-between gap-2" style={{ height: 140 }}>
          {trend.map((t, i) => {
            const totalH = (t.total / trendMax) * 100;
            const instrH = (t.instructional / trendMax) * 100;
            const budgetH = ((t.budget || 0) / trendMax) * 100;
            const over = (t.budget || 0) > 0 && t.total > t.budget;
            return (
              <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1" style={{ height: '100%' }}>
                <span className={`text-[10px] font-mono ${over ? 'text-red-600 font-bold' : 'text-gray-500'}`}>{round1(t.total)}</span>
                {/* Column is full-height so the budget tick can sit at its own
                    level independent of how tall the bar is. */}
                <div className="relative w-full max-w-[46px] flex-1">
                  <div className="absolute bottom-0 w-full rounded-t bg-gray-100" style={{ height: `${totalH}%` }}
                    title={`Total ${round1(t.total)}h · Instr ${round1(t.instructional)}h · Budget ${round1(t.budget || 0)}h`}>
                    <div className="absolute bottom-0 w-full rounded-t bg-emerald-400" style={{ height: `${(instrH / Math.max(totalH, 0.001)) * 100}%` }} />
                    <div className={`absolute inset-x-0 top-0 h-1 rounded-t ${over ? 'bg-red-500' : 'bg-gray-300'}`} />
                  </div>
                  {/* Per-period budget tick — this period's own target. */}
                  {(t.budget || 0) > 0 && (
                    <div className="pointer-events-none absolute -inset-x-1 border-t border-dashed border-amber-400"
                      style={{ bottom: `${Math.min(100, budgetH)}%` }} title={`Budget ${round1(t.budget)}h`} />
                  )}
                </div>
                <span className="text-[10px] text-gray-400">{t.label}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-400" /> Instructional</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-gray-200" /> Other</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 border-t border-dashed border-amber-400" /> That period's own budget</span>
        </div>
      </div>

      {/* Targets — collapsible */}
      <div className="mt-5 rounded-2xl border bg-white p-4 shadow-sm">
        <button onClick={() => setShowTargets(v => !v)} className="flex w-full items-center justify-between text-sm font-bold text-gray-900">
          <span className="flex flex-wrap items-center gap-2">
            <span>Targets for {format(periodStart, 'MMM d')} – {format(periodEnd, 'MMM d')}</span>
            {targetSource === 'saved' && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">Saved for this period</span>
            )}
            {targetSource === 'legacy' && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">Centre baseline</span>
            )}
            {targetSource === 'default' && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">Model default — not saved yet</span>
            )}
          </span>
          <span className="text-xs font-normal text-gray-400">{showTargets ? 'Hide' : 'Edit'}</span>
        </button>
        {showTargets && (
          <>
            <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
              These targets belong to <b>this pay period only</b>. Page to another period with the arrows up top and you'll see (and can save) a different set — editing one no longer rewrites the rest.
            </p>

            {/* Hour targets, per role */}
            <p className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Hour targets (per 14-day cycle)</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['instructional', 'Instructional'], ['online', 'Online'], ['steam', 'STEAM'], ['summerCamp', 'Summer Camp'],
                ['adminHours', 'Admin Hours'], ['adminAssistant', 'Admin Assistant'], ['host', 'Host'],
              ].map(([k, label]) => (
                <label key={k} className="block">
                  <span className="mb-1 block text-xs text-gray-500">{label}</span>
                  <input type="number" step="1" min="0" value={targets[k]}
                    onChange={e => setTargets(t => ({ ...t, [k]: e.target.value }))}
                    className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-amber-500 focus:outline-none" />
                </label>
              ))}
            </div>

            {/* ── The 15th day ───────────────────────────────────────────
                8th box. Pay periods are 15–16 days but the targets above
                are a 14-day cycle, so one or two weekdays run a 3rd time
                and need paying for. */}
            {extra.days.length === 0 ? (
              <p className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500">
                This period is exactly 14 days — no extra day to budget for.
              </p>
            ) : extra.days.map(d => (
              <div key={d.weekday} className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-3">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-bold text-indigo-900">
                    Day {d.dayNo} — <b>{d.weekday}</b> runs 3× this period
                    {!d.isOpen && <span className="ml-1 font-normal text-indigo-400">(closed — costs nothing)</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    {d.isCustom && (
                      <button onClick={() => resetExtraDay(d.weekday)}
                        className="rounded-lg border border-indigo-200 px-2 py-0.5 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-100">
                        Reset to {d.weekday} default
                      </button>
                    )}
                    <span className="text-sm font-bold text-indigo-900">{round1(d.total)}h</span>
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {CATEGORIES.map(c => (
                    <label key={c.key} className="block">
                      <span className="mb-1 block text-[11px] font-medium" style={{ color: c.color }}>{c.label}</span>
                      <input type="number" step="0.5" min="0"
                        value={extraDays[d.weekday]?.[c.key] ?? (WEEKDAY_DEFAULTS[d.weekday]?.[c.key] ?? 0)}
                        onChange={e => setExtraCat(d.weekday, c.key, e.target.value)}
                        className="w-full rounded-lg border bg-white px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none" />
                    </label>
                  ))}
                </div>
              </div>
            ))}

            {/* Prominent total of all the hour targets */}
            <div className="mt-3 rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-amber-900">Total hours budget</span>
                <span className="text-2xl font-bold text-amber-900">{round1(totalTarget)}<span className="ml-1 text-sm font-semibold">h</span></span>
              </div>
              <div className="mt-1 text-right text-[11px] font-medium text-amber-700">
                {round1(baseTarget)}h base (14-day cycle)
                {extra.hours > 0 && <> + {round1(extra.hours)}h for {extra.days.filter(d => d.total > 0).map(d => d.weekday).join(' + ')}</>}
              </div>
            </div>

            {/* Efficiency target — a ratio, not hours (kept separate to avoid confusion) */}
            <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50/60 px-4 py-3">
              <div className="flex items-center gap-3">
                <div>
                  <span className="block text-xs font-semibold text-gray-700">Instr ÷ student target</span>
                  <input type="number" step="0.1" min="0" value={targets.kpi}
                    onChange={e => setTargets(t => ({ ...t, kpi: e.target.value }))}
                    className="mt-1 w-24 rounded-lg border px-2 py-1.5 text-sm focus:border-amber-500 focus:outline-none" />
                </div>
                <p className="flex-1 text-xs text-gray-500">
                  <b>Instructional hours ÷ number of students</b> — how many instructor-hours you spend per enrolled student each pay period. It's an efficiency ratio, <i>not</i> an hours figure, so it isn't part of the total above. Lower = leaner.
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={saveTargets} disabled={!dirty || saving}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-40">
                <Save size={14} /> {saving ? 'Saving…' : `Save hours for ${format(periodStart, 'MMM d')} – ${format(periodEnd, 'MMM d')}`}
              </button>
              {savedAt && <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700"><Check size={13} /> Saved</span>}
              {dirty && !savedAt && (
                <span className="text-xs font-medium text-amber-600">Unsaved changes — they only apply to this period.</span>
              )}
              {targetSource === 'saved' && !dirty && (
                <button onClick={clearPeriodTargets} disabled={saving}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-500 hover:bg-gray-50 disabled:opacity-50">
                  <RotateCcw size={12} /> Reset this period
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <p className="mt-4 text-xs text-gray-400">
        Instr ÷ student uses your current roster ({studentCount}) for every period, so historical periods are approximate until roster size is snapshotted. Per-day budgets come from the centre's weekday model — the same figures Manage Schedule shows in its day headers.
      </p>
    </div>
  );
}
