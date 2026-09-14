import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { collection, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import Mascot from './Mascot';
import RatioLogo from './RatioLogo';
import MigrationBanner from './MigrationBanner';
import { canUseNewLook, isNewLookOn, setNewLook } from '../lib/newLook';
import { myOpenCount, canUseDesk } from '../lib/deskNotes';
import { isHourlyPaid } from '../lib/payProjection';
import { roleLabelFor } from '../lib/roleLabel';
import { PAGES, PORTAL_NAME, PORTAL_SUBTITLE, documentTitleFor } from '../lib/pageNames';
import CenterSwitcher from './CenterSwitcher';
import {
  House, Megaphone, CalendarDays, MessageSquare, Settings, LogOut, Menu, X, Bell,
  Briefcase, Shield, BarChart3, DollarSign, Headphones, Building2, FileClock, UserCog,
  CalendarRange, Users, Wallet, ClipboardList, Plug, MessagesSquare, Sparkles, CalendarCheck,
  UserPlus, FileBarChart, Activity, Package, History, LayoutGrid,
  StickyNote,
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

export default function Layout({ children }) {
  const auth = useAuth();
  const { profile, mySubRoles, logout, activeCenterId, isSuperAdmin, isOwner, isDirector, isAdminAssistant, isAdmin, isLead, isVolunteer, canTakeShifts, canSeeAdminPanel, canManageOperations } = auth;
  // The phone-first home is for people whose job is working shifts.
  // Leadership keeps the classic pages, whose numbers are known-good.
  const newLookEligible = canUseNewLook(auth);
  const isOwnerLikeNav = isSuperAdmin || isOwner || isAdminAssistant || isDirector;
  const newLookOn = newLookEligible && isNewLookOn(profile?.uid);
  // Volunteers are unpaid and salaried staff aren't paid from the hourly
  // sheet, so a pay projection would be wrong for both.
  const showPay = isHourlyPaid({ displayName: profile?.displayName, isVolunteer }, auth.centerConfig);
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [openShifts, setOpenShifts] = useState([]);
  const [chatDocs, setChatDocs] = useState([]);
  const [deskNotes, setDeskNotes] = useState([]);
  // Asked exactly the way the Firestore rules ask it — see canUseDesk.
  // `can('notes.access')` alone hid the link from Hosts and Managers at
  // any centre that had ever saved its roles from Manage Roles.
  const canOpenDesk = canUseDesk({
    platformRole: profile?.role,
    instructorType: auth.myInstructorType,
    permissions: auth.permissions,
  });

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

  // Notes waiting on this person. The whole reason the desk beats the
  // spreadsheet is that nobody has to read 121 rows looking for their own
  // initials — so the count belongs in the sidebar, not behind a click.
  // Only subscribed for people who can open the desk; for everybody else
  // the read would be refused by the rules anyway.
  useEffect(() => {
    if (!canOpenDesk || !activeCenterId) return undefined;
    // Open notes only. The settled archive runs to 1,730 documents and
    // none of them can be waiting on anybody.
    return onSnapshot(
      query(
        collection(db, 'centers', activeCenterId, 'notes'),
        where('status', '==', 'open'),
      ),
      snap => setDeskNotes(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setDeskNotes([]),
    );
  }, [canOpenDesk, activeCenterId]);

  // Gated on the way OUT rather than cleared in the effect: losing desk
  // access has to zero the badge immediately, and an effect that clears
  // state is a cascading render the linter is right to object to.
  const deskCount = useMemo(
    () => (canOpenDesk ? myOpenCount(deskNotes, profile?.uid) : 0),
    [canOpenDesk, deskNotes, profile?.uid]);

  // Eligible-for-this-user count for the sidebar badge.
  const boardCount = useMemo(() => {
    const today = todayStr();
    const subs = mySubRoles || [];

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
  }, [openShifts, chatDocs, profile, mySubRoles]);

  // The owner-shaped sidebar (Growth / Demand / Supply / …) — see below.
  const useOwnerLayout = isOwner || isAdminAssistant || isDirector;

  // Build nav based on role.
  //
  // Two distinct layouts:
  //
  // (A) OWNER / ADMIN-ASSISTANT layout (the business operator) — uses a
  //     supply / demand mental model that mirrors the actual economics
  //     of a tutoring centre. The owner's whole job is matching demand
  //     (students) against supply (staff hours), so the sidebar is
  //     literally shaped like the P&L:
  //
  //       GENERAL  → home, chats — daily start point
  //       GROWTH   → the funnel (leads → assessments → enrolled)
  //       DEMAND   → active students + today's room
  //       SUPPLY   → staff: schedule, roster, payroll
  //       INTELLIGENCE → analytics, the answers
  //       CENTRE   → settings + configuration
  //
  // (B) EVERYONE ELSE — instructor / plain admin / super-admin — uses
  //     the original verb-named groupings (General / Manage / Insights /
  //     Communicate / Enterprise / Settings) because the supply/demand
  //     frame is for the business owner, not the people running shifts
  //     in the room or the platform operator.
  //
  // Role guide unchanged:
  //   instructor  → GENERAL + personal Scheduling / Shift Board / Chat.
  //   admin       → GENERAL + MANAGE + COMMUNICATE.
  //   admin_asst. → owner-style layout (they ARE owner-equivalent for ops).
  //   owner       → owner-style layout.
  //   super_admin → original layout + ENTERPRISE.
  // Directors get the full owner-style sidebar (Growth, Supply,
  // Intelligence, Centre) — they run the centre and need the same
  // navigation as an owner, just with a different label.
  // ─── GENERAL (both layouts share this) ─────────────────────────────
  const general = [
    { to: PAGES.home.path, label: PAGES.home.name, icon: House },
  ];
  // The owner-shaped sidebar has no Communicate section, so everyone on it
  // gets a single "Chats" entry: a hub holding Announcements, Team Chat,
  // Management Chat and (owners only) Owner Chat. It used to be Owner-only,
  // which left Directors and the Admin Assistant with no way to a chat or
  // announcements from the sidebar at all.
  if (useOwnerLayout) {
    general.push({ to: PAGES.chats.path, label: PAGES.chats.name, icon: MessagesSquare });
  }
  // Personal scheduling surfaces. Enterprise users skip these entirely —
  // they're the platform operator and shouldn't be claiming shifts at
  // someone else's centre. Owners skip Schedule (the personal-availability
  // page) since they run the business rather than take individual shifts,
  // but AA gets it back (they ARE scheduled like staff).
  if (!isSuperAdmin && !isOwner) {
    general.push({ to: PAGES.mySchedule.path, label: PAGES.mySchedule.name, icon: CalendarDays });
  }
  // Shift Board is for instructors and AA (anyone who can claim shifts).
  // Owners see open shifts inside Manage Schedule and don't need a
  // separate sidebar item.
  // Volunteers don't pick up open shifts or swap — they work the shifts
  // they're given and ask to cancel if something comes up. Trainees
  // shadow an instructor rather than covering a slot, so the same
  // applies. The Shift Board is entirely about claiming and swapping,
  // so it's not theirs — see canTakeShifts in AuthContext.
  if (!isSuperAdmin && !isOwner && canTakeShifts) {
    general.push({ to: PAGES.jobBoard.path, label: PAGES.jobBoard.name, icon: Briefcase, badge: boardCount });
  }
  // Their own hours and an estimate of what those come to. Not for owners
  // (they read the real payroll sheet) or for anyone not paid by the hour.
  if (!isOwnerLikeNav && showPay) {
    general.push({ to: PAGES.myPay.path, label: PAGES.myPay.name, icon: Wallet });
  }

  // ─── OWNER LAYOUT ──────────────────────────────────────────────────
  // Built only when useOwnerLayout is true. Empty arrays otherwise so
  // the section-assembly below stays uniform.
  //
  // GROWTH — the lead → student funnel. Leads sits above Intakes
  // because it's the wider top of the funnel (anyone interested),
  // while Intakes is the narrower next step (a scheduled assessment).
  // Owners scan the sidebar top-to-bottom — putting them in funnel
  // order reinforces the mental model every time.
  const growth = [];
  if (useOwnerLayout) {
    growth.push(
      { to: PAGES.leads.path,   label: PAGES.leads.name,   icon: UserPlus },
      { to: PAGES.intakes.path, label: PAGES.intakes.name, icon: CalendarCheck },
    );
  }

  // DEMAND — active students + today's room. The daily ops tool sits
  // here, not under Manage, because students ARE the demand. Renamed
  // "Scheduler Creation" → "Student Scheduler" to match how owners
  // actually describe it (and to underline that it's about students,
  // not about building schedulers).
  const demand = [];
  if (useOwnerLayout) {
    demand.push({ to: PAGES.studentScheduler.path, label: PAGES.studentScheduler.name, icon: ClipboardList });
    demand.push({ to: PAGES.staffingBoard.path, label: PAGES.staffingBoard.name, icon: LayoutGrid });
  }

  // SUPPLY — staff. Schedule + roster + pay = supply being allocated,
  // maintained, settled. Same three Admin sub-tabs as before, just
  // re-framed under the right mental bucket.
  const supply = [];
  if (useOwnerLayout && canSeeAdminPanel) {
    supply.push(
      { to: PAGES.staffSchedule.path, label: PAGES.staffSchedule.name, icon: CalendarRange },
      { to: PAGES.manageStaff.path,   label: PAGES.manageStaff.name,   icon: Users },
      { to: PAGES.managePayroll.path, label: PAGES.managePayroll.name, icon: Wallet },
      // Availability history sits with the staff tools, not with Centre
      // config: you open it while looking at a schedule dispute, which
      // is exactly when Manage Staff Schedule is the tab next door.
      { to: PAGES.availabilityLog.path, label: PAGES.availabilityLog.name, icon: History },
    );
  }

  // INTELLIGENCE — the answers. Centre Analytics belongs here, not
  // mixed with the verbs above. Case Study is the slide-ready numbers
  // used for sales pitches (Owner-only conceptually, but admin_assistant
  // who runs operations should see them too).
  const intelligence = [];
  if (useOwnerLayout) {
    intelligence.push({ to: PAGES.centreAnalytics.path, label: PAGES.centreAnalytics.name, icon: BarChart3 });
    intelligence.push({ to: PAGES.supplyDemand.path,    label: PAGES.supplyDemand.name,    icon: Activity });
    intelligence.push({ to: PAGES.staffingBudget.path,  label: PAGES.staffingBudget.name,  icon: Wallet });
    intelligence.push({ to: PAGES.caseStudy.path,       label: PAGES.caseStudy.name,       icon: FileBarChart });
  }

  // CENTRE — configuration. Sits at the bottom because owners touch it
  // rarely. Connectors and Holidays already live inside Centre Settings
  // as sub-tabs.
  const centre = [];
  if (useOwnerLayout) {
    // Inventory sits above Centre Settings: supplies get touched weekly,
    // settings get touched twice a year. Admin-and-above only — the route
    // and the Firestore rules enforce it too, this just hides the link.
    if (canSeeAdminPanel) {
      centre.push({ to: PAGES.inventory.path, label: PAGES.inventory.name, icon: Package });
      // Staff meetings and fun days. Sits with Centre because it is the
      // centre's calendar, not a scheduling tool.
      centre.push({ to: PAGES.centreEvents.path, label: PAGES.centreEvents.name, icon: CalendarCheck });
    }
    if (canOpenDesk) {
      centre.push({ to: PAGES.desk.path, label: PAGES.desk.name, icon: StickyNote, badge: deskCount });
    }
    centre.push({ to: PAGES.centreSettings.path, label: PAGES.centreSettings.name, icon: Settings });
  }

  // ─── NON-OWNER LAYOUT (original Manage / Insights / Communicate) ──
  // Built only when useOwnerLayout is false (instructor, plain admin,
  // super_admin). Owners / AA reach all of this via Growth / Demand /
  // Supply / Intelligence / Centre above.

  const manage = [];
  if (!useOwnerLayout && canManageOperations) {
    // Plain Admin, Manager, and Host all land here — same "operational
    // admin" tier, full list. (Owner / AA / Director reach the same
    // pages via Growth / Demand / Supply / Intelligence above instead.)
    manage.push(
      { to: PAGES.staffSchedule.path,    label: PAGES.staffSchedule.name,    icon: CalendarRange },
      { to: PAGES.studentScheduler.path, label: PAGES.studentScheduler.name, icon: ClipboardList },
      { to: PAGES.manageStaff.path,      label: PAGES.manageStaff.name,      icon: Users },
      { to: PAGES.managePayroll.path,    label: PAGES.managePayroll.name,    icon: Wallet },
      { to: PAGES.inventory.path,        label: PAGES.inventory.name,        icon: Package },
      { to: PAGES.availabilityLog.path,  label: PAGES.availabilityLog.name,  icon: History },
      // Without the admin panel this page is only the fun-day calendar, so
      // the link says so rather than promising the rest.
      { to: PAGES.centreEvents.path, label: (canSeeAdminPanel ? PAGES.centreEvents : PAGES.funDays).name, icon: CalendarCheck },
    );
    if (canOpenDesk) {
      manage.push({ to: PAGES.desk.path, label: PAGES.desk.name, icon: StickyNote, badge: deskCount });
    }
  } else if (!useOwnerLayout && isLead) {
    // Lead instructors get Student Scheduler — but NOT the broader
    // admin pages (Manage Staff / Payroll stay owner-side). They run
    // the floor; they don't run HR.
    manage.push(
      { to: PAGES.studentScheduler.path, label: PAGES.studentScheduler.name, icon: ClipboardList },
    );
  }

  const insights = [];
  if (!useOwnerLayout && isSuperAdmin) {
    insights.push({ to: PAGES.centreAnalytics.path, label: PAGES.centreAnalytics.name, icon: BarChart3 });
    insights.push({ to: PAGES.intakes.path,         label: PAGES.intakes.name,         icon: CalendarCheck });
  }

  // COMMUNICATE — chat, announcements, personal notification prefs.
  // Owners skip this entirely (consolidated under General → Chats).
  const communicate = [];
  // Volunteers get a bare-bones portal — no team messaging. The route
  // guard enforces it; this just keeps the sidebar honest.
  if (!isSuperAdmin && !isOwner && !isVolunteer) {
    communicate.push({ to: PAGES.teamChat.path, label: PAGES.teamChat.name, icon: MessageSquare });
  }
  if ((isAdmin || isAdminAssistant) && !isSuperAdmin && !isVolunteer) {
    communicate.push({ to: PAGES.managementChat.path, label: PAGES.managementChat.name, icon: Headphones });
  }
  // Volunteers get the latest announcement on their Home page, which is
  // the whole of what they need from it.
  if (!isOwner && !isVolunteer) {
    communicate.push({ to: PAGES.announcements.path, label: PAGES.announcements.name, icon: Megaphone });
  }
  if (!isOwner) {
    communicate.push({ to: PAGES.notifications.path, label: PAGES.notifications.name, icon: Bell });
  }

  // ENTERPRISE — platform-operator only. Sits between COMMUNICATE and
  // SETTINGS so super-admin tools are grouped together.
  const enterprise = [];
  if (isSuperAdmin) {
    enterprise.push(
      { to: PAGES.manageCentres.path,   label: PAGES.manageCentres.name,   icon: Building2 },
      { to: PAGES.manageRoles.path,     label: PAGES.manageRoles.name,     icon: UserCog },
      { to: PAGES.platformRevenue.path, label: PAGES.platformRevenue.name, icon: DollarSign },
      { to: PAGES.managementChat.path,  label: PAGES.managementChat.name,  icon: Headphones },
      { to: PAGES.ownerChat.path,       label: PAGES.ownerChat.name,       icon: Sparkles },
      { to: PAGES.auditLogs.path,       label: PAGES.auditLogs.name,       icon: FileClock },
    );
  }

  // SETTINGS — non-owner fallback for those who didn't get a Centre
  // section above. Super-admin lands here.
  const settingsSection = [];
  if (!useOwnerLayout && isSuperAdmin) {
    settingsSection.push({ to: PAGES.centreSettings.path, label: PAGES.centreSettings.name, icon: Settings });
  }

  const navSections = useOwnerLayout
    ? [
        { label: 'General',      items: general      },
        { label: 'Growth',       items: growth       },
        { label: 'Demand',       items: demand       },
        { label: 'Supply',       items: supply       },
        { label: 'Intelligence', items: intelligence },
        { label: 'Centre',       items: centre       },
      ].filter(s => s.items.length > 0)
    : [
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

  // The browser tab names the page, from the same list as the sidebar.
  useEffect(() => {
    document.title = documentTitleFor(location.pathname, location.search);
  }, [location.pathname, location.search]);

  // Role badge for the bottom user card: the job title at THIS centre
  // (Host, Lead, Center Director), not the platform role — see roleLabelFor.
  const roleLabel = roleLabelFor({
    platformRole: profile?.role,
    instructorType: auth.myInstructorType,
    isVolunteer,
  });

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Multi-center migration gate — covers the whole UI until the one-time
          migration has been run. After that, this renders nothing. */}
      <MigrationBanner />
      {open && <div className="fixed inset-0 z-20 bg-black/50 lg:hidden" onClick={() => setOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-30 w-64 flex flex-col transform bg-gradient-to-b from-gray-900 to-gray-800 text-white transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="shrink-0 flex items-center gap-3 border-b border-gray-700 px-5 py-5">
          {/* Their own Cole, picked at sign-up or on Account. */}
          <Mascot id={profile?.mascot} size={40} className="shrink-0" />
          <div>
            <h1 className="text-lg font-bold leading-tight text-white">{PORTAL_NAME}</h1>
            <p className="text-xs text-gray-400">{PORTAL_SUBTITLE}</p>
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
            title={PAGES.myAccount.name}
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
          {/* Opt-in preview of the role-shaped home pages.
              Deliberately down here with the other preferences rather than
              in the nav: it changes ONE page (Home), and dressing it up as a
              destination would oversell it. Off by default for everybody —
              nobody meets a redesigned portal because a deploy landed. */}
          {newLookEligible && (
            <button
              onClick={() => { setNewLook(profile?.uid, !newLookOn); window.location.reload(); }}
              className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-gray-400 transition-colors hover:bg-gray-700 hover:text-white"
              title="A home page built for a phone: your next shift, anything Ratio needs from you, and open shifts. Nothing else in the portal changes, and you can switch back here.">
              <Sparkles size={16} />
              <span className="flex-1">{newLookOn ? 'Back to classic home' : 'Try the new home'}</span>
              {!newLookOn && (
                <span className="rounded-full bg-gray-700 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-gray-300">
                  New
                </span>
              )}
            </button>
          )}
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
          <button onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu size={24} className="text-gray-700" />
          </button>
          <div className="flex items-center gap-2">
            <Mascot id={profile?.mascot} size={28} className="shrink-0" />
            <span className="font-bold text-gray-900">{PORTAL_NAME}</span>
          </div>

          {/* Account and settings live on the avatar, top-right — where
              people already look for them, and where they don't cost a
              permanent sixth of the tab bar for something touched twice a
              year. */}
          <Link to={PAGES.myAccount.path} title={PAGES.myAccount.name}
            aria-label={PAGES.myAccount.name}
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
            {profile?.photoURL ? (
              <img src={profile.photoURL} alt=""
                className="h-9 w-9 rounded-full object-cover" />
            ) : (
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-red-600 text-sm font-bold text-white">
                {profile?.displayName?.charAt(0)?.toUpperCase() || '?'}
              </span>
            )}
          </Link>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>

        {/* Bottom tabs — phones only, and only for floor staff on the new
            home. Instructors touch four things; reaching them through a
            hamburger menu built for an owner's eighteen sidebar links is
            the single worst part of the portal on a phone. `lg:hidden`
            because the sidebar is back at that width and two navigations
            would just compete. */}
        {newLookOn && (
          <MobileTabs canTakeShifts={canTakeShifts} isVolunteer={isVolunteer} showPay={showPay} />
        )}
      </div>
    </div>
  );
}

/**
 * The four things a person working a shift actually opens.
 *
 * Volunteers get no team chat (they work the shifts they're given and ask
 * to cancel — see canTakeShifts in AuthContext), and anyone who can't pick
 * up shifts has no use for the board, so both tabs are conditional rather
 * than shown-and-broken.
 */
function MobileTabs({ canTakeShifts, isVolunteer, showPay }) {
  const location = useLocation();
  const tabs = [
    // Same names as the sidebar — a tab called "Pay" and a link called
    // "My Pay" read as two places.
    { to: PAGES.home.path, label: PAGES.home.name, icon: House, exact: true },
    { to: PAGES.mySchedule.path, label: PAGES.mySchedule.name, icon: CalendarDays },
    canTakeShifts && { to: PAGES.jobBoard.path, label: PAGES.jobBoard.name, icon: Briefcase },
    showPay && { to: PAGES.myPay.path, label: PAGES.myPay.name, icon: Wallet },
    !isVolunteer && { to: PAGES.teamChat.path, label: PAGES.teamChat.name, icon: MessageSquare },
  ].filter(Boolean);

  return (
    <nav
      className="nl-tabbar no-print sticky bottom-0 z-20 grid border-t bg-white lg:hidden"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`, borderColor: '#e5e7eb' }}
      aria-label="Main">
      {tabs.map(t => {
        const active = t.exact ? location.pathname === t.to : location.pathname.startsWith(t.to);
        return (
          <Link key={t.to} to={t.to}
            aria-current={active ? 'page' : undefined}
            // min-h-[56px] keeps every target comfortably past the 44px
            // minimum even on a small phone.
            className="flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 py-2 text-[10.5px] font-semibold transition-colors"
            style={{ color: active ? '#C8102E' : '#6E625B' }}>
            <t.icon size={19} strokeWidth={active ? 2.4 : 2} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
