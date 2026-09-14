/**
 * What every page is called — in the sidebar, on the phone tabs, as the
 * page's own title, in Home shortcuts, in the browser tab, and in any
 * sentence that sends someone there ("it's on the Job Board").
 *
 * One list, because the names had drifted: "Student Scheduler" opened a
 * page titled "Scheduler Creation", "Shift Board" was "Job board" on the
 * phone, "Chat" was "Team Chat" on the page and "Centre Chat" in the Chats
 * hub, and "Notifications" was titled "Notification Preferences". Import
 * the name from here instead of typing it; pageNames.test.js fails if a
 * retired name comes back.
 *
 * The rules the names follow:
 *   - The sidebar name is the name everywhere. No short forms on phones.
 *   - Pages about you start with "My": My Schedule, My Pay, My Account.
 *   - Canadian spelling: Centre.
 *   - "Job Board" is the centre's own word (from Rahul's sketch of the
 *     phone home), and replaced "Shift Board".
 */

export const PORTAL_NAME = 'Mathnasium';
export const PORTAL_SUBTITLE = 'Staff Portal';

export const PAGES = {
  home:             { path: '/',                      name: 'Home' },
  mySchedule:       { path: '/schedule',              name: 'My Schedule' },
  jobBoard:         { path: '/shift-board',           name: 'Job Board' },
  myPay:            { path: '/my-pay',                name: 'My Pay' },
  myAccount:        { path: '/account',               name: 'My Account' },
  teamChat:         { path: '/chat',                  name: 'Team Chat' },
  chats:            { path: '/chats',                 name: 'Chats' },
  managementChat:   { path: '/platform-chat',         name: 'Management Chat' },
  ownerChat:        { path: '/platform-chat?view=owners', name: 'Owner Chat' },
  announcements:    { path: '/announcements',         name: 'Announcements' },
  notifications:    { path: '/notifications',         name: 'Notifications' },

  studentScheduler: { path: '/scheduler-creation',    name: 'Student Scheduler' },
  staffSchedule:    { path: '/admin?tab=spreadsheet', name: 'Manage Staff Schedule' },
  manageStaff:      { path: '/admin?tab=users',       name: 'Manage Staff' },
  managePayroll:    { path: '/admin?tab=payroll',     name: 'Manage Payroll' },
  staffingBoard:    { path: '/staffing-board',        name: 'Staffing Board' },
  inventory:        { path: '/inventory',             name: 'Inventory' },
  availabilityLog:  { path: '/availability-log',      name: 'Availability Log' },
  centreEvents:     { path: '/events',                name: 'Centre Events' },
  // The same page, for someone who can only run the fun-day calendar.
  funDays:          { path: '/events',                name: 'Fun Days' },
  desk:             { path: '/desk',                  name: 'Management Desk' },

  leads:            { path: '/leads',                 name: 'Leads' },
  intakes:          { path: '/intakes',               name: 'Intakes' },
  centreAnalytics:  { path: '/center-analytics',      name: 'Centre Analytics' },
  supplyDemand:     { path: '/supply-demand',         name: 'Supply & Demand' },
  staffingBudget:   { path: '/staffing-budget',       name: 'Staffing Budget' },
  caseStudy:        { path: '/case-study',            name: 'Case Study' },
  centreSettings:   { path: '/center-settings',       name: 'Centre Settings' },
  connectors:       { path: '/connectors',            name: 'Connectors' },

  manageCentres:    { path: '/super-admin',           name: 'Manage Centres' },
  manageRoles:      { path: '/manage-roles',          name: 'Manage Roles' },
  platformRevenue:  { path: '/platform-revenue',      name: 'Platform Revenue' },
  auditLogs:        { path: '/audit-logs',            name: 'Audit Logs' },
};

const ADMIN_TAB_PAGE = {
  spreadsheet: PAGES.staffSchedule, scheduler: PAGES.staffSchedule, requests: PAGES.staffSchedule,
  users: PAGES.manageStaff, payroll: PAGES.managePayroll,
};

/**
 * The page name for a location, for the browser tab. The Admin page is
 * three pages to the people using it, so its ?tab= decides the name.
 * Centre Analytics has sub-pages under its path. Unknown → null.
 */
export function pageNameFor(pathname, search = '') {
  if (pathname === '/admin') {
    const tab = new URLSearchParams(search).get('tab') || 'spreadsheet';
    return (ADMIN_TAB_PAGE[tab] || PAGES.staffSchedule).name;
  }
  if (pathname === '/platform-chat') {
    return new URLSearchParams(search).get('view') === 'owners' ? PAGES.ownerChat.name : PAGES.managementChat.name;
  }
  if (pathname.startsWith('/center-analytics')) return PAGES.centreAnalytics.name;
  const hit = Object.values(PAGES).find(p => !p.path.includes('?') && p.path === pathname);
  return hit ? hit.name : null;
}

/** "Job Board · Ratio" — the browser tab. */
export function documentTitleFor(pathname, search = '') {
  const name = pageNameFor(pathname, search);
  return name ? `${name} · Ratio` : 'Ratio';
}
