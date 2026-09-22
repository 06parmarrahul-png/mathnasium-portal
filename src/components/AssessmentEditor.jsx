import { useMemo, useState } from 'react';
import { doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { X, Trash2, Loader2, AlertTriangle, MapPin, Link2 } from 'lucide-react';
import { db } from '../firebase';
import { toast, confirmDialog } from '../lib/notify';
import { PAGES } from '../lib/pageNames';
import { minutesOf, hhmm } from '../lib/ratioCalendar';
import { INTAKE_STATUSES, slotOf, validateAssessment, clashWith } from '../lib/assessments';

/**
 * An assessment, edited where you found it.
 *
 * The Calendar could show a booked assessment and not change one, because
 * an assessment is a `centerIntakes` document rather than a calendar
 * entry. Imported ones arrive with whatever a Google Calendar title could
 * be made to give up, so "read-only" meant "wrong forever".
 *
 * WHO / WHAT / WHERE / WHEN, in that order, because that is the order
 * somebody asks. Where is the centre's own address — read-only here, since
 * it is a Centre Settings field and an assessment happens in the building.
 *
 * NOTHING HERE TOUCHES GOOGLE. The import is a one-way snapshot: editing
 * the Ratio copy changes Ratio. The original event stays exactly as it is,
 * which is the point — two calendars that both think they are in charge is
 * how a family gets told two different times.
 */

export default function AssessmentEditor({
  intake, intakes = [], centerConfig, onClose, canEdit = true,
}) {
  const [draft, setDraft] = useState(() => ({
    id: intake.id,
    date: String(intake.slot || '').slice(0, 10),
    startTime: String(intake.slot || '').slice(11, 16),
    durationMin: intake.durationMin || 60,
    childName: intake.childName || '',
    childGrade: intake.childGrade || '',
    childSchool: intake.childSchool || '',
    guardianName: intake.guardianName || '',
    email: intake.email || '',
    phone: intake.phone || '',
    status: intake.status || 'scheduled',
    notes: intake.notes || '',
  }));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const clash = useMemo(() => clashWith(draft, intakes), [draft, intakes]);
  const address = centerConfig?.intakeSettings?.address || '';
  const endTime = minutesOf(draft.startTime) == null
    ? '' : hhmm(minutesOf(draft.startTime) + Number(draft.durationMin || 60));

  const save = async () => {
    const problem = validateAssessment(draft);
    if (problem) { setError(problem); return; }
    setSaving(true);
    try {
      await updateDoc(doc(db, 'centerIntakes', intake.id), {
        slot: slotOf(draft.date, draft.startTime),
        durationMin: Number(draft.durationMin) || 60,
        childName: draft.childName.trim(),
        childGrade: draft.childGrade.trim(),
        childSchool: draft.childSchool.trim(),
        guardianName: draft.guardianName.trim(),
        email: draft.email.trim().toLowerCase(),
        phone: draft.phone.trim(),
        status: draft.status,
        notes: draft.notes.trim(),
        updatedAt: new Date().toISOString(),
      });
      toast.success('Assessment updated.');
      onClose();
    } catch (e) {
      setError(e?.message || 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete ${draft.childName || 'this assessment'}?`,
      message: 'The time goes back on the public booking page straight away. '
        + 'To keep the record instead, set it to Cancelled.',
      confirmText: 'Delete', cancelText: 'Keep it', danger: true,
    });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'centerIntakes', intake.id));
      toast.success('Deleted.');
      onClose();
    } catch (e) { toast.error(e?.message || 'Could not delete that.'); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8">
      <div className="nl w-full max-w-lg rounded-2xl border p-5 shadow-xl"
        style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
        <div className="mb-1 flex items-center gap-2">
          <h2 className="nl-display text-[19px] font-semibold">Assessment</h2>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em]"
            style={{ background: 'var(--nl-okw)', color: 'var(--nl-ok)' }}>Intake</span>
          <button type="button" onClick={onClose} className="ml-auto p-1" aria-label="Close">
            <X size={17} style={{ color: 'var(--nl-muted)' }} />
          </button>
        </div>
        <p className="mb-3 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
          Lives in the Intakes list, which is what keeps this hour off the public booking page.
          {intake.source === 'google-import' && ' Imported from Google Calendar — editing it here does not change the original event.'}
        </p>

        {!canEdit ? (
          <p className="rounded-xl border p-3 text-[12.5px]"
            style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
            Assessments carry family contact details, so only owners, directors and the admin
            assistant can change one.
          </p>
        ) : (
          <>
            <Group label="When">
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" value={draft.date} aria-label="Date"
                  onChange={e => set({ date: e.target.value })} style={INPUT} className={CLS} />
                <input type="time" value={draft.startTime} aria-label="Start time"
                  onChange={e => set({ startTime: e.target.value })} style={INPUT} className={CLS} />
                <select value={draft.durationMin} aria-label="How long"
                  onChange={e => set({ durationMin: Number(e.target.value) })} style={INPUT} className={CLS}>
                  {[30, 45, 60, 75, 90, 120].map(n => <option key={n} value={n}>{n} min</option>)}
                </select>
                {endTime && (
                  <span className="text-[12px]" style={{ color: 'var(--nl-muted)' }}>ends {endTime}</span>
                )}
              </div>
              {clash && (
                <p className="mt-2 flex items-start gap-1.5 text-[12px]" style={{ color: 'var(--nl-warn)' }}>
                  <AlertTriangle size={13} className="mt-[1px] shrink-0" />
                  Runs into {clash.childName || 'another assessment'} at{' '}
                  {String(clash.slot).slice(11, 16)}. Allowed — just so you know.
                </p>
              )}
            </Group>

            <Group label="Who — the child">
              <div className="flex flex-wrap gap-2">
                <Field value={draft.childName} onChange={v => set({ childName: v })}
                  label="Child's name" placeholder="Child's name" grow />
                <Field value={draft.childGrade} onChange={v => set({ childGrade: v })}
                  label="Grade" placeholder="Grade" width={84} />
              </div>
              <div className="mt-2">
                <Field value={draft.childSchool} onChange={v => set({ childSchool: v })}
                  label="School" placeholder="School" grow />
              </div>
            </Group>

            <Group label="Who — the guardian">
              <Field value={draft.guardianName} onChange={v => set({ guardianName: v })}
                label="Guardian's name" placeholder="Guardian's name" grow />
              <div className="mt-2 flex flex-wrap gap-2">
                <Field value={draft.email} onChange={v => set({ email: v })}
                  label="Email" placeholder="Email" type="email" grow />
                <Field value={draft.phone} onChange={v => set({ phone: v })}
                  label="Phone" placeholder="Phone" width={150} />
              </div>
            </Group>

            <Group label="Where">
              <p className="flex items-start gap-1.5 text-[12.5px]" style={{ color: 'var(--nl-ink2)' }}>
                <MapPin size={13} className="mt-[2px] shrink-0" style={{ color: 'var(--nl-muted)' }} />
                <span>
                  In centre{address ? ` — ${address}` : ''}
                  <span className="block text-[11px]" style={{ color: 'var(--nl-muted)' }}>
                    {address
                      ? 'From Centre Settings, the same address the family was shown.'
                      : 'No address saved yet — add one in Centre Settings and it shows on the booking page too.'}
                  </span>
                </span>
              </p>
            </Group>

            <Group label="What happened">
              <div className="flex flex-wrap gap-1.5">
                {INTAKE_STATUSES.map(o => {
                  const on = draft.status === o.key;
                  return (
                    <button key={o.key} type="button" onClick={() => set({ status: o.key })}
                      className="rounded-full border px-3 py-1.5 text-[11.5px] font-medium"
                      style={on
                        ? { background: 'var(--nl-ink)', borderColor: 'var(--nl-ink)', color: '#fff', fontWeight: 600 }
                        : { borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
                      {o.label}
                    </button>
                  );
                })}
              </div>
              {draft.status === 'cancelled' && (
                <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
                  Cancelling puts the hour back on the public booking page and keeps the record.
                </p>
              )}
            </Group>

            <Group label="Notes">
              <textarea value={draft.notes} onChange={e => set({ notes: e.target.value })}
                rows={2} placeholder="Anything worth knowing on the day" aria-label="Notes"
                className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none" style={INPUT} />
            </Group>

            {intake.leadId && (
              <p className="mt-3 flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                <Link2 size={12} /> This family is on the {PAGES.leads.name} board.
              </p>
            )}

            {error && (
              <p className="mt-2 text-[12.5px] font-medium" style={{ color: 'var(--nl-brand)' }}>{error}</p>
            )}

            <div className="mt-4 flex items-center gap-2 border-t pt-4" style={{ borderColor: 'var(--nl-rule)' }}>
              <button type="button" onClick={remove}
                className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] font-semibold"
                style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-brand)' }}>
                <Trash2 size={13} /> Delete
              </button>
              <button type="button" onClick={onClose}
                className="ml-auto rounded-lg border px-4 py-2 text-[12.5px] font-semibold"
                style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
                Cancel
              </button>
              <button type="button" onClick={save} disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-60"
                style={{ background: 'var(--nl-brand)' }}>
                {saving && <Loader2 size={13} className="animate-spin" />}
                Save changes
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const INPUT = { borderColor: 'var(--nl-rule)', background: 'var(--nl-card)', color: 'var(--nl-ink)' };
const CLS = 'rounded-lg border px-3 py-2 text-[13.5px]';

function Group({ label, children }) {
  return (
    <div className="mt-3.5">
      <div className="mb-1.5 text-[9.5px] font-bold uppercase tracking-[0.13em]"
        style={{ color: 'var(--nl-muted)' }}>{label}</div>
      {children}
    </div>
  );
}

function Field({ value, onChange, label, placeholder, width, grow = false, type = 'text' }) {
  return (
    <input type={type} value={value || ''} onChange={e => onChange(e.target.value)}
      aria-label={label} placeholder={placeholder}
      className={`${CLS} ${grow ? 'min-w-0 flex-1' : ''}`}
      style={{ ...INPUT, ...(width ? { width } : null) }} />
  );
}
