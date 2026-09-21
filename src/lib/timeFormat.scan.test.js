import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Nobody writes a thirteenth one.
 *
 * This whole module exists because twelve hand-rolled `fmtTime`s had
 * grown across the app and quietly disagreed — "3:30 PM" here, "3:30pm"
 * there, "15:30" in two places that skipped the helper altogether. The
 * fix only holds if the next person reaches for src/lib/timeFormat.js
 * instead of writing their own five-liner, so this scans for the shapes
 * that drift takes.
 *
 * ALLOWED, and why:
 *   - timeFormat.js itself, which is where the one copy lives.
 *   - PARSERS. Reading "3:00 PM" off a Radius export or an Acuity feed is
 *     the opposite direction and has nothing to do with display.
 *   - The email and export formatters, which are pinned to 12-hour on
 *     purpose: they leave the app, where the reader's preference is not
 *     ours to know.
 *   - api/, which runs on the server with no reader to ask.
 */

const ALLOWED = new Set([
  path.join('src', 'lib', 'timeFormat.js'),
  // Emails go to whoever receives them, not to the person whose
  // preference we hold — see the note at the top of timeFormat.js.
  path.join('src', 'lib', 'emailService.js'),
]);

// Building a 12-hour clock face by hand. Parsers read the other way
// ('PM' → 24h) and are matched separately below so they stay legal.
const BUILDS_AMPM = /\?\s*'(PM|pm|p)'\s*:\s*'(AM|am|a)'/;
// Asking Intl for a clock face without saying which one the reader wants.
const BARE_LOCALE_TIME = /toLocaleTimeString\((?!.*hour12)/;

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '__fixtures__'].includes(entry.name)) out.push(...sourceFiles(full));
    } else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const withoutComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
  .join('\n');

const scan = (re) => sourceFiles('src')
  .filter(f => !ALLOWED.has(f))
  .flatMap(f => withoutComments(fs.readFileSync(f, 'utf8'))
    .split('\n')
    .map((line, i) => (re.test(line) ? `${f}:${i + 1}: ${line.trim()}` : null))
    .filter(Boolean));

describe('one clock, not thirteen', () => {
  it('scans the whole app', () => {
    expect(sourceFiles('src').length).toBeGreaterThan(100);
  });

  it('nobody hand-rolls an AM/PM suffix', () => {
    expect(scan(BUILDS_AMPM)).toEqual([]);
  });

  it('nobody asks Intl for a clock face without saying which', () => {
    // hour12 is the tell: with it, the caller knows the preference exists.
    expect(scan(BARE_LOCALE_TIME)).toEqual([]);
  });
});
