import { useMemo, useState } from 'react';
import {
  Phone, CalendarClock, UserX, CalendarX, HelpCircle, Clock, Check,
  MessageSquare, CalendarPlus,
} from 'lucide-react';
import {
  worklist, ownedBy, unassigned, monthKpis, DAYS_TO_ASSESSMENT_GOAL,
} from '../lib/leadFollowUp';
import { familyKind } from '../lib/formerStudents';

/**
 * The call sheet — who needs you, grouped by when.
 *
 * The top of the Leads page, because it is the question the page gets
 * opened to answer. It replaced a flat list with a stats bar bolted
 * underneath, which said everything at once and so said nothing first.
 *
 * GROUPED BY WHEN, NOT BY WHAT KIND OF PROBLEM IT IS. "Right now /
 * Overdue / Coming up" is the order somebody works a morning in; a
 * heading per kind ("No-shows", "Undecided") sorts the list by the
 * system's vocabulary instead of theirs, and makes you read all of it to
 * find the first call.
 *
 * THE ACTIONS ARE ON THE ROW. Dial, log what was said, book them in —
 * the three things that actually happen after reading a line. Making
 * each of them a drawer-open-then-scroll is how a worklist turns into a
 * list people read and then do nothing about.
 *
 * EVERY LEAD APPEARS AT MOST ONCE; the picking is in leadFollowUp.js.
 */

const ICON = {
  'assessment-today':      CalendarClock,
  'assessment-tomorrow':   CalendarClock,
  'assessment-unrecorded': HelpCircle,
  'no-show':               UserX,
  cancelled:               CalendarX,
  'follow-up-due':         Phone,
  'assessed-undecided':    Clock,
  'no-assessment':         Phone,
};

/** Urgency → the avatar's colour. Rose is today, amber is late, sky is soon. */
const AVATAR = ['bg-rose-100 text-rose-700', 'bg-amber-100 text-amber-700',
  'bg-sky-100 text-sky-700', 'bg-gray-100 text-gray-600'];

const GROUPS = [
  { label: 'Right now', of: (u) => u === 0 },
  { label: 'Overdue',   of: (u) => u === 1 },
  { label: 'Coming up', of: (u) => u >= 2 },
];

const initialsOf = (name) => String(name || '').trim().split(/\s+/)
  .slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';

export default function LeadWorklist({ leads, me, studentIndex, onOpen, onLogContact, onBook }) {
  const [mineOnly, setMineOnly] = useState(false);
  const all = useMemo(() => worklist(leads), [leads]);
  const mine = useMemo(() => ownedBy(all, me), [all, me]);
  const items = mineOnly ? mine : all;
  const loose = useMemo(() => unassigned(leads), [leads]);

  const groups = GROUPS
    .map(g => ({ ...g, items: items.filter(i => g.of(i.urgency)) }))
    .filter(g => g.items.length > 0);

  return (
    <section className="space-y-3">
      <DayBar leads={leads} items={all} />

      {me && mine.length > 0 && all.length !== mine.length && (
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

      {groups.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-8 text-center shadow-sm">
          <Check size={22} className="mx-auto mb-1.5 text-emerald-500" />
          <p className="text-sm font-semibold text-gray-700">
            {mineOnly ? 'Nothing waiting on you.' : 'Nobody is waiting on a call.'}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            Assessments get booked, follow-up dates come due, and this fills itself.
          </p>
        </div>
      ) : groups.map(group => (
        <div key={group.label}>
          <h3 className="mb-1.5 flex items-baseline gap-2 px-0.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{group.label}</span>
            <span className="text-[11px] font-semibold text-gray-400">{group.items.length}</span>
          </h3>
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            {group.items.map(it => (
              <Row key={it.id} item={it} kind={familyKind(it.lead, studentIndex)}
              onOpen={onOpen} onLogContact={onLogContact} onBook={onBook} />
            ))}
          </ul>
        </div>
      ))}

      {loose.length > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <b>{loose.length}</b> live lead{loose.length === 1 ? ' has' : 's have'} nobody on {loose.length === 1 ? 'it' : 'them'}.
          {' '}Set who new bookings go to in Centre Settings → Online Booking.
        </p>
      )}
    </section>
  );
}

function Row({ item, kind, onOpen, onLogContact, onBook }) {
  const { lead } = item;
  const Icon = ICON[item.kind] || Phone;
  return (
    <li className="flex items-center gap-3 px-3.5 py-3 hover:bg-gray-50">
      <button type="button" onClick={() => onOpen?.(lead)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${AVATAR[item.urgency] || AVATAR[3]}`}>
          {initialsOf(lead.parentName || lead.childName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <b className="text-[14px] text-gray-900">{lead.parentName || lead.childName || 'Unnamed lead'}</b>
            {lead.childName && lead.parentName && (
              <span className="text-[12.5px] text-gray-500">
                {lead.childName}{lead.childGrade ? ` · Gr ${lead.childGrade}` : ''}
              </span>
            )}
            {/* Returning is worth saying; "new" is the default and a badge
                on every row is noise. Nothing at all until the student
                export is in, because then there is nothing to know. */}
            {kind === 'returning' && (
              <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-800">
                Returning
              </span>
            )}
            {!lead.assignedTo && (
              <span className="text-[11px] font-semibold text-amber-700">unassigned</span>
            )}
          </span>
          <span className="mt-0.5 flex items-start gap-1.5 text-[12.5px] leading-snug text-gray-600">
            <Icon size={13} className="mt-0.5 shrink-0 text-gray-400" /> {item.why}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {/* A real tel: link, so it dials on a phone and hands the number
            to the desk phone's handler on a desktop. */}
        {lead.parentPhone ? (
          <a href={`tel:${lead.parentPhone}`} title={`Call ${lead.parentPhone}`}
            aria-label={`Call ${lead.parentPhone}`}
            className="rounded-lg border border-gray-300 bg-white p-1.5 text-gray-600 hover:bg-gray-50">
            <Phone size={14} />
          </a>
        ) : (
          <span className="rounded-lg border border-gray-200 p-1.5 text-gray-300" title="No phone number on this lead">
            <Phone size={14} />
          </span>
        )}
        <button type="button" onClick={() => onLogContact?.(lead)}
          title="Log what was said" aria-label={`Log contact with ${lead.parentName || 'this lead'}`}
          className="rounded-lg border border-gray-300 bg-white p-1.5 text-gray-600 hover:bg-gray-50">
          <MessageSquare size={14} />
        </button>
        <button type="button" onClick={() => onBook?.(lead)}
          title="Book the assessment" aria-label={`Book an assessment for ${lead.parentName || 'this lead'}`}
          className="rounded-lg border border-gray-300 bg-white p-1.5 text-gray-600 hover:bg-gray-50">
          <CalendarPlus size={14} />
        </button>
      </div>
    </li>
  );
}

/**
 * The day in one line: what is waiting, then the numbers from under
 * Vin's table. Each figure says what it was measured on, and a rate with
 * nothing to divide by prints "—" rather than 0% — "nothing has happened
 * yet" and "nothing worked" are different facts.
 */
function DayBar({ leads, items }) {
  const k = useMemo(() => monthKpis(leads), [leads]);
  const today = items.filter(i => i.urgency === 0).length;
  const over = items.filter(i => i.urgency === 1).length;
  return (
    <div className="flex flex-wrap items-center rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm"
      style={{ columnGap: 22, rowGap: 8 }}>
      <Fig big n={today + over} label="need a call" />
      <span className="h-8 w-px bg-gray-200" />
      <Fig n={today} label="today" tone={today > 0 ? 'rose' : null} />
      <Fig n={over} label="overdue" tone={over > 0 ? 'amber' : null} />
      <span className="h-8 w-px bg-gray-200" />
      <Fig n={k.daysToAssessment === null ? '—' : k.daysToAssessment.toFixed(1)}
        label={`days to assess · goal <${DAYS_TO_ASSESSMENT_GOAL}`}
        tone={k.meetsAssessmentGoal === null ? null : (k.meetsAssessmentGoal ? 'emerald' : 'rose')} />
      <Fig n={k.assessedRate === null ? '—' : `${Math.round(k.assessedRate * 100)}%`}
        label={`assessed · ${k.assessed}/${k.leads}`} />
      <Fig n={k.noAssessmentBooked} label="never booked in"
        tone={k.noAssessmentBooked > 0 ? 'amber' : null} />
      <Fig n={k.noShows + k.cancelled} label="no-show / cancelled" />
    </div>
  );
}

function Fig({ n, label, tone, big }) {
  const colour = tone === 'rose' ? 'text-rose-700'
    : tone === 'amber' ? 'text-amber-700'
      : tone === 'emerald' ? 'text-emerald-700' : 'text-gray-900';
  return (
    <div className="whitespace-nowrap">
      <div className={`font-bold leading-none tabular-nums ${big ? 'text-[22px]' : 'text-[17px]'} ${colour}`}>{n}</div>
      <div className="mt-0.5 text-[11px] text-gray-500">{label}</div>
    </div>
  );
}
