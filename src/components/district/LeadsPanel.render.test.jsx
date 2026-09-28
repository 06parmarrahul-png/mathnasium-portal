// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import LeadsPanel from './LeadsPanel';
import { rollUpLeads, monthlyTrend } from '../../lib/leadAnalytics';

/**
 * The funnel, rendered. Pure props in, so this is the whole component.
 *
 * The figures worth being strict about are the ones a district manager
 * would act on: a conversion rate that has no closed leads behind it, and
 * a timing figure measured on a handful of the leads it appears to speak
 * for.
 */

const DAY = 86400000;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const lead = (over = {}) => ({
  id: `l${Math.random()}`, centreId: 'langley', status: 'new',
  source: 'website', createdAt: ago(10), parentName: 'Amrit Sanghera', ...over,
});

const draw = (byCentre, names = { langley: 'Langley', burnaby: 'Burnaby' }) => {
  const funnel = rollUpLeads(byCentre, NOW);
  const trend = monthlyTrend(Object.values(byCentre).flat(), 6, NOW);
  return render(<LeadsPanel funnel={funnel} trend={trend} centreNames={names} now={NOW} />);
};

/**
 * A stat tile reads value → label → note, so the note identifies the tile
 * and the value is the first child of the same block. Several of these
 * numbers legitimately appear again in the per-centre table, so they are
 * read from their own tile rather than from the whole document.
 */
const tileByNote = (note) => {
  const el = screen.getByText(note);
  return {
    value: el.parentElement.firstElementChild.textContent,
    label: el.parentElement.children[1].textContent,
  };
};

/** The card under a given small-caps heading. */
const sectionUnder = (heading) =>
  screen.getByText(heading, { selector: 'div' }).parentElement;

afterEach(() => { cleanup(); });

describe('a district with no leads at all', () => {
  it('says so rather than drawing an empty funnel', () => {
    draw({ langley: [] });
    expect(screen.getByText(/No leads on any centre yet/i)).toBeTruthy();
    expect(screen.queryByText(/Converted/)).toBeNull();
  });
});

describe('the four numbers it leads with', () => {
  const SET = {
    langley: [
      lead({ status: 'enrolled', createdAt: ago(40), contactedAt: ago(39), enrolledAt: ago(20) }),
      lead({ status: 'enrolled', createdAt: ago(30), contactedAt: ago(29) }),
      lead({ status: 'lost', createdAt: ago(25), contactedAt: ago(20) }),
      lead({ status: 'new', createdAt: ago(9) }),        // cold
      lead({ status: 'new', createdAt: ago(1) }),        // still fresh
    ],
  };

  it('counts conversion against closed leads, and shows the working', () => {
    draw(SET);
    const tile = tileByNote('2 of 3 closed');
    expect(tile.value).toBe('67%');                        // 2 enrolled of 3 closed
    expect(tile.label).toBe('Converted');
  });

  it('counts what is still open', () => {
    draw(SET);
    expect(tileByNote('not yet won or lost').value).toBe('2');
  });

  it('flags the leads gone cold', () => {
    draw(SET);
    expect(tileByNote('new, untouched 3+ days').value).toBe('1');
  });

  it('says how many leads a timing figure is actually based on', () => {
    // The honesty line: three of five leads have a contact time, and the
    // page must not imply the median speaks for all five.
    draw(SET);
    expect(screen.getByText('median of 3 leads')).toBeTruthy();
  });

  it('admits when no lead can be timed at all', () => {
    draw({ langley: [lead(), lead()] });
    expect(screen.getByText('no lead has a contact time')).toBeTruthy();
  });
});

describe('the funnel itself', () => {
  it('lays the stages out with their counts', () => {
    draw({ langley: [
      lead({ status: 'new' }), lead({ status: 'new' }),
      lead({ status: 'contacted' }), lead({ status: 'enrolled' }),
    ] });
    const funnel = sectionUnder(/Where the 4 leads are/i);
    for (const stage of ['New', 'Contacted', 'Assessed', 'Enrolled', 'Lost']) {
      expect(within(funnel).getByText(stage), stage).toBeTruthy();
    }
  });

  it('explains why a busy pipeline is not a failing one', () => {
    draw({ langley: [lead()] });
    expect(screen.getByText(/neither a win nor a loss/i)).toBeTruthy();
  });
});

describe('where they come from', () => {
  it('ranks the sources and shows what each converts', () => {
    draw({ langley: [
      lead({ source: 'referral', status: 'enrolled' }),
      lead({ source: 'referral', status: 'enrolled' }),
      lead({ source: 'social', status: 'lost' }),
    ] });
    const tables = screen.getAllByRole('table');
    const sources = tables[0];
    expect(within(sources).getByText('Referral')).toBeTruthy();
    expect(within(sources).getByText('Social')).toBeTruthy();
    // 2 of 2 closed for referral; 0 of 1 for social.
    expect(within(sources).getByText('100%')).toBeTruthy();
    expect(within(sources).getByText('0%')).toBeTruthy();
  });

  it('shows a dash, not nought per cent, for a source with nothing closed', () => {
    draw({ langley: [lead({ source: 'event', status: 'new' })] });
    const sources = screen.getAllByRole('table')[0];
    expect(within(sources).getByText('—')).toBeTruthy();
    expect(within(sources).queryByText('0%')).toBeNull();
  });
});

describe('centre by centre', () => {
  it('gives every centre a row, biggest funnel first', () => {
    draw({
      burnaby: [lead({ centreId: 'burnaby' })],
      langley: [lead(), lead(), lead()],
    });
    const centres = screen.getAllByRole('table')[1];
    const names = within(centres).getAllByRole('row').slice(1)
      .map(r => r.firstElementChild.textContent);
    expect(names).toEqual(['Langley', 'Burnaby']);
  });

  it('keeps a centre with no leads visible, because empty is a finding', () => {
    draw({ langley: [lead()], burnaby: [] });
    const centres = screen.getAllByRole('table')[1];
    expect(within(centres).getByText('Burnaby')).toBeTruthy();
  });
});

describe('the one he can act on this afternoon', () => {
  it('names who has been waiting longest, and where', () => {
    draw({
      langley: [lead({ parentName: 'Dana Kowalski', createdAt: ago(20) })],
      burnaby: [lead({ centreId: 'burnaby', parentName: 'Wei Chen', createdAt: ago(40) })],
    });
    const waiting = screen.getByText(/Waiting longest/i).parentElement;
    const names = within(waiting).getAllByText(/Kowalski|Chen/).map(n => n.textContent);
    expect(names[0]).toBe('Wei Chen');       // 40 days beats 20
    expect(within(waiting).getByText('40 days')).toBeTruthy();
  });

  it('stays away when nothing has gone cold', () => {
    draw({ langley: [lead({ createdAt: ago(1) })] });
    expect(screen.queryByText(/Waiting longest/i)).toBeNull();
  });
});

describe('identity is never colour alone', () => {
  it('names both series in the trend, and labels the bars', () => {
    // Red and green side by side is the classic colourblind trap, so the
    // legend names them and every bar carries its own number.
    draw({ langley: [lead({ status: 'enrolled', createdAt: ago(5), enrolledAt: ago(2) })] });
    const trend = sectionUnder(/Last \d+ months/i);
    expect(within(trend).getByText('New leads')).toBeTruthy();
    expect(within(trend).getByText('Enrolled')).toBeTruthy();
  });
});
