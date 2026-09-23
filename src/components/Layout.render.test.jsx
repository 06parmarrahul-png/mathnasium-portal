// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The sidebar, rendered for each role.
 *
 * Written after the role atlas found the sidebar and the pages disagreeing:
 * Directors and the Admin Assistant had no way to a chat, and page names
 * differed between the sidebar, the phone tabs and the pages themselves.
 * The role registry below is Langley's saved one (permissions only), so the
 * Host here has the admin panel exactly as it does in production.
 */

vi.mock('../firebase', () => ({ db: {}, auth: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}), query: () => ({}), where: () => ({}), orderBy: () => ({}), limit: () => ({}),
  doc: () => ({}),
  onSnapshot: (q, next) => { if (typeof next === 'function') next({ docs: [] }); return () => {}; },
}));
vi.mock('./CenterSwitcher', () => ({ default: () => null }));
vi.mock('./MigrationBanner', () => ({ default: () => null }));
const current = { auth: {} };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth, useOptionalAuth: () => current.auth }));

const { default: Layout } = await import('./Layout');
const { resolveRoles, resolvePermissions, can: hasPermission } = await import('../lib/roles');
const { PAGES, PORTAL_SUBTITLE } = await import('../lib/pageNames');

const LANGLEY = {
  staffRolePermissions: {
    'Lead': ['scheduler.run'],
    'Dir. of Education': ['admin.panel', 'admin.operations', 'analytics.view', 'scheduler.run', 'shifts.take', 'chat.access', 'centre.settings'],
    'Manager': ['scheduler.run', 'admin.operations', 'chat.access'],
    'Center Director': ['admin.panel', 'admin.operations', 'analytics.view', 'scheduler.run', 'shifts.take', 'chat.access', 'centre.settings'],
    'Host': ['scheduler.run', 'admin.operations', 'admin.panel', 'analytics.view', 'shifts.take', 'chat.access'],
  },
};

// After scripts/managers-take-over-admin.cjs: the Manager role carries
// what the retired Admin role did.
const LANGLEY_AFTER = {
  staffRolePermissions: {
    ...LANGLEY.staffRolePermissions,
    Manager: ['admin.panel', 'admin.operations', 'analytics.view', 'scheduler.run', 'shifts.take', 'chat.access', 'notes.access'],
  },
};

function authFor({ role, title, volunteer = false, config = LANGLEY }) {
  const roles = resolveRoles(config, () => '#999');
  const permissions = resolvePermissions({ platformRole: role, instructorType: title, isVolunteer: volunteer, roles });
  const isDirector = role === 'director';
  return {
    profile: {
      uid: `u-${title}-${role}`, displayName: 'Sam Lee', role, centerId: 'langley', centerIds: ['langley'],
      centerMemberships: { langley: { instructorType: title, isVolunteer: volunteer } },
    },
    activeCenterId: 'langley', centerConfig: config, mySubRoles: ['Elementary'], logout: () => {},
    isSuperAdmin: role === 'super_admin', isOwner: role === 'owner', isDirector,
    isAdminAssistant: role === 'admin_assistant', isAdmin: role === 'admin',
    isOwnerLike: ['owner', 'admin_assistant', 'super_admin'].includes(role) || isDirector,
    isLead: title === 'Lead', isVolunteer: volunteer,
    canTakeShifts: permissions.has('shifts.take'), canSeeAdminPanel: permissions.has('admin.panel'),
    canManageOperations: permissions.has('admin.operations'), permissions, myInstructorType: title,
    // The nav asks for permissions by id now, the same way AuthContext
    // answers them. Resolved from the same set rather than stubbed true,
    // so a link gated on a permission is still really gated here.
    can: (id) => hasPermission(permissions, id),
  };
}

const PEOPLE = {
  owner:     { role: 'owner', title: 'Instructor' },
  director:  { role: 'director', title: 'Center Director' },
  education: { role: 'director', title: 'Dir. of Education' },
  aa:        { role: 'admin_assistant', title: 'Admin' },
  manager:   { role: 'admin', title: 'Manager' },
  // The same Manager once their account is off the retired Admin role.
  managerNow:{ role: 'instructor', title: 'Manager', config: LANGLEY_AFTER },
  host:      { role: 'instructor', title: 'Host' },
  lead:      { role: 'instructor', title: 'Lead' },
  instructor:{ role: 'instructor', title: 'Instructor' },
  trainee:   { role: 'instructor', title: 'Training' },
  volunteer: { role: 'instructor', title: 'Volunteer', volunteer: true },
};

function draw(who, { newHome = false, at = '/' } = {}) {
  current.auth = authFor(PEOPLE[who]);
  localStorage.clear();
  if (newHome) localStorage.setItem(`ratio-new-look:${current.auth.profile.uid}`, 'on');
  const { container } = render(<MemoryRouter initialEntries={[at]}><Layout><div /></Layout></MemoryRouter>);
  const sidebar = [...container.querySelectorAll('aside nav a')].map(a => a.textContent.trim().replace(/\d+$/, ''));
  const tabs = [...container.querySelectorAll('nav[aria-label="Main"] a')].map(a => a.textContent.trim());
  const card = container.querySelector('aside a[href="/account"] p:last-child')?.textContent;
  return { container, sidebar, tabs, card };
}

beforeEach(() => { document.title = ''; });
afterEach(() => { cleanup(); });

const NAMES = new Set(Object.values(PAGES).map(p => p.name));

describe('Ratio Games follows the centre switch', () => {
  // Off by default: a deploy must not drop a competition into eighteen
  // sidebars. On, it is for EVERY account — the volunteer included, who
  // has no Chat and no Job Board.
  const sidebarFor = (who, config) => {
    current.auth = { ...authFor(PEOPLE[who]), centerConfig: config };
    const { container } = render(
      <MemoryRouter><Layout><div /></Layout></MemoryRouter>,
    );
    return container.textContent;
  };

  it('is absent until the centre turns it on', () => {
    expect(sidebarFor('instructor', LANGLEY)).not.toContain(PAGES.ratioGames.name);
    expect(sidebarFor('owner', LANGLEY)).not.toContain(PAGES.ratioGames.name);
  });

  it('appears for everyone once it is on, volunteers included', () => {
    const on = { ...LANGLEY, gamesEnabled: true };
    for (const who of ['owner', 'director', 'aa', 'manager', 'host', 'lead', 'instructor', 'trainee', 'volunteer']) {
      expect(sidebarFor(who, on)).toContain(PAGES.ratioGames.name);
    }
  });
});

describe('one name per page', () => {
  it.each(Object.keys(PEOPLE))('every sidebar link for %s uses its page name', (who) => {
    const { sidebar } = draw(who);
    expect(sidebar.length).toBeGreaterThan(1);
    for (const label of sidebar) expect(NAMES).toContain(label);
  });

  it('uses the same names on the phone tabs as in the sidebar', () => {
    expect(draw('instructor', { newHome: true }).tabs)
      .toEqual(['Home', 'My Schedule', 'Job Board', 'My Pay', 'Team Chat']);
  });

  it('says Staff Portal, for everyone', () => {
    for (const who of ['owner', 'instructor']) {
      const { container } = draw(who);
      expect(container.querySelector('aside').textContent).toContain(PORTAL_SUBTITLE);
      expect(container.textContent).not.toContain('Instructor Portal');
      cleanup();
    }
  });

  it('names the page in the browser tab', () => {
    draw('instructor', { at: '/shift-board' });
    expect(document.title).toBe('Job Board · Ratio');
  });
});

describe('everyone can reach a chat', () => {
  it.each(['owner', 'director', 'education', 'aa'])('%s has Chats in the sidebar', (who) => {
    expect(draw(who).sidebar).toContain('Chats');
  });

  it.each(['manager', 'host', 'lead', 'instructor', 'trainee'])('%s has Team Chat', (who) => {
    expect(draw(who).sidebar).toContain('Team Chat');
  });

  it('except a volunteer, who has no team messaging', () => {
    const { sidebar } = draw('volunteer');
    expect(sidebar).not.toContain('Team Chat');
    expect(sidebar).not.toContain('Chats');
  });
});

describe('Managers took over the Admin role', () => {
  it('a Manager off the Admin role keeps exactly the same sidebar', () => {
    const before = draw('manager').sidebar;
    cleanup();
    const after = draw('managerNow').sidebar;
    expect(after).toEqual(before);
    expect(after).toContain('Management Chat');
    expect(after).toContain('Centre Events');
    expect(after).not.toContain('Fun Days');
  });

  it('Hosts and Leads still have no Management Chat', () => {
    expect(draw('host').sidebar).not.toContain('Management Chat');
    cleanup();
    expect(draw('lead').sidebar).not.toContain('Management Chat');
  });
});

describe('job titles', () => {
  it.each([
    ['director', 'Centre Director'], ['education', 'Director of Education'], ['aa', 'Admin Assistant'],
    ['manager', 'Manager'], ['host', 'Host'], ['lead', 'Lead Instructor'], ['instructor', 'Instructor'],
    ['trainee', 'Trainee'], ['volunteer', 'Volunteer'], ['owner', 'Owner'],
  ])('%s reads "%s" under their name', (who, label) => {
    expect(draw(who).card).toBe(label);
  });

  it('keeps the Job Board from people who cannot take shifts', () => {
    expect(draw('instructor').sidebar).toContain('Job Board');
    cleanup();
    expect(draw('trainee').sidebar).not.toContain('Job Board');
    cleanup();
    expect(draw('volunteer').sidebar).not.toContain('Job Board');
  });
});

describe('the Calendar reaches management and stops there', () => {
  // Rahul's ask, in his words: owners, both directors, managers, admin
  // assistants and hosts, "and they are the only ones to see and access
  // it". The route enforces it — this is the sidebar agreeing.
  const CALENDAR = PAGES.calendar.name;

  it.each(['owner', 'director', 'education', 'aa', 'manager', 'managerNow', 'host'])(
    'is in the sidebar for %s', (who) => {
      expect(draw(who).sidebar).toContain(CALENDAR);
    });

  it.each(['lead', 'instructor', 'trainee', 'volunteer'])(
    'is not in the sidebar for %s', (who) => {
      expect(draw(who).sidebar).not.toContain(CALENDAR);
    });

  it('is not on the phone tab bar for anyone — it is a desk tool', () => {
    for (const who of ['owner', 'manager', 'host', 'instructor']) {
      expect(draw(who).tabs).not.toContain(CALENDAR);
    }
  });

  const sidebarWithConfig = (who, config) => {
    current.auth = authFor({ ...PEOPLE[who], config });
    const { container } = render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>);
    return [...container.querySelectorAll('aside nav a')].map(a => a.textContent.trim());
  };

  const HOST_WITHOUT = ['scheduler.run', 'admin.operations', 'notes.access'];

  it('disappears when a centre takes calendar.access off a role', () => {
    // A Host holds it by default. Manage Roles can remove it, and the
    // link has to follow — it asks for the permission rather than riding
    // on the operations tier the rest of that group uses.
    const sidebar = sidebarWithConfig('host', {
      ...LANGLEY,
      staffRoles: [{ name: 'Host', permissions: HOST_WITHOUT }],
      // The centre has SEEN this permission and chosen not to grant it.
      knownPermissions: [...HOST_WITHOUT, 'calendar.access'],
    });
    expect(sidebar).not.toContain(CALENDAR);
    // Still a Host: the rest of their group is untouched.
    expect(sidebar.some(x => x.startsWith(PAGES.staffSchedule.name))).toBe(true);
  });

  /**
   * Which SECTION it sits in, not just whether it is there.
   *
   * It used to be filed under SUPPLY on the owner-shaped sidebar — a
   * section about staff hours — and under MANAGE on the other one. It is
   * a daily surface, so it lives in GENERAL on both, directly above Ratio
   * Games.
   */
  const sectionsOf = (who, config) => {
    current.auth = config
      ? { ...authFor(PEOPLE[who]), centerConfig: config }
      : authFor(PEOPLE[who]);
    const { container } = render(<MemoryRouter><Layout><div /></Layout></MemoryRouter>);
    return [...container.querySelectorAll('aside nav > div')].map(d => ({
      label: d.querySelector('p')?.textContent.trim(),
      items: [...d.querySelectorAll('a')].map(a => a.textContent.trim().replace(/\d+$/, '')),
    }));
  };

  it.each(['owner', 'director', 'aa', 'manager', 'host'])(
    'sits in General for %s, on either sidebar shape', (who) => {
      const general = sectionsOf(who).find(s => s.label === 'General');
      expect(general, 'no General section').toBeTruthy();
      expect(general.items).toContain(CALENDAR);
    });

  it.each(['owner', 'director', 'aa'])('has left Supply for %s', (who) => {
    const supply = sectionsOf(who).find(s => s.label === 'Supply');
    if (supply) expect(supply.items).not.toContain(CALENDAR);
  });

  it.each(['manager', 'host'])('has left Manage for %s', (who) => {
    const manage = sectionsOf(who).find(s => s.label === 'Manage');
    if (manage) expect(manage.items).not.toContain(CALENDAR);
  });

  it('sits directly above Ratio Games when the centre has games on', () => {
    // Games are off by default, so this is the only way to see the pair.
    const general = sectionsOf('owner', { ...LANGLEY, gamesEnabled: true })
      .find(s => s.label === 'General');
    const cal = general.items.indexOf(CALENDAR);
    const games = general.items.indexOf(PAGES.ratioGames.name);
    expect(cal).toBeGreaterThan(-1);
    expect(games).toBe(cal + 1);
  });

  it('appears exactly once in the whole sidebar', () => {
    // Two entries under two gates is what this replaced.
    for (const who of ['owner', 'director', 'aa', 'manager', 'host']) {
      expect(draw(who).sidebar.filter(x => x === CALENDAR)).toHaveLength(1);
    }
  });

  it('is kept by a centre whose saved roles predate the permission', () => {
    // The additive rule in roles.js, which this feature is the first new
    // permission to exercise: a centre that edited its roles BEFORE
    // calendar.access existed never had the chance to consider it, so it
    // keeps the built-in grant rather than silently losing a page. Drop
    // this and every centre that has ever opened the role editor would
    // have shipped without the Calendar for its Hosts.
    expect(sidebarWithConfig('host', {
      ...LANGLEY,
      staffRoles: [{ name: 'Host', permissions: HOST_WITHOUT }],
      knownPermissions: HOST_WITHOUT,
    })).toContain(CALENDAR);
  });
});
