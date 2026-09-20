import { useMemo } from 'react';
import { ArrowRight } from 'lucide-react';
import { Btn } from './ui';
import { fmtTime, fmtDay } from './format';
import { assignmentFor, assignmentShort, assignmentColorHex, stateColorHex } from '../../lib/centerConfig';
import {
  mins, dayAxis, snapshotRows, groupRows, instructorsPerSlot,
  snapshotTotals, whoIsRunningIt, peakWindow, isTrainingRole,
} from '../../lib/snapshotGrid';

/**
 * Today's Snapshot, condensed for the leadership home.
 *
 * The classic grid is a full table — a row per person, a CELL per half
 * hour, nineteen columns wide. That shape is the point of it: leadership
 * read it to see the shape of the day, not just its headcount. So this
 * keeps the table and shrinks it, rather than replacing it with a summary.
 *
 * WHAT CHANGED FROM THE CLASSIC
 *   - The four tiles and the headcount moved into a brand band on top,
 *     which also absorbs the old "on the floor today" card — otherwise
 *     the same number appeared twice on one page.
 *   - A cell per half hour became a bar per person, laid over the same
 *     half-hour columns. One row is 26px instead of a table row.
 *   - The "Instructors" footer row became a bar strip in the band, where
 *     it answers "when is it thin" at a glance.
 *
 * THE COLUMNS ARE ONE LAYER BEHIND EVERY ROW, not a background on each.
 * Per-row rules restart at every group heading and read as stripes rather
 * than columns; drawn once behind the whole grid they line up, which is
 * what makes this read as the table it is replacing.
 *
 * Colours come from the centre's own role registry through
 * assignmentColorHex, so recolouring a role in Manage Roles repaints this
 * and the classic grid together.
 *
 * Every figure is a read of today's shifts and nothing else.
 */

const NAME_W = 178;
const TIME_W = 92;

/** Two rules: every half hour light, every hour darker. */
function columnLayer(count) {
  const half = 100 / count;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-y-0"
      style={{
        left: NAME_W, right: TIME_W,
        borderLeft: '1px solid var(--nl-rule)', borderRight: '1px solid var(--nl-rule)',
        backgroundImage: 'linear-gradient(to right, var(--nl-rule) 1px, transparent 1px),'
          + ' linear-gradient(to right, var(--nl-hair) 1px, transparent 1px)',
        backgroundSize: `${half * 2}% 100%, ${half}% 100%`,
      }} />
  );
}

export default function TodaySnapshotCard({
  shifts, volunteerNames, centerConfig, dateISO, isToday = true, to,
}) {
  const rows = useMemo(
    () => snapshotRows(shifts, { volunteerNames }), [shifts, volunteerNames]);
  const axis = useMemo(() => dayAxis(rows), [rows]);
  const perSlot = useMemo(() => instructorsPerSlot(rows, axis.slots), [rows, axis.slots]);
  const totals = useMemo(() => snapshotTotals(rows), [rows]);
  const groups = useMemo(() => groupRows(rows), [rows]);
  const peak = useMemo(() => peakWindow(perSlot, axis.slots), [perSlot, axis.slots]);
  const { leads, host } = useMemo(() => whoIsRunningIt(rows), [rows]);

  if (!rows.length || !axis.slots.length) return null;

  const span = axis.to - axis.from;
  const pct = (m) => ((m - axis.from) / span) * 100;
  const maxCount = Math.max(1, ...perSlot);

  // Where "now" falls, but only on a day that is actually today and only
  // while the centre is open — a marker parked at the edge is noise.
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const nowIn = isToday && nowMin >= axis.from && nowMin < axis.to;
  const nowCount = nowIn
    ? perSlot[Math.floor((nowMin - axis.from) / 30)] : null;

  const hours = [];
  for (let h = Math.ceil(axis.from / 60); h * 60 < axis.to; h += 1) {
    const end = Math.min((h + 1) * 60, axis.to);
    hours.push({ h, centre: (h * 60 + end) / 2 });
  }

  const keyOf = (r) => {
    if (r.sickPay) return ['Sick', stateColorHex('Sick Pay', centerConfig)];
    if (r.noShow) return ['No-show', stateColorHex('No-Show', centerConfig)];
    if (r.isVolunteer) return ['Volunteer', stateColorHex('Volunteer', centerConfig)];
    if (isTrainingRole(r.role)) return ['Training', stateColorHex('Training', centerConfig)];
    const a = assignmentFor({ role: r.role, subRole: r.subRole });
    return [assignmentShort(a), assignmentColorHex(a, centerConfig)];
  };
  const colourOf = (r) => keyOf(r)[1];

  // Only what is actually on today — a fixed key would list roles nobody
  // is working and leave the reader hunting for a colour that isn't there.
  const legend = [];
  const seen = new Set();
  for (const r of rows) {
    const [label, colour] = keyOf(r);
    if (!seen.has(label)) { seen.add(label); legend.push({ label, colour }); }
  }

  const stat = (n, k) => (
    <div key={k}>
      <div className="nl-display text-[26px] font-bold leading-none">{n}</div>
      <div className="mt-1 text-[11px] opacity-90">{k}</div>
    </div>
  );

  return (
    <div>
      {/* ── The band ─────────────────────────────────────────────── */}
      <div className="rounded-t-2xl p-5" style={{ background: 'var(--nl-brand)', color: '#fff' }}>
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 text-[10px] font-bold uppercase tracking-[0.14em] opacity-85">
            {isToday ? "Today's snapshot" : 'Snapshot'} · {fmtDay(dateISO, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
          {to && (
            <Btn to={to} size="sm" variant="ghost" className="shrink-0 !border-white/60 !text-white">
              Full snapshot <ArrowRight size={13} />
            </Btn>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="min-w-0">
            <div className="nl-display text-[34px] font-bold leading-none sm:text-[42px]">
              {totals.people} on today
            </div>
            <div className="mt-2 text-[13.5px] leading-snug opacity-90">
              {fmtTime(fromMins(axis.from))} – {fmtTime(fromMins(axis.to))}
              {leads.length > 0 && ` · ${list(leads)} leading`}
              {host && ` · ${host} hosting`}
            </div>
            {(totals.sick > 0 || totals.noShow > 0) && (
              <div className="mt-1.5 text-[13px] opacity-90">
                {[totals.sick && `${totals.sick} off sick`, totals.noShow && `${totals.noShow} no-show`]
                  .filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
          <div className="grid w-full grid-cols-2 gap-x-4 gap-y-3 sm:ml-auto sm:w-auto sm:grid-cols-4 sm:gap-x-7">
            {stat(totals.instructors, 'Instructors')}
            {stat(totals.host, 'Host')}
            {stat(totals.online, 'Online')}
            {stat(`${totals.hours.toFixed(1)}h`, 'Total hours')}
          </div>
        </div>

        {/* Instructors each half hour — the classic grid's footer row. */}
        <div className="mt-4 border-t pt-3" style={{ borderColor: 'rgba(255,255,255,.28)' }}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12px]">
            <span className="opacity-90">Instructors on the floor, each half hour</span>
            <span className="font-semibold">
              {nowIn && `Right now ${nowCount}`}
              {nowIn && peak && ' · '}
              {peak && `${peak.max} from ${fmtTime(fromMins(peak.from))} to ${fmtTime(fromMins(peak.to))}`}
            </span>
          </div>
          <div className="flex items-end gap-[3px]" style={{ height: 40 }}>
            {perSlot.map((c, i) => (
              <div key={axis.slots[i]} className="flex-1 rounded-t-[3px]"
                style={{
                  height: Math.max(2, Math.round((c / maxCount) * 40)),
                  background: `rgba(255,255,255,${c === maxCount ? 0.95 : c ? 0.6 : 0.2})`,
                }} />
            ))}
          </div>
        </div>
      </div>

      {/* ── The grid ─────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-b-2xl border border-t-0"
        style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
        <div className="relative min-w-[720px] px-4 pb-3 pt-2.5">
          {columnLayer(axis.slots.length)}

          <div className="relative flex h-6 items-center">
            <div className="shrink-0" style={{ width: NAME_W }} />
            <div className="relative min-w-0 flex-1">
              {hours.map(({ h, centre }) => (
                <span key={h} className="absolute -translate-x-1/2 text-[11px] font-semibold"
                  style={{ left: `${pct(centre)}%`, color: 'var(--nl-muted)' }}>
                  {hourLabel(h)}
                </span>
              ))}
            </div>
            <div className="shrink-0" style={{ width: TIME_W }} />
          </div>

          {groups.map(g => (
            <div key={g.tier}>
              <div className="relative flex h-[30px] items-center border-b"
                style={{ borderColor: 'var(--nl-hair)' }}>
                <div className="sticky left-0 shrink-0 whitespace-nowrap pr-3 text-[10px] font-bold uppercase tracking-[0.1em]"
                  style={{ color: 'var(--nl-muted)', background: 'var(--nl-card)' }}>
                  {g.label} · {g.rows.length}
                </div>
                <div className="flex-1" />
              </div>
              {g.rows.map((r) => {
                const a = mins(r.startTime);
                const b = mins(r.endTime);
                const colour = colourOf(r);
                return (
                  <div key={r.id} className="relative flex h-[26px] items-center border-b"
                    style={{ borderColor: 'var(--nl-hair)' }}>
                    <div className="sticky left-0 flex shrink-0 items-center gap-2 truncate pr-2 text-[13px]"
                      style={{ width: NAME_W, background: 'var(--nl-card)' }}>
                      <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                        style={{ background: colour }} />
                      <span className="truncate">{r.userName}</span>
                    </div>
                    <div className="relative h-[26px] min-w-0 flex-1">
                      <div className="absolute rounded-[3px]"
                        style={{
                          left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%`,
                          top: 7, height: 11, background: colour,
                        }} />
                    </div>
                    <div className="shrink-0 whitespace-nowrap text-right text-[12px]"
                      style={{ width: TIME_W, color: 'var(--nl-muted)' }}>
                      {shortTime(r.startTime)}–{shortTime(r.endTime)}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-3 text-[11px]"
            style={{ color: 'var(--nl-muted)' }}>
            {legend.map(({ label, colour }) => (
              <span key={label} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-[6px] w-3 rounded-full" style={{ background: colour }} />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const fromMins = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
/** "15:30" -> "3:30", "19:00" -> "7". The band above carries the am/pm. */
const shortTime = (t) => {
  const m = mins(t);
  if (!Number.isFinite(m)) return '';
  const h = ((Math.floor(m / 60) + 11) % 12) + 1;
  return m % 60 ? `${h}:${String(m % 60).padStart(2, '0')}` : `${h}`;
};
const list = (xs) => (xs.length === 1 ? xs[0]
  : `${xs.slice(0, -1).join(', ')} & ${xs[xs.length - 1]}`);
