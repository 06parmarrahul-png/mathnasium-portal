/**
 * The lead inbox — the queue on the left, the whole family on the right.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * NO MODAL, BECAUSE THE WORK IS A LIST OF CALLS.
 *
 * The page it replaced put the call sheet at the top and everything you
 * would want while ringing somebody behind a dialog: open it, read, close
 * it, find your place again, open the next one. Six calls in a morning is
 * six round trips through a form.
 *
 * Here, clicking a name fills the right-hand pane — why they are on the
 * list, their whole story in order, the assessment write-up, and the box
 * to log what was just said. The queue never moves, so you work down it.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * THE STORY IS VERTICAL FOR A REASON. Once events carry paragraphs — an
 * assessment write-up is the thing everyone re-reads before picking up
 * the phone — a horizontal timeline has to truncate them. Down the page,
 * each paragraph sits beside its own dot and nothing is cut.
 *
 * EVERY LEAD APPEARS AT MOST ONCE in the queue; the picking is in
 * lib/leadFollowUp.js, and it is the same rule the tracker's Needs column
 * uses, so the two can never disagree about how much work there is.
 */

import { useMemo, useState } from 'react';
import {
  Phone, Search, CalendarPlus, Check, X, Pencil, MessageSquare, History,
} from 'lucide-react';
import {
  worklist, ownedBy, familyLabel, URGENCY, LEAD_REASON_LABELS,
} from '../lib/leadFollowUp';
import { familyKind } from '../lib/formerStudents';
import { LEAD_SOURCE_LABELS, appendLeadNote, updateLead } from '../lib/leads';
import { formatDay } from '../lib/leadStory';
import { todayISO } from '../lib/payProjection';
import { toast } from '../lib/notify';
import { LeadStorySpine, LeadStoryRail } from './LeadStory';

/** Urgency → how loud the row is. Rose is today, amber is late, sky is soon. */
const TONE = ['rose', 'amber', 'sky', 'slate'];
const AVATAR = {
  rose:  'bg-rose-100 text-rose-700',
  amber: 'bg-amber-100 text-amber-700',
  sky:   'bg-sky-100 text-sky-700',
  slate: 'bg-gray-100 text-gray-600',
};
const PILL = {
  rose:  'bg-rose-50 text-rose-700 ring-rose-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  sky:   'bg-sky-50 text-sky-700 ring-sky-200',
  slate: 'bg-gray-50 text-gray-600 ring-gray-200',
};

const GROUPS = [
  { label: 'Right now', of: (u) => u === URGENCY.today },
  { label: 'Overdue',   of: (u) => u === URGENCY.overdue },
  { label: 'Coming up', of: (u) => u === URGENCY.soon },
  { label: 'Gone quiet', of: (u) => u >= URGENCY.stale },
];

/** What the item is called, in two or three words, for the pill. */
const KIND_LABEL = {
  'assessment-today':      'Assessment today',
  'assessment-tomorrow':   'Assessment tomorrow',
  'assessment-unrecorded': 'Outcome blank',
  'no-show':               'No show',
  cancelled:               'Cancelled',
  'follow-up-due':         'Follow-up due',
  'assessed-undecided':    'Undecided',
  'no-assessment':         'Never booked',
};

const initialsOf = (name) => String(name || '').trim().split(/\s+/)
  .slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

const Chip = ({ children }) => (
  <span className="rounded bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium text-gray-600 ring-1 ring-gray-200">
    {children}
  </span>
);

const Btn = ({ icon: Icon, children, primary, onClick, disabled, href }) => {
  const cls = `inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition ${
    primary ? 'bg-gray-900 text-white hover:bg-gray-800'
      : 'bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50'} ${
    disabled ? 'pointer-events-none opacity-40' : ''}`;
  if (href) return <a href={href} className={cls}>{Icon ? <Icon size={13} /> : null}{children}</a>;
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls}>
      {Icon ? <Icon size={13} /> : null}{children}
    </button>
  );
};

export default function LeadInbox({
  leads, centerId, actor, me, studentIndex, onEdit, onConvert, onLose,
}) {
  const [mineOnly, setMineOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');

  const all = useMemo(() => worklist(leads), [leads]);
  const mine = useMemo(() => ownedBy(all, me), [all, me]);
  const scoped = mineOnly ? mine : all;

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter(it => (
      familyLabel(it.lead).toLowerCase().includes(q)
      || String(it.lead.parentPhone || '').includes(q)
      || String(it.lead.parentEmail || '').toLowerCase().includes(q)
    ));
  }, [scoped, query]);

  // Derived, not stored: whoever is selected if they are still in the
  // list, else the top of it. A lead that gets logged and drops off the
  // queue therefore hands the pane to the next call instead of blanking
  // it, and there is no state to fall out of step with the list.
  const current = items.find(it => it.id === selected) || items[0] || null;

  if (all.length === 0) {
    return (
      <section className="rounded-xl bg-white p-8 text-center ring-1 ring-gray-200">
        <Check className="mx-auto mb-2 text-emerald-600" size={22} />
        <h2 className="text-[15px] font-semibold text-gray-900">Nothing needs chasing.</h2>
        <p className="mt-1 text-[13px] text-gray-500">
          Every lead is either booked in, enrolled, or closed. New bookings land here on their own.
        </p>
      </section>
    );
  }

  return (
    <div className="grid items-start gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* ── The queue ─────────────────────────────────────────────── */}
      <section className="overflow-hidden rounded-xl bg-white ring-1 ring-gray-200">
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2">
          <Search size={14} className="shrink-0 text-gray-400" />
          <input value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search the queue"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-700 outline-none placeholder:text-gray-400" />
          <span className="shrink-0 rounded-full bg-gray-900 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white">
            {items.length}
          </span>
        </div>
        {mine.length > 0 && mine.length !== all.length ? (
          <button type="button" onClick={() => setMineOnly(v => !v)}
            className="w-full border-b border-gray-100 px-3 py-1.5 text-left text-[11px] font-semibold text-gray-600 hover:bg-gray-50">
            {mineOnly ? `Showing yours (${mine.length}) — show all ${all.length}` : `Show only mine (${mine.length})`}
          </button>
        ) : null}

        <div className="max-h-[70vh] overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-gray-500">Nobody matches that.</p>
          ) : GROUPS.map(g => {
            const rows = items.filter(it => g.of(it.urgency));
            if (rows.length === 0) return null;
            return (
              <div key={g.label}>
                <div className="sticky top-0 z-10 bg-gray-50/95 px-3 py-1.5 backdrop-blur">
                  <h3 className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                    {g.label} <span className="tabular-nums text-gray-400">{rows.length}</span>
                  </h3>
                </div>
                {rows.map(it => {
                  const tone = TONE[it.urgency] || 'slate';
                  const on = it.id === selected;
                  return (
                    <button key={it.id} type="button" onClick={() => setSelected(it.id)}
                      className={`block w-full border-l-2 px-3 py-2.5 text-left transition ${
                        on ? 'border-gray-900 bg-gray-50' : 'border-transparent hover:bg-gray-50/60'}`}>
                      <div className="flex items-center gap-2">
                        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold ${AVATAR[tone]}`}>
                          {initialsOf(it.lead.parentName || it.lead.childName)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-gray-900">
                          {it.lead.parentName || it.lead.childName || 'Unnamed lead'}
                        </span>
                        {familyKind(it.lead, studentIndex) === 'returning' ? (
                          <History size={12} className="shrink-0 text-violet-600" />
                        ) : null}
                        {it.lead.childGrade ? (
                          <span className="shrink-0 text-[10px] font-semibold text-gray-400">Gr {it.lead.childGrade}</span>
                        ) : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-gray-600">{it.why}</p>
                      <div className="mt-1.5 pr-1"><LeadStoryRail lead={it.lead} tone={tone} size={9} /></div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── The family ────────────────────────────────────────────── */}
      {current ? (
        <LeadPane key={current.id} item={current} centerId={centerId} actor={actor}
          studentIndex={studentIndex} onEdit={onEdit} onConvert={onConvert} onLose={onLose} />
      ) : (
        <section className="rounded-xl bg-white p-8 text-center text-[13px] text-gray-500 ring-1 ring-gray-200">
          Pick somebody from the queue.
        </section>
      )}
    </div>
  );
}

/**
 * One family, whole. Keyed on the lead id by the parent so the log box
 * empties when you move to the next call rather than carrying the last
 * person's sentence into it.
 */
function LeadPane({ item, centerId, actor, studentIndex, onEdit, onConvert, onLose }) {
  const lead = item.lead;
  const tone = TONE[item.urgency] || 'slate';
  const [note, setNote] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);

  const who = firstName(lead.parentName) || firstName(lead.childName);
  const returning = familyKind(lead, studentIndex) === 'returning';

  const log = async () => {
    if (!note.trim() && !next) { toast.info('Write what was said, or pick a day to ring back.'); return; }
    setSaving(true);
    try {
      if (note.trim()) await appendLeadNote(centerId, lead.id, note, actor);
      await updateLead(centerId, lead.id, {
        lastContactOn: todayISO(),
        // Only written when they picked one. Clearing it by accident
        // takes the family OFF the list rather than putting them on it.
        ...(next ? { followUpOn: next } : {}),
      });
      setNote(''); setNext('');
      toast.success('Logged.');
    } catch (e) {
      toast.error(e.message || 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <section className="rounded-xl bg-white p-4 ring-1 ring-gray-200">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[19px] font-bold text-gray-900">
                {lead.childName || lead.parentName || 'Unnamed lead'}
              </h2>
              {lead.childGrade ? <Chip>Grade {lead.childGrade}</Chip> : null}
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${PILL[tone]}`}>
                {KIND_LABEL[item.kind] || 'Needs a call'}
              </span>
              {returning ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200">
                  <History size={11} /> Been here before
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-[13px] text-gray-600">
              {[lead.parentName, lead.parentPhone, lead.childSchool].filter(Boolean).join(' · ')
                || 'No contact details on file.'}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Btn icon={Phone} primary href={lead.parentPhone ? `tel:${lead.parentPhone}` : undefined}
              disabled={!lead.parentPhone}>
              {lead.parentPhone ? `Call ${who}` : 'No number'}
            </Btn>
            <Btn icon={CalendarPlus} onClick={() => onEdit?.(lead)}>Book</Btn>
            <Btn icon={Check} onClick={() => onConvert?.(lead)}>Enrolled</Btn>
            <Btn icon={X} onClick={() => onLose?.(lead)}>Lost</Btn>
            <Btn icon={Pencil} onClick={() => onEdit?.(lead)}>Edit</Btn>
          </div>
        </div>

        {/* Why they are on the list, in the words somebody would say. */}
        <div className="mt-3 rounded-lg bg-gray-900 px-3 py-2.5">
          <p className="text-[13px] font-medium text-white">{item.why}</p>
        </div>
      </section>

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="rounded-xl bg-white p-4 ring-1 ring-gray-200">
          <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wide text-gray-500">Their story</h3>
          <LeadStorySpine lead={lead} tone={tone} />
        </section>

        <div className="space-y-3">
          <section className="rounded-xl bg-white p-4 ring-1 ring-gray-200">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-500">Log this call</h3>
            <textarea rows={3} value={note} onChange={e => setNote(e.target.value)}
              placeholder="e.g. Left a voicemail · Mum will talk to dad and ring back Friday"
              className="w-full rounded-lg border border-gray-300 px-2.5 py-2 text-[12px] focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400" />
            <label className="mt-2 block">
              <span className="mb-1 block text-[11px] font-semibold text-gray-600">Ring them back on</span>
              <input type="date" value={next} onChange={e => setNext(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-[12px] focus:border-red-400 focus:outline-none" />
            </label>
            <p className="mt-1 text-[10px] leading-snug text-gray-500">
              Leave it blank and they stay on the list for the reason they are already on it.
            </p>
            <button type="button" onClick={log} disabled={saving}
              className="mt-2 w-full rounded-lg bg-red-600 px-3 py-2 text-[13px] font-semibold text-white hover:bg-red-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Log it'}
            </button>
          </section>

          <section className="rounded-xl bg-white p-4 ring-1 ring-gray-200">
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-500">Detail</h3>
            <dl className="space-y-1.5 text-[12px]">
              {[
                ['Why they called', LEAD_REASON_LABELS[lead.reason] || ''],
                ['Source', LEAD_SOURCE_LABELS[lead.source] || lead.source],
                ['Owner', lead.assignedTo],
                ['Toured by', lead.tourBy],
                ['Assessed by', lead.assessedBy],
                ['Last contact', formatDay(lead.lastContactOn)],
                ['Follow-up on', formatDay(lead.followUpOn)],
                ['Email', lead.parentEmail],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="shrink-0 text-gray-500">{k}</dt>
                  <dd className={`min-w-0 truncate text-right font-medium ${v ? 'text-gray-900' : 'text-gray-300'}`}>
                    {v || '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {(lead.history || []).length > 0 ? (
            <section className="rounded-xl bg-white p-4 ring-1 ring-gray-200">
              <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <MessageSquare size={12} /> Everything logged
              </h3>
              <div className="max-h-56 space-y-1.5 overflow-y-auto">
                {(lead.history || []).slice().reverse().map((h, i) => (
                  <div key={i} className="text-[11px] leading-snug">
                    <span className="text-gray-400">{String(h.at || '').slice(0, 10)}</span>
                    {h.by ? <span className="text-gray-400"> · {h.by}</span> : null}
                    <span className="mt-0.5 block text-gray-700">{h.text}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
