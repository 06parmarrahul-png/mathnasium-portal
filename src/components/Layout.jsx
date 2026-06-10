import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import Logo from './Logo';
import RatioLogo from './RatioLogo';
import MigrationBanner from './MigrationBanner';
import CenterSwitcher from './CenterSwitcher';
import {
  House, Megaphone, CalendarDays, MessageSquare, Settings, LogOut, Menu, X, Bell,
  Briefcase, Shield, BarChart3, DollarSign, Headphones, Building2, FileClock, UserCog,
  CalendarRange, Users, Wallet, ClipboardList, Plug,
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

// Role labels for user-visible surfaces. The underlying Firestore role string
// stays 'super_admin' (so security rules + audit codes don't churn) but every
// place a human sees the role, we render it as "Enterprise".
const ROLE_LABEL = {
  super_admin: 'Enterprise',
  owner:       'Owner',
  admin:       'Admin',
  instructor:  'Instructor',
};

export default function Layout({ children }) {
  const { profile, logout, activeCenterId, isSuperAdmin, isOwner, isAdminAssistant, isAdmin, canSeeAdminPanel } = useAuth();
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

  // Build nav based on role. Sections appear in this order:
  //   GENERAL → MANAGE → INSIGHTS → COMMUNICATE → ENTERPRISE → SETTINGS
  // ordered roughly by how often a new owner needs each thing. The
  // "Manage" group breaks the old Admin Panel mega-tab into three
  // verb-named destinations a brand-new owner can scan and understand
  // without prior training. Holidays moved under Settings, time off is
  // a sub-tab of Manage Schedule, and Shift Board is hidden for owners
  // (they see open shifts inside Manage Schedule already).
  //
  // Role guide:
  //   instructor  → GENERAL + personal Scheduling / Shift Board / Chat.
  //   admin       → GENERAL + MANAGE + COMMUNICATE.
  //   admin_asst. → GENERAL + MANAGE + INSIGHTS + COMMUNICATE + SETTINGS,
  //                 PLUS personal Scheduling (they take shifts).
  //   owner       → GENERAL + MANAGE + INSIGHTS + COMMUNICATE + SETTINGS.
  //   super_admin → above + ENTERPRISE: Manage Centres, Manage Roles,
  //                 Platform Revenue, Leadership Chat, Audit Logs.
  const general = [
    { to: '/', label: 'Home', icon: House },
  ];
  // Personal scheduling surfaces. Enterprise users skip these entirely —
  // they're the platform operator and shouldn't be claiming shifts at
  // someone else's centre. Owners skip Schedule (the personal-availability
  // page) since they run the business rather than take individual shifts,
  // but AA gets it back (they ARE scheduled like staff).
  if (!isSuperAdmin && !isOwner) {
    general.push({ to: '/schedule', label: 'My Schedule', icon: CalendarDays });
  }
  // Shift Board is for instructors and AA (anyone who can claim shifts).
  // Owners see open shifts inside Manage Schedule and don't need a
  // separate sidebar item.
  if (!isSuperAdmin && !isOwner) {
    general.push({ to: '/shift-board', label: 'Shift Board', icon: Briefcase, badge: boardCount });
  }

  // MANAGE — verb-named top-level destinations for the things an owner
  // does every day. Each links to a focused view of what used to be a
  // tab inside the old Admin Panel. Internal Admin component reads
  // ?tab= from the URL so the existing tab system keeps working.
  //
  // Scheduler Creation lives here too (rather than under Enterprise) so
  // owners don't have to scroll the sidebar past Insights / Communicate
  // every shift. Available to anyone with daily-ops responsibility:
  // super_admin, owner, admin_assistant. Plain admin doesn't get it
  // (they're not configuring the scheduler).
  const manage = [];
  if (canSeeAdminPanel) {
    manage.push({ to: '/admin?tab=spreadsheet', label: 'Manage Schedule', icon: CalendarRange });
  }
  // Scheduler Creation is the daily ops tool — anyone who runs a shift
  // (super_admin, owner, admin_assistant, AND plain admin) gets access.
  // Same audience as canSeeAdminPanel so admins running the front desk
  // can check students in without needing owner-level rights.
  if (canSeeAdminPanel) {
    manage.push({ to: '/scheduler-creation', label: 'Scheduler Creation', icon: ClipboardList });
  }
  if (canSeeAdminPanel) {
    manage.push(
      { to: '/admin?tab=users',   label: 'Manage Staff',   icon: Users },
      { to: '/admin?tab=payroll', label: 'Manage Payroll', icon: Wallet },
    );
  }
  // Connectors — Mathnasium-approved vendor integrations dashboard.
  // Surfaced for the same audience as Scheduler Creation (owners + AA +
  // Enterprise) so the people who actually decide which tools the centre
  // uses can mark them connected.
  if (isSuperAdmin || isOwner || isAdminAssistant) {
    manage.push({ to: '/connectors', label: 'Connectors', icon: Plug });
  }

  // INSIGHTS — strategy / metrics surface. Owners + AA + Enterprise.
  // Plain admins run day-to-day ops but don't see strategic metrics.
  const insights = [];
  if (isSuperAdmin || isOwner || isAdminAssistant) {
    insights.push({ to: '/center-analytics', label: 'Centre Analytics', icon: BarChart3 });
  }

  // COMMUNICATE — chat, announcements, personal notification prefs.
  // For Owners we trim this section hard: Chat, Leadership Chat, and
  // Notification Preferences all live one click away on the Account page
  // (clicking the user card at the bottom of the sidebar). Keeps the
  // sidebar short enough that an owner mid-shift never has to scroll.
  const communicate = [];
  if (!isSuperAdmin && !isOwner) {
    communicate.push({ to: '/chat', label: 'Chat', icon: MessageSquare });
  }
  if ((isAdmin || isAdminAssistant) && !isSuperAdmin) {
    communicate.push({ to: '/platform-chat', label: 'Leadership Chat', icon: Headphones });
  }
  communicate.push({ to: '/announcements', label: 'Announcements', icon: Megaphone });
  if (!isOwner) {
    communicate.push({ to: '/notifications', label: 'Notifications', icon: Bell });
  }

  // ENTERPRISE — platform-operator only. Sits between COMMUNICATE and
  // SETTINGS so super-admin tools are grouped together but don't crowd
  // the per-centre nav above. (Scheduler Creation used to live here too
  // but moved under Manage so owners reach it without scrolling.)
  const enterprise = [];
  if (isSuperAdmin) {
    enterprise.push(
      { to: '/super-admin',      label: 'Manage Centres',   icon: Building2 },
      { to: '/manage-roles',     label: 'Manage Roles',     icon: UserCog },
      { to: '/platform-revenue', label: 'Platform Revenue', icon: DollarSign },
      { to: '/platform-chat',    label: 'Leadership Chat',  icon: Headphones },
      { to: '/audit-logs',       label: 'Audit Logs',       icon: FileClock },
    );
  }

  // SETTINGS — one-time / rare-touch configuration. Sits at the bottom
  // so it doesn't crowd the daily-use items above. Centre Settings
  // includes Holidays as a sub-section (one less sidebar row for the
  // owner to scan past).
  const settingsSection = [];
  if (isSuperAdmin || isOwner || isAdminAssistant) {
    settingsSection.push({ to: '/center-settings', label: 'Centre Settings', icon: Settings });
  }

  const navSections = [
    { label: 'General',     items: general     },
    { label: 'Manage',      items: manage      },
    { label: 'Insights',    items: insights    },
    { label: 'Communicate', items: communicate },
    { label: 'Enterprise',  items: enterprise  },
    { label: 'Settings',    items: settingsSection },
  ].filter(s => s.items.length > 0);

  // Path equality + (when the link carries a ?tab= query string)
  // also matches the active tab. This keeps Manage Schedule /
  // Manage Staff / Manage Payroll distinct in the sidebar even
  // though they all point at /admin underneath.
  const currentTab = new URLSearchParams(location.search).get('tab') || 'spreadsheet';
  const isActive = (item) => {
    const [path, queryStr] = item.to.split('?');
    if (location.pathname !== path) return false;
    if (!queryStr) {
      // Item has no ?tab=, so it's only active when no tab is selected
      // (the default landing). Avoids /admin matching /admin?tab=users.
      if (path === '/admin') return currentTab === 'spreadsheet';
      return true;
    }
    const itemTab = new URLSearchParams(queryStr).get('tab');
    return itemTab === currentTab;
  };

  // Role badge for the bottom user card
  const roleLabel = ROLE_LABEL[profile?.role] || (isAdmin ? 'Admin' : 'Instructor');

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Multi-center migration gate — covers the whole UI until the one-time
          migration has been run. After that, this renders nothing. */}
      <MigrationBanner />
      {open && <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-30 w-64 flex flex-col transform bg-gradient-to-b from-gray-900 to-gray-800 text-white transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="shrink-0 flex items-center gap-3 border-b border-gray-700 px-5 py-5">
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
        <div className="shrink-0 px-3 pt-3">
          <CenterSwitcher />
        </div>

        <nav className="mt-3 flex-1 min-h-0 overflow-y-auto flex flex-col gap-1 px-3 pb-4">
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
        <div className="shrink-0 border-t border-gray-700 p-4">
          {/* User card — clickable. Goes to /account for self-service
              profile + email + password management. Enterprise accounts
              keep the Ratio brand mark; everyone else shows their
              uploaded photoURL (if set) or a coloured initials circle.
              Title attribute makes the click target discoverable. */}
          <Link
            to="/account"
            onClick={() => setOpen(false)}
            title="Account Details"
            className="mb-3 -mx-1 flex items-center gap-3 rounded-lg px-1 py-1 transition-colors hover:bg-gray-700/60"
          >
            {isSuperAdmin ? (
              <div className="shrink-0">
                <RatioLogo size={32} alt={profile?.displayName || 'Ratio'} />
              </div>
            ) : profile?.photoURL ? (
              <img
                src={profile.photoURL}
                alt={profile?.displayName || 'Profile picture'}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold bg-red-600">
                {profile?.displayName?.charAt(0)?.toUpperCase() || '?'}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{profile?.displayName || 'User'}</p>
              <p className="truncate text-xs text-gray-400">{roleLabel}</p>
            </div>
          </Link>
          <button onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-gray-400 transition-colors hover:bg-gray-700 hover:text-white">
            <LogOut size={16} /> Sign Out
          </button>
          {/* Ratio wordmark + brand mark — small, muted, sits below the
              user card and Sign Out so the platform brand has a quiet
              presence without competing with the centre's identity in
              the header. */}
          <div className="mt-3 flex items-center justify-center gap-1.5" title="More time with students. More time with family. Less time on everything else.">
            <RatioLogo size={14} alt="Ratio" />
            <span className="text-[10px] uppercase tracking-[0.25em] text-gray-500">
              Ratio
            </span>
          </div>
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
