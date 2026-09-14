import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PAGES, pageNameFor, documentTitleFor } from './pageNames';

describe('pageNameFor — the browser tab', () => {
  it('names the page from its path', () => {
    expect(pageNameFor('/shift-board')).toBe('Job Board');
    expect(pageNameFor('/scheduler-creation')).toBe('Student Scheduler');
    expect(pageNameFor('/account')).toBe('My Account');
    expect(pageNameFor('/notifications')).toBe('Notifications');
  });

  it('treats the three Admin tabs as the three pages people know them as', () => {
    expect(pageNameFor('/admin', '?tab=spreadsheet')).toBe('Manage Staff Schedule');
    expect(pageNameFor('/admin', '?tab=scheduler')).toBe('Manage Staff Schedule');
    expect(pageNameFor('/admin', '?tab=users')).toBe('Manage Staff');
    expect(pageNameFor('/admin', '?tab=payroll')).toBe('Manage Payroll');
    expect(pageNameFor('/admin', '')).toBe('Manage Staff Schedule');
  });

  it('tells Management Chat from Owner Chat, and covers analytics sub-pages', () => {
    expect(pageNameFor('/platform-chat')).toBe('Management Chat');
    expect(pageNameFor('/platform-chat', '?view=owners')).toBe('Owner Chat');
    expect(pageNameFor('/center-analytics/retention')).toBe('Centre Analytics');
  });

  it('says only "Ratio" for a page it has no name for', () => {
    expect(pageNameFor('/nowhere')).toBeNull();
    expect(documentTitleFor('/nowhere')).toBe('Ratio');
    expect(documentTitleFor('/my-pay')).toBe('My Pay · Ratio');
  });

  it('never gives two different pages the same name', () => {
    const byName = {};
    for (const p of Object.values(PAGES)) (byName[p.name] ||= new Set()).add(p.path.split('?')[0] + (p.path.includes('view=') ? '?owners' : ''));
    for (const [name, paths] of Object.entries(byName)) expect([name, paths.size]).toEqual([name, 1]);
  });
});

/**
 * Retired names must not come back.
 *
 * Every one of these was on screen somewhere, naming a page that is called
 * something else in the sidebar. Comments are allowed to mention them (a
 * lot of history lives in comments); anything a person can read is not.
 */
const RETIRED = [
  'Shift Board', 'Job board', 'Scheduler Creation', 'Notification Preferences', 'Manage Users',
  'Instructor Portal', 'Mathnasium Portal', 'Staffing Supply', 'Account Details', 'Centre Chat',
  'Welcome back', 'Admin Panel', 'Center Settings', 'center owner', 'Multi-Center', 'multi-center migration',
  'Instructor Account', 'Staff Scheduling',
];

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', '__fixtures__'].includes(entry.name)) out.push(...sourceFiles(full)); }
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

// Block comments (JS and JSX), then `// …` line comments — but not the
// `//` inside "https://".
const withoutComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
  .join('\n');

describe('retired page names', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('api')];

  it('scans the whole app', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(RETIRED)('"%s" is not on screen anywhere', (phrase) => {
    const hits = files.flatMap(f => withoutComments(fs.readFileSync(f, 'utf8'))
      .split('\n')
      .map((line, i) => (line.includes(phrase) ? `${f}:${i + 1}: ${line.trim()}` : null))
      .filter(Boolean));
    expect(hits).toEqual([]);
  });
});
