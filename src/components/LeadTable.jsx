import { useMemo, useState } from 'react';
import { ArrowUpDown } from 'lucide-react';
import { LEAD_STATUS_LABELS, LEAD_STATUS_STYLES } from '../lib/leads';
import {
  worklist, daysSince, daysUntil, LEAD_REASON_LABELS, ASSESSMENT_OUTCOME_LABELS,
} from '../lib/leadFollowUp';
import { familyKind } from '../lib/formerStudents';

/**
 * The tracker — Vin's sheet, as a table, with a column for what needs doing.
 *
 * It replaced a stack of cards that showed a status pill, a name and an
 * email. Everything the centre actually decides on — why they called,
 * how long they have been waiting, what happened at the assessment, who
 * toured, who assessed, whose lead it is — was only visible by opening
 * each one.
 *
 * THE OUTCOME IS A TAG, NOT A DATE. "09-29 ATTENDED" and "10-01 NO-SHOW"
 * are a glance apart; two dates in two columns are not. NS and CA were
 * values in his Assessment Date column for a reason: the outcome is the
 * thing you scan for.
 *
 * SORTING IS A VIEW, NOT A SETTING. It resets on reload, because this is
 * a table people re-sort three times in a minute and a remembered sort
 * is the one that confuses the next person to open it.
 */

const COLS = [
  { key: 'family',  label: 'Family',          sort: l => `${l.parentName || ''} ${l.childName || ''}`.trim().toLowerCase() },
  { key: 'reason',  label: 'Why they called', sort: l => l.reason || '~' },
  { key: 'age',     label: 'In',              sort: l => -(daysSince(l.createdAt) ?? -1), right: true },
  { key: 'assess',  label: 'Assessment',      sort: l => l.assessmentOn || '~' },
  { key: 'tour',    label: 'Toured',          sort: l => (l.tourBy || '~').toLowerCase() },
  { key: 'by',      label: 'Assessed',        sort: l => (l.assessedBy || '~').toLowerCase() },
  { key: 'owner',   label: 'Owner',           sort: l => (l.assignedTo || '~').toLowerCase() },
  { key: 'status',  label: 'Stage',           sort: l => l.status || '~' },
  { key: 'needs',   label: 'Needs',           sort: null },
];

const OUTCOME_TONE = {
  'no-show':  'bg-rose-100 text-rose-700',
  cancelled:  'bg-orange-100 text-orange-700',
  attended:   'bg-emerald-100 text-emerald-700',
  booked:     'bg-sky-100 text-sky-700',
};

const NEEDS_TONE = ['bg-rose-100 text-rose-800', 'bg-amber-100 text-amber-800',
  'bg-sky-100 text-sky-800', 'bg-gray-100 text-gray-700'];

const Dash = () => <span className="text-gray-300">—</span>;

export default function LeadTable({
  leads, studentIndex, showArchived, onToggleArchived, onOpen, emptyNote,
}) {
  const [sortKey, setSortKey] = useState('needs');
  const [asc, setAsc] = useState(true);

  // Eleven years of imported history lives here and is hidden by
  // default: the table is for working the pipeline, and 875 archived
  // leads on top of it is an archive with a pipeline buried in it.
  const rowsIn = useMemo(
    () => (showArchived ? leads : (leads || []).filter(l => l.archived !== true)),
    [leads, showArchived],
  );
  const archivedCount = (leads || []).filter(l => l.archived === true).length;
  const needs = useMemo(() => new Map(worklist(rowsIn).map(i => [i.id, i])), [rowsIn]);

  const rows = useMemo(() => {
    const list = [...rowsIn];
    const col = COLS.find(c => c.key === sortKey);
    if (!col?.sort) {
      // The default: whatever needs doing most, then the rest in the
      // order the worklist already decided, which is urgency then age.
      const order = [...needs.keys()];
      return list.sort((a, b) => {
        const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
        if (ai !== bi) return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
        return (daysSince(b.createdAt) ?? 0) - (daysSince(a.createdAt) ?? 0);
      });
    }
    return list.sort((a, b) => {
      const av = col.sort(a), bv = col.sort(b);
      const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return asc ? cmp : -cmp;
    });
  }, [rowsIn, sortKey, asc, needs]);

  const click = (col) => {
    if (!col.sort) { setSortKey('needs'); return; }
    if (sortKey === col.key) setAsc(a => !a);
    else { setSortKey(col.key); setAsc(true); }
  };

  if (!rows.length) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500 shadow-sm">
        {emptyNote}
      </div>
    );
  }

  return (
    <div>
      {archivedCount > 0 && (
        <div className="mb-1.5 flex justify-end">
          <button type="button" onClick={onToggleArchived}
            className="text-xs font-semibold text-gray-500 hover:text-gray-900">
            {showArchived
              ? `Hide ${archivedCount} archived`
              : `Show ${archivedCount} archived from Radius`}
          </button>
        </div>
      )}
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full min-w-[980px] text-[12.5px]">
        <thead className="border-b border-gray-200 bg-gray-50">
          <tr>
            {COLS.map(col => (
              <th key={col.key}
                className={`whitespace-nowrap px-2.5 py-2 text-[10px] font-bold uppercase tracking-wide text-gray-500 ${col.right ? 'text-right' : 'text-left'}`}>
                <button type="button" onClick={() => click(col)}
                  className="inline-flex items-center gap-1 hover:text-gray-800">
                  {col.label}
                  {col.sort && sortKey === col.key && <ArrowUpDown size={10} />}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(lead => {
            const it = needs.get(lead.id);
            const style = LEAD_STATUS_STYLES[lead.status] || LEAD_STATUS_STYLES.new;
            const until = daysUntil(lead.assessmentOn);
            const outcome = lead.assessmentOutcome
              || (lead.assessmentOn ? 'booked' : '');
            return (
              <tr key={lead.id} onClick={() => onOpen?.(lead)}
                className={`cursor-pointer hover:bg-gray-50 ${it?.urgency === 0 ? 'bg-rose-50/40' : ''}`}>
                <td className="px-2.5 py-2">
                  <b className="block text-gray-900">
                    {lead.parentName || lead.childName || 'Unnamed lead'}
                    {familyKind(lead, studentIndex) === 'returning' && (
                      <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-800">
                        Returning
                      </span>
                    )}
                  </b>
                  {lead.childName && lead.parentName && (
                    <span className="text-[11.5px] text-gray-500">
                      {lead.childName}{lead.childGrade ? ` · Gr ${lead.childGrade}` : ''}
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-2 text-gray-600">
                  {lead.reason ? (LEAD_REASON_LABELS[lead.reason] || lead.reason).split(' — ')[0] : <Dash />}
                </td>
                <td className="px-2.5 py-2 text-right tabular-nums text-gray-500">
                  {daysSince(lead.createdAt) === null ? <Dash /> : `${daysSince(lead.createdAt)}d`}
                </td>
                <td className="whitespace-nowrap px-2.5 py-2">
                  {lead.assessmentOn ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="tabular-nums text-gray-700">{lead.assessmentOn.slice(5)}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${OUTCOME_TONE[outcome] || 'bg-gray-100 text-gray-600'}`}>
                        {outcome === 'booked' && until === 0 ? 'today'
                          : ASSESSMENT_OUTCOME_LABELS[outcome] || outcome}
                      </span>
                    </span>
                  ) : <span className="text-gray-400">not booked</span>}
                </td>
                <td className="px-2.5 py-2 text-gray-600">{lead.tourBy || <Dash />}</td>
                <td className="px-2.5 py-2 text-gray-600">{lead.assessedBy || <Dash />}</td>
                <td className="px-2.5 py-2">
                  {lead.assignedTo || <span className="font-semibold text-amber-700">nobody</span>}
                </td>
                <td className="px-2.5 py-2">
                  <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${style.bg} ${style.text}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
                    {LEAD_STATUS_LABELS[lead.status] || lead.status}
                  </span>
                </td>
                <td className="px-2.5 py-2">
                  {it ? (
                    <span className={`inline-block max-w-[280px] rounded px-1.5 py-1 text-[11.5px] font-medium leading-tight ${NEEDS_TONE[it.urgency] || NEEDS_TONE[3]}`}>
                      {it.why}
                    </span>
                  ) : lead.outcomeReason ? (
                    <span className="text-[11.5px] italic text-gray-500">{lead.outcomeReason}</span>
                  ) : <Dash />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}
