/**
 * slotChart.js — geometry and palette for the Supply & Demand bar chart
 * (components/SlotBarChart.jsx).
 *
 * In their own module because callers lay HTML out underneath the SVG —
 * target inputs, day labels, status pills — and it has to line up with the
 * columns. Keeping them next to the component would also stop fast refresh
 * working on it (a component file may only export components).
 */

// H and PADB dropped by 10 together when the legend came out of the SVG and
// went above it as HTML — chartH is H − PADT − PADB, so moving both by the
// same amount leaves the plot exactly where it was and only removes the
// empty band the legend used to sit in.
export const CHART = { W: 780, H: 250, PADL: 40, PADB: 22, PADT: 14, PADR: 12 };

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

/**
 * The plot area, as percentages of the chart's own width.
 *
 * The SVG scales to its container, so the axis gutter is a fixed FRACTION
 * of whatever width it gets — which is the only thing a strip of HTML
 * underneath can line itself up against. Put these on a wrapper and give
 * the strip inside `repeat(n, minmax(0, 1fr))` with NO gap, and cell i is
 * centred exactly on bar i at every width.
 *
 * WHAT NOT TO DO, because it was what was there: a row label in the first
 * column of that grid. It eats width the chart has not got, so every cell
 * after it drifts right of its bar — the wider the label, the further out.
 * Labels go ABOVE the strip. See components/SlotStrip.jsx.
 */
export const CHART_INSET = {
  left:  `${(CHART.PADL / CHART.W) * 100}%`,
  right: `${(CHART.PADR / CHART.W) * 100}%`,
};
