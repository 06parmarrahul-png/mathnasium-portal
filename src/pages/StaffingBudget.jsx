import { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, query, where, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { format, addDays, subDays } from 'date-fns';
import {
  Wallet, ChevronLeft, ChevronRight, Save, Check, AlertTriangle, TrendingUp, Users, GraduationCap,
} from 'lucide-react';

/**
 * Staffing Budget — Budget vs Actual, per 2-week period.
 *
 * Ports the "SUMMARY" tab of the Staffing & Scheduling Budget workbook into
 * Ratio, straight off the centre's own shift data — no more exporting a
 * timeclock and reconciling by hand. For a chosen 14-day period it rolls up
 * paid hours by category, staff + student counts, and the North-Star metric
 * (Instructional Hours ÷ Students), each against an editable target.
 *
 * Targets live on centerConfig.staffingBudget (per 2-week) so they're set
 * once and shared. Defaults seed from the July 2026 model.
 */

// ── Category + hours helpers ───────────────────────────────────────────────
const ADMIN_HOST_ROLES = new Set([
  'Admin', 'Host', 'Manager', 'Center Director', 'Centre Director',
  'Dir. of Education', 'Director of Education',
]);

// Which budget bucket a shift falls into. Mirrors the workbook's split:
// Admin/Hosting, Lead, Instructional, Online, plus Flex (STEAM / Summer Camp).
function shiftCategory(s) {
  if (s.flexRole) return 'flex';
  const role = s.role || 'Instructor';
  const sub = (s.subRole || '').toLowerCase();
  if (role === 'Online Instructor' || sub === 'online' || s.shiftType === 'Online') return 'online';
  if (ADMIN_HOST_ROLES.has(role)) return 'adminHosting';
  if (role === 'Lead') return 'lead';
  return 'instructional';
}

// Paid hours for a shift — matches Manage Payroll: no-show pays 0, a
// per-shift payHoursOverride wins, otherwise scheduled length.
function paidHours(s) {
  if (s.noShow) return 0;
  if (typeof s.payHoursOverride === 'number' && isFinite(s.payHoursOverride)) {
    return Math.max(0, s.payHoursOverride);
  }
  if (!s.startTime || !s.endTime) return 0;
  const [sh, sm] = s.startTime.split(':').map(Number);
  const [eh, em] = s.endTime.split(':').map(Number);
  const h = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
  return isNaN(h) || h < 0 ? 0 : h;
}

const CATEGORIES = [
  { key: 'instructional', label: 'Instructional', tint: 'text-emerald-700' },
  { key: 'adminHosting',  label: 'Admin & Hosting', tint: 'text-blue-700' },
  { key: 'lead',          label: 'Lead',           tint: 'text-purple-700' },
  { key: 'online',        label: 'Online',         tint: 'text-indigo-700' },
  { key: 'flex',          label: 'STEAM / Summer Camp', tint: 'text-orange-700' },
];

// Per-2-week default targets, seeded from the July 2026 model.
const DEFAULT_TARGETS = {
  total: 604,
  instructional: 396,
  adminHosting: 86,
  lead: 68,
  online: 54,
  flex: 70,
  kpi: 1.8, // instructional hours per student
};

function aggregate(shifts, loStr, hiStr) {
  const byCat = { adminHosting: 0, lead: 0, instructional: 0, online: 0, flex: 0 };
  const staff = new Set();
  let total = 0;
  for (const s of shifts) {
    if (!s.date || s.date < loStr || s.date > hiStr) continue;
    if (s.status === 'draft') continue;
    const hrs = paidHours(s);
    if (hrs <= 0) continue;
    byCat[shiftCategory(s)] += hrs;
    total += hrs;
    if (s.userName) staff.add(s.userName);
  }
  return { byCat, total, staffCount: staff.size };
}

function round1(n) { return Math.round(n * 10) / 10; }

// Monday on/before the given date — periods align to Mondays like the model.
function mondayOnOrBefore(d) {
  const day = d.getDay(); // 0 Sun … 6 Sat
  const back = day === 0 ? 6 : day - 1;
  return subDays(d, back);
}

export default function StaffingBudget() {
  const { activeCenterId, centerConfig, canSeeAdminPanel, activeCenterName } = useAuth();
  const [shifts, setShifts] = useState([]);
  const [studentCount, setStudentCount] = useState(0);

  // Period = 14 days starting on a Monday. Default: the completed 2-week
  // block ending around today (two Mondays back).
  const [periodStart, setPeriodStart] = useState(() => mondayOnOrBefore(subDays(new Date(), 13)));
  const periodEnd = addDays(periodStart, 13);
  const loStr = format(periodStart, 'yyyy-MM-dd');
  const hiStr = format(periodEnd, 'yyyy-MM-dd');

  // Editable targets (seeded from config → defaults).
  const savedTargets = useMemo(() => ({ ...DEFAULT_TARGETS, ...(centerConfig?.staffingBudget || {}) }), [centerConfig]);
  const [targets, setTargets] = useState(savedTargets);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(false);
  useEffect(() => { setTargets(savedTargets); }, [savedTargets]);

  // Shifts for this centre (bounded client-side to the recent window).
  useEffect(() => {
    if (!activeCenterId) return;
    const windowStart = format(subDays(new Date(), 140), 'yyyy-MM-dd');
    return onSnapshot(
      query(collection(db, 'shifts'), where('centerId', '==', activeCenterId)),
      snap => setShifts(
        snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.date && s.date >= windowStart),
      ),
      () => setShifts([]),
    );
  }, [activeCenterId]);

  // Active student roster count (the denominator of the KPI).
  useEffect(() => {
    if (!activeCenterId) return;
    return onSnapshot(
      query(collection(db, 'students'), where('centerId', '==', activeCenterId)),
      snap => setStudentCount(snap.docs.filter(d => (d.data()?.status || 'active') !== 'inactive').length),
      () => setStudentCount(0),
    );
  }, [activeCenterId]);

  const period = useMemo(() => aggregate(shifts, loStr, hiStr), [shifts, loStr, hiStr]);
  const kpi = studentCount > 0 ? period.byCat.instructional / studentCount : null;

  // Trend: the previous 6 periods (total + instructional + KPI).
  const trend = useMemo(() => {
    const rows = [];
    for (let i = 5; i >= 0; i--) {
      const start = subDays(periodStart, i * 14);
      const end = addDays(start, 13);
      const agg = aggregate(shifts, format(start, 'yyyy-MM-dd'), format(end, 'yyyy-MM-dd'));
      rows.push({
        label: `${format(start, 'MMM d')}–${format(end, 'MMM d')}`,
        total: agg.total,
        instructional: agg.byCat.instructional,
        staff: agg.staffCount,
        kpi: studentCount > 0 ? agg.byCat.instructional / studentCount : null,
      });
    }
    return rows;
  }, [shifts, periodStart, studentCount]);

  const dirty = Object.keys(DEFAULT_TARGETS).some(k => Number(targets[k]) !== Number(savedTargets[k]));

  const saveTargets = async () => {
    if (!activeCenterId) return;
    setSaving(true);
    try {
      const clean = {};
      for (const k of Object.keys(DEFAULT_TARGETS)) clean[k] = Number(targets[k]) || 0;
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { staffingBudget: clean, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setSavedAt(true); setTimeout(() => setSavedAt(false), 2500);
    } finally { setSaving(false); }
  };

  if (!canSeeAdminPanel) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-bold text-gray-900">Staffing Budget</h1>
        <p className="text-sm text-gray-500">Owner / admin only.</p>
      </div>
    );
  }

  const varianceCell = (actual, target) => {
    const diff = actual - target;
    const over = diff > 0.5;
    const under = diff < -0.5;
    return (
      <span className={`font-semibold ${over ? 'text-red-600' : under ? 'text-emerald-600' : 'text-gray-500'}`}>
        {diff >= 0 ? '+' : ''}{round1(diff)}
      </span>
    );
  };

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-amber-100 p-2.5 text-amber-600"><Wallet size={22} /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Staffing Budget</h1>
            <p className="text-sm text-gray-500">Budget vs actual, per 2-week period · {activeCenterName || activeCenterId}</p>
          </div>
        </div>
        {/* Period navigator */}
        <div className="flex items-center gap-2 rounded-xl border bg-white px-2 py-1.5 shadow-sm">
          <button onClick={() => setPeriodStart(subDays(periodStart, 14))} className="rounded-lg p-1.5 hover:bg-gray-100" title="Previous period">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-[150px] text-center text-sm font-semibold text-gray-800">
            {format(periodStart, 'MMM d')} – {format(periodEnd, 'MMM d, yyyy')}
          </span>
          <button onClick={() => setPeriodStart(addDays(periodStart, 14))} className="rounded-lg p-1.5 hover:bg-gray-100" title="Next period">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* KPI + counts */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
            <TrendingUp size={13} /> Instr. hrs ÷ student
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-gray-900">{kpi == null ? '—' : round1(kpi)}</span>
            <span className="text-xs text-gray-400">target {round1(targets.kpi)}</span>
          </div>
          {kpi != null && (
            <p className={`mt-0.5 text-xs font-medium ${kpi > targets.kpi + 0.05 ? 'text-red-600' : 'text-emerald-600'}`}>
              {kpi > targets.kpi + 0.05 ? 'Above target (more hours per student)' : 'At / under target'}
            </p>
          )}
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500"><Users size={13} /> Staff worked</div>
          <div className="mt-1 text-3xl font-bold text-gray-900">{period.staffCount}</div>
          <p className="mt-0.5 text-xs text-gray-400">distinct people this period</p>
        </div>
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500"><GraduationCap size={13} /> Active students</div>
          <div className="mt-1 text-3xl font-bold text-gray-900">{studentCount}</div>
          <p className="mt-0.5 text-xs text-gray-400">current roster</p>
        </div>
      </div>

      {/* Category breakdown: Actual vs Target vs Variance */}
      <div className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <th className="px-4 py-2.5 text-left font-semibold">Category</th>
              <th className="px-4 py-2.5 text-right font-semibold">Actual (hrs)</th>
              <th className="px-4 py-2.5 text-right font-semibold">Target</th>
              <th className="px-4 py-2.5 text-right font-semibold">Variance</th>
            </tr>
          </thead>
          <tbody>
            {CATEGORIES.map(c => (
              <tr key={c.key} className="border-b border-gray-100">
                <td className={`px-4 py-2.5 font-semibold ${c.tint}`}>{c.label}</td>
                <td className="px-4 py-2.5 text-right font-mono">{round1(period.byCat[c.key])}</td>
                <td className="px-4 py-2.5 text-right text-gray-500">{round1(targets[c.key])}</td>
                <td className="px-4 py-2.5 text-right">{varianceCell(period.byCat[c.key], targets[c.key])}</td>
              </tr>
            ))}
            <tr className="bg-gray-50 font-bold">
              <td className="px-4 py-2.5 text-gray-900">Total</td>
              <td className="px-4 py-2.5 text-right font-mono">{round1(period.total)}</td>
              <td className="px-4 py-2.5 text-right text-gray-500">{round1(targets.total)}</td>
              <td className="px-4 py-2.5 text-right">{varianceCell(period.total, targets.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-xs text-gray-400">
        Green variance = under budget, red = over. Hours are paid hours (no-shows count 0, per-shift pay overrides honoured), same as Manage Payroll.
      </p>

      {/* Editable targets */}
      <div className="mt-5 rounded-2xl border bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold text-gray-900">Targets (per 2-week period)</h3>
          <div className="flex items-center gap-2">
            {savedAt && <span className="flex items-center gap-1 text-xs text-emerald-700"><Check size={13} /> Saved</span>}
            <button onClick={saveTargets} disabled={!dirty || saving}
              className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
              <Save size={13} /> {saving ? 'Saving…' : 'Save targets'}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['instructional', 'Instructional'], ['adminHosting', 'Admin & Hosting'], ['lead', 'Lead'],
            ['online', 'Online'], ['flex', 'STEAM / Camp'], ['total', 'Total hours'], ['kpi', 'Instr÷student'],
          ].map(([k, label]) => (
            <label key={k} className="block">
              <span className="mb-1 block text-xs text-gray-500">{label}</span>
              <input
                type="number" step={k === 'kpi' ? '0.1' : '1'} min="0"
                value={targets[k]}
                onChange={e => setTargets(t => ({ ...t, [k]: e.target.value }))}
                className="w-full rounded-lg border px-2 py-1.5 text-sm focus:border-amber-500 focus:outline-none"
              />
            </label>
          ))}
        </div>
      </div>

      {/* Trend — last 6 periods */}
      <div className="mt-5 overflow-hidden rounded-2xl border bg-white shadow-sm">
        <div className="border-b bg-gray-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Last 6 periods
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-gray-400">
              <th className="px-4 py-2 text-left font-semibold">Period</th>
              <th className="px-4 py-2 text-right font-semibold">Total hrs</th>
              <th className="px-4 py-2 text-right font-semibold">Instr. hrs</th>
              <th className="px-4 py-2 text-right font-semibold">Staff</th>
              <th className="px-4 py-2 text-right font-semibold">Instr÷student</th>
            </tr>
          </thead>
          <tbody>
            {trend.map((r, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="px-4 py-2 text-gray-700">{r.label}</td>
                <td className="px-4 py-2 text-right font-mono">{round1(r.total)}</td>
                <td className="px-4 py-2 text-right font-mono">{round1(r.instructional)}</td>
                <td className="px-4 py-2 text-right">{r.staff}</td>
                <td className="px-4 py-2 text-right font-mono">{r.kpi == null ? '—' : round1(r.kpi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/50 px-3 py-2 text-xs text-amber-800">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>
          The Instr÷student ratio uses your <b>current</b> active roster ({studentCount}) for every period, so historical periods are approximate until we snapshot roster size per period. Everything else is exact from your shift data.
        </span>
      </div>
    </div>
  );
}
