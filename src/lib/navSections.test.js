import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  navKey, readCollapsed, writeCollapsed, toggleCollapsed,
  isSectionOpen, rollUpBadge, sectionHasActive,
} from './navSections';

const store = new Map();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('remembering what is collapsed', () => {
  it('starts with everything open', () => {
    expect(readCollapsed('u1').size).toBe(0);
  });

  it('remembers per person', () => {
    toggleCollapsed('u1', 'Intelligence');
    expect(readCollapsed('u1').has('Intelligence')).toBe(true);
    expect(readCollapsed('u2').has('Intelligence')).toBe(false);
    expect(navKey('u1')).not.toBe(navKey('u2'));
  });

  it('toggles back open', () => {
    toggleCollapsed('u1', 'Centre');
    toggleCollapsed('u1', 'Centre');
    expect(readCollapsed('u1').size).toBe(0);
  });

  it('STORES THE CLOSED ONES, so a new section arrives open', () => {
    // The other way round, a section added in a later release would be
    // invisible to everybody who had ever saved a preference — and nobody
    // reports that, they just never find the feature.
    writeCollapsed('u1', new Set(['Intelligence']));
    expect(store.get(navKey('u1'))).toBe('["Intelligence"]');
    expect(isSectionOpen({ label: 'A Brand New Section', index: 3, collapsed: readCollapsed('u1') }))
      .toBe(true);
  });

  it('survives junk in storage rather than throwing', () => {
    store.set(navKey('u1'), 'not json');
    expect(() => readCollapsed('u1')).not.toThrow();
    expect(readCollapsed('u1').size).toBe(0);
    store.set(navKey('u1'), '{"nope":1}');
    expect(readCollapsed('u1').size).toBe(0);
    store.set(navKey('u1'), '[1,2,null]');
    expect(readCollapsed('u1').size).toBe(0);
  });

  it('survives storage being blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => readCollapsed('u1')).not.toThrow();
    expect(() => toggleCollapsed('u1', 'Centre')).not.toThrow();
  });
});

describe('which sections are open', () => {
  const collapsed = new Set(['Intelligence', 'Centre', 'General']);

  it('honours the preference', () => {
    expect(isSectionOpen({ label: 'Intelligence', index: 2, collapsed })).toBe(false);
    expect(isSectionOpen({ label: 'Growth', index: 1, collapsed })).toBe(true);
  });

  it('KEEPS THE FIRST SECTION OPEN whatever the preference says', () => {
    // A sidebar whose top section is shut looks broken.
    expect(isSectionOpen({ label: 'General', index: 0, collapsed })).toBe(true);
  });

  it('KEEPS THE SECTION YOU ARE STANDING IN OPEN', () => {
    // Otherwise the sidebar has nothing highlighted and no clue where you
    // are — the one moment collapsing actively hurts.
    expect(isSectionOpen({ label: 'Centre', index: 4, collapsed, hasActive: true })).toBe(true);
  });

  it('copes with no preference at all', () => {
    expect(isSectionOpen({ label: 'Centre', index: 4 })).toBe(true);
  });
});

describe('collapsing must not silence a badge', () => {
  it('rolls the counts up to the header', () => {
    // Open shifts and the Desk are the whole reason somebody looks.
    expect(rollUpBadge([{ badge: 3 }, { badge: 2 }, {}])).toBe(5);
  });

  it('is zero when there is nothing to say', () => {
    expect(rollUpBadge([{}, { badge: 0 }])).toBe(0);
    expect(rollUpBadge([])).toBe(0);
    expect(rollUpBadge(undefined)).toBe(0);
  });

  it('ignores junk rather than rendering NaN', () => {
    expect(rollUpBadge([{ badge: 'lots' }, { badge: -2 }, { badge: 4 }])).toBe(4);
  });
});

describe('finding the section you are in', () => {
  const items = [{ to: '/a' }, { to: '/b' }];

  it('spots it', () => {
    expect(sectionHasActive(items, (i) => i.to === '/b')).toBe(true);
    expect(sectionHasActive(items, (i) => i.to === '/zzz')).toBe(false);
  });

  it('does not let a broken matcher take the sidebar down', () => {
    expect(() => sectionHasActive(items, () => { throw new Error('nope'); })).not.toThrow();
    expect(sectionHasActive(items, () => { throw new Error('nope'); })).toBe(false);
  });

  it('copes with an empty section', () => {
    expect(sectionHasActive([], () => true)).toBe(false);
    expect(sectionHasActive(undefined, () => true)).toBe(false);
  });
});
