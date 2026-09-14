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
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => current.auth }));

const { default: Layout } = await import('./Layout');
const { resolveRoles, resolvePermissions } = await import('../lib/roles');
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

function authFor({ role, title, volunteer = false }) {
  const roles = resolveRoles(LANGLEY, () => '#999');
  const permissions = resolvePermissions({ platformRole: role, instructorType: title, isVolunteer: volunteer, roles });
  const isDirector = role === 'director';
  return {
    profile: { uid: `u-${title}`, displayName: 'Sam Lee', role },
    activeCenterId: 'langley', centerConfig: LANGLEY, mySubRoles: ['Elementary'], logout: () => {},
    isSuperAdmin: role === 'super_admin', isOwner: role === 'owner', isDirector,
    isAdminAssistant: role === 'admin_assistant', isAdmin: role === 'admin',
    isOwnerLike: ['owner', 'admin_assistant', 'super_admin'].includes(role) || isDirector,
    isLead: title === 'Lead', isVolunteer: volunteer,
    canTakeShifts: permissions.has('shifts.take'), canSeeAdminPanel: permissions.has('admin.panel'),
    canManageOperations: permissions.has('admin.operations'), permissions, myInstructorType: title,
  };
}

const PEOPLE = {
  owner:     { role: 'owner', title: 'Instructor' },
  director:  { role: 'director', title: 'Center Director' },
  education: { role: 'director', title: 'Dir. of Education' },
  aa:        { role: 'admin_assistant', title: 'Admin' },
  manager:   { role: 'admin', title: 'Manager' },
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
