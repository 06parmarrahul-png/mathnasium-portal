// Intake distribution card for Centre Analytics. Reads centerIntakes
// directly from Firestore (rules already restrict access to owner-like),
// rolls up totals, grade mix, school mix, and status mix so the owner can
// see "who's coming in" without leaving the dashboard.
//
// Side benefit: once you cut over from Apptoto to native booking, this
// card replaces the Apptoto appointments card on the analytics page.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  GraduationCap, School, ChevronRight, Loader2, AlertTriangle, Plug,
} from 'lucide-react';

// Same status palette as the management page so badges read consistently
// across surfaces.
const STATUS_COLORS = {
  scheduled: 'bg-blue-500',
  completed: 'bg-emerald-500',
  no_show:   'bg-amber-500',
  cancelled: 'bg-gray-400',
};
const STATUS_LABELS = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  no_show:   'No-show',
  cancelled: 'Cancelled',
};

// Grade ordering for the breakdown bars — keeps Pre-K → Grade 12 → Adult
// in a sensible reading order regardless of insertion order.
const GRADE_ORDER = [
  'Pre-K', 'Kindergarten',
  'Grade 1','Grade 2','Grade 3','Grade 4','Grade 5','Grade 6',
  'Grade 7','Grade 8','Grade 9','Grade 10','Grade 11','Grade 12',
  'Adult / Other',
];

function startOfMonth(d) { const x = new Date(d); x.setDate(1); x.setHours(0,0,0,0); return x; }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }

export default function IntakeAnalyticsCard() {
  const { activeCenterId, canSeeCenterSettings } = useAuth();
  const [intakes, setIntakes] = useState(null);
  const [error, setError]     = useState('');

  useEffect(() => {
    if (!activeCenterId || !canSeeCenterSettings) return undefined;
    return onSnapshot(
      query(collection(db, 'centerIntakes'), where('centerId', '==', activeCenterId)),
      snap => setIntakes(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err  => setError(err.message),
    );
  }, [activeCenterId, canSeeCenterSettings]);

  const stats = useMemo(() => {
    if (!Array.isArray(intakes)) return null;
    const now = new Date();
    const monthStart = startOfMonth(now).toISOString();
    const yearStart  = startOfYear(now).toISOString();
    const nowISO     = now.toISOString();

    let total = 0, thisMonth = 0, thisYear = 0, upcoming = 0;
    const byGrade  = new Map();
    const bySchool = new Map();
    const byStatus = new Map();

    for (const i of intakes) {
      total++;
      if (i.bookedAt >= monthStart) thisMonth++;
      if (i.bookedAt >= yearStart)  thisYear++;
      if (i.slot >= nowISO && (i.status || 'scheduled') !== 'cancelled') upcoming++;

      const g = (i.childGrade || '').trim() || 'Unknown';
      byGrade.set(g, (byGrade.get(g) || 0) + 1);

      const sch = (i.childSchool || '').trim();
      if (sch) bySchool.set(sch, (bySchool.get(sch) || 0) + 1);

      const st = i.status || 'scheduled';
      byStatus.set(st, (byStatus.get(st) || 0) + 1);
    }

    const grades = [...byGrade.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => {
        const ia = GRADE_ORDER.indexOf(a.name);
        const ib = GRADE_ORDER.indexOf(b.name);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.name.localeCompare(b.name);
      });
    const schools = [...bySchool.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n);
    const statuses = ['scheduled', 'completed', 'no_show', 'cancelled']
      .map(k => ({ key: k, n: byStatus.get(k) || 0 }))
      .filter(x => x.n > 0);

    const maxGrade  = Math.max(1, ...grades.map(g => g.n));
    const maxSchool = Math.max(1, ...schools.map(s => s.n));

    return {
      total, thisMonth, thisYear, upcoming,
      grades, schools, statuses,
      maxGrade, maxSchool,
    };
  }, [intakes]);

  if (!canSeeCenterSettings) return null;

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="rounded-lg bg-red-100 p-1.5 text-red-700"><GraduationCap size={14} /></div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-900">Booking Intakes</h3>
          <p className="text-[11px] text-gray-500">Who&apos;s booked through your Ratio page.</p>
        </div>
        <Link
          to="/intakes"
          className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 hover:border-red-300 hover:text-red-700 transition-colors"
        >
          Manage <ChevronRight size={12} />
        </Link>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-start gap-1.5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> <span>{error}</span>
        </div>
      )}

      {intakes === null && (
        <div className="py-6 text-center text-sm text-gray-400 flex items-center justify-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}

      {intakes && intakes.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center">
          <Plug size={18} className="mx-auto text-gray-400 mb-2" />
          <p className="text-sm font-medium text-gray-700">No intakes booked yet.</p>
          <p className="mt-1 text-xs text-gray-500">
            Share your public booking link to start collecting assessments.
          </p>
        </div>
      )}

      {stats && intakes.length > 0 && (
        <>
          {/* Top KPI strip */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            <Stat label="Upcoming"   value={stats.upcoming}  tone="purple" />
            <Stat label="This month" value={stats.thisMonth} />
            <Stat label="This year"  value={stats.thisYear}  />
            <Stat label="All time"   value={stats.total}     />
          </div>

          {/* Status mix (stacked bar) */}
          {stats.statuses.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Status mix</p>
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100">
                {stats.statuses.map(s => (
                  <div key={s.key}
                    title={`${STATUS_LABELS[s.key]}: ${s.n}`}
                    className={STATUS_COLORS[s.key] || 'bg-gray-400'}
                    style={{ width: `${(s.n / stats.total) * 100}%` }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                {stats.statuses.map(s => (
                  <span key={s.key} className="inline-flex items-center gap-1 text-gray-600">
                    <span className={`inline-block h-2 w-2 rounded-full ${STATUS_COLORS[s.key]}`} />
                    {STATUS_LABELS[s.key]} <span className="text-gray-400">· {s.n}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Two-column breakdown: grade + school */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Grades */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2 inline-flex items-center gap-1">
                <GraduationCap size={11} /> By grade
              </p>
              <div className="space-y-1.5">
                {stats.grades.map(g => (
                  <Bar key={g.name} label={g.name} n={g.n} max={stats.maxGrade} color="bg-red-500" />
                ))}
              </div>
            </div>

            {/* Schools */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2 inline-flex items-center gap-1">
                <School size={11} /> By school
              </p>
              {stats.schools.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No schools captured yet. The booking form asks for school as an optional field.</p>
              ) : (
                <div className="space-y-1.5">
                  {stats.schools.slice(0, 8).map(s => (
                    <Bar key={s.name} label={s.name} n={s.n} max={stats.maxSchool} color="bg-purple-500" />
                  ))}
                  {stats.schools.length > 8 && (
                    <p className="text-[11px] text-gray-400 mt-1">
                      + {stats.schools.length - 8} more
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  const cls = tone === 'purple'
    ? 'border-purple-200 bg-purple-50 text-purple-900'
    : 'border-gray-200 bg-gray-50 text-gray-900';
  return (
    <div className={`rounded-xl border px-3 py-2 ${cls}`}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</p>
      <p className="mt-0.5 text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function Bar({ label, n, max, color }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-0.5">
        <span className="font-medium text-gray-700 truncate">{label}</span>
        <span className="text-gray-500 tabular-nums">{n}</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${(n / max) * 100}%` }} />
      </div>
    </div>
  );
}
