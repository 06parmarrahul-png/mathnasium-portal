import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { Btn } from './ui';
import { fmtDay } from './format';
import { useTimeFormat } from '../../lib/useTimeFormat';
import { assignmentFor, assignmentShort, assignmentColorHex, stateColorHex } from '../../lib/centerConfig';
import {
  mins, dayAxis, snapshotRows, groupRows,
  snapshotTotals, whoIsRunningIt, isTrainingRole,
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
 *   - The "Instructors" footer row is gone. It spent 40px of the band
 *     restating, as bars, a shape the grid underneath already draws.
 *
 * THE COLUMNS ARE ONE LAYER BEHIND EVERY ROW, not a background on each.
 * Per-row rules restart at every group heading and read as stripes rather
 * than columns; drawn once behind the whole grid they line up, which is
 * what makes this read as the table it is replacing.
 *
 * ONE FUNCTION PLACES EVERYTHING HORIZONTAL. pct() turns a time into a
 * percentage across the track, and the hour labels, the rules and the bars
 * all go through it. They used to be positioned three different ways and
 * agreed with each other only by accident — see ColumnLayer below.
 *
 * Colours come from the centre's own role registry through
 * assignmentColorHex, so recolouring a role in Manage Roles repaints this
 * and the classic grid together.
 *
 * Every figure is a read of today's shifts and nothing else.
 */

/**
 * Whether the grid is folded away, remembered per browser.
 *
 * The band carries the day's headline figures on its own, so somebody who
 * only wants "is the floor covered" can put seventeen rows away and still
 * have the answer. It opens by default — the grid IS the card, and a
 * collapsed default would hide it from everyone who never thought to ask.
 */
const OPEN_KEY = 'nl.todaySnapshot.open';

const NAME_W = 178;
const TIME_W = 132;

/**
 * The rules behind the rows: every half hour light, every hour darker.
 *
 * Each one is an element placed by the SAME pct() the bars use. It used to
 * be a repeating CSS gradient, which was wrong twice over:
 *
 *   - A gradient tiles from its own left edge, so the darker "hour" rule
 *     only landed on an hour while the day happened to START on one. A day
 *     opening at 10:30 drew its hour rules at 10:30, 11:30, 12:30…
 *   - The layer is absolutely positioned, so its left/right are measured
 *     from the parent's PADDING edge — but the rows sit INSIDE that
 *     parent's px-4. The rules were 16px left of the track and 32px wider
 *     than it, so every column was ~2px too wide and the error compounded
 *     across the day.
 *
 * Its parent is now a box with no padding of its own, which is what makes
 * left/right here land on exactly the pixels each row's flex track covers.
 */
function ColumnLayer({ axis, pct }) {
  const ticks = [];
  for (let t = axis.from + 30; t < axis.to; t += 30) ticks.push(t);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-0"
      style={{ left: NAME_W, right: TIME_W }}>
      <span className="absolute inset-y-0 left-0 w-px" style={{ background: 'var(--nl-rule)' }} />
      <span className="absolute inset-y-0 right-0 w-px" style={{ background: 'var(--nl-rule)' }} />
      {ticks.map(t => (
        <span key={t} className="absolute inset-y-0 w-px"
          style={{
            left: `${pct(t)}%`,
            background: t % 60 === 0 ? 'var(--nl-rule)' : 'var(--nl-hair)',
          }} />
      ))}
    </div>
  );
}

export default function TodaySnapshotCard({
  shifts, volunteerNames, centerConfig, dateISO, isToday = true, to,
}) {
  const fmtTime = useTimeFormat();
  const gridId = useId();
  const rows = useMemo(
    () => snapshotRows(shifts, { volunteerNames }), [shifts, volunteerNames]);
  const axis = useMemo(() => dayAxis(rows), [rows]);
  const totals = useMemo(() => snapshotTotals(rows), [rows]);
  const groups = useMemo(() => groupRows(rows), [rows]);
  const { leads, host } = useMemo(() => whoIsRunningIt(rows), [rows]);

  // Storage can throw (private windows, blocked site data) and can come
  // back empty. Neither is worth a blank card, so both fall through to
  // open — see OPEN_KEY.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) !== '0'; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); }
    catch { /* nothing to do about it, and nothing depends on it */ }
  }, [open]);

  if (!rows.length || !axis.slots.length) return null;

  const span = axis.to - axis.from;
  const pct = (m) => ((m - axis.from) / span) * 100;

  // Every hour tick the day touches, closing one included.
  //
  // This used to record the MIDDLE of each hour and centre the label there,
  // so "10a" was drawn at 10:30 — half a column right of where a 10:00 bar
  // began. That single line is why none of the start times appeared to line
  // up with the header.
  const hours = [];
  for (let h = Math.ceil(axis.from / 60); h * 60 <= axis.to; h += 1) hours.push(h);

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
      <div className={`p-5 ${open ? 'rounded-t-2xl' : 'rounded-2xl'}`}
        style={{ background: 'var(--nl-brand)', color: '#fff' }}>
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 text-[10px] font-bold uppercase tracking-[0.14em] opacity-85">
            {isToday ? "Today's snapshot" : 'Snapshot'} · {fmtDay(dateISO, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen(v => !v)}
              aria-expanded={open}
              aria-controls={gridId}
              className="flex min-h-[32px] items-center gap-1.5 rounded-lg border border-white/60 px-2.5 text-[12px] font-semibold text-white"
            >
              {open ? 'Hide' : 'Show'}
              <ChevronDown size={14} aria-hidden="true"
                className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {to && (
              <Btn to={to} size="sm" variant="ghost" className="!border-white/60 !text-white">
                Full snapshot <ArrowRight size={13} />
              </Btn>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-4">
          <div className="min-w-0">
            <div className="nl-display text-[34px] font-bold leading-none sm:text-[42px]">
              {totals.people} on today
            </div>
            <div className="mt-2 text-[13.5px] leading-snug opacity-90">
              {fmtTime.range(fromMins(axis.from), fromMins(axis.to))}
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
      </div>

      {/* ── The grid ─────────────────────────────────────────────── */}
      {open && (
      <div id={gridId} className="overflow-x-auto rounded-b-2xl border border-t-0"
        style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
        <div className="min-w-[760px] px-4 pb-3 pt-2.5">

          {/* Hour labels. Built on the same three-part flex as every row
              below, so a label and the bars beneath it are measured off
              one track rather than two that only looked alike. */}
          <div className="relative z-[2] flex h-6 items-center">
            <div className="shrink-0" style={{ width: NAME_W }} />
            {/* The labels had no vertical anchor. Absolute with no `top`
                falls to the static position — the top of this box, which
                sits on the row's midline because every child in it is
                positioned and it therefore measures zero. So each label
                started halfway down a 24px row and hung ~4px below it,
                and the first group band, being opaque and above, sliced
                the descenders off "12p" and "7p". They are centred on the
                row now; h-full just makes that 50% resolve against the
                row instead of against nothing. */}
            <div className="relative h-full min-w-0 flex-1">
              {hours.map(h => {
                const p = pct(h * 60);
                // X puts the label on its tick; the two end labels are
                // pulled inward instead, where centring would hang them
                // off the track and into the columns either side. Y keeps
                // it inside the row it belongs to.
                const dx = p <= 0 ? '0' : p >= 100 ? '-100%' : '-50%';
                return (
                  <span key={h} className="absolute text-[11px] font-semibold"
                    style={{
                      left: `${p}%`,
                      top: '50%',
                      transform: `translate(${dx}, -50%)`,
                      color: 'var(--nl-muted)',
                    }}>
                    {hourLabel(h, fmtTime)}
                  </span>
                );
              })}
            </div>
            <div className="shrink-0" style={{ width: TIME_W }} />
          </div>

          {/* The rows, with the rules behind them. No padding on this box:
              that is what makes ColumnLayer's left/right agree with each
              row's flex track to the pixel. */}
          <div className="relative">
            <ColumnLayer axis={axis} pct={pct} />

            {groups.map(g => (
              <div key={g.tier}>
                {/* A tinted band the full width of the grid.
                    z-[1] lifts it over ColumnLayer, so the rules stop
                    short of it instead of running through the heading —
                    "IN-CENTRE INSTRUCTORS · 10" is wider than the name
                    column and used to sit across the 10a rule. Masking
                    them is also what turns this from a line of small
                    text into a divider you can see from a metre away.
                    In dark the tint equals the card, so the borders
                    carry it there — same trade the half-hour rules make. */}
                <div className="relative z-[1] flex h-[30px] items-center border-y"
                  style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-raised)' }}>
                  <div className="sticky left-0 shrink-0 whitespace-nowrap pr-3 text-[10px] font-bold uppercase tracking-[0.08em]"
                    style={{ color: 'var(--nl-muted)', background: 'var(--nl-raised)' }}>
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
                      {/* Above the bars, not under them: when the grid is
                          scrolled sideways the names stay legible instead
                          of having somebody's shift drawn across them. */}
                      <div className="sticky left-0 z-[2] flex shrink-0 items-center gap-2 truncate pr-2 text-[13px]"
                        style={{ width: NAME_W, background: 'var(--nl-card)' }}>
                        <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                          style={{ background: colour }} />
                        <span className="truncate">{r.userName}</span>
                      </div>
                      <div className="relative z-[1] h-[26px] min-w-0 flex-1">
                        <div className="absolute rounded-[3px]"
                          style={{
                            left: `${pct(a)}%`,
                            width: `${Math.max(0, pct(b) - pct(a))}%`,
                            top: '50%', height: 11, transform: 'translateY(-50%)',
                            background: colour,
                          }} />
                      </div>
                      <div className="shrink-0 whitespace-nowrap text-right text-[12px]"
                        style={{ width: TIME_W, color: 'var(--nl-muted)' }}>
                        {fmtTime.range(r.startTime, r.endTime)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Outside the layer, so no rules run behind the key. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-3 text-[11px]"
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
      )}
    </div>
  );
}

const fromMins = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** An hour mark on the axis: "3p", or "15" on a 24-hour clock. */
const hourLabel = (h, fmt) => fmt.tick(h * 60);
/** "Bri & Luke", "Bri, Luke & Sam" — for the line under the headline. */
const list = (xs) => (xs.length === 1 ? xs[0]
  : `${xs.slice(0, -1).join(', ')} & ${xs[xs.length - 1]}`);
