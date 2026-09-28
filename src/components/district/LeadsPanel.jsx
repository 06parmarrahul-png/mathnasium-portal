import { Card, Lbl, Pill, AllClear } from '../newlook/ui';
import {
  FUNNEL_ORDER, asPercent, asDays, byAge, CHASE_AFTER_DAYS,
} from '../../lib/leadAnalytics';
import { LEAD_STATUS_LABELS, LEAD_SOURCE_LABELS } from '../../lib/leads';

/**
 * The lead funnel across a district.
 *
 * PURE — every figure arrives as a prop. The page does the reading; this
 * does the showing, which is also what makes it something you can put in
 * front of a browser on its own.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THESE FORMS.
 *
 *   Conversion, pipeline, gone-cold, time-to-contact are single numbers
 *   and are shown as numbers. A chart of one value is decoration.
 *
 *   The funnel is one measure across four ordered stages, so it is one
 *   hue, not four — colouring the stages differently would imply they are
 *   unrelated categories rather than the same people moving along.
 *
 *   The trend is the only place with two series, so it is the only place
 *   with a legend, and both series are also labelled directly.
 *
 *   Sources are a table, not a pie. A pie cannot be read for rank, which
 *   is the entire question ("which source actually converts").
 *
 * The two series colours were checked with the palette validator rather
 * than chosen by eye: the design system's own --nl-ok is below the chroma
 * floor at mark size and reads grey, so the green here is a step up in
 * chroma from it. Red/green alone would be a colourblind trap, so every
 * bar is also directly labelled and the legend names both.
 * ═══════════════════════════════════════════════════════════════════════
 */

const CREATED = '#C8102E';   // validated pair: ΔE 31.0 normal, 9.6 deutan
const ENROLLED = '#0F8A5F';

/** A stage of the funnel: one bar, its own label, no colour-coding games. */
function FunnelRow({ label, count, of, note }) {
  const pct = of > 0 ? Math.round((count / of) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-[88px] shrink-0 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>{label}</div>
      <div className="relative h-[18px] min-w-0 flex-1 rounded-[4px]" style={{ background: 'var(--nl-raised)' }}>
        <div className="h-full rounded-[4px]" title={`${label}: ${count}`}
          style={{ width: `${Math.max(count > 0 ? 2 : 0, pct)}%`, background: CREATED }} />
      </div>
      <div className="w-[76px] shrink-0 text-right text-[12.5px] tabular-nums">
        <span className="font-bold">{count}</span>
        {note && <span className="ml-1.5" style={{ color: 'var(--nl-muted)' }}>{note}</span>}
      </div>
    </div>
  );
}

/** Created against enrolled, by month. Two series, so: legend + labels. */
function Trend({ rows }) {
  const peak = Math.max(1, ...rows.map(r => Math.max(r.created, r.enrolled)));
  const monthName = (key) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' });
  };
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[8px] w-[8px] rounded-[2px]" style={{ background: CREATED }} /> New leads
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[8px] w-[8px] rounded-[2px]" style={{ background: ENROLLED }} /> Enrolled
        </span>
      </div>
      <div className="flex items-end gap-2" style={{ height: 96 }}>
        {rows.map(r => (
          <div key={r.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            {/* 2px gap between the pair, per the mark spec — adjacent fills
                must not touch or they read as one block. */}
            <div className="flex h-[72px] w-full items-end justify-center gap-[2px]">
              <Bar value={r.created} peak={peak} colour={CREATED} label={`${monthName(r.month)}: ${r.created} new`} />
              <Bar value={r.enrolled} peak={peak} colour={ENROLLED} label={`${monthName(r.month)}: ${r.enrolled} enrolled`} />
            </div>
            <div className="text-[10.5px]" style={{ color: 'var(--nl-muted)' }}>{monthName(r.month)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bar({ value, peak, colour, label }) {
  const h = value > 0 ? Math.max(3, Math.round((value / peak) * 72)) : 0;
  return (
    <div className="relative flex w-full max-w-[16px] flex-col items-center justify-end" style={{ height: 72 }}>
      {value > 0 && (
        <span className="mb-0.5 text-[10px] font-bold tabular-nums" style={{ color: 'var(--nl-ink2)' }}>{value}</span>
      )}
      <div className="w-full rounded-t-[4px]" title={label} style={{ height: h, background: colour }} />
    </div>
  );
}

function Figure({ label, value, note, tone }) {
  return (
    <div className="min-w-0">
      <div className="nl-display text-[26px] font-bold leading-none"
        style={{ color: tone === 'warn' ? 'var(--nl-warn)' : 'var(--nl-ink)' }}>
        {value}
      </div>
      <div className="mt-1 text-[11px]" style={{ color: 'var(--nl-muted)' }}>{label}</div>
      {note && <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--nl-muted)' }}>{note}</div>}
    </div>
  );
}

/**
 * `now` is a prop rather than a default, because a component that reads the
 * clock while rendering is not a function of its props — the linter is
 * right to refuse it, and the page has the clock already.
 */
export default function LeadsPanel({ funnel, trend, centreNames = {}, now }) {
  const nameOf = (id) => centreNames[id] || id;
  const { counts, total, conversion, timing, sources, cold, open, centres } = funnel;

  if (total === 0) {
    return (
      <div>
        <Lbl className="mb-1.5">Leads</Lbl>
        <AllClear title="No leads on any centre yet"
          note="Leads appear here as centres add them — from the booking page, a walk-in, or a referral." />
      </div>
    );
  }

  const sourceRows = Object.entries(sources)
    .map(([key, s]) => ({ key, ...s }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-3.5">
      {/* ── The four numbers worth leading with ──────────────────── */}
      <div>
        <Lbl className="mb-1.5">Leads</Lbl>
        <Card>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Figure label="Converted" value={asPercent(conversion)}
              note={`${counts.enrolled} of ${counts.enrolled + counts.lost} closed`} />
            <Figure label="Still open" value={open} note="not yet won or lost" />
            <Figure label="Gone cold" value={cold.length}
              note={`new, untouched ${CHASE_AFTER_DAYS}+ days`}
              tone={cold.length > 0 ? 'warn' : null} />
            <Figure label="To first contact" value={asDays(timing.daysToContact)}
              note={timing.daysToContactFrom > 0
                ? `median of ${timing.daysToContactFrom} leads`
                : 'no lead has a contact time'} />
          </div>
        </Card>
      </div>

      {/* ── The funnel ───────────────────────────────────────────── */}
      <div>
        <Lbl className="mb-1.5">Where the {total} leads are</Lbl>
        <Card>
          <div className="space-y-2">
            {FUNNEL_ORDER.map(stage => (
              <FunnelRow key={stage} label={LEAD_STATUS_LABELS[stage]}
                count={counts[stage]} of={total} />
            ))}
            <FunnelRow label={LEAD_STATUS_LABELS.lost} count={counts.lost} of={total} />
          </div>
          <p className="mt-3 border-t pt-2.5 text-[11.5px]"
            style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-muted)' }}>
            Converted counts the enrolled against leads that have actually closed. Leads still being
            worked are neither a win nor a loss, so counting them would make a busy pipeline look
            like a failing one.
          </p>
        </Card>
      </div>

      {/* ── Direction ────────────────────────────────────────────── */}
      {trend && trend.length > 0 && (
        <div>
          <Lbl className="mb-1.5">Last {trend.length} months</Lbl>
          <Card><Trend rows={trend} /></Card>
        </div>
      )}

      {/* ── Where they come from ─────────────────────────────────── */}
      <div>
        <Lbl className="mb-1.5">Where they come from</Lbl>
        <Card className="!p-0 overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ background: 'var(--nl-raised)', color: 'var(--nl-muted)' }}>
                <th className="px-4 py-2 text-left text-[10px] font-bold uppercase tracking-wider">Source</th>
                <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">Leads</th>
                <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">Enrolled</th>
                <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">Converts</th>
              </tr>
            </thead>
            <tbody>
              {sourceRows.map(s => (
                <tr key={s.key} className="border-t" style={{ borderColor: 'var(--nl-rule)' }}>
                  <td className="px-4 py-2.5">{LEAD_SOURCE_LABELS[s.key] || s.key}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{s.total}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{s.enrolled}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold"
                    style={{ color: s.rate === null ? 'var(--nl-muted)' : 'inherit' }}>
                    {asPercent(s.rate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* ── Centre by centre ─────────────────────────────────────── */}
      <div>
        <Lbl className="mb-1.5">Funnel by centre</Lbl>
        <Card className="!p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead>
                <tr style={{ background: 'var(--nl-raised)', color: 'var(--nl-muted)' }}>
                  <th className="px-4 py-2 text-left text-[10px] font-bold uppercase tracking-wider">Centre</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">Leads</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">Open</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">Cold</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">Converts</th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-wider">To contact</th>
                </tr>
              </thead>
              <tbody>
                {centres.map(c => (
                  <tr key={c.centreId} className="border-t" style={{ borderColor: 'var(--nl-rule)' }}>
                    <td className="px-4 py-2.5 font-semibold">{nameOf(c.centreId)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.total}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.open}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums"
                      style={{ color: c.cold > 0 ? 'var(--nl-warn)' : 'inherit' }}>{c.cold}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{asPercent(c.conversion)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums"
                      style={{ color: 'var(--nl-muted)' }}>{asDays(c.timing.daysToContact)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ── The actionable one ───────────────────────────────────── */}
      {cold.length > 0 && (
        <div>
          <Lbl className="mb-1.5">Waiting longest</Lbl>
          <Card className="!p-0 overflow-hidden">
            {byAge(cold, now).slice(0, 6).map(({ lead, ageDays }, i) => (
              <div key={lead.id || i}
                className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-2.5 ${i ? 'border-t' : ''}`}
                style={{ borderColor: 'var(--nl-rule)' }}>
                <span className="text-[13.5px] font-semibold">
                  {lead.parentName || lead.childName || 'Unnamed lead'}
                </span>
                <span className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
                  {nameOf(lead.centreId)}
                  <Pill tone="warn">{ageDays} days</Pill>
                </span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
