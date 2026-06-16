// Case study — Mathnasium Langley's own numbers, in the format the
// October BC franchisee pitch will quote.
//
// Owner-only by design. The page is internal: it tells the owner what
// they can credibly say in public. The "Copy headline for slide" button
// produces text the user pastes into the actual pitch deck.
//
// Honesty rules baked into the page (not just into the data):
//   - Wage attribution is explicit per metric. Admin wage drives prep
//     savings, instructor wage is held for the staffing-slack metric.
//   - Conversion rate suppresses until 10+ leads are closed. Until then,
//     "data collecting" appears instead of a misleading first-week %.
//   - Title says "At Mathnasium Langley", not "the average Ratio centre".

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  BarChart3, Clock, TrendingUp, Users, ClipboardList, CalendarCheck,
  Copy, CheckCircle2, RefreshCw, Pencil, Info,
} from 'lucide-react';
import {
  computeCaseStudy, saveCaseStudyConfig, defaultRange,
  money, hours, pct,
} from '../lib/case-study';
import { toast } from '../lib/notify';

export default function CaseStudy() {
  const { activeCenterId: centerId, isOwner, isSuperAdmin, isAdminAssistant } = useAuth();
  const allowed = isOwner || isSuperAdmin || isAdminAssistant;

  const [range, setRange] = useState(defaultRange());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  // Reload whenever centre, date range, or config changes.
  const reload = async () => {
    if (!centerId || !allowed) return;
    setLoading(true); setError(null);
    try {
      const d = await computeCaseStudy(centerId, range);
      setData(d);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [centerId, range.from, range.to, allowed]);

  // Hooks must run on every render — keep this above the early return.
  const headlineText = useMemo(() => buildHeadlineText(data), [data]);

  if (!allowed) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        Case study is owner-only.
      </div>
    );
  }

  const handleCopyHeadline = async () => {
    try {
      await navigator.clipboard.writeText(headlineText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Copy failed — select and copy manually.');
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mathnasium Langley case study</h1>
          <p className="text-sm text-gray-500 max-w-2xl">
            The numbers you can defend in front of a room of franchise owners.
            Computed from your own Firestore data — no fake averages, no industry benchmarks borrowed from somewhere else.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-gray-500">From</label>
          <input type="date" value={range.from}
            onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
            className="rounded border border-gray-300 px-2 py-1 text-sm" />
          <label className="text-xs text-gray-500">To</label>
          <input type="date" value={range.to}
            onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
            className="rounded border border-gray-300 px-2 py-1 text-sm" />
          <button onClick={reload}
            className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      {loading && !data && (
        <div className="rounded-lg bg-white p-8 text-center text-gray-500">Loading…</div>
      )}

      {data && (
        <>
          {/* ── HEADLINE TILE ─────────────────────────────────── */}
          <section className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="text-xs font-medium uppercase tracking-widest text-emerald-700">Headline · for the slide</div>
                <div className="mt-1 text-2xl font-bold text-gray-900 max-w-2xl leading-snug">
                  {headlineText}
                </div>
              </div>
              <button onClick={handleCopyHeadline}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy headline'}
              </button>
            </div>
          </section>

          {/* ── 4-up tiles ────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile icon={Clock} label="Admin time / week recovered"
              value={hours(data.timeSavings.hoursPerWeek)}
              sub={`${money(data.timeSavings.annualDollars)} / year at $${data.config.hourlyWageAdmin}/hr`} />
            <Tile icon={CalendarCheck} label="Intakes booked (in range)"
              value={String(data.funnel.intakesBooked)}
              sub={`${data.activity.intakesBooked} via the public booking link`} />
            <Tile icon={TrendingUp} label="Lead → enrolled conversion"
              value={data.funnel.dataCollecting ? '—' : pct(data.funnel.conversionRate)}
              sub={data.funnel.dataCollecting
                ? `Collecting · ${data.funnel.closed} of ${data.config.conversionMinClosedLeads} closed leads`
                : `${data.funnel.byStatus.enrolled} enrolled / ${data.funnel.closed} closed`} />
            <Tile icon={ClipboardList} label="Days scheduled through Ratio"
              value={String(data.activity.daysWithSchedule)}
              sub={`${data.activity.totalInstructorAssignments.toLocaleString()} instructor-slot assignments`} />
          </div>

          {/* ── Time savings breakdown ────────────────────────── */}
          <Section title="Time savings (your defensible number)" icon={Clock}>
            <div className="space-y-2 text-sm text-gray-700">
              <Row label="Before Ratio (admin prep + student scheduling, weekly)"
                value={hours(data.config.prepHoursBeforeWeekly)} />
              <Row label="After Ratio (weekly)"
                value={hours(data.config.prepHoursAfterWeekly)} />
              <Row label="Recovered per week" bold
                value={hours(data.timeSavings.hoursPerWeek)} />
              <Row label="Admin wage applied" hint="Rachel — admin assistant, NOT instructor wage"
                value={`$${data.config.hourlyWageAdmin}/hr`} />
              <div className="my-1 h-px bg-gray-200" />
              <Row label="Annual time recovered" value={hours(data.timeSavings.annualHours)} />
              <Row label="Annual dollar value" bold large
                value={money(data.timeSavings.annualDollars)} />
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Opportunity cost, not cash freed. Be ready to name what Rachel now does with the recovered 5 hrs/week.
              "Rachel now runs follow-up on stale leads / closes Saturdays / handles intake calls" makes the dollar
              figure read as recaptured productivity rather than theoretical savings.
            </p>
          </Section>

          {/* ── Funnel section ────────────────────────────────── */}
          <Section title="Funnel" icon={TrendingUp}>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
              {Object.entries(data.funnel.byStatus).map(([k, v]) => (
                <div key={k} className="rounded border border-gray-200 bg-white p-2 text-center">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500">{k}</div>
                  <div className="text-lg font-bold text-gray-900">{v}</div>
                </div>
              ))}
            </div>
            {data.funnel.dataCollecting ? (
              <p className="mt-3 text-xs text-gray-500">
                <Info size={11} className="inline -mt-0.5 mr-1" />
                Conversion rate suppressed until {data.config.conversionMinClosedLeads} leads have closed
                (enrolled or lost). Currently {data.funnel.closed}. The intake-form auto-mirror started feeding this
                pipeline recently — by October you'll have a defensible rate to quote.
              </p>
            ) : (
              <p className="mt-3 text-sm text-gray-700">
                <b>{pct(data.funnel.conversionRate)}</b> of closed leads enrolled
                ({data.funnel.byStatus.enrolled} of {data.funnel.closed}).
              </p>
            )}
          </Section>

          {/* ── Activity proof ────────────────────────────────── */}
          <Section title="Activity proof — Ratio is being used" icon={Users}>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Row inline label="Students tracked" value={data.activity.studentsTracked} />
              <Row inline label="Leads created (in range)" value={data.activity.leadsCreated} />
              <Row inline label="Intakes booked (in range)" value={data.activity.intakesBooked} />
              <Row inline label="Days scheduled" value={data.activity.daysWithSchedule} />
              <Row inline label="Total instructor-slot assignments" value={data.activity.totalInstructorAssignments.toLocaleString()} />
            </div>
            <p className="mt-3 text-xs text-gray-500">
              Not impressive in isolation — these prove the system is touched by real ops, not a demo.
              "Over the last {Math.round((new Date(range.to) - new Date(range.from)) / 86400000)} days we ran the
              schedule through Ratio for {data.activity.daysWithSchedule} of them" is a credibility line, not a benefit line.
            </p>
          </Section>

          {/* ── 2025 baseline + post-Ratio claims ────────────── */}
          <BaselineSection config={data.config} />

          {/* ── Config inputs ─────────────────────────────────── */}
          <ConfigPanel centerId={centerId} config={data.config} onSaved={reload} />

          {/* ── Staffing visibility (placeholder for forward instrumentation) */}
          <Section title="Staffing visibility (instrumentation pending)" icon={BarChart3}>
            <p className="text-sm text-gray-700">
              The "Ratio surfaced X hours/week of staffing slack worth $Y/month" metric requires forward-looking
              instrumentation — need-vs-have isn't logged historically. By October you'll have ~3 months of
              data. Until then, this section stays blank deliberately rather than showing a number you can't defend.
            </p>
          </Section>
        </>
      )}
    </div>
  );
}

// ── Headline text for the "Copy" button ─────────────────────────────────
function buildHeadlineText(data) {
  if (!data) return '';
  const weekly = data.timeSavings.hoursPerWeek;
  const annual = data.timeSavings.annualDollars;
  return (
    `At Mathnasium Langley, Ratio recovered ${weekly.toFixed(1)} hours per week of admin-assistant time — ` +
    `≈ ${money(annual)}/year at $${data.config.hourlyWageAdmin}/hr.`
  );
}

// ── 2025 baseline + post-Ratio claims ───────────────────────────────────
// Reads the priorYear* and postRatio* config fields and renders them
// side-by-side. Post-Ratio numbers display with a "preliminary" badge
// until postRatioStatsVerified flips to true. Lift math only renders
// when BOTH a prior and a verified post number exist.
function BaselineSection({ config }) {
  const haveVerified = config.postRatioStatsVerified
    && config.postRatioConversionRate != null
    && config.priorYearConversionRate != null;
  const convLift = haveVerified
    ? config.postRatioConversionRate - config.priorYearConversionRate
    : null;
  const daysLift = (config.postRatioStatsVerified
                    && config.postRatioDaysToConvert != null
                    && config.priorYearDaysToConvert != null)
    ? config.priorYearDaysToConvert - config.postRatioDaysToConvert
    : null;

  const post = (v, fmt) => {
    if (v == null) return <span className="text-gray-400">—</span>;
    return (
      <span>
        {fmt(v)}
        {!config.postRatioStatsVerified && (
          <span className="ml-1.5 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-800">
            unverified
          </span>
        )}
      </span>
    );
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-900">
        {config.priorYearLabel || 'Prior'} baseline vs post-Ratio
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-2 py-1 text-left">Metric</th>
              <th className="px-2 py-1 text-right">{config.priorYearLabel || 'Prior'}</th>
              <th className="px-2 py-1 text-right">Post-Ratio</th>
              <th className="px-2 py-1 text-right">Lift</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            <tr>
              <td className="px-2 py-1.5">Revenue</td>
              <td className="px-2 py-1.5 text-right">{money(config.priorYearRevenue)}</td>
              <td className="px-2 py-1.5 text-right">{post(config.postRatioRevenue, money)}</td>
              <td className="px-2 py-1.5 text-right text-gray-400">—</td>
            </tr>
            <tr>
              <td className="px-2 py-1.5">Leads</td>
              <td className="px-2 py-1.5 text-right">{config.priorYearLeads}</td>
              <td className="px-2 py-1.5 text-right text-gray-400">—</td>
              <td className="px-2 py-1.5 text-right text-gray-400">—</td>
            </tr>
            <tr>
              <td className="px-2 py-1.5">New students enrolled</td>
              <td className="px-2 py-1.5 text-right">{config.priorYearNewStudents}</td>
              <td className="px-2 py-1.5 text-right text-gray-400">—</td>
              <td className="px-2 py-1.5 text-right text-gray-400">—</td>
            </tr>
            <tr>
              <td className="px-2 py-1.5">Lead → enrolled conversion</td>
              <td className="px-2 py-1.5 text-right">{pct(config.priorYearConversionRate)}</td>
              <td className="px-2 py-1.5 text-right">{post(config.postRatioConversionRate, pct)}</td>
              <td className="px-2 py-1.5 text-right">
                {convLift == null ? <span className="text-gray-400">—</span>
                  : <span className="font-semibold text-emerald-700">+{Math.round(convLift * 100)} pts</span>}
              </td>
            </tr>
            <tr>
              <td className="px-2 py-1.5">Avg days to convert</td>
              <td className="px-2 py-1.5 text-right">{config.priorYearDaysToConvert} days</td>
              <td className="px-2 py-1.5 text-right">{post(config.postRatioDaysToConvert, (v) => `${v} days`)}</td>
              <td className="px-2 py-1.5 text-right">
                {daysLift == null ? <span className="text-gray-400">—</span>
                  : <span className="font-semibold text-emerald-700">−{daysLift} days</span>}
              </td>
            </tr>
            <tr>
              <td className="px-2 py-1.5">Avg length of stay</td>
              <td className="px-2 py-1.5 text-right">{config.priorYearAvgStayMonths} mo</td>
              <td className="px-2 py-1.5 text-right text-gray-400">—</td>
              <td className="px-2 py-1.5 text-right text-gray-400">—</td>
            </tr>
            {config.priorYearRankInCanada != null && (
              <tr>
                <td className="px-2 py-1.5">Mathnasium Canada rank</td>
                <td className="px-2 py-1.5 text-right font-semibold">#{config.priorYearRankInCanada}</td>
                <td className="px-2 py-1.5 text-right text-gray-400">—</td>
                <td className="px-2 py-1.5 text-right text-gray-400">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!config.postRatioStatsVerified && (
        <p className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <Info size={11} className="inline -mt-0.5 mr-1" />
          Post-Ratio numbers are <b>preliminary</b>. Verify the denominator matches the {config.priorYearLabel || 'prior-year'} conversion definition before quoting. A 91% conversion claim is unprecedented for tutoring — franchise owners will ask "91% of what" within 30 seconds.
        </p>
      )}
    </section>
  );
}

// ── Reusable bits ───────────────────────────────────────────────────────
function Tile({ icon, label, value, sub }) {
  const IconComp = icon;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
        {IconComp && <IconComp size={12} />}
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-gray-900">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>}
    </div>
  );
}

function Section({ title, icon: Icon, children }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
        {Icon && <Icon size={14} />} {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value, bold, large, hint, inline }) {
  if (inline) {
    return (
      <div className="rounded border border-gray-100 bg-gray-50 p-2">
        <div className="text-[11px] text-gray-500">{label}</div>
        <div className="text-base font-semibold text-gray-900">{value}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className={`text-sm ${bold ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
        {label}
        {hint && (
          <span className="ml-1.5 text-[10px] font-normal text-gray-500" title={hint}>
            <Info size={10} className="inline -mt-0.5" />
          </span>
        )}
      </span>
      <span className={`${large ? 'text-xl font-bold text-emerald-700' : bold ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
        {value}
      </span>
    </div>
  );
}

// ── Config panel ────────────────────────────────────────────────────────
// Three editable numbers + the conversion threshold. Stored on
// schedulerSettings.caseStudy. Changes recompute the page on save.
function ConfigPanel({ centerId, config, onSaved }) {
  const [draft, setDraft] = useState(config);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => setDraft(config), [config]);

  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const num   = (v) => Number(v) || 0;
      const numOrNull = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
      await saveCaseStudyConfig(centerId, {
        hourlyWageInstructor:    num(draft.hourlyWageInstructor),
        hourlyWageAdmin:         num(draft.hourlyWageAdmin),
        prepHoursBeforeWeekly:   num(draft.prepHoursBeforeWeekly),
        prepHoursAfterWeekly:    num(draft.prepHoursAfterWeekly),
        conversionMinClosedLeads: num(draft.conversionMinClosedLeads) || 10,
        priorYearLabel:          draft.priorYearLabel || '2025',
        priorYearRevenue:        num(draft.priorYearRevenue),
        priorYearLeads:          num(draft.priorYearLeads),
        priorYearNewStudents:    num(draft.priorYearNewStudents),
        priorYearConversionRate: num(draft.priorYearConversionRate),
        priorYearDaysToConvert:  num(draft.priorYearDaysToConvert),
        priorYearAvgStayMonths:  num(draft.priorYearAvgStayMonths),
        priorYearRankInCanada:   numOrNull(draft.priorYearRankInCanada),
        postRatioConversionRate: numOrNull(draft.postRatioConversionRate),
        postRatioDaysToConvert:  numOrNull(draft.postRatioDaysToConvert),
        postRatioRevenue:        numOrNull(draft.postRatioRevenue),
        postRatioStatsVerified:  !!draft.postRatioStatsVerified,
      });
      toast.success('Saved. Recomputing…');
      await onSaved?.();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <button onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between text-sm font-semibold text-gray-900 hover:text-red-600">
        <span className="inline-flex items-center gap-2"><Pencil size={14} /> Inputs (Langley defaults)</span>
        <span className="text-xs text-gray-500">{open ? 'Hide' : 'Edit'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Admin-assistant hourly wage ($)" value={draft.hourlyWageAdmin}
              onChange={v => set('hourlyWageAdmin', v)} />
            <Input label="Instructor hourly wage ($)" value={draft.hourlyWageInstructor}
              onChange={v => set('hourlyWageInstructor', v)}
              hint="Used for the (future) staffing-slack metric." />
            <Input label="Prep hours/week BEFORE Ratio"
              value={draft.prepHoursBeforeWeekly}
              onChange={v => set('prepHoursBeforeWeekly', v)}
              hint="Honest estimate. Schedule build + payroll exports + manual student scheduler." />
            <Input label="Prep hours/week NOW"
              value={draft.prepHoursAfterWeekly}
              onChange={v => set('prepHoursAfterWeekly', v)} />
            <Input label="Conversion rate: min closed leads"
              value={draft.conversionMinClosedLeads}
              onChange={v => set('conversionMinClosedLeads', v)}
              hint="Conversion rate is suppressed until this many leads have closed (enrolled or lost)." />
          </div>

          {/* ── Prior-year baseline ───────────────────────────── */}
          <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-gray-500">{draft.priorYearLabel || 'Prior'} baseline (Langley operational reality)</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Baseline year label" value={draft.priorYearLabel}
              onChange={v => set('priorYearLabel', v)} />
            <Input label="Revenue ($)" value={draft.priorYearRevenue}
              onChange={v => set('priorYearRevenue', v)} />
            <Input label="Leads" value={draft.priorYearLeads}
              onChange={v => set('priorYearLeads', v)} />
            <Input label="New students enrolled" value={draft.priorYearNewStudents}
              onChange={v => set('priorYearNewStudents', v)} />
            <Input label="Conversion rate (0–1)" value={draft.priorYearConversionRate}
              onChange={v => set('priorYearConversionRate', v)}
              hint="0.36 = 36%. Document the denominator (all leads vs assessed leads etc.) — must match post-Ratio." />
            <Input label="Avg days to convert" value={draft.priorYearDaysToConvert}
              onChange={v => set('priorYearDaysToConvert', v)} />
            <Input label="Avg length of stay (months)" value={draft.priorYearAvgStayMonths}
              onChange={v => set('priorYearAvgStayMonths', v)} />
            <Input label="Rank in Canada (blank if N/A)" value={draft.priorYearRankInCanada ?? ''}
              onChange={v => set('priorYearRankInCanada', v === '' ? null : Number(v))} />
          </div>

          {/* ── Post-Ratio claims (preliminary until verified) ─ */}
          <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Post-Ratio claims</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Conversion rate (0–1)" value={draft.postRatioConversionRate ?? ''}
              onChange={v => set('postRatioConversionRate', v === '' ? null : Number(v))}
              hint="0.91 = 91%. Same denominator as prior-year — or the comparison is meaningless." />
            <Input label="Avg days to convert" value={draft.postRatioDaysToConvert ?? ''}
              onChange={v => set('postRatioDaysToConvert', v === '' ? null : Number(v))} />
            <Input label="Revenue ($, when known)" value={draft.postRatioRevenue ?? ''}
              onChange={v => set('postRatioRevenue', v === '' ? null : Number(v))} />
            <label className="flex items-center gap-2 self-end pb-1">
              <input type="checkbox" checked={!!draft.postRatioStatsVerified}
                onChange={e => set('postRatioStatsVerified', e.target.checked)} />
              <span className="text-sm">Verified & ready to quote on the pitch slide</span>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDraft(config)}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
              Reset
            </button>
            <button onClick={save} disabled={saving}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Input({ label, value, onChange, hint }) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-600">{label}</span>
      <input type="number" step="0.01" value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400" />
      {hint && <span className="mt-0.5 block text-[10px] text-gray-500">{hint}</span>}
    </label>
  );
}
