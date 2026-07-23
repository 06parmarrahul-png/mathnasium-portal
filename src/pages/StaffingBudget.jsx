import { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, query, where, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { resolveUserForCenter } from '../lib/centerMembership';
import { resolveInstructionalHours } from '../lib/centerConfig';
import { BUDGET_BUCKETS, bucketHoursForShift } from '../lib/budgetBuckets';
import { format, addDays, subDays } from 'date-fns';
import {
  Wallet, ChevronLeft, ChevronRight, Save, Check, Users, GraduationCap, TrendingUp, CalendarDays,
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

// Per-period default targets, seeded from the July 2026 model.
const DEFAULT_TARGETS = {
  instructional: 396, online: 54, steam: 46, summerCamp: 70,
  adminHours: 68, adminAssistant: 40, host: 46,
  kpi: 1.8, // instructional hours per student
};

// `windowFor(dateStr)` → { start, end } instructional window for that day (or null),
// used to split floor shifts into Instructional (in-window) vs Admin Hours (out).
function aggregate(shifts, loStr, hiStr, excluded, windowFor) {
  const byCat = {};
  for (const b of BUDGET_BUCKETS) byCat[b.key] = 0;
  const staff = new Set();
  let total = 0;
  for (const s of shifts) {
    if (!s.date || s.date < loStr || s.date > hiStr) continue;
    if (s.status === 'draft') continue;
    if (excluded && excluded.has(s.userName)) continue;
    const hrs = paidHours(s);
    if (hrs <= 0) continue;
    const alloc = bucketHoursForShift(s, hrs, windowFor(s.date));
    for (const k in alloc) byCat[k] = (byCat[k] || 0) + alloc[k];
    total += hrs;
    if (s.userName) staff.add(s.userName);
  }
  return { byCat, total, staffCount: staff.size };
}

function perDayHours(shifts, loStr, hiStr, excluded, windowFor) {
  const byDate = new Map();
  for (const s of shifts) {
    if (!s.date || s.date < loStr || s.date > hiStr) continue;
    if (s.status === 'draft') continue;
    if (excluded && excluded.has(s.userName)) continue;
    const hrs = paidHours(s);
    if (hrs <= 0) continue;
    const rec = byDate.get(s.date) || { total: 0, instructional: 0 };
    rec.total += hrs;
    const alloc = bucketHoursForShift(s, hrs, windowFor(s.date));
    rec.instructional += (alloc.instructional || 0);
    byDate.set(s.date, rec);
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
      if (resolved?.isVolunteer === true && resolved.displayName) set.add(resolved.displayName);
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

  const savedTargets = useMemo(() => ({ ...DEFAULT_TARGETS, ...(centerConfig?.staffingBudget || {}) }), [centerConfig]);
  const [targets, setTargets] = useState(savedTargets);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  useEffect(() => { setTargets(savedTargets); }, [savedTargets]);

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
  const totalTarget = useMemo(() => CATEGORIES.reduce((n, c) => n + (Number(targets[c.key]) || 0), 0), [targets]);
  const catScale = useMemo(
    () => Math.max(1, ...CATEGORIES.map(c => Math.max(period.byCat[c.key], Number(targets[c.key]) || 0))) * 1.1,
    [period, targets],
  );

  const perDay = useMemo(() => {
    const byDate = perDayHours(shifts, loStr, hiStr, excludedNames, windowFor);
    const opDays = (Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length)
      ? centerConfig.operatingDays
      : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const rows = [];
    let opCount = 0;
    let d = periodStart;
    while (format(d, 'yyyy-MM-dd') <= hiStr) {
      const isOp = opDays.includes(DOW[d.getDay()]);
      if (isOp) opCount++;
      const rec = byDate.get(format(d, 'yyyy-MM-dd')) || { total: 0, instructional: 0 };
      rows.push({ label: format(d, 'EEE MMM d'), isOp, total: rec.total, instructional: rec.instructional });
      d = addDays(d, 1);
    }
    return { rows, dailyBudget: opCount > 0 ? totalTarget / opCount : 0 };
  }, [shifts, loStr, hiStr, excludedNames, periodStart, centerConfig, totalTarget, windowFor]);
  const dayScale = useMemo(
    () => Math.max(1, perDay.dailyBudget, ...perDay.rows.map(r => r.total)) * 1.05,
    [perDay],
  );

  const trend = useMemo(() => {
    const starts = [];
    let s = periodStart;
    for (let i = 0; i < 6; i++) { starts.unshift(s); s = prevPeriodStart(s); }
    return starts.map(st => {
      const en = periodEndFor(st);
      const a = aggregate(shifts, format(st, 'yyyy-MM-dd'), format(en, 'yyyy-MM-dd'), excludedNames, windowFor);
      return { label: format(st, 'MMM d'), total: a.total, instructional: a.byCat.instructional };
    });
  }, [shifts, periodStart, excludedNames, windowFor]);
  const trendMax = useMemo(() => Math.max(1, totalTarget, ...trend.map(t => t.total)) * 1.05, [trend, totalTarget]);

  const dirty = Object.keys(DEFAULT_TARGETS).some(k => Number(targets[k]) !== Number(savedTargets[k]));

  const saveTargets = async () => {
    if (!activeCenterId) return;
    setSaving(true);
    try {
      const clean = {};
      for (const k of Object.keys(DEFAULT_TARGETS)) clean[k] = Number(targets[k]) || 0;
      await setDoc(doc(db, 'centers', activeCenterId, 'config', 'main'),
        { staffingBudget: clean, updatedAt: serverTimestamp() }, { merge: true });
      setSavedAt(true); setTimeout(() => setSavedAt(false), 2500);
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
          <div className="mt-1.5"><VarPill diff={period.total - totalTarget} /></div>
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Instructional</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-3xl font-bold text-emerald-700">{round1(period.byCat.instructional)}</span>
            <span className="text-xs text-gray-400">/ {round1(targets.instructional)}</span>
          </div>
          <div className="mt-2"><HBar value={period.byCat.instructional} target={Number(targets.instructional)} scale={Math.max(period.byCat.instructional, Number(targets.instructional)) * 1.1} over={period.byCat.instructional > targets.instructional} /></div>
          <div className="mt-1.5"><VarPill diff={period.byCat.instructional - targets.instructional} /></div>
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
            const target = Number(targets[c.key]) || 0;
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
          Bar = actual hours, tick = budget target. Red = over, green = under. Floor shifts split by the clock — time <b>inside</b> instructional hours counts as Instructional, time <b>outside</b> (setup / prep / office) as Admin Hours — so someone who teaches and does admin lands in both. Salaried staff + volunteers excluded (same as Manage Payroll).
        </p>
      </div>

      {/* By day — bars */}
      <div className="mt-5 rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-gray-900"><CalendarDays size={15} /> By day — which days ran over / under</h3>
          <span className="text-xs text-gray-400">daily budget ≈ {round1(perDay.dailyBudget)}h (even split)</span>
        </div>
        <div className="space-y-1.5">
          {perDay.rows.map((r, i) => {
            const diff = r.total - perDay.dailyBudget;
            const over = r.isOp && diff > 2;
            return (
              <div key={i} className={`grid grid-cols-[96px_1fr_128px] items-center gap-3 ${!r.isOp && r.total === 0 ? 'opacity-40' : ''}`}>
                <div className="text-xs font-medium text-gray-600">{r.label}</div>
                {(!r.isOp && r.total === 0)
                  ? <div className="text-[11px] text-gray-300">closed</div>
                  : <HBar value={r.total} target={perDay.dailyBudget} scale={dayScale} over={over} />}
                <div className="flex items-center justify-end gap-2">
                  <span className="font-mono text-xs text-gray-600">{round1(r.total)}h</span>
                  {r.isOp || r.total > 0 ? <VarPill diff={diff} /> : <span className="min-w-[52px]" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Trend — 6 periods */}
      <div className="mt-5 rounded-2xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-gray-900">Trend — last 6 pay periods</h3>
        <div className="relative flex items-end justify-between gap-2" style={{ height: 140 }}>
          {/* Target reference line */}
          <div className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-amber-400"
            style={{ bottom: `${Math.min(100, (totalTarget / trendMax) * 100)}%` }}>
            <span className="absolute -top-4 right-0 text-[10px] font-semibold text-amber-600">budget {round1(totalTarget)}</span>
          </div>
          {trend.map((t, i) => {
            const totalH = (t.total / trendMax) * 100;
            const instrH = (t.instructional / trendMax) * 100;
            const over = t.total > totalTarget;
            return (
              <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1" style={{ height: '100%' }}>
                <span className="text-[10px] font-mono text-gray-500">{round1(t.total)}</span>
                <div className="relative w-full max-w-[46px] rounded-t bg-gray-100" style={{ height: `${totalH}%` }} title={`Total ${round1(t.total)}h · Instr ${round1(t.instructional)}h`}>
                  <div className="absolute bottom-0 w-full rounded-t bg-emerald-400" style={{ height: `${(instrH / Math.max(totalH, 0.001)) * 100}%` }} />
                  <div className={`absolute inset-x-0 top-0 h-1 rounded-t ${over ? 'bg-red-500' : 'bg-gray-300'}`} />
                </div>
                <span className="text-[10px] text-gray-400">{t.label}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex items-center gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-400" /> Instructional</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-gray-200" /> Other</span>
          <span className="flex items-center gap-1"><span className="h-2 w-3 border-t border-dashed border-amber-400" /> Total budget</span>
        </div>
      </div>

      {/* Targets — collapsible */}
      <div className="mt-5 rounded-2xl border bg-white p-4 shadow-sm">
        <button onClick={() => setShowTargets(v => !v)} className="flex w-full items-center justify-between text-sm font-bold text-gray-900">
          <span>Targets (per pay period)</span>
          <span className="text-xs font-normal text-gray-400">{showTargets ? 'Hide' : 'Edit'}</span>
        </button>
        {showTargets && (
          <>
            {/* Hour targets, per role */}
            <p className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Hour targets (per pay period)</p>
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

            {/* Prominent total of all the hour targets */}
            <div className="mt-3 flex items-center justify-between rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-3">
              <span className="text-sm font-bold text-amber-900">Total hours budget</span>
              <span className="text-2xl font-bold text-amber-900">{round1(totalTarget)}<span className="ml-1 text-sm font-semibold">h</span></span>
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

            <div className="mt-3 flex items-center gap-2">
              <button onClick={saveTargets} disabled={!dirty || saving}
                className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
                <Save size={13} /> {saving ? 'Saving…' : 'Save targets'}
              </button>
              {savedAt && <span className="flex items-center gap-1 text-xs text-emerald-700"><Check size={13} /> Saved</span>}
            </div>
          </>
        )}
      </div>

      <p className="mt-4 text-xs text-gray-400">
        Instr ÷ student uses your current roster ({studentCount}) for every period, so historical periods are approximate until roster size is snapshotted. The per-day budget is an even split of the period total; encoding per-weekday targets makes it exact.
      </p>
    </div>
  );
}
