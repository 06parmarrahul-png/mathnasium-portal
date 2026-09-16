/**
 * SlotBarChart — the Supply & Demand bar chart, as its own component.
 *
 * Lifted verbatim out of SupplyDemand.jsx so the Coverage view can be the
 * same chart rather than a second one that drifts. Both pages ask the same
 * shape of question — a value per slot, a line marking what it should be,
 * and a colour for how the two compare — they just measure different
 * things:
 *
 *   Supply & Demand   bar = students booked,      line = capacity (supply × ratio)
 *   Coverage          bar = instructors available, line = the target for that day
 *
 * So the series are named `value` and `marker` here rather than demand and
 * capacity, and the axis title and legend wording come from the caller.
 *
 * The geometry is exported because callers lay HTML out underneath the SVG
 * (target inputs, day labels) and it has to line up with the columns.
 */

import { CHART, CHART_COLORS } from '../lib/slotChart';

/**
 * @param {Array}  items      [{ label, value, marker, status }] — status is
 *                            'matched' | 'understaffed' | 'overstaffed', or
 *                            'none' for a column with nothing to compare.
 * @param {number} maxY       top of the y-axis
 * @param {number} tickStep   gap between gridlines
 * @param {string} axisTitle  rotated label on the y-axis
 * @param {object} legend     { fill, matched, under, over } wording
 */
export default function SlotBarChart({ items, maxY, tickStep, axisTitle, legend }) {
  const { W, H, PADL, PADB, PADT, PADR } = CHART;
  const { GREEN_FILL, OVER_FILL, UNDER_FILL, GREEN_LINE, UNDER_LINE, OVER_LINE } = CHART_COLORS;
  const chartW = W - PADL - PADR;
  const chartH = H - PADT - PADB;
  const barW   = (chartW / Math.max(1, items.length)) * 0.62;
  const groupW = chartW / Math.max(1, items.length);
  const yScale = (v) => PADT + chartH - (v / maxY) * chartH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Y-axis title */}
      <text x={10} y={PADT + chartH / 2} transform={`rotate(-90 10 ${PADT + chartH / 2})`} textAnchor="middle" fontSize="10" fill="#6b7280">
        {axisTitle}
      </text>
      {/* Y grid + labels */}
      {Array.from({ length: Math.ceil(maxY / tickStep) + 1 }, (_, i) => {
        const val = i * tickStep;
        if (val > maxY + tickStep) return null;
        const y = yScale(val);
        return (
          <g key={i}>
            <line x1={PADL} x2={W - PADR} y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />
            <text x={PADL - 6} y={y + 3} textAnchor="end" fontSize="10" fill="#6b7280">{val}</text>
          </g>
        );
      })}

      {items.map((r, i) => {
        const x = PADL + i * groupW + (groupW - barW) / 2;
        const hasMarker = Number.isFinite(r.marker);
        const barTopVal = hasMarker ? Math.max(r.value, r.marker) : r.value;
        const overlapVal = hasMarker ? Math.min(r.value, r.marker) : r.value;
        const barTopY   = yScale(barTopVal);
        const overlapY  = yScale(overlapVal);
        const baseY     = yScale(0);
        const barH      = baseY - barTopY;
        const greenH    = baseY - overlapY;

        // Colour scheme depends on how the mismatch resolves.
        const isOver  = r.status === 'overstaffed';
        const isUnder = r.status === 'understaffed';
        const upperFill = isOver ? OVER_FILL : (isUnder ? UNDER_FILL : 'transparent');
        const markerColor = r.status === 'matched' ? GREEN_LINE : (isUnder ? UNDER_LINE : OVER_LINE);

        return (
          <g key={i}>
            {/* Upper "mismatch" portion — spare capacity (pink) or shortfall (tan) */}
            {barTopVal !== overlapVal && (
              <rect x={x} y={barTopY} width={barW} height={overlapY - barTopY} fill={upperFill} />
            )}
            {/* Green portion = covered */}
            <rect x={x} y={overlapY} width={barW} height={greenH} fill={GREEN_FILL} />
            {/* Bar outline for visual crispness */}
            <rect x={x} y={barTopY} width={barW} height={barH} fill="none" stroke="#a3a3a3" strokeWidth="0.5" opacity="0.6" />
            {/* Marker line — what this column is measured against */}
            {hasMarker && (
              <line x1={x - 3} x2={x + barW + 3} y1={yScale(r.marker)} y2={yScale(r.marker)} stroke={markerColor} strokeWidth="2.5" />
            )}
            {/* Value above the bar */}
            <text x={x + barW / 2} y={barTopY - 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="#111827">
              {r.value}
            </text>
            {/* Column label */}
            <text x={x + barW / 2} y={H - PADB + 14} textAnchor="middle" fontSize="10" fill="#6b7280">
              {r.label}
            </text>
          </g>
        );
      })}

      {/* Legend at the bottom — matches the boss's screenshot ordering. */}
      <g transform={`translate(${PADL}, ${H - 2})`}>
        <rect x="0" y="-9" width="10" height="9" fill={GREEN_FILL} />
        <text x="14" y="-1" fontSize="10" fill="#4b5563">{legend.fill}</text>
        <line x1="130" y1="-5" x2="146" y2="-5" stroke={GREEN_LINE} strokeWidth="2.5" />
        <text x="150" y="-1" fontSize="10" fill="#4b5563">{legend.matched}</text>
        <line x1="248" y1="-5" x2="264" y2="-5" stroke={UNDER_LINE} strokeWidth="2.5" />
        <text x="268" y="-1" fontSize="10" fill="#4b5563">{legend.under}</text>
        <line x1="378" y1="-5" x2="394" y2="-5" stroke={OVER_LINE} strokeWidth="2.5" />
        <text x="398" y="-1" fontSize="10" fill="#4b5563">{legend.over}</text>
      </g>
    </svg>
  );
}
