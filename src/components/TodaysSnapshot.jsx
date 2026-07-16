import { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { format } from 'date-fns';
import { Calendar, HandHeart } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { resolveUserForCenter } from '../lib/centerMembership';
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
  const { activeCenterId, centerConfig } = useAuth();
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
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '==', todayStr),
      ),
      snap => {
        // Drafts are excluded — Today's Snapshot reflects what's actually
        // happening, not what's been planned but not yet published.
        const rows = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(s => s.status !== 'draft');
        setShifts(rows);
        setLoading(false);
      },
      () => setLoading(false),
    )
  ), [todayStr, activeCenterId]);

  // Users subscription — needed to know which shifts belong to a
  // volunteer. Volunteer flag is per-centre so we resolve against the
  // active centre before reading isVolunteer.
  const [users, setUsers] = useState([]);
  useEffect(() => {
    if (!activeCenterId) return;
    return onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setUsers(snap.docs.map(d => ({ uid: d.id, ...d.data() }))),
    );
  }, [activeCenterId]);

  const volunteerNames = useMemo(() => {
    const set = new Set();
    for (const u of users) {
      const resolved = resolveUserForCenter(u, activeCenterId);
      if (resolved.isVolunteer === true && resolved.displayName) set.add(resolved.displayName);
    }
    return set;
  }, [users, activeCenterId]);

  // Build the day-shaped object that CoverageGrid expects. We pass
  // per-SHIFT entries (not name-keyed maps) so one person scheduled in
  // two roles on the same day — e.g. LEAD 11–3 covering for the owner,
  // HOST 3–7 — renders as two distinct rows with their actual roles
  // and times. The legacy name-keyed shape silently overwrote the
  // first shift, leaving Bri showing twice with both rows mislabelled.
  const dayData = useMemo(() => {
    const shiftEntries = [];
    for (const s of shifts) {
      const name = s.userName;
      if (!name || !s.startTime || !s.endTime) continue;
      shiftEntries.push({
        key:         s.id,
        name,
        role:        s.role || 'Instructor',
        subRole:     s.subRole,
        shiftTime:   `${s.startTime} - ${s.endTime}`,
        sickPay:     !!s.sickPay,
        noShow:      !!s.noShow,
        isVolunteer: volunteerNames.has(name),
      });
    }
    return {
      date: todayStr,
      dayOfWeek,
      dayNumber: now.getDate(),
      shiftEntries,
    };
  }, [shifts, todayStr, dayOfWeek, now, volunteerNames]);

  // Volunteers on the day → banner + count for the header.
  const volunteersToday = useMemo(() => {
    const names = new Set();
    for (const e of dayData.shiftEntries) {
      if (e.isVolunteer) names.add(e.name);
    }
    return Array.from(names);
  }, [dayData.shiftEntries]);

  // Stats — counted per SHIFT, not per person, because each shift is
  // distinct work. (A teacher pulling both a LEAD and a HOST shift today
  // legitimately fills 1 of each tile's headline number.)
  const teachingCount = useMemo(() => (
    dayData.shiftEntries.filter(e => ['Instructor', 'Lead'].includes(e.role)).length
  ), [dayData]);

  const hostCount = useMemo(() => (
    dayData.shiftEntries.filter(e => e.role === 'Host').length
  ), [dayData]);

  const onlineCount = useMemo(() => (
    dayData.shiftEntries.filter(e => e.role === 'Online Instructor').length
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

  const totalStaff = dayData.shiftEntries.length;

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

          {/* Volunteer banner — surfaces today's unpaid contributors so
              the owner knows the on-floor count includes free help.
              Volunteer hours don't count in payroll totals or the
              paid-coverage numbers. */}
          {volunteersToday.length > 0 && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs">
              <HandHeart size={14} className="text-sky-600 mt-0.5 shrink-0" />
              <div>
                <span className="font-semibold text-sky-900">
                  {volunteersToday.length} volunteer{volunteersToday.length === 1 ? '' : 's'} today
                </span>
                <span className="text-sky-700"> — {volunteersToday.join(', ')}. </span>
                <span className="text-sky-600/80 italic">Not counted in paid coverage.</span>
              </div>
            </div>
          )}

          {/* Coverage grid (reuses the auto-scheduler component) */}
          <CoverageGrid day={dayData} centerConfig={centerConfig} />
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
