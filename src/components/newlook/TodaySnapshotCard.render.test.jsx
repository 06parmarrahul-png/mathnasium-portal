// @vitest-environment jsdom
import React from 'react';   // this file is transformed with the classic JSX runtime
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

afterEach(() => { cleanup(); });

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
