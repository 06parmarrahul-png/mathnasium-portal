import { describe, it, expect } from 'vitest';
import {
  MAX_PINS, resolvePins, isPinned, canPin, togglePin, pinnedItems, fullMessage,
} from './pinnedPages';

const ITEMS = [
  { to: '/', label: 'Home' },
  { to: '/scheduler-creation', label: 'Student Scheduler' },
  { to: '/admin?tab=payroll', label: 'Manage Payroll' },
  { to: '/job-board', label: 'Job Board', badge: 3 },
  { to: '/desk', label: 'Management Desk', badge: 2 },
  { to: '/inventory', label: 'Inventory' },
];
const PATHS = ITEMS.map(i => i.to);

describe('what shows on the strip', () => {
  it('keeps the order they were pinned in', () => {
    expect(resolvePins(['/desk', '/'], PATHS)).toEqual(['/desk', '/']);
  });

  it('drops a pin to a page this person no longer has', () => {
    // Role changed, or they switched centre. The link would go nowhere.
    expect(resolvePins(['/desk', '/platform-revenue'], PATHS)).toEqual(['/desk']);
  });

  it('never shows the same pin twice', () => {
    expect(resolvePins(['/desk', '/desk'], PATHS)).toEqual(['/desk']);
  });

  it('stops at five however many are stored', () => {
    const six = ['/', '/scheduler-creation', '/admin?tab=payroll', '/job-board', '/desk', '/inventory'];
    expect(resolvePins(six, PATHS)).toHaveLength(MAX_PINS);
  });

  it('copes with nothing stored, or nonsense stored', () => {
    expect(resolvePins(undefined, PATHS)).toEqual([]);
    expect(resolvePins(null, PATHS)).toEqual([]);
    expect(resolvePins('desk', PATHS)).toEqual([]);
    expect(resolvePins([null, 42, ''], PATHS)).toEqual([]);
  });

  it('keeps a query string exactly, so the payroll tab stays the payroll tab', () => {
    expect(resolvePins(['/admin?tab=payroll'], PATHS)).toEqual(['/admin?tab=payroll']);
    expect(resolvePins(['/admin'], PATHS)).toEqual([]);
  });
});

describe('pinning and unpinning', () => {
  it('adds to the end', () => {
    expect(togglePin(['/desk'], '/inventory')).toEqual(['/desk', '/inventory']);
  });

  it('removes one that is already on', () => {
    expect(togglePin(['/desk', '/inventory'], '/desk')).toEqual(['/inventory']);
  });

  it('refuses a sixth rather than quietly dropping the oldest', () => {
    // A shortcut that vanishes on its own is worse than one you had to
    // make room for — you find out at the moment you reached for it.
    const five = ['/', '/scheduler-creation', '/admin?tab=payroll', '/job-board', '/desk'];
    expect(togglePin(five, '/inventory')).toBe(five);      // same list, untouched
    expect(canPin(five, '/inventory')).toBe(false);
    expect(fullMessage()).toMatch(/Unpin one/);
  });

  it('still lets you unpin when full', () => {
    const five = ['/', '/scheduler-creation', '/admin?tab=payroll', '/job-board', '/desk'];
    expect(canPin(five, '/desk')).toBe(true);
    expect(togglePin(five, '/desk')).toHaveLength(4);
  });

  it('starts from nothing safely', () => {
    expect(togglePin(undefined, '/desk')).toEqual(['/desk']);
    expect(togglePin(['/desk'], '')).toEqual(['/desk']);
    expect(isPinned(undefined, '/desk')).toBe(false);
  });
});

describe('the items behind the pins', () => {
  it('hands back the real sidebar item, badge and all', () => {
    // A pinned Job Board that doesn't show the open shifts is a worse
    // shortcut than no shortcut.
    const items = pinnedItems(['/job-board'], ITEMS);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Job Board');
    expect(items[0].badge).toBe(3);
  });

  it('keeps pin order, not sidebar order', () => {
    expect(pinnedItems(['/desk', '/'], ITEMS).map(i => i.label))
      .toEqual(['Management Desk', 'Home']);
  });

  it('skips a pin with no item behind it', () => {
    expect(pinnedItems(['/gone', '/desk'], ITEMS).map(i => i.label)).toEqual(['Management Desk']);
    expect(pinnedItems([], ITEMS)).toEqual([]);
    expect(pinnedItems(['/desk'], [])).toEqual([]);
  });
});
