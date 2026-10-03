import { useMemo, useState } from 'react';
import {
  CalendarClock, PhoneCall, UserX, CalendarX, HelpCircle, Clock, Check, ChevronRight,
} from 'lucide-react';
import {
  worklist, ownedBy, unassigned, familyLabel, monthKpis,
  DAYS_TO_ASSESSMENT_GOAL,
} from '../lib/leadFollowUp';

/**
 * Who needs you today, and what to say when they pick up.
 *
 * The top of the Leads page, because it is the question the page gets
 * opened to answer. Vin's tracker has no dashboard on it — it has a row
 * per family and a Notes column, and the work is reading down the rows.
 * So this is a list of people, each with the sentence a person would say
 * out loud about why they are on it, and a way in to the lead.
 *
 * EVERY LEAD APPEARS AT MOST ONCE. A family who no-showed and has an
 * overdue follow-up is one phone call; a list that counts them twice is
 * a list nobody believes the length of. The picking is in leadFollowUp.js.
 */

const ICON = {
  'assessment-today':      CalendarClock,
  'assessment-tomorrow':   CalendarClock,
  'assessment-unrecorded': HelpCircle,
  'no-show':               UserX,
  cancelled:               CalendarX,
  'follow-up-due':         PhoneCall,
  'assessed-undecided':    Clock,
  'no-assessment':         PhoneCall,
};

const TONE = {
  0: { chip: 'bg-rose-100 text-rose-800',   bar: 'bg-rose-500' },     // today
  1: { chip: 'bg-amber-100 text-amber-800', bar: 'bg-amber-500' },    // overdue
  2: { chip: 'bg-sky-100 text-sky-800',     bar: 'bg-sky-500' },      // soon
  3: { chip: 'bg-gray-100 text-gray-700',   bar: 'bg-gray-300' },     // stale
};

const URGENCY_WORD = { 0: 'Today', 1: 'Overdue', 2: 'Soon', 3: 'Waiting' };

export default function LeadWorklist({ leads, me, onOpen }) {
  const [mineOnly, setMineOnly] = useState(false);
  const all = useMemo(() => worklist(leads), [leads]);
  const mine = useMemo(() => ownedBy(all, me), [all, me]);
  const items = mineOnly ? mine : all;
  const loose = useMemo(() => unassigned(leads), [leads]);
  const kpis = useMemo(() => monthKpis(leads), [leads]);

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">
            Needs you{items.length > 0 && <span className="ml-1.5 text-gray-400">{items.length}</span>}
          </h2>
          <p className="text-xs text-gray-500">
            One line per family, most urgent first. Each lead appears once.
          </p>
        </div>
        {me && mine.length > 0 && (
          <div className="inline-flex rounded-lg bg-gray-100 p-0.5 text-xs font-semibold">
            {[[false, `Everyone ${all.length}`], [true, `Mine ${mine.length}`]].map(([v, label]) => (
              <button key={String(v)} type="button" onClick={() => setMineOnly(v)}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  mineOnly === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
                }`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </header>

      {items.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <Check size={22} className="mx-auto mb-1.5 text-emerald-500" />
          <p className="text-sm font-semibold text-gray-700">
            {mineOnly ? 'Nothing waiting on you.' : 'Nobody is waiting on a call.'}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            Assessments get booked, follow-up dates come due, and this fills itself.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {items.map(it => {
            const Icon = ICON[it.kind] || PhoneCall;
            const tone = TONE[it.urgency] || TONE[3];
            return (
              <li key={it.id}>
                <button type="button" onClick={() => onOpen?.(it.lead)}
                  className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-gray-50">
                  <span className={`mt-0.5 h-8 w-1 shrink-0 rounded-full ${tone.bar}`} />
                  <Icon size={15} className="mt-1 shrink-0 text-gray-400" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <b className="truncate text-sm text-gray-900">{familyLabel(it.lead)}</b>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone.chip}`}>
                        {URGENCY_WORD[it.urgency]}
                      </span>
                      {it.lead.assignedTo
                        ? <span className="text-[11px] text-gray-500">{it.lead.assignedTo}</span>
                        : <span className="text-[11px] font-semibold text-amber-700">unassigned</span>}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-gray-600">{it.why}</span>
                  </span>
                  <ChevronRight size={14} className="mt-1.5 shrink-0 text-gray-300" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* The numbers from under Vin's table. Each says what it was
          measured on, so a rate can never quietly mean "the two rows that
          had the fields" — and a figure with nothing behind it says so
          rather than reading as zero. */}
      <footer className="grid grid-cols-2 gap-px border-t border-gray-100 bg-gray-100 sm:grid-cols-4">
        <Kpi label="Days to assessment"
          value={kpis.daysToAssessment === null ? '—' : kpis.daysToAssessment.toFixed(1)}
          sub={kpis.daysToAssessmentSample > 0
            ? `${kpis.daysToAssessmentSample} booked · goal under ${DAYS_TO_ASSESSMENT_GOAL}`
            : 'Nothing booked yet'}
          tone={kpis.meetsAssessmentGoal === null ? null : (kpis.meetsAssessmentGoal ? 'good' : 'bad')} />
        <Kpi label="Leads assessed"
          value={kpis.assessedRate === null ? '—' : `${Math.round(kpis.assessedRate * 100)}%`}
          sub={`${kpis.assessed} of ${kpis.leads}`} />
        <Kpi label="Never booked in" value={kpis.noAssessmentBooked}
          sub="No assessment on file"
          tone={kpis.noAssessmentBooked > 0 ? 'bad' : null} />
        <Kpi label="No-shows & cancellations" value={kpis.noShows + kpis.cancelled}
          sub={`${kpis.noShows} no-show · ${kpis.cancelled} cancelled`} />
      </footer>

      {loose.length > 0 && (
        <p className="border-t border-gray-100 px-4 py-2 text-xs text-amber-800">
          <b>{loose.length}</b> live lead{loose.length === 1 ? ' has' : 's have'} nobody on {loose.length === 1 ? 'it' : 'them'}.
          {' '}Set who new bookings go to in Centre Settings → Online Booking.
        </p>
      )}
    </section>
  );
}

function Kpi({ label, value, sub, tone }) {
  const colour = tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-700' : 'text-gray-900';
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${colour}`}>{value}</div>
      <div className="text-[10.5px] text-gray-500">{sub}</div>
    </div>
  );
}
