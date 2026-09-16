/**
 * slotChart.js — geometry and palette for the Supply & Demand bar chart
 * (components/SlotBarChart.jsx).
 *
 * In their own module because callers lay HTML out underneath the SVG —
 * target inputs, day labels, status pills — and it has to line up with the
 * columns. Keeping them next to the component would also stop fast refresh
 * working on it (a component file may only export components).
 */

export const CHART = { W: 780, H: 260, PADL: 40, PADB: 32, PADT: 14, PADR: 12 };

/**
 * The palette the centre already reads on Supply & Demand. Don't recolour
 * these without changing both pages — a green bar means the same thing on
 * each, and that is the point of sharing the chart.
 */
export const CHART_COLORS = {
  GREEN_FILL: '#a7d5a3',   // the part that is covered
  OVER_FILL:  '#f8c9c9',   // spare capacity (pink)
  UNDER_FILL: '#cdb98b',   // the part that is not covered (tan)
  GREEN_LINE: '#166534',   // matched marker
  UNDER_LINE: '#ea580c',   // understaffed marker
  OVER_LINE:  '#dc2626',   // overstaffed marker
};

/** Left/right padding as a percentage, for aligning HTML under the columns. */
export const CHART_INSET = {
  left:  `${(CHART.PADL / CHART.W) * 100}%`,
  right: `${(CHART.PADR / CHART.W) * 100}%`,
};
