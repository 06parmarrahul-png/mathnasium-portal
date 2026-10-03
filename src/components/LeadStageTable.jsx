/**
 * Where everybody is standing — one row per lead, stages in fixed columns.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE POINT IS READING DOWN, NOT ACROSS.
 *
 * Each row is one family's story, but because the five stages sit in the
 * same five columns on every row, a column becomes a question: how many
 * assessments are booked and unconfirmed? how many families did nobody
 * ever reach? Four red dots stacked in the Assessment column is a problem
 * you can see from across the room, and no number in a stats box says it
 * as fast.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Sorted by how far along they are, so the rows stack into the shape of
 * the funnel — everyone stuck at the same step ends up next to each other.
 */

import { useMemo } from 'react';
import { stageIndex, STORY_KEYS, STORY_LABELS } from '../lib/leadStory';
import { actionFor, daysSince, LEAD_REASON_LABELS } from '../lib/leadFollowUp';
import { LeadStoryGrid } from './LeadStory';

const TONE = ['rose', 'amber', 'sky', 'slate'];
const PILL = {
  rose:  'bg-rose-50 text-rose-700 ring-rose-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  sky:   'bg-sky-50 text-sky-700 ring-sky-200',
  slate: 'bg-gray-50 text-gray-600 ring-gray-200',
};

export default function LeadStageTable({ leads, onOpen }) {
  const rows = useMemo(() => (leads || [])
    .filter(l => l.archived !== true && l.status !== 'enrolled' && l.status !== 'lost')
    .map(lead => ({
      lead,
      at: stageIndex(lead),
      action: actionFor(lead),
      // How long since anybody did anything — the number that says which
      // of two leads at the same stage has been left longer.
      quiet: daysSince(lead.lastContactOn || lead.createdAt),
    }))
    .sort((a, b) => a.at - b.at || (b.quiet ?? 0) - (a.quiet ?? 0)), [leads]);

  if (rows.length === 0) {
    return (
      <section className="rounded-xl bg-white p-6 text-center text-[13px] text-gray-500 ring-1 ring-gray-200">
        Nothing open. Every lead is enrolled, closed or archived.
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl bg-white ring-1 ring-gray-200">
      <div className="overflow-x-auto">
        <div style={{ minWidth: 640 }}>
          <div className="grid border-b border-gray-200 px-4 py-1.5"
            style={{ gridTemplateColumns: '200px minmax(0,1fr) 72px', columnGap: 14 }}>
            <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Family</div>
            <div className="grid" style={{ gridTemplateColumns: `repeat(${STORY_KEYS.length}, minmax(0,1fr))` }}>
              {STORY_KEYS.map(k => (
                <div key={k} className="text-center text-[10px] font-bold uppercase tracking-wide text-gray-400">
                  {STORY_LABELS[k]}
                </div>
              ))}
            </div>
            <div className="text-right text-[10px] font-bold uppercase tracking-wide text-gray-400">Quiet</div>
          </div>

          <div className="divide-y divide-gray-100">
            {rows.map(({ lead, action, quiet }) => {
              const tone = action ? (TONE[action.urgency] || 'slate') : 'slate';
              return (
                <button key={lead.id} type="button" onClick={() => onOpen?.(lead)}
                  className="grid w-full items-center px-4 py-2 text-left hover:bg-gray-50/60"
                  style={{ gridTemplateColumns: '200px minmax(0,1fr) 72px', columnGap: 14 }}>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-gray-900">
                      {lead.childName || lead.parentName || 'Unnamed lead'}
                    </div>
                    <div className="truncate text-[11px] text-gray-500">
                      {[lead.childGrade ? `Gr ${lead.childGrade}` : '',
                        LEAD_REASON_LABELS[lead.reason] || ''].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  <LeadStoryGrid lead={lead} tone={tone} />
                  <div className="text-right">
                    {quiet === null ? (
                      <span className="text-[11px] text-gray-300">—</span>
                    ) : (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ring-1 ${PILL[tone]}`}>
                        {quiet}d
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
