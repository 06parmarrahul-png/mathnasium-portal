// Leads — the top of the funnel.
//
// FOUR VIEWS, ONE QUESTION EACH.
//
//   Inbox      who do I ring, right now?
//   Pipeline   where is everybody standing?
//   Tracker    Vin's spreadsheet, month by month, with his KPIs.
//   Call backs families who were here before and are worth another call.
//
// It replaced a single page of seven stacked panels — day bar, call
// sheet, funnel strip, search, call-backs, import, tracker table, source
// breakdown — all the same size and all demanding attention at once, so
// none of them got it. The work is a list of phone calls; everything
// else is reference you visit on purpose.

import { useEffect, useMemo, useState } from 'react';
import {
  Plus, Search, X, ArrowRight, UserPlus, Trash2, TrendingUp, Filter,
  Inbox, GitBranch, Table2, History,
} from 'lucide-react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { useTimeFormat } from '../lib/useTimeFormat';
import {
  watchLeads, createLead, updateLead, setLeadStatus, deleteLead,
  appendLeadNote, appendAssessmentNote, convertLeadToStudent,
  LEAD_STATUSES, LEAD_STATUS_LABELS, LEAD_STATUS_STYLES,
  LEAD_SOURCES, LEAD_SOURCE_LABELS,
  funnelCounts, conversionRate, sourceBreakdown,
} from '../lib/leads';
import { toast, confirmDialog } from '../lib/notify';
import LeadInbox from '../components/LeadInbox';
import LeadStageTable from '../components/LeadStageTable';
import LeadTracker from '../components/LeadTracker';
import LeadTable from '../components/LeadTable';
import RadiusLeadImport from '../components/RadiusLeadImport';
import LeadTrackerImport from '../components/LeadTrackerImport';
import FormerStudents from '../components/FormerStudents';
import { buildStudentIndex } from '../lib/formerStudents';
import {
  worklist, LEAD_REASONS, LEAD_REASON_LABELS,
  ASSESSMENT_OUTCOMES, ASSESSMENT_OUTCOME_LABELS,
} from '../lib/leadFollowUp';

const VIEWS = [
  { key: 'inbox',     label: 'Inbox',      icon: Inbox },
  { key: 'pipeline',  label: 'Pipeline',   icon: GitBranch },
  { key: 'tracker',   label: 'Tracker',    icon: Table2 },
  { key: 'callbacks', label: 'Call backs', icon: History },
];

export default function Leads() {
  const { activeCenterId: centerId, profile } = useAuth();
  const [leads, setLeads] = useState([]);
  const [view, setView] = useState('inbox');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | status
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // Former students, read once for the page so every row can say whether
  // this family has been here before. Empty until the export is
  // imported, and familyKind() answers null rather than guessing.
  const [formerStudents, setFormerStudents] = useState([]);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (!centerId) return;
    return watchLeads(centerId, setLeads);
  }, [centerId]);

  // Read here rather than inside the Call backs tab: every view wants to
  // know whether a family has been here before, and a badge that only
  // appears once you have visited another tab is a badge nobody trusts.
  useEffect(() => {
    if (!centerId) return undefined;
    return onSnapshot(
      collection(db, 'centers', centerId, 'formerStudents'),
      snap => setFormerStudents(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      // A centre that has never imported the export, or a reader without
      // the rule for it, gets an empty index — and familyKind() answers
      // null rather than guessing that everybody is new.
      () => setFormerStudents([]),
    );
  }, [centerId]);

  const counts = useMemo(() => funnelCounts(leads), [leads]);
  const conv = useMemo(() => conversionRate(leads), [leads]);
  const sources = useMemo(() => sourceBreakdown(leads), [leads]);
  // The same count the Inbox shows, from the same rule, so the tab badge
  // and the queue can never disagree about how much work there is.
  const todo = useMemo(() => worklist(leads).length, [leads]);

  // Newest-first list, narrowed by status + free-text search.
  const visible = useMemo(() => {
    let list = leads;
    if (statusFilter !== 'all') list = list.filter(l => l.status === statusFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(l =>
        (l.parentName || '').toLowerCase().includes(q) ||
        (l.childName  || '').toLowerCase().includes(q) ||
        (l.parentEmail || '').toLowerCase().includes(q) ||
        (l.parentPhone || '').includes(q) ||
        (l.notes || '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [leads, statusFilter, search]);

  const studentIndex = useMemo(() => buildStudentIndex(formerStudents), [formerStudents]);
  const editing = editingId ? leads.find(l => l.id === editingId) : null;

  // Enrolling and losing a lead are the two endings, and both are worth
  // a confirm — one writes a student onto the roster, the other takes a
  // family off every list the centre looks at.
  const handleConvert = async (lead) => {
    const ok = await confirmDialog({
      title: 'Convert to student?',
      message: `This creates a row in your Student Scheduler roster for "${lead.childName || lead.parentName}" and marks this lead Enrolled.`,
      confirmText: 'Convert',
    });
    if (!ok) return;
    try {
      await convertLeadToStudent(centerId, lead.id, profile);
      toast.success('Converted to student and marked enrolled.');
    } catch (e) { toast.error(e.message); }
  };

  const handleLose = async (lead) => {
    const ok = await confirmDialog({
      title: 'Close this lead?',
      message: `"${lead.childName || lead.parentName}" comes off the call sheet. The record stays in the tracker.`,
      confirmText: 'Close it',
    });
    if (!ok) return;
    try {
      await setLeadStatus(centerId, lead.id, 'lost', profile);
      toast.success('Closed.');
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Leads</h1>
          <p className="text-sm text-gray-500">
            Who to ring, where everyone is standing, and the tracker behind it.
          </p>
        </div>
        <button onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700">
          <Plus size={16} /> Add lead
        </button>
      </div>

      {/* ── One view at a time ─────────────────────────────────────
          Seven panels of equal weight said everything at once and so
          said nothing first. These are four doors, and the badge on the
          first one is the only number that needs to be seen on arrival. */}
      <div className="flex flex-wrap items-center gap-1 rounded-xl bg-white p-1 ring-1 ring-gray-200">
        {VIEWS.map(v => {
          const on = view === v.key;
          const Icon = v.icon;
          return (
            <button key={v.key} type="button" onClick={() => setView(v.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${
                on ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
              <Icon size={14} />
              {v.label}
              {v.key === 'inbox' && todo > 0 ? (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                  on ? 'bg-rose-500 text-white' : 'bg-rose-100 text-rose-700'}`}>
                  {todo}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* ── Inbox: queue left, the whole family right ───────────────── */}
      {view === 'inbox' && (
        <LeadInbox
          leads={leads}
          centerId={centerId}
          actor={profile}
          me={profile?.displayName || ''}
          studentIndex={studentIndex}
          onEdit={lead => setEditingId(lead.id)}
          onConvert={handleConvert}
          onLose={handleLose}
        />
      )}

      {/* ── Pipeline: where everybody is standing ───────────────────── */}
      {view === 'pipeline' && (
        <div className="space-y-4">
          <LeadStageTable leads={leads} onOpen={lead => setEditingId(lead.id)} />

          {/* Funnel stats strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {LEAD_STATUSES.map(s => (
              <button key={s}
                onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
                className={`rounded-lg border bg-white p-3 text-left transition-colors ${
                  statusFilter === s
                    ? `${LEAD_STATUS_STYLES[s].ring} ring-2 border-transparent`
                    : 'border-gray-200 hover:border-gray-300'
                }`}>
                <div className="flex items-center justify-between">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${LEAD_STATUS_STYLES[s].text}`}>
                    <span className={`h-2 w-2 rounded-full ${LEAD_STATUS_STYLES[s].dot}`} />
                    {LEAD_STATUS_LABELS[s]}
                  </span>
                </div>
                <div className="mt-1 text-2xl font-bold text-gray-900">{counts[s]}</div>
              </button>
            ))}
            {/* Conversion tile: enrolled / (enrolled + lost) */}
            <div className="rounded-lg border border-gray-200 bg-gradient-to-br from-emerald-50 to-white p-3">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                <TrendingUp size={12} /> Conversion
              </span>
              <div className="mt-1 text-2xl font-bold text-emerald-700">
                {conv == null ? '—' : `${Math.round(conv * 100)}%`}
              </div>
              <div className="text-[10px] text-emerald-700/70">enrolled / (enrolled + lost)</div>
            </div>
          </div>

          {/* Search + filter row */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name, email, phone, notes…"
                className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-8 pr-3 text-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400"
              />
            </div>
            {statusFilter !== 'all' && (
              <button onClick={() => setStatusFilter('all')}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-50">
                <Filter size={12} /> {LEAD_STATUS_LABELS[statusFilter]} <X size={12} />
              </button>
            )}
          </div>

          <LeadTable leads={visible} studentIndex={studentIndex}
            showArchived={showArchived} onToggleArchived={() => setShowArchived(v => !v)}
            onOpen={lead => setEditingId(lead.id)}
            emptyNote={leads.length === 0
              ? "No leads yet. Add one, or wait for an assessment booking — every booking, through Ratio or Apptoto, writes a lead."
              : 'No leads match this filter.'} />

          {leads.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-gray-900">Where leads come from</h2>
              <SourceTable sources={sources} />
            </div>
          )}
        </div>
      )}

      {/* ── Tracker: the spreadsheet, month by month ────────────────── */}
      {view === 'tracker' && (
        <div className="space-y-4">
          <LeadTracker leads={leads} onOpen={lead => setEditingId(lead.id)} />
          {/* The layout is only half of it — the workbook's own families
              go in here, which is what stops the sheet being kept open in
              the other window. */}
          <LeadTrackerImport centerId={centerId} />
        </div>
      )}

      {/* ── Call backs: bringing the history across ─────────────────── */}
      {view === 'callbacks' && (
        <div className="space-y-4">
          <FormerStudents centerId={centerId} actor={profile} />
          <RadiusLeadImport centerId={centerId} />
        </div>
      )}

      {/* ── Add lead modal ────────────────────────────────────────── */}
      {showAdd && (
        <LeadModal
          centerId={centerId}
          actor={profile}
          onClose={() => setShowAdd(false)}
        />
      )}

      {/* ── Edit / detail modal ───────────────────────────────────── */}
      {editing && (
        <LeadModal
          centerId={centerId}
          actor={profile}
          lead={editing}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

// ─── Lead modal (add + edit) ──────────────────────────────────────────
function LeadModal({ centerId, actor, lead, onClose }) {
  const fmtTime = useTimeFormat();
  const isEdit = !!lead;
  const [form, setForm] = useState(() => ({
    parentName:   lead?.parentName   || '',
    parentEmail:  lead?.parentEmail  || '',
    parentPhone:  lead?.parentPhone  || '',
    childName:    lead?.childName    || '',
    childGrade:   lead?.childGrade   || '',
    childSchool:  lead?.childSchool  || '',
    source:       lead?.source       || 'other',
    sourceDetail: lead?.sourceDetail || '',
    notes:        lead?.notes        || '',
    assignedTo:   lead?.assignedTo   || '',
    status:       lead?.status       || 'new',
    // The tracker's own columns. Blank on an older lead, which is the
    // truth about it rather than a gap to apologise for.
    reason:            lead?.reason            || '',
    assessmentOn:      lead?.assessmentOn      || '',
    assessmentOutcome: lead?.assessmentOutcome || '',
    tourBy:            lead?.tourBy            || '',
    assessedBy:        lead?.assessedBy        || '',
    followUpOn:        lead?.followUpOn        || '',
    outcomeReason:     lead?.outcomeReason     || '',
  }));
  const [noteDraft, setNoteDraft] = useState('');
  const [assessDraft, setAssessDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm(s => ({ ...s, ...patch }));

  const handleSave = async () => {
    if (!form.parentName && !form.childName) {
      toast.error('Add a parent or child name.');
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        await updateLead(centerId, lead.id, form);
        // Status change goes through its own helper so we get history.
        if (form.status !== lead.status) {
          await setLeadStatus(centerId, lead.id, form.status, actor);
        }
        toast.success('Lead updated.');
      } else {
        await createLead(centerId, form, actor);
        toast.success('Lead added.');
      }
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleAddNote = async () => {
    if (!noteDraft.trim()) return;
    try {
      await appendLeadNote(centerId, lead.id, noteDraft, actor);
      setNoteDraft('');
      toast.success('Note added.');
    } catch (e) { toast.error(e.message); }
  };

  const handleConvert = async () => {
    const ok = await confirmDialog({
      title: 'Convert to student?',
      message: `This creates a row in your Student Scheduler roster for "${form.childName || form.parentName}" and marks this lead Enrolled.`,
      confirmText: 'Convert',
    });
    if (!ok) return;
    try {
      await convertLeadToStudent(centerId, lead.id, actor);
      toast.success('Converted to student and marked enrolled.');
      onClose();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: 'Delete this lead?',
      message: 'This permanently removes the lead and its history.',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLead(centerId, lead.id);
      toast.success('Lead deleted.');
      onClose();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{isEdit ? 'Lead' : 'Add lead'}</h2>
            {isEdit && (
              <p className="text-xs text-gray-500 mt-0.5">
                Created {formatDate(lead.createdAt, fmtTime)}
                {lead.enrolledAt && ` · Enrolled ${formatDate(lead.enrolledAt, fmtTime)}`}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {/* Status pipeline */}
          {isEdit && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">Funnel stage</label>
              <div className="flex flex-wrap gap-1">
                {LEAD_STATUSES.map(s => {
                  const active = form.status === s;
                  const styles = LEAD_STATUS_STYLES[s];
                  return (
                    <button key={s}
                      onClick={() => set({ status: s })}
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                        active
                          ? `${styles.bg} ${styles.text} ring-2 ${styles.ring}`
                          : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50'
                      }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
                      {LEAD_STATUS_LABELS[s]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Parent / child grid */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Parent name">
              <input value={form.parentName} onChange={e => set({ parentName: e.target.value })}
                className={inputCls} placeholder="e.g. Jane Smith" />
            </Field>
            <Field label="Child name">
              <input value={form.childName} onChange={e => set({ childName: e.target.value })}
                className={inputCls} placeholder="e.g. Sam Smith" />
            </Field>
            <Field label="Parent email">
              <input type="email" value={form.parentEmail} onChange={e => set({ parentEmail: e.target.value })}
                className={inputCls} placeholder="parent@example.com" />
            </Field>
            <Field label="Parent phone">
              <input type="tel" value={form.parentPhone} onChange={e => set({ parentPhone: e.target.value })}
                className={inputCls} placeholder="604-555-0100" />
            </Field>
            <Field label="Child grade">
              <input value={form.childGrade} onChange={e => set({ childGrade: e.target.value })}
                className={inputCls} placeholder="K – 12" />
            </Field>
            <Field label="Child school">
              <input value={form.childSchool} onChange={e => set({ childSchool: e.target.value })}
                className={inputCls} placeholder="e.g. Walnut Grove Secondary" />
            </Field>
          </div>

          {/* Source + assignment */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Source">
              <select value={form.source} onChange={e => set({ source: e.target.value })}
                className={inputCls}>
                {LEAD_SOURCES.map(s => (
                  <option key={s} value={s}>{LEAD_SOURCE_LABELS[s]}</option>
                ))}
              </select>
            </Field>
            <Field label="Source detail (optional)">
              <input value={form.sourceDetail} onChange={e => set({ sourceDetail: e.target.value })}
                className={inputCls} placeholder="e.g. Referred by Sarah J." />
            </Field>
            <Field label="Assigned to (optional)" className="md:col-span-2">
              <input value={form.assignedTo} onChange={e => set({ assignedTo: e.target.value })}
                className={inputCls} placeholder="Staff member tracking this lead" />
            </Field>
          </div>

          {/* ── The assessment, and what to do next ──────────────────
              These are the columns the Lead Tracker is actually worked
              in. Between them they are what the follow-up list reads:
              a date with no outcome becomes "did they come in?", a
              no-show becomes "rebook it", a follow-up date becomes a
              call due that morning. */}
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-500">
              The assessment
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Why they called">
                <select value={form.reason} onChange={e => set({ reason: e.target.value })}
                  className={inputCls}>
                  <option value="">Not recorded</option>
                  {LEAD_REASONS.map(r => (
                    <option key={r} value={r}>{LEAD_REASON_LABELS[r]}</option>
                  ))}
                </select>
              </Field>
              <Field label="Assessment date">
                <input type="date" value={form.assessmentOn}
                  onChange={e => set({ assessmentOn: e.target.value })} className={inputCls} />
              </Field>
              <Field label="What happened">
                <select value={form.assessmentOutcome}
                  onChange={e => set({ assessmentOutcome: e.target.value })} className={inputCls}>
                  <option value="">Not recorded</option>
                  {ASSESSMENT_OUTCOMES.map(o => (
                    <option key={o} value={o}>{ASSESSMENT_OUTCOME_LABELS[o]}</option>
                  ))}
                </select>
              </Field>
              <Field label="Next follow-up">
                <input type="date" value={form.followUpOn}
                  onChange={e => set({ followUpOn: e.target.value })} className={inputCls} />
              </Field>
              <Field label="Toured by">
                <input value={form.tourBy} onChange={e => set({ tourBy: e.target.value })}
                  className={inputCls} placeholder="e.g. Sabrina" />
              </Field>
              <Field label="Assessed by">
                <input value={form.assessedBy} onChange={e => set({ assessedBy: e.target.value })}
                  className={inputCls} placeholder="e.g. Vin — or Sabrina / Vin for both" />
              </Field>
              {/* THE WRITE-UP. Its own field rather than a line in the
                  event log, because it is the one entry anybody re-reads
                  before picking up the phone — and in the log it sits
                  three scrolls under "Status moved to Assessed". */}
              {isEdit && (
                <div className="md:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-gray-700">
                    What the assessment found
                  </label>
                  {(lead.assessmentNotes || []).length > 0 && (
                    <ul className="mb-2 space-y-1.5 rounded-lg border border-gray-200 bg-white p-2">
                      {lead.assessmentNotes.map((n, i) => (
                        <li key={i} className="text-xs leading-snug text-gray-700">
                          <span className="font-semibold text-gray-500">
                            {String(n.at).slice(0, 10)} · {n.by}
                          </span>
                          <span className="mt-0.5 block whitespace-pre-wrap">{n.text}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <textarea rows={3} value={assessDraft} onChange={e => setAssessDraft(e.target.value)}
                    className={inputCls}
                    placeholder="e.g. Two grades behind on fractions, strong on mental maths. Mum was sold; dad needs convincing on price." />
                  <button type="button" disabled={!assessDraft.trim()}
                    onClick={async () => {
                      await appendAssessmentNote(centerId, lead.id, assessDraft, actor);
                      setAssessDraft('');
                      toast.success('Added to the write-up.');
                    }}
                    className="mt-1.5 rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                    Add to the write-up
                  </button>
                  <p className="mt-1 text-[11px] text-gray-500">
                    Appended, never overwritten — a second visit reads under the first.
                  </p>
                </div>
              )}
              <Field label="Why they did or didn't" className="md:col-span-2">
                <input value={form.outcomeReason} onChange={e => set({ outcomeReason: e.target.value })}
                  className={inputCls}
                  placeholder="e.g. Enrolled on the spot · Needs to discuss with wife · Went with Kumon on price" />
              </Field>
            </div>
          </div>

          {/* Notes — persistent free text */}
          <Field label="Notes">
            <textarea value={form.notes} onChange={e => set({ notes: e.target.value })}
              rows={3} className={inputCls}
              placeholder="Anything to remember about this family." />
          </Field>

          {/* Activity log (edit mode only) */}
          {isEdit && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-700">Activity</label>
              <div className="space-y-1 rounded border border-gray-200 bg-gray-50 p-2 max-h-48 overflow-y-auto">
                {(lead.history || []).slice().reverse().map((h, i) => (
                  <div key={i} className="text-xs">
                    <span className="text-gray-400">{formatDate(h.at, fmtTime)}</span>
                    <span className="mx-1.5 text-gray-300">·</span>
                    <span className="text-gray-500">{h.by}</span>
                    <span className="mx-1.5 text-gray-300">·</span>
                    <span className="text-gray-700">{h.text}</span>
                  </div>
                ))}
                {(!lead.history || lead.history.length === 0) && (
                  <div className="text-xs text-gray-400">No activity yet.</div>
                )}
              </div>
              <div className="mt-2 flex gap-2">
                <input value={noteDraft} onChange={e => setNoteDraft(e.target.value)}
                  className={inputCls + ' flex-1'}
                  placeholder="Log a contact attempt, observation, etc."
                  onKeyDown={e => e.key === 'Enter' && handleAddNote()} />
                <button onClick={handleAddNote}
                  className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-200">
                  Add note
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-gray-200 bg-white px-5 py-3">
          {isEdit && form.status !== 'enrolled' && (
            <button onClick={handleConvert}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              <UserPlus size={14} /> Convert to student
            </button>
          )}
          {isEdit && (
            <button onClick={handleDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50">
              <Trash2 size={14} /> Delete
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
              {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Add lead')}
              {!isEdit && <ArrowRight size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-medium text-gray-700">{label}</label>
      {children}
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-400';

// ─── Source breakdown table ───────────────────────────────────────────
function SourceTable({ sources }) {
  const entries = Object.entries(sources)
    .filter(([, v]) => v.total > 0)
    .sort((a, b) => b[1].total - a[1].total);
  if (entries.length === 0) return <div className="text-xs text-gray-500">No data yet.</div>;
  return (
    <table className="w-full text-sm">
      <thead className="text-[10px] uppercase text-gray-500">
        <tr>
          <th className="text-left font-medium pb-1">Source</th>
          <th className="text-right font-medium pb-1">Leads</th>
          <th className="text-right font-medium pb-1">Enrolled</th>
          <th className="text-right font-medium pb-1">Lost</th>
          <th className="text-right font-medium pb-1">Conversion</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([src, v]) => (
          <tr key={src} className="border-t border-gray-100">
            <td className="py-1.5">{LEAD_SOURCE_LABELS[src] || src}</td>
            <td className="py-1.5 text-right">{v.total}</td>
            <td className="py-1.5 text-right text-emerald-700">{v.enrolled}</td>
            <td className="py-1.5 text-right text-gray-500">{v.lost}</td>
            <td className="py-1.5 text-right font-medium">
              {v.rate == null ? '—' : `${Math.round(v.rate * 100)}%`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
function formatDate(v, fmtTime) {
  if (!v) return '';
  // Firestore Timestamp or ISO string or millis — normalize.
  let d;
  if (typeof v === 'object' && typeof v?.toDate === 'function') d = v.toDate();
  else if (typeof v === 'string') d = new Date(v);
  else if (typeof v === 'number') d = new Date(v);
  else return '';
  if (isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return fmtTime.stamp(d, sameYear ? {} : { year: 'numeric' });
}
