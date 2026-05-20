import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, query, orderBy, limit, where } from 'firebase/firestore';
import { format } from 'date-fns';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { styleFor as subRoleStyleFor } from '../lib/subRoles';
import TodaysSnapshot from '../components/TodaysSnapshot';
import CareerPlanModal from '../components/CareerPlanModal';
import {
  CalendarDays, MessageSquare, Users, Clock,
  ChevronRight, Megaphone, Pin, ArrowRight,
  Building2, Laptop, Wifi,
  TrendingUp, CheckCircle2,
} from 'lucide-react';

// Friendly 'YYYY-MM' → 'August 2026' for the 4-month plan status line.
function formatPlanMonth(key) {
  if (!key) return 'soon';
  const [y, m] = key.split('-');
  const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

const CATEGORY_STYLES = {
  general:  { bg: 'bg-gray-100',   text: 'text-gray-700',   label: 'General' },
  'fun-day':{ bg: 'bg-green-100',  text: 'text-green-700',  label: 'Fun Day' },
  policy:   { bg: 'bg-blue-100',   text: 'text-blue-700',   label: 'Policy' },
  urgent:   { bg: 'bg-red-100',    text: 'text-red-700',    label: 'Urgent' },
};

function fmtTime(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtShiftDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);

  const isSameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(d, today)) return 'Today';
  if (isSameDay(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}

const quickLinks = [
  { to: '/schedule', label: 'Scheduling', desc: 'Submit availability and view shifts', icon: CalendarDays, color: 'bg-blue-50 text-blue-600', border: 'border-blue-100' },
  { to: '/chat',     label: 'Chat',       desc: 'Talk with your team and swap shifts', icon: MessageSquare, color: 'bg-green-50 text-green-600', border: 'border-green-100' },
];

export default function Home() {
  const { profile, activeCenterId, canSeeAdminPanel } = useAuth();
  const [shifts, setShifts] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [careerPlanOpen, setCareerPlanOpen] = useState(false);

  // Local-time today (avoids UTC edge cases for Pacific time)
  const todayStr = format(new Date(), 'yyyy-MM-dd');

  // Only subscribe to this user's shifts at the active center — much smaller
  // payload than the whole collection.
  useEffect(() => {
    if (!profile?.uid) return;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('userId', '==', profile.uid),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, [profile?.uid, activeCenterId]);

  useEffect(() => onSnapshot(
    query(
      collection(db, 'announcements'),
      where('centerId', '==', activeCenterId),
      orderBy('date', 'desc'),
      limit(10),
    ),
    snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Pinned first, then by date
      data.sort((a, b) => (a.pinned && !b.pinned ? -1 : !a.pinned && b.pinned ? 1 : 0));
      setAnnouncements(data);
    }
  ), [activeCenterId]);

  const upcomingShift = useMemo(() => {
    return shifts
      .filter(s => s.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  }, [shifts, todayStr]);

  const latestAnnouncement = announcements[0] || null;

  const days = upcomingShift ? daysUntil(upcomingShift.date) : null;

  const isStaff = profile?.uid && profile?.role !== 'owner' && profile?.role !== 'super_admin';
  // Today's Snapshot is for everyone running ops — admins, owners, and
  // super-admins. Previously gated to owner-only which left admins (who
  // staff the centre day-to-day) without the coverage view at a glance.
  const showTodaysSnapshot = canSeeAdminPanel;

  // 4-month plan staleness. Asking once a quarter (90 days) is the cadence
  // that catches life changes without nagging. Captured at mount via lazy
  // state init so the React purity rule doesn't flag Date.now() in render
  // — staying open across midnight won't roll the day, but a reload will.
  const [nowMs] = useState(() => Date.now());
  const plan = profile?.careerPlan;
  const planUpdatedMs = plan?.updatedAt?.seconds ? plan.updatedAt.seconds * 1000 : 0;
  const planAgeDays = planUpdatedMs ? Math.floor((nowMs - planUpdatedMs) / 86_400_000) : null;
  const planStale = !plan || !plan.updatedAt || planAgeDays > 90;
  const planStatus = plan?.stayingIn4Months === 'yes'
    ? 'Staying for the next 4 months'
    : plan?.stayingIn4Months === 'unsure'
      ? 'Unsure about the next 4 months'
      : plan?.stayingIn4Months === 'no'
        ? `Planning to leave by ${formatPlanMonth(plan.expectedDepartureMonth)}`
        : null;

  return (
    // Owners see a wider container because Today's Snapshot includes the
    // coverage grid which benefits from extra room. Instructors stay narrow.
    <div className={`mx-auto space-y-6 ${showTodaysSnapshot ? 'max-w-5xl' : 'max-w-3xl'}`}>

      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back, {profile?.displayName?.split(' ')[0] || 'Instructor'}!
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {/* ── 4-month plan banner (staff only) ── */}
      {isStaff && (
        planStale ? (
          <div className="rounded-2xl border-2 border-purple-200 bg-gradient-to-r from-purple-50 to-white p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="shrink-0 rounded-lg bg-purple-100 p-2 text-purple-600">
                <TrendingUp size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-bold text-gray-900">
                  {plan ? 'Your 4-month plan is out of date' : 'Help us plan 4 months ahead'}
                </h3>
                <p className="mt-0.5 text-xs text-gray-600">
                  Let us know if you're planning to stay, considering leaving, or unsure
                  {' — '}plus any career goals we can support. Takes about a minute and helps us hire ahead so you're never overworked.
                </p>
                <button
                  type="button"
                  onClick={() => setCareerPlanOpen(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 transition-colors"
                >
                  <TrendingUp size={14} /> {plan ? 'Update my plan' : 'Set my plan'}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border bg-white px-4 py-3 shadow-sm">
            <div className="shrink-0 rounded-lg bg-emerald-100 p-1.5 text-emerald-600">
              <CheckCircle2 size={14} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-gray-800">
                4-month plan: {planStatus || 'Submitted'}
              </p>
              <p className="text-xs text-gray-400">
                Updated {planAgeDays === 0 ? 'today' : planAgeDays === 1 ? 'yesterday' : `${planAgeDays} days ago`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCareerPlanOpen(true)}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
            >
              Update
            </button>
          </div>
        )
      )}

      {/* ── Today's Snapshot (owners only) ── */}
      {showTodaysSnapshot && <TodaysSnapshot />}

      {/* ── Upcoming Shift Card ── */}
      {/* Hidden for anyone with admin-panel access (super_admin / owner /
          admin) — they care about today's coverage and announcements, not
          their own next personal shift. Only instructors see this. */}
      {!canSeeAdminPanel && (
        upcomingShift ? (
          <Link to="/schedule" className="group block">
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-red-600 to-red-700 p-6 shadow-lg shadow-red-200 transition-all hover:shadow-xl hover:shadow-red-200 hover:-translate-y-0.5">
              {/* Decorative circle */}
              <div className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-white/10" />
              <div className="pointer-events-none absolute -bottom-6 -right-2 h-24 w-24 rounded-full bg-white/5" />

              <div className="relative">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="rounded-lg bg-white/20 p-1.5">
                      <CalendarDays size={16} className="text-white" />
                    </div>
                    <span className="text-sm font-semibold text-red-100 uppercase tracking-widest">
                      Upcoming Shift
                    </span>
                  </div>
                  {days === 0 && (
                    <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white">
                      TODAY
                    </span>
                  )}
                  {days === 1 && (
                    <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white">
                      TOMORROW
                    </span>
                  )}
                  {days > 1 && (
                    <span className="rounded-full bg-white/20 px-3 py-1 text-xs font-bold text-white">
                      IN {days} DAYS
                    </span>
                  )}
                </div>

                <p className="text-2xl font-bold text-white">
                  {fmtShiftDate(upcomingShift.date)}
                </p>

                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <Clock size={14} className="text-red-200" />
                  <p className="text-base font-medium text-red-100">
                    {fmtTime(upcomingShift.startTime)} – {fmtTime(upcomingShift.endTime)}
                  </p>
                  {upcomingShift.role && (
                    <>
                      <span className="text-red-300">·</span>
                      <span className="text-sm text-red-200">{upcomingShift.role}</span>
                    </>
                  )}
                  {/* In-centre vs Online — most important location info for the instructor */}
                  {(() => {
                    const st = upcomingShift.shiftType || 'In-Centre';
                    const Icon = st === 'Online' ? Laptop : st === 'Both' ? Wifi : Building2;
                    return (
                      <span className="flex items-center gap-1 rounded-full bg-white/20 backdrop-blur-sm px-2.5 py-0.5 text-xs font-bold text-white">
                        <Icon size={11} />
                        {st === 'Both' ? 'In-Centre + Online' : st}
                      </span>
                    );
                  })()}
                  {(() => {
                    const s = subRoleStyleFor(upcomingShift.subRole);
                    if (!s) return null;
                    return (
                      <span className="ml-auto flex items-center gap-1 rounded-full bg-white/20 backdrop-blur-sm px-2.5 py-0.5 text-xs font-bold text-white">
                        <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                        {s.label}
                      </span>
                    );
                  })()}
                </div>

                <div className="mt-4 flex items-center gap-1 text-xs font-semibold text-red-200 group-hover:text-white transition-colors">
                  View full schedule <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
                </div>
              </div>
            </div>
          </Link>
        ) : (
          <Link to="/schedule" className="group block">
            <div className="rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 p-6 text-center transition-colors hover:border-red-300 hover:bg-red-50">
              <CalendarDays size={28} className="mx-auto mb-2 text-gray-300 group-hover:text-red-400 transition-colors" />
              <p className="text-sm font-semibold text-gray-500 group-hover:text-red-600 transition-colors">No upcoming shifts</p>
              <p className="text-xs text-gray-400 mt-0.5">Tap to set your availability</p>
            </div>
          </Link>
        )
      )}

      {/* ── Latest Announcement ── */}
      {latestAnnouncement && (
        <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-red-100 p-1.5 text-red-600">
                <Megaphone size={15} />
              </div>
              <span className="text-sm font-bold text-gray-800">Latest Announcement</span>
            </div>
            <Link
              to="/announcements"
              className="flex items-center gap-1 text-xs font-semibold text-red-600 hover:text-red-700 transition-colors"
            >
              See all <ChevronRight size={13} />
            </Link>
          </div>

          <div className="px-5 py-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {latestAnnouncement.pinned && (
                <Pin size={12} className="text-red-500" />
              )}
              {(() => {
                const cat = CATEGORY_STYLES[latestAnnouncement.category] || CATEGORY_STYLES.general;
                return (
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${cat.bg} ${cat.text}`}>
                    {cat.label}
                  </span>
                );
              })()}
              <span className="text-xs text-gray-400">
                {latestAnnouncement.date
                  ? new Date(latestAnnouncement.date).toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                    })
                  : ''}
              </span>
            </div>

            <h3 className="text-base font-bold text-gray-900 mb-1">
              {latestAnnouncement.title}
            </h3>
            <p className="text-sm text-gray-600 line-clamp-3 whitespace-pre-wrap">
              {latestAnnouncement.text}
            </p>

            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-gray-400">
                Posted by {latestAnnouncement.author}
              </span>
              <Link
                to="/announcements"
                className="text-xs font-semibold text-red-600 hover:text-red-700 transition-colors"
              >
                Read more →
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* ── Quick Actions ── */}
      {/* Personal nav shortcuts — useful for instructors, just clutter for
          admins / owners / super-admins who have the full sidebar already. */}
      {!canSeeAdminPanel && (
      <div>
        <p className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-400 px-0.5">
          Quick Actions
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {quickLinks.map(item => (
            <Link
              key={item.to}
              to={item.to}
              className={`group flex items-center gap-4 rounded-xl border ${item.border} bg-white p-4 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5`}
            >
              <div className={`shrink-0 rounded-xl p-2.5 ${item.color}`}>
                <item.icon size={20} />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-gray-900 group-hover:text-red-600 transition-colors">
                  {item.label}
                </h3>
                <p className="text-xs text-gray-500 truncate">{item.desc}</p>
              </div>
              <ChevronRight size={16} className="ml-auto shrink-0 text-gray-300 group-hover:text-red-400 transition-colors" />
            </Link>
          ))}

          {profile?.role === 'owner' && (
            <Link
              to="/admin"
              className="group flex items-center gap-4 rounded-xl border border-purple-100 bg-white p-4 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5"
            >
              <div className="shrink-0 rounded-xl bg-purple-50 p-2.5 text-purple-600">
                <Users size={20} />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-gray-900 group-hover:text-red-600 transition-colors">
                  Admin Panel
                </h3>
                <p className="text-xs text-gray-500 truncate">Manage instructors and shifts</p>
              </div>
              <ChevronRight size={16} className="ml-auto shrink-0 text-gray-300 group-hover:text-red-400 transition-colors" />
            </Link>
          )}
        </div>
      </div>
      )}

      {/* 4-month plan modal — opened from the banner above. */}
      <CareerPlanModal
        open={careerPlanOpen}
        onClose={() => setCareerPlanOpen(false)}
      />
    </div>
  );
}
