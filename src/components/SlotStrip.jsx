/**
 * SlotStrip — a row of cells that lines up with SlotBarChart's bars.
 *
 * Both pages under the chart were drawn as a `table-fixed` whose FIRST
 * column held the row's label ("Ratio status", "Impact", "Target"). A
 * fixed-width label column inside the same track list steals width the
 * chart's own columns do not lose, so every cell sat a little right of the
 * bar it described — and the wider the label, the further out. On Supply &
 * Demand the label column was 90px; on Coverage it was 96px. At a 900px
 * card that is a full half-column of drift by the right-hand edge.
 *
 * So the label goes ABOVE the row and the cells get the plot area to
 * themselves: the wrapper carries the chart's own left/right inset, and the
 * grid is n equal columns with NO gap — cell i is then centred on bar i at
 * every width, because both are (i + ½) of the same span. Spacing between
 * pills is padding INSIDE each cell, which does not move its centre; a
 * `gap` would, by up to half a gap at the ends.
 *
 * It also stops scrolling on its own. The strip used to sit in an
 * `overflow-x-auto` while the chart above it did not, so on a narrow screen
 * the two could be scrolled out of step with each other — an alignment that
 * silently comes apart is worse than one that is merely tight.
 */

import { CHART_INSET } from '../lib/slotChart';

/**
 * @param {string} label   what this row is, above it
 * @param {string} hint    smaller second line under the label
 * @param {number} count   how many columns the chart is drawing
 */
export default function SlotStrip({ label, hint, count, children }) {
  return (
    <div style={{ paddingLeft: CHART_INSET.left, paddingRight: CHART_INSET.right }}>
      {label && (
        <p className="mb-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">
          {label}
          {hint && (
            <span className="ml-1.5 font-normal normal-case tracking-normal text-gray-400">{hint}</span>
          )}
        </p>
      )}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
        {children}
      </div>
    </div>
  );
}
