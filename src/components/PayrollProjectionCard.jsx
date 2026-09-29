/**
 * PayrollProjectionCard — the two pay runs of a month, side by side.
 *
 * Moved off Centre Analytics and onto Manage Payroll, at the top, because
 * that is the page somebody is on when the question comes up and because
 * the figure is the same one the table underneath adds up. Nothing about
 * the card changed in the move; only where it reads its numbers from.
 *
 * Presentational — it is handed a projection from lib/payrollProjection
 * and does no arithmetic of its own beyond rounding for display.
 */

const round1 = (h) => Math.round((Number.isFinite(h) ? h : 0) * 10) / 10;

function RunCard({ run }) {
  return (
    <div className={`rounded-xl border p-4 ${
      run.upcoming ? 'border-purple-300 bg-purple-50/40' : 'border-gray-200 bg-gray-50/40'
    }`}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{run.label}</span>
        {run.upcoming && (
          <span className="rounded-full bg-purple-200 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-800">
            Upcoming
          </span>
        )}
      </div>
      <p className="mb-2 text-[10px] text-gray-500">{run.window}</p>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-purple-700">{round1(run.hours)}</span>
        <span className="text-sm text-gray-500">hrs</span>
      </div>
      <p className="mt-1 text-[10px] text-gray-500">
        {run.shifts} shift{run.shifts === 1 ? '' : 's'} · {run.instructors} instructor{run.instructors === 1 ? '' : 's'}
      </p>
    </div>
  );
}

export default function PayrollProjectionCard({ projection }) {
  if (!projection || projection.runs.length === 0) return null;
  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Payroll Projection</h3>
        <span className="text-xs text-gray-500">{projection.monthLabel}</span>
      </div>
      <p className="mb-4 text-xs text-gray-500">
        Semi-monthly pay runs · Payroll Hours = override (if set) or scheduled hours
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {projection.runs.map(run => <RunCard key={run.key} run={run} />)}
      </div>
      <div className="mt-3 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
        <span className="text-xs font-medium text-gray-600">Total month projection</span>
        <span className="text-sm font-bold text-gray-900">{round1(projection.totalHours)} hrs</span>
      </div>
      {/* Said on the page the export comes off, so it reads as a
          description of the table below rather than a promise about
          another page. */}
      <p className="mt-2 text-[10px] italic text-gray-400">
        Same rule as the Total Hours column: posted shifts only, sick / volunteers / salaried / hidden accounts excluded.
      </p>
    </div>
  );
}
