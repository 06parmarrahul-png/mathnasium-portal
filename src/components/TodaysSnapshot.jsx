import { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { format } from 'date-fns';
import { Calendar } from 'lucide-react';
import { db } from '../firebase';
import CoverageGrid from './CoverageGrid';

/**
 * "Today's Snapshot" — at-a-glance dashboard for the owner.
 *
 * Shows:
 *  - The date
 *  - Stat tiles: # instructors, # hosts, # online, total scheduled hours
 *  - The same half-hour coverage grid used in the auto-scheduler draft,
 *    fed today's actual posted shifts
 *
 * Subscribes only to today's shifts via a Firestore equality filter
 * (no composite index needed). Re-runs at midnight if you leave the page
 * open across a date change.
 */

const DAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

export default function TodaysSnapshot() {
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);

  // Capture today once on mount; re-tick the component if the date rolls over.
  // This way leaving the tab open across midnight doesn't show stale data.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => {
      const fresh = new Date();
      setNow(prev => (
        prev.toDateString() === fresh.toDateString() ? prev : fresh
      ));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const todayStr   = format(now, 'yyyy-MM-dd');
  const todayLabel = format(now, 'EEEE, MMMM d, yyyy');
  const dayOfWeek  = DAY_NAMES[now.getDay()];

  useEffect(() => (
    onSnapshot(
      query(collection(db, 'shifts'), where('date', '==', todayStr)),
      snap => {
        setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false),
    )
  ), [todayStr]);

  // Build the day-shaped object that CoverageGrid expects.
  const dayData = useMemo(() => {
    const assignedEmployees = [];
    const shiftTimes = {};
    const roles = {};
    const subRoles = {};
    for (const s of shifts) {
      const name = s.userName;
      if (!name || !s.startTime || !s.endTime) continue;
      assignedEmployees.push(name);
      shiftTimes[name] = `${s.startTime} - ${s.endTime}`;
      roles[name]      = s.role || 'Instructor';
      subRoles[name]   = s.subRole;
    }
    return {
      date: todayStr,
      dayOfWeek,
      dayNumber: now.getDate(),
      assignedEmployees,
      shiftTimes,
      roles,
      subRoles,
    };
  }, [shifts, todayStr, dayOfWeek, now]);

  // Stats
  const teachingCount = useMemo(() => (
    dayData.assignedEmployees.filter(n =>
      ['Instructor', 'Lead'].includes(dayData.roles[n])
    ).length
  ), [dayData]);

  const hostCount = useMemo(() => (
    dayData.assignedEmployees.filter(n => dayData.roles[n] === 'Host').length
  ), [dayData]);

  const onlineCount = useMemo(() => (
    dayData.assignedEmployees.filter(n => dayData.roles[n] === 'Online Instructor').length
  ), [dayData]);

  const totalHours = useMemo(() => (
    shifts.reduce((sum, s) => {
      if (!s.startTime || !s.endTime) return sum;
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      const h = ((eh + em / 60) - (sh + sm / 60));
      return sum + (isNaN(h) || h < 0 ? 0 : h);
    }, 0)
  ), [shifts]);

  const totalStaff = dayData.assignedEmployees.length;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="rounded-2xl border bg-white p-5 sm:p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="rounded-xl bg-blue-100 p-2 text-blue-600 shrink-0">
          <Calendar size={22} />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-gray-900">Today's Snapshot</h2>
          <p className="text-xs text-gray-500 truncate">{todayLabel}</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
        </div>
      ) : totalStaff === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 px-4 py-10 text-center">
          <p className="text-sm font-medium text-gray-500">No staff scheduled today.</p>
          <p className="mt-1 text-xs text-gray-400">
            Run the auto-scheduler or add shifts manually from the Admin Panel.
          </p>
        </div>
      ) : (
        <>
          {/* Stat tiles */}
          <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile
              value={teachingCount}
              label={teachingCount === 1 ? 'Instructor' : 'Instructors'}
              tone="blue"
            />
            <StatTile
              value={hostCount}
              label={hostCount === 1 ? 'Host' : 'Hosts'}
              tone="amber"
            />
            <StatTile
              value={onlineCount}
              label={onlineCount === 1 ? 'Online' : 'Online'}
              tone="indigo"
            />
            <StatTile
              value={`${totalHours.toFixed(1)}h`}
              label="Total hours"
              tone="emerald"
            />
          </div>

          {/* Coverage grid (reuses the auto-scheduler component) */}
          <CoverageGrid day={dayData} />
        </>
      )}
    </div>
  );
}

function StatTile({ value, label, tone }) {
  const tones = {
    blue:    { bg: 'bg-blue-50',    border: 'border-blue-100',    text: 'text-blue-700',    sub: 'text-blue-600'    },
    amber:   { bg: 'bg-amber-50',   border: 'border-amber-100',   text: 'text-amber-700',   sub: 'text-amber-600'   },
    indigo:  { bg: 'bg-indigo-50',  border: 'border-indigo-100',  text: 'text-indigo-700',  sub: 'text-indigo-600'  },
    emerald: { bg: 'bg-emerald-50', border: 'border-emerald-100', text: 'text-emerald-700', sub: 'text-emerald-600' },
  };
  const t = tones[tone] || tones.blue;
  return (
    <div className={`rounded-lg border ${t.bg} ${t.border} p-3`}>
      <p className={`text-2xl font-bold ${t.text}`}>{value}</p>
      <p className={`text-xs mt-0.5 ${t.sub}`}>{label}</p>
    </div>
  );
}
