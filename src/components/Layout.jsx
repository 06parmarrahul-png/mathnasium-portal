import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import Logo from './Logo';
import MigrationBanner from './MigrationBanner';
import CenterSwitcher from './CenterSwitcher';
import {
  House, Megaphone, CalendarDays, MessageSquare, Settings, LogOut, Menu, X, Bell,
  Briefcase, Shield, BarChart3, DollarSign, Headphones, Building2, FileClock,
} from 'lucide-react';

// Eligibility logic mirrors ShiftBoard.canTake — kept here so the badge count
// stays in sync without a circular import. Users with zero sub-roles cannot
// take anything; legacy shifts (no subRole) are takeable by anyone *with* a
// sub-role; otherwise the user must have the matching sub-role.
function canTake(shiftSubRole, userSubRoles) {
  const subs = userSubRoles || [];
  if (subs.length === 0) return false;
  if (!shiftSubRole) return true;
  return subs.includes(shiftSubRole);
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const ROLE_LABEL = {
  super_admin: 'Super Admin',
  owner:       'Owner',
  admin:       'Admin',
  instructor:  'Instructor',
};

export default function Layout({ children }) {
  const { profile, logout, activeCenterId, isSuperAdmin, isOwner, isAdmin, canSeeAdminPanel } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [openShifts, setOpenShifts] = useState([]);
  const [chatDocs, setChatDocs] = useState([]);

  // Subscribe to data needed for the Shift Board badge counter — scoped to
  // the active center. Both queries are also used by the ShiftBoard page
  // itself; Firebase dedupes identical subscriptions.
  useEffect(() => onSnapshot(
    query(
      collection(db, 'openShifts'),
      where('centerId', '==', activeCenterId),
      orderBy('date', 'asc'),
    ),
    snap => setOpenShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId]);

  useEffect(() => onSnapshot(
    query(
      collection(db, 'chat'),
      where('centerId', '==', activeCenterId),
      orderBy('createdAt', 'desc'),
      limit(200),
    ),
    snap => setChatDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
  ), [activeCenterId]);

  // Eligible-for-this-user count for the sidebar badge.
  const boardCount = useMemo(() => {
    const today = todayStr();
    const subs = profile?.subRoles || [];

    const openCount = openShifts.filter(s =>
      s.status === 'open' &&
      s.date >= today &&
      canTake(s.subRole, subs)
    ).length;

    const swapCount = chatDocs.filter(m =>
      m.type === 'shift_swap' &&
      m.swapStatus === 'open' &&
      (!m.shiftDate || m.shiftDate >= today) &&
      m.userId !== profile?.uid &&
      canTake(m.shiftSubRole, subs)
    ).length;

    return openCount + swapCount;
  }, [openShifts, chatDocs, profile]);

  // Build nav based on role. Three sections — GENERAL / OWNER / ADMIN —
  // visible to whoever's signed in. Items are added per-section based on
  // role rather than building entirely different nav trees per role; that
  // way the structure stays consistent and only what appears inside each
  // section varies. Empty sections are dropped before render.
  //
  // Role guide:
  //   instructor → GENERAL only (their personal app: Home, Announcements,
  //                Schedule, Shift Board, Chat) + Notifications under ADMIN.
  //   admin      → above + Admin Panel + Platform Chat under ADMIN.
  //   owner      → above + Centre Analytics + Centre Settings under OWNER.
  //   super_admin → above + Manage Centres + Platform Revenue + Audit Logs
  //                  under OWNER. (Owners don't run other centres so the
  //                  platform-operator items stay super-admin-only.)
  const general = [
    { to: '/',              label: 'Home',          icon: House },
    { to: '/announcements', label: 'Announcements', icon: Megaphone },
  ];
  // Personal scheduling surfaces. Super-admins skip these entirely —
  // they're the platform operator and shouldn't be claiming shifts at
  // someone else's centre. Owners skip Schedule (the personal-availability
  // page) since they run the business rather than take individual shifts,
  // but they keep Shift Board and Chat for awareness / coverage gaps.
  if (!isSuperAdmin) {
    if (!isOwner) {
      general.push({ to: '/schedule', label: 'Scheduling', icon: CalendarDays });
    }
    general.push(
      { to: '/shift-board', label: 'Shift Board', icon: Briefcase, badge: boardCount },
      { to: '/chat',        label: 'Chat',        icon: MessageSquare },
    );
  }

  const owner = [];
  if (isSuperAdmin) {
    owner.push({ to: '/super-admin', label: 'Manage Centres', icon: Building2 });
  }
  // Centre Analytics + Centre Settings = canSeeCenterSettings (owner +
  // super-admin). Plain admins manage day-to-day ops but don't get strategic
  // metrics or scheduler config.
  if (isSuperAdmin || isOwner) {
    owner.push(
      { to: '/center-analytics', label: 'Centre Analytics', icon: BarChart3 },
      { to: '/center-settings',  label: 'Centre Settings',  icon: Settings },
    );
  }
  if (isSuperAdmin) {
    owner.push(
      { to: '/platform-revenue', label: 'Platform Revenue', icon: DollarSign },
      { to: '/audit-logs',       label: 'Audit Logs',       icon: FileClock },
    );
  }

  const admin = [];
  if (canSeeAdminPanel) {
    admin.push({ to: '/admin', label: 'Admin Panel', icon: Shield });
  }
  if (isSuperAdmin || isOwner || isAdmin) {
    admin.push({ to: '/platform-chat', label: 'Platform Chat', icon: Headphones });
  }
  // Notifications is per-user preference — every signed-in user has one.
  admin.push({ to: '/notifications', label: 'Notifications', icon: Bell });

  const navSections = [
    { label: 'General', items: general },
    { label: 'Owner',   items: owner   },
    { label: 'Admin',   items: admin   },
  ].filter(s => s.items.length > 0);

  // Simple path equality is enough now that nothing deep-links into
  // admin?tab= from the sidebar.
  const isActive = (item) => location.pathname === item.to;

  // Role badge for the bottom user card
  const roleLabel = ROLE_LABEL[profile?.role] || (isAdmin ? 'Admin' : 'Instructor');

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Multi-center migration gate — covers the whole UI until the one-time
          migration has been run. After that, this renders nothing. */}
      <MigrationBanner />
      {open && <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-30 w-64 transform bg-gradient-to-b from-gray-900 to-gray-800 text-white transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center gap-3 border-b border-gray-700 px-5 py-5">
          <Logo size={40} />
          <div>
            <h1 className="text-lg font-bold leading-tight text-white">Mathnasium</h1>
            <p className="text-xs text-gray-400">Instructor Portal</p>
          </div>
          <button className="ml-auto lg:hidden" onClick={() => setOpen(false)}>
            <X size={20} />
          </button>
        </div>

        {/* Center switcher (shown if user has multiple centers or is super-admin) */}
        <div className="px-3 pt-3">
          <CenterSwitcher />
        </div>

        <nav className="mt-3 flex flex-col gap-1 px-3 pb-32">
          {navSections.map((section, idx) => (
            <div key={section.label || `sec-${idx}`} className={idx > 0 ? 'mt-4' : ''}>
              {section.label && (
                <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-gray-500">
                  {section.label}
                </p>
              )}
              {section.items.map(item => {
                const active = isActive(item);
                return (
                  <Link
                    key={item.to + (item.label || '')}
                    to={item.to}
                    onClick={() => setOpen(false)}
                    className={`mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${active ? 'bg-red-600 text-white shadow-md' : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}
                  >
                    <item.icon size={18} />
                    <span className="flex-1">{item.label}</span>
                    {item.badge > 0 && (
                      <span className={`min-w-[20px] text-center rounded-full px-1.5 py-0.5 text-xs font-bold ${active ? 'bg-white text-red-600' : 'bg-orange-500 text-white'}`}>
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="absolute bottom-0 left-0 right-0 border-t border-gray-700 p-4">
          <div className="mb-3 flex items-center gap-3">
            <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${isSuperAdmin ? 'bg-purple-600' : 'bg-red-600'}`}>
              {profile?.displayName?.charAt(0)?.toUpperCase() || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profile?.displayName || 'User'}</p>
              <p className="truncate text-xs text-gray-400">{roleLabel}</p>
            </div>
          </div>
          <button onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-700 hover:text-white">
            <LogOut size={16} /> Sign Out
          </button>
        </div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center gap-3 border-b bg-white px-4 py-3 shadow-sm lg:hidden">
          <button onClick={() => setOpen(true)}>
            <Menu size={24} className="text-gray-700" />
          </button>
          <div className="flex items-center gap-2">
            <Logo size={28} />
            <span className="font-bold text-gray-900">Mathnasium Portal</span>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
