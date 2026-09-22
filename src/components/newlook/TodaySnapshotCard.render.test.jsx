// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import TodaySnapshotCard from './TodaySnapshotCard';

/**
 * The geometry of Today's Snapshot.
 *
 * Written after the grid shipped with its hour labels half a column right
 * of the bars they were labelling. Three things are placed horizontally —
 * the labels, the rules and the bars — and each was positioned its own way,
 * so nothing lined up with anything:
 *
 *   - labels were centred on the MIDDLE of each hour, so "10a" drew at 10:30
 *   - the rules layer measured from the parent's padding edge while the
 *     rows sat inside its px-4, leaving them 16px adrift and 32px too wide
 *
 * Both are arithmetic, and arithmetic can be asserted. These tests read the
 * inline left/width off the DOM and check the three agree.
 */

const shift = (over = {}) => ({
  id: 's1', userName: 'Rachel Rozelle', centerId: 'langley',
  role: 'Admin', subRole: null, date: '2026-09-21',
  startTime: '10:00', endTime: '14:00', status: 'published', ...over,
});

// 10:00 → 19:30, so the axis spans 570 minutes and every position below is
// a round number: 10a sits at 0%, and each hour is 6000/570 % wide.
const A_DAY = [
  shift(),
  shift({ id: 's2', userName: 'Neeru Gill', role: 'Dir. of Education', startTime: '11:00', endTime: '19:30' }),
  shift({ id: 's3', userName: 'Homer Ayuste', role: 'Instructor', subRole: 'Highschool', startTime: '15:00', endTime: '19:00' }),
];

const draw = (shifts = A_DAY) => render(
  <MemoryRouter>
    <TodaySnapshotCard shifts={shifts} volunteerNames={new Set()}
      centerConfig={{ name: 'Langley' }} dateISO="2026-09-21" />
  </MemoryRouter>,
);

/** The inline `left` of an hour label, as a number of percent. */
const labelLeft = (text) => parseFloat(screen.getByText(text).style.left);

/**
 * The inline left/width of the bar in the row that shows `name`.
 *
 * closest('div.flex') lands on the NAME CELL — it is itself a flex box —
 * so the row is one step above it. The bar is the only thing in the row
 * carrying an inline `left`.
 */
const barBox = (name) => {
  const row = screen.getByText(name).closest('div.flex').parentElement;
  const bar = row.querySelector('div[style*="left"]');
  return { left: parseFloat(bar.style.left), width: parseFloat(bar.style.width) };
};

afterEach(() => {
  cleanup();
  try { localStorage.clear(); } catch { /* not every environment has it */ }
});

// 570 minutes across the track; one hour is this many percent.
const HOUR = (60 / 570) * 100;

describe('the hour labels sit on their own hour', () => {
  it('puts the opening hour at the very start of the track', () => {
    draw();
    expect(labelLeft('10a')).toBeCloseTo(0, 5);
  });

  it('spaces each label exactly one hour from the last', () => {
    draw();
    expect(labelLeft('11a')).toBeCloseTo(HOUR, 5);
    expect(labelLeft('12p')).toBeCloseTo(HOUR * 2, 5);
    expect(labelLeft('3p')).toBeCloseTo(HOUR * 5, 5);
  });

  it('labels the closing hour too', () => {
    // 19:30 close, so 7p is the last tick and it is inside the track.
    draw();
    expect(labelLeft('7p')).toBeCloseTo(HOUR * 9, 5);
  });
});

describe('a bar starts where its own hour label is', () => {
  it('lines a 10:00 start up with 10a', () => {
    draw();
    expect(barBox('Rachel Rozelle').left).toBeCloseTo(labelLeft('10a'), 5);
  });

  it('lines an 11:00 start up with 11a', () => {
    draw();
    expect(barBox('Neeru Gill').left).toBeCloseTo(labelLeft('11a'), 5);
  });

  it('lines a 3:00 start up with 3p', () => {
    draw();
    expect(barBox('Homer Ayuste').left).toBeCloseTo(labelLeft('3p'), 5);
  });

  it('gives a four-hour shift four hours of width', () => {
    draw();
    expect(barBox('Rachel Rozelle').width).toBeCloseTo(HOUR * 4, 5);
  });

  it('runs the closing shift to the end of the track', () => {
    draw();
    const { left, width } = barBox('Neeru Gill');
    expect(left + width).toBeCloseTo(100, 5);
  });
});

describe('a day that does not start on the hour', () => {
  // The old rules layer tiled from its own left edge, so on a day opening
  // at 10:30 it drew its darker "hour" rules at 10:30, 11:30, 12:30…
  const OFF_HOUR = [shift({ startTime: '10:30', endTime: '13:00' })];

  it('still puts 11a one half hour in, not at the left edge', () => {
    draw(OFF_HOUR);
    // Axis 10:30 → 13:00 is 150 minutes; 11:00 is 30 of them in.
    expect(labelLeft('11a')).toBeCloseTo((30 / 150) * 100, 5);
  });

  it('starts the bar at the edge, ahead of the first label', () => {
    draw(OFF_HOUR);
    expect(barBox('Rachel Rozelle').left).toBeCloseTo(0, 5);
    expect(labelLeft('11a')).toBeGreaterThan(0);
  });
});

describe('what the band no longer carries', () => {
  it('has dropped the half-hour bar strip', () => {
    draw();
    expect(screen.queryByText(/Instructors on the floor/)).toBeNull();
    expect(screen.queryByText(/Right now/)).toBeNull();
  });

  it('still shows the headline figures it replaced nothing of', () => {
    draw();
    expect(screen.getByText('3 on today')).toBeTruthy();
    expect(screen.getByText(/10:00 AM – 7:30 PM/)).toBeTruthy();
  });
});

describe('the group headings divide the tiers', () => {
  /**
   * "IN-CENTRE INSTRUCTORS · 10" is wider than the 178px name column, so it
   * ran out over the first column rule and read as a line of text lying
   * across the grid. The heading is a tinted band now, lifted above the
   * rules layer so nothing shows through it.
   */
  const headingFor = (label) => [...document.querySelectorAll('div')]
    .find(d => d.className.includes('border-y') && d.textContent.trim().startsWith(label));

  // A_DAY has management and in-centre only; add an online instructor so
  // all three headings the grid actually shows are under test.
  const THREE_TIERS = [...A_DAY, shift({
    id: 's4', userName: 'Krishnaja Tikkisetty',
    role: 'Instructor', subRole: 'Online', startTime: '15:00', endTime: '19:00',
  })];

  it('gives every tier heading a band, not just a line of text', () => {
    draw(THREE_TIERS);
    for (const label of ['Hosts & Management', 'Online Instructors', 'In-Centre Instructors']) {
      const row = headingFor(label);
      expect(row, label).toBeTruthy();
      expect(row.style.background).toBe('var(--nl-raised)');
    }
  });

  it('lifts the band over the rules so none run through the heading', () => {
    draw(THREE_TIERS);
    // z-0 is the rules layer; the heading has to sit above it.
    expect(headingFor('In-Centre Instructors').className).toContain('z-[1]');
  });

  it('counts the people in each tier', () => {
    draw(THREE_TIERS);
    expect(headingFor('Hosts & Management').textContent).toContain('· 2');
    expect(headingFor('Online Instructors').textContent).toContain('· 1');
    expect(headingFor('In-Centre Instructors').textContent).toContain('· 1');
  });
});

describe('the hour labels stay inside their own row', () => {
  /**
   * They were absolutely positioned with no `top`, so they fell to the
   * static position and hung below a 24px row — where the opaque group
   * band clipped the descenders off "12p" and "7p". jsdom has no layout
   * to measure, but the anchor that keeps them in the row is assertable.
   */
  it('anchors every label to the middle of the row', () => {
    draw();
    for (const t of ['10a', '12p', '7p']) {
      const el = screen.getByText(t);
      expect(el.style.top, t).toBe('50%');
      expect(el.style.transform, t).toContain('-50%');
    }
  });

  it('still pulls the two end labels inward rather than centring them', () => {
    draw();
    expect(screen.getByText('10a').style.transform).toBe('translate(0, -50%)');
    expect(screen.getByText('7p').style.transform).toBe('translate(-50%, -50%)');
  });
});

describe('the times beside each row', () => {
  /**
   * They read "11–7:30" and "12:30–6:45": no meridiem, and the :00 dropped
   * on the hour, so "3–7" could as easily have been the morning. They go
   * through the shared formatter now, which means they also follow whoever
   * is reading — a 24-hour account sees "11:00 – 19:30" instead.
   */
  it('spells both ends out, with AM and PM', () => {
    draw();
    expect(screen.getByText('10:00 AM – 2:00 PM')).toBeTruthy();   // Rachel, 10–14
    expect(screen.getByText('11:00 AM – 7:30 PM')).toBeTruthy();   // Neeru, 11–19:30
    expect(screen.getByText('3:00 PM – 7:00 PM')).toBeTruthy();    // Homer, 15–19
  });

  it('keeps the minutes on a half-hour shift', () => {
    draw([shift({ startTime: '12:30', endTime: '18:45' })]);
    expect(screen.getByText('12:30 PM – 6:45 PM')).toBeTruthy();
  });
});

describe('folding the grid away', () => {
  const toggle = () => screen.getByRole('button', { name: /hide|show/i });

  it('opens by default — the grid is the card', () => {
    draw();
    expect(toggle()).toHaveProperty('ariaExpanded', 'true');
    expect(screen.getByText('Rachel Rozelle')).toBeTruthy();
  });

  it('puts the rows away, keeping the headline that answers "are we covered"', () => {
    draw();
    fireEvent.click(toggle());
    expect(screen.queryByText('Rachel Rozelle')).toBeNull();
    expect(screen.getByText('3 on today')).toBeTruthy();
    expect(toggle().textContent).toMatch(/show/i);
  });

  it('brings them back', () => {
    draw();
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(screen.getByText('Rachel Rozelle')).toBeTruthy();
    expect(toggle().textContent).toMatch(/hide/i);
  });

  it('remembers the choice for next time', () => {
    draw();
    fireEvent.click(toggle());
    cleanup();
    draw();
    expect(toggle()).toHaveProperty('ariaExpanded', 'false');
    expect(screen.queryByText('Rachel Rozelle')).toBeNull();
  });

  it('names the thing it controls, for anyone not using a mouse', () => {
    draw();
    const id = toggle().getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id)).toBeTruthy();
  });
});
