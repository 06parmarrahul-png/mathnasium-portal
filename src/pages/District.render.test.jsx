// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The district roll-up, rendered.
 *
 * The behaviour worth being strict about is not the layout — it is that a
 * centre which never reported is never counted as a zero. A district
 * manager acting on a total that silently dropped two centres is the exact
 * failure that got the previous leadership board deleted.
 */

const DAY = 86400000;

// Firestore, routed by what is being asked for. Docs and collections are
// answered separately so a test cannot pass by handing every listener the
// same rows.
const docs = {};          // 'centers/langley/config/main' -> data
const collections = {};   // 'shifts|langley|2026-10-01' -> rows

vi.mock('../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (...a) => ({ __c: a[1] }),
  doc: (...a) => ({ __d: a.slice(1).join('/') }),
  query: (c, ...clauses) => ({ ...c, __q: clauses.map(x => x.__w).filter(Boolean) }),
  where: (field, op, value) => ({ __w: `${field}:${Array.isArray(value) ? value.join(',') : value}` }),
  onSnapshot: (ref, next) => {
    if (typeof next !== 'function') return () => {};
    if (ref.__d !== undefined) {
      const data = docs[ref.__d];
      next({ exists: () => data !== undefined, data: () => data });
    } else {
      const key = [ref.__c, ...(ref.__q || [])].join('|');
      const rows = collections[key] || [];
      next({ docs: rows.map((r, i) => ({ id: r.id || `d${i}`, data: () => r })) });
    }
    return () => {};
  },
}));

const authValue = { current: {} };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authValue.current,
  useOptionalAuth: () => authValue.current,
}));

const { default: District } = await import('./District');

const TODAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const authFor = (centerIds, perms = ['district.view']) => ({
  profile: { uid: 'michelle', displayName: 'Michelle Katz', centerIds },
  can: (id) => perms.includes(id),
});

const vitals = (over = {}) => ({
  activeStudents: 120, inactiveStudents: 30, onHoldStudents: 8,
  monthlyRevenue: 48000, updatedAt: Date.now() - 3 * DAY, updatedByName: 'Neeru',
  ...over,
});

const centre = (name, over = {}) => ({
  name, city: name, province: 'British Columbia', vitals: vitals(), ...over,
});

/** Put a centre's config in place, and (optionally) its live rows. */
const seed = (id, config, { shifts = [], open = [] } = {}) => {
  docs[`centers/${id}`] = { name: config.name, city: config.city, province: config.province };
  docs[`centers/${id}/config/main`] = config;
  collections[`shifts|centerId:${id}|date:${TODAY}`] = shifts;
  collections[`openShifts|centerId:${id}`] = open;
};

const draw = (centerIds, perms) => {
  authValue.current = authFor(centerIds, perms);
  return render(<MemoryRouter><District /></MemoryRouter>);
};

beforeEach(() => {
  for (const k of Object.keys(docs)) delete docs[k];
  for (const k of Object.keys(collections)) delete collections[k];
  collections['users|centerIds:langley,burnaby'] = [];
});
afterEach(() => { cleanup(); });

describe('who may open it', () => {
  it('turns away an account without the permission', () => {
    draw(['langley'], []);
    expect(screen.getByText(/Not your page/i)).toBeTruthy();
  });

  it('says so plainly when the account has no centres on it', () => {
    draw([], ['district.view']);
    expect(screen.getByText(/No centres on this account/i)).toBeTruthy();
  });
});

describe('the roll-up', () => {
  it('adds up the centres that reported', () => {
    seed('langley', centre('Langley'));
    seed('burnaby', centre('Burnaby', { vitals: vitals({ activeStudents: 80, monthlyRevenue: 31000 }) }));
    draw(['burnaby', 'langley']);
    expect(screen.getByText('200')).toBeTruthy();            // 120 + 80 active
    expect(screen.getByText('$79,000')).toBeTruthy();        // 48000 + 31000
    expect(screen.getByText('2 of 2 reporting')).toBeTruthy();
  });

  it('never counts a silent centre as a zero', () => {
    // The whole reason this page exists in the shape it does.
    seed('langley', centre('Langley'));
    seed('burnaby', { name: 'Burnaby', province: 'British Columbia' });   // never entered anything
    draw(['burnaby', 'langley']);
    // 120 twice: once as Langley's row, once as the district total. That
    // the total EQUALS the one reporting centre is the assertion — a
    // silent centre added nothing, and did not drag it to 120 + 0.
    expect(screen.getAllByText('120')).toHaveLength(2);
    expect(screen.getByText('1 of 2 reporting')).toBeTruthy();
    expect(screen.queryByText('2 of 2 reporting')).toBeNull();
  });

  it('shows a dash, not a nought, for a figure nobody reported', () => {
    seed('langley', centre('Langley', {
      vitals: { activeStudents: 40, updatedAt: Date.now() - DAY },
    }));
    draw(['langley']);
    const cells = screen.getAllByText('—');
    expect(cells.length).toBeGreaterThan(0);                 // inactive / hold / revenue
    expect(screen.queryByText('$0')).toBeNull();
  });

  it('names the district when every centre agrees on a province', () => {
    seed('langley', centre('Langley'));
    seed('burnaby', centre('Burnaby'));
    draw(['burnaby', 'langley']);
    expect(screen.getByText('British Columbia')).toBeTruthy();
  });

  it('invents no label for a mixed set', () => {
    seed('langley', centre('Langley'));
    seed('burnaby', centre('Burnaby', { province: 'Alberta' }));
    draw(['burnaby', 'langley']);
    expect(screen.getByText('Your centres')).toBeTruthy();
  });
});

describe('what needs him', () => {
  it('counts shifts nobody has taken, and says where', () => {
    seed('langley', centre('Langley'), {
      open: [{ status: 'open', date: TODAY }, { status: 'open', date: TODAY }],
      shifts: [{ status: 'published' }],
    });
    draw(['langley']);
    expect(screen.getByText(/2 shifts nobody has taken/)).toBeTruthy();
    expect(screen.getByText(/Langley \(2\)/)).toBeTruthy();
  });

  it('ignores an open shift already claimed, or in the past', () => {
    seed('langley', centre('Langley'), {
      open: [{ status: 'claimed', date: TODAY }, { status: 'open', date: '2020-01-01' }],
      shifts: [{ status: 'published' }],
    });
    draw(['langley']);
    expect(screen.queryByText(/shifts nobody has taken/)).toBeNull();
  });

  it('flags a centre with nobody rostered today', () => {
    seed('langley', centre('Langley'), { shifts: [] });
    draw(['langley']);
    expect(screen.getByText(/1 centre with nobody rostered today/)).toBeTruthy();
  });

  it('does not count a draft as somebody being on the floor', () => {
    seed('langley', centre('Langley'), { shifts: [{ status: 'draft' }] });
    draw(['langley']);
    expect(screen.getByText(/nobody rostered today/)).toBeTruthy();
  });

  it('chases the centres that have never reported', () => {
    seed('langley', centre('Langley'), { shifts: [{ status: 'published' }] });
    seed('burnaby', { name: 'Burnaby' }, { shifts: [{ status: 'published' }] });
    draw(['burnaby', 'langley']);
    expect(screen.getByText(/1 centre have never reported their numbers|1 centre has never/i)).toBeTruthy();
  });

  it('chases a figure that has gone stale', () => {
    seed('langley', centre('Langley', { vitals: vitals({ updatedAt: Date.now() - 90 * DAY }) }),
      { shifts: [{ status: 'published' }] });
    draw(['langley']);
    expect(screen.getByText(/overdue an update/)).toBeTruthy();
    // Said twice on purpose: once while chasing it, once beside the centre.
    expect(screen.getAllByText(/as of 3 months ago/).length).toBeGreaterThan(0);
  });

  it('is quiet when there is genuinely nothing to raise', () => {
    seed('langley', centre('Langley'), { shifts: [{ status: 'published' }] });
    draw(['langley']);
    expect(screen.getByText(/Nothing standing out/)).toBeTruthy();
  });
});

describe('centre by centre', () => {
  it('gives each centre a row with its own figures', () => {
    seed('langley', centre('Langley'));
    seed('burnaby', centre('Burnaby', { vitals: vitals({ activeStudents: 80 }) }));
    draw(['burnaby', 'langley']);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Langley')).toBeTruthy();
    expect(within(table).getByText('Burnaby')).toBeTruthy();
  });

  it('marks a centre that has never sent figures', () => {
    seed('langley', { name: 'Langley' }, { shifts: [{ status: 'published' }] });
    draw(['langley']);
    expect(screen.getByText('no figures')).toBeTruthy();
  });

  it('writes nothing — every control on the page is a read', () => {
    seed('langley', centre('Langley'));
    const { container } = draw(['langley']);
    expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
