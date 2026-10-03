/**
 * The Lead Tracker — Vin's spreadsheet, inside Ratio.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * IT LOOKS LIKE THE SHEET ON PURPOSE.
 *
 * One tab per month, his twelve columns in his order, his shorthand in
 * the cells, and the summary block underneath. People have worked this
 * layout every day for a year and know where their eye goes; a tidier
 * arrangement would be a different tool they have to learn, and the
 * spreadsheet would stay open in the other window — which is the exact
 * problem this is meant to end.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * IT NEEDED NO NEW FIELDS. Ratio already stored all twelve columns; they
 * had never been shown together in the arrangement the centre thinks in.
 * The one derived column is Week Ending, which is a function of the
 * created date and nothing else.
 *
 * ONE NUMBER IS DELIBERATELY NOT A COPY. The sheet computes Days to
 * Assessment with DAYS360, a thirty-day-month accounting count — it reads
 * 29 Aug → 1 Sep as two days because it collapses the 30th and the 31st.
 * Across the real tracker it understates 15 of 241 rows, by 1.67 days on
 * average. This column counts the days the family actually waited. The
 * rules and the tests are in lib/leadTracker.js.
 *
 * STILL EXPORTS. The sheet is not going away the day Ratio copies it,
 * and a tracker you cannot get back out of is one people keep a parallel
 * copy of.
 */

import { useMemo, useState } from 'react';
import { Download, Table2, ChevronDown, ChevronRight } from 'lucide-react';
import {
  TRACKER_COLUMNS, trackerMonths, trackerRows, trackerSummary, trackerCsv,
  trackerKpis, monthsBefore, monthLabel, monthOf,
} from '../lib/leadTracker';
import { formatDay } from '../lib/leadStory';
import { DAYS_TO_ASSESSMENT_GOAL } from '../lib/leadFollowUp';
import { todayISO } from '../lib/payProjection';
import { toast } from '../lib/notify';

const ENROLLED_TONE = {
  Yes:     'bg-emerald-50 text-emerald-800 ring-emerald-200',
  Pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  No:      'bg-gray-100 text-gray-600 ring-gray-200',
};

const Dash = () => <span className="text-gray-300">—</span>;

const pct = (v) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** "N out of M", the way the sheet prints it. */
function OutOf({ label, n, outOf, rate, tone }) {
  return (
    <div className="rounded-lg bg-white p-2.5 ring-1 ring-gray-200">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className={`text-lg font-bold tabular-nums ${tone || 'text-gray-900'}`}>{n}</span>
        <span className="text-[11px] text-gray-500">out of {outOf}</span>
        {rate !== null && rate !== undefined ? (
          <span className="ml-auto text-[11px] font-semibold tabular-nums text-gray-500">{pct(rate)}</span>
        ) : null}
      </div>
    </div>
  );
}

/** One figure, with what it was measured over. */
function Stat({ label, value, hint, note, tone }) {
  return (
    <div className="rounded-lg bg-white p-2.5 ring-1 ring-gray-200">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className={`text-lg font-bold tabular-nums ${tone || 'text-gray-900'}`}>{value}</span>
        {hint ? <span className="text-[11px] text-gray-500">{hint}</span> : null}
        {/* The sample, always — a mean over three rows and a mean over
            thirty are different facts. */}
        {note ? <span className="ml-auto text-[11px] text-gray-400">{note}</span> : null}
      </div>
    </div>
  );
}

/**
 * Person down the side, month across the top — his KPI Tracking tab.
 *
 * "How is Sabrina doing" is a question about the year, and the monthly
 * block under the rows cannot answer it however often you change tab.
 */
function KpiGrid({ title, months, rows }) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg bg-white p-3 ring-1 ring-gray-200">
      <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">{title}</h4>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase text-gray-400">
            <th className="pb-1 text-left font-semibold">Who</th>
            {months.map(m => (
              <th key={m} className="pb-1 text-right font-semibold">{monthLabel(m).split(' ')[0].slice(0, 3)}</th>
            ))}
            <th className="pb-1 text-right font-semibold">Total</th>
            <th className="pb-1 text-right font-semibold">Enrolled</th>
            <th className="pb-1 text-right font-semibold">Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.person} className="border-t border-gray-100">
              <td className="py-1 font-medium text-gray-900">{r.person}</td>
              {months.map(m => (
                <td key={m} className={`py-1 text-right tabular-nums ${r.months[m] ? 'text-gray-700' : 'text-gray-300'}`}>
                  {r.months[m] || '—'}
                </td>
              ))}
              <td className="py-1 text-right font-semibold tabular-nums text-gray-900">{r.total}</td>
              <td className="py-1 text-right tabular-nums text-emerald-700">{r.enrolled}</td>
              <td className="py-1 text-right font-semibold tabular-nums text-gray-700">{pct(r.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Tours and assessments per person — the table the staff actually read. */
function Scoreboard({ title, rows }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg bg-white p-3 ring-1 ring-gray-200">
        <h4 className="text-[11px] font-bold uppercase tracking-wide text-gray-500">{title}</h4>
        <p className="mt-1 text-[12px] text-gray-400">Nobody is named in this column yet.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-white p-3 ring-1 ring-gray-200">
      <h4 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">{title}</h4>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase text-gray-400">
            <th className="pb-1 text-left font-semibold">Who</th>
            <th className="pb-1 text-right font-semibold">Number</th>
            <th className="pb-1 text-right font-semibold">Enrolled</th>
            <th className="pb-1 text-right font-semibold">Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.person} className="border-t border-gray-100">
              <td className="py-1 font-medium text-gray-900">{r.person}</td>
              <td className="py-1 text-right tabular-nums text-gray-700">{r.total}</td>
              <td className="py-1 text-right tabular-nums text-emerald-700">{r.enrolled}</td>
              <td className="py-1 text-right font-semibold tabular-nums text-gray-700">{pct(r.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LeadTracker({ leads, onOpen }) {
  // Eleven years of imported Radius history gave this screen 130 monthly
  // tabs. The archive is one click away rather than always in the way.
  const [allMonths, setAllMonths] = useState(false);
  const [showKpis, setShowKpis] = useState(true);
  const months = useMemo(() => trackerMonths(leads, { all: allMonths }), [leads, allMonths]);
  const hidden = useMemo(() => monthsBefore(leads), [leads]);
  const kpis = useMemo(() => trackerKpis(leads, months), [leads, months]);
  // The month with the most recent lead in it, which is the one somebody
  // opening this is nearly always working.
  const [month, setMonth] = useState(() => monthOf({ createdAt: Date.now() }));
  const active = months.includes(month) ? month : (months[0] || month);

  const rows = useMemo(() => trackerRows(leads, active), [leads, active]);
  const summary = useMemo(() => trackerSummary(rows), [rows]);

  const handleExport = () => {
    if (rows.length === 0) { toast.info('Nothing in this month to export.'); return; }
    const blob = new Blob([trackerCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lead-tracker-${active}-${todayISO()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="rounded-xl bg-white ring-1 ring-gray-200">
      {/* ── The tabs along the bottom of a workbook, along the top here ── */}
      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 px-3 py-2">
        <Table2 size={15} className="mr-1 text-gray-400" />
        {months.length === 0 ? (
          <span className="text-[12px] text-gray-500">No leads yet.</span>
        ) : months.map(m => (
          <button key={m} type="button" onClick={() => setMonth(m)}
            className={`rounded-lg px-2.5 py-1 text-[12px] font-semibold transition ${
              m === active ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}>
            {monthLabel(m)}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          {hidden > 0 && (
            <button type="button" onClick={() => setAllMonths(v => !v)}
              className="rounded-lg px-2.5 py-1 text-[12px] font-semibold text-gray-500 hover:bg-gray-100">
              {allMonths ? 'Hide the archive' : `Show ${hidden} older ${hidden === 1 ? 'month' : 'months'}`}
            </button>
          )}
          <button type="button" onClick={handleExport}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-[12px] font-semibold text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50">
            <Download size={13} /> Export
          </button>
        </div>
      </div>

      {/* ── The rows ────────────────────────────────────────────────── */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]" style={{ minWidth: 1180 }}>
          <thead>
            <tr className="bg-gray-50">
              {TRACKER_COLUMNS.map(c => (
                <th key={c.key}
                  className={`whitespace-nowrap border-b border-gray-200 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide text-gray-500 ${
                    c.number ? 'text-right' : 'text-left'}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={TRACKER_COLUMNS.length} className="px-3 py-6 text-center text-[12px] text-gray-500">
                  Nothing in {monthLabel(active)} yet.
                </td>
              </tr>
            ) : rows.map(r => (
              <tr key={r.id} onClick={() => onOpen?.(r.lead)}
                className="cursor-pointer border-b border-gray-100 align-top hover:bg-amber-50/40">
                <td className="px-2 py-1.5 font-medium text-gray-900">{r.name || <Dash />}</td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-gray-600">{formatDay(r.created) || <Dash />}</td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-gray-500">{formatDay(r.week) || <Dash />}</td>
                {/* "VB 7/16" is a person AND a date in one cell. Running
                    it through a date formatter blanks the whole column,
                    which is what it did until somebody looked. */}
                <td className="whitespace-nowrap px-2 py-1.5 text-gray-600">
                  {!r.contact ? <Dash />
                    : r.contactIsDate ? <span className="tabular-nums">{formatDay(r.contact)}</span>
                      : r.contact}
                </td>
                <td className="px-2 py-1.5 text-gray-600">{r.reason || <Dash />}</td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {r.assess === 'NS' || r.assess === 'CA' ? (
                    <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] font-bold text-rose-700 ring-1 ring-rose-200">
                      {r.assess}
                    </span>
                  ) : r.assess ? (
                    <span className="tabular-nums text-gray-700">{formatDay(r.assess)}</span>
                  ) : <Dash />}
                </td>
                {/* Wide enough to read a sentence in, capped so one long
                    write-up cannot push every other row off the screen.
                    The whole note is on the row-s title, and clicking the
                    row opens the lead where it is shown in full. */}
                <td className="px-2 py-1.5 text-gray-600" style={{ minWidth: 230, maxWidth: 360 }}>
                  {r.notes
                    ? <span className="line-clamp-4 whitespace-pre-wrap" title={r.notes}>{r.notes}</span>
                    : <Dash />}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-gray-700">{r.tour || <Dash />}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-gray-700">{r.assessor || <Dash />}</td>
                <td className="px-2 py-1.5">
                  {r.enrolled ? (
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ${ENROLLED_TONE[r.enrolled]}`}>
                      {r.enrolled}
                    </span>
                  ) : <Dash />}
                </td>
                <td className="px-2 py-1.5 text-gray-600" style={{ minWidth: 150, maxWidth: 230 }}>
                  {r.why ? <span className="line-clamp-3" title={r.why}>{r.why}</span> : <Dash />}
                </td>
                <td className={`px-2 py-1.5 text-right font-semibold tabular-nums ${
                  r.days === null ? '' : r.days > DAYS_TO_ASSESSMENT_GOAL ? 'text-amber-700' : 'text-gray-700'}`}>
                  {r.days === null ? <Dash /> : r.days}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── The block under the rows — his numbers, his names ──────── */}
      {rows.length > 0 ? (
        <div className="space-y-3 border-t border-gray-200 bg-gray-50 p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <OutOf label="No assessment booked" n={summary.noAssessment}
              outOf={summary.leads} rate={summary.noAssessmentRate} />
            {/* Out of ASSESSMENTS, not out of leads. The two denominators
                are different on his sheet too, deliberately. */}
            <OutOf label="Cancellations / no shows" n={summary.broken}
              outOf={summary.assessments} rate={summary.brokenRate} tone="text-rose-700" />
            <OutOf label="Leads converted" n={summary.converted}
              outOf={summary.leads} rate={null} tone="text-emerald-700" />
            <Stat label="Days to assessment"
              value={summary.daysToAssessment === null ? '—' : summary.daysToAssessment.toFixed(1)}
              hint={`goal ${DAYS_TO_ASSESSMENT_GOAL}`}
              note={`of ${summary.daysToAssessmentSample}`}
              tone={summary.daysToAssessment === null ? 'text-gray-400'
                : summary.daysToAssessment <= DAYS_TO_ASSESSMENT_GOAL ? 'text-emerald-700' : 'text-amber-700'} />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="Leads assessed rate" value={pct(summary.leadsAssessedRate)}
              hint={`${summary.assessments - summary.broken} of ${summary.leads}`} />
            <Stat label="Lead conversion rate" value={pct(summary.leadConversionRate)}
              hint={`${summary.converted} of ${summary.assessments} assessed`} />
            <Stat label="Assessment conversion rate" value={pct(summary.assessmentConversionRate)}
              hint={`${summary.converted} of ${summary.decided} decided`} />
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <Scoreboard title="Tours" rows={summary.tours} />
            <Scoreboard title="Assessments" rows={summary.assessors} />
          </div>
        </div>
      ) : null}

      {/* ── The KPI tab: the year, not one month ───────────────────── */}
      {months.length > 1 ? (
        <div className="border-t border-gray-200">
          <button type="button" onClick={() => setShowKpis(v => !v)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-gray-50">
            {showKpis ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
            <span className="text-[12px] font-bold uppercase tracking-wide text-gray-600">KPI tracking</span>
            <span className="text-[11px] text-gray-500">Tours and assessments per person, across every month</span>
          </button>
          {showKpis ? (
            <div className="space-y-3 border-t border-gray-100 bg-gray-50 p-3">
              <KpiGrid title="Tours" months={kpis.months} rows={kpis.tours} />
              <KpiGrid title="Assessments" months={kpis.months} rows={kpis.assessments} />
            </div>
          ) : null}
        </div>
      ) : null}

    </section>
  );
}
