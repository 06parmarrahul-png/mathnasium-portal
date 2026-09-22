import { useMemo, useRef, useState } from 'react';
import { collection, doc, writeBatch } from 'firebase/firestore';
import { Upload, X, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { db } from '../firebase';
import { chunk } from '../lib/deskImport';
import { parseIcs, buildRows, importSummary, SKIP_REASONS } from '../lib/icsImport';
import { kindLabel } from '../lib/ratioCalendar';

/**
 * Bringing a Google Calendar in.
 *
 * Built to be un-scary rather than quick, the same way DeskImport is: pick
 * the file, READ WHAT IT IS ABOUT TO DO, correct anything wrong, then
 * confirm. Nothing is written before that second press.
 *
 * The rows carry parents' and children's names, so the table is the
 * feature, not a formality — every field an extractor guessed at is shown
 * and editable. See the note at the top of src/lib/icsImport.js.
 *
 * WHERE THINGS LAND
 *   assessment → `centerIntakes`, because that collection alone occupies a
 *                booking slot, counts against the day cap and reaches the
 *                Intakes page. It shows on the calendar either way.
 *   everything else → `centers/{id}/calendar`
 *
 * Re-running is safe: the event's UID is stored as `sourceUid` and a
 * second import skips whatever is already here.
 */

const BATCH = 400;   // Firestore caps a batch at 500 writes.

export default function CalendarImport({
  centerId, timeZone = 'America/Vancouver', profile,
  existingUids = new Set(), onClose,
}) {
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const fileRef = useRef(null);

  const summary = useMemo(() => (rows ? importSummary(rows) : null), [rows]);

  const pick = async (file) => {
    setError(''); setRows(null); setDone(null);
    if (!file) return;
    try {
      const text = await file.text();
      const events = parseIcs(text, { timeZone });
      if (!events.length) {
        setError('No events in that file. Google Calendar → Settings → Import & export → Export gives a .ics per calendar.');
        return;
      }
      setFileName(file.name);
      setRows(buildRows(events, { existingUids }));
    } catch (e) {
      setError(e?.message || 'Could not read that file.');
    }
  };

  const edit = (id, patch) => setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)));

  const run = async () => {
    const live = rows.filter(r => r.include && !r.skip);
    if (!live.length) return;
    setBusy(true); setError('');
    try {
      const who = profile?.displayName || profile?.email || null;
      const now = new Date().toISOString();
      let intakes = 0;
      let entries = 0;

      for (const group of chunk(live, BATCH)) {
        const batch = writeBatch(db);
        for (const r of group) {
          if (r.target === 'intake') {
            // The shape api/intakes.js writes, so the Intakes page, the
            // booking grid and the day cap all read these the same as a
            // booking made on the website.
            batch.set(doc(collection(db, 'centerIntakes')), {
              centerId,
              slot: `${r.date}T${r.startTime || '00:00'}:00`,
              durationMin: r.durationMin || 60,
              guardianName: (r.guardianName || '').trim(),
              childName: (r.childName || '').trim(),
              childGrade: (r.childGrade || '').trim(),
              childSchool: (r.childSchool || '').trim(),
              email: (r.email || '').trim().toLowerCase(),
              phone: (r.phone || '').trim(),
              smsOptIn: false,
              notes: r.note || '',
              status: 'scheduled',
              source: 'google-import',
              sourceUid: r.uid || null,
              bookedAt: now,
              importedAt: now,
              importedBy: who,
            });
            intakes += 1;
          } else {
            batch.set(doc(collection(db, 'centers', centerId, 'calendar')), {
              title: (r.title || '').trim() || 'Imported entry',
              kind: r.kind || 'task',
              date: r.date,
              allDay: !!r.allDay,
              startTime: r.allDay ? null : r.startTime,
              endTime: r.allDay ? null : r.endTime,
              assignedTo: [],
              assignedNames: [],
              // An import never closes the booking page on anyone's
              // behalf. Whoever wants that ticks it afterwards, on the
              // entry, where the page says what it costs.
              holdsBooking: false,
              note: r.note || '',
              seriesId: null, repeat: null, repeatUntil: null,
              source: 'google-import',
              sourceUid: r.uid || null,
              createdAt: now, createdBy: who,
            });
            entries += 1;
          }
        }
        await batch.commit();
      }
      setDone({ intakes, entries });
      setRows(null);
    } catch (e) {
      setError(e?.message || 'Could not import that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-8">
      <div className="nl w-full max-w-4xl rounded-2xl border p-5 shadow-xl"
        style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="nl-display text-[19px] font-semibold">Import from Google Calendar</h2>
          <button type="button" onClick={onClose} className="ml-auto p-1" aria-label="Close">
            <X size={17} style={{ color: 'var(--nl-muted)' }} />
          </button>
        </div>

        {done ? (
          <div className="rounded-xl border p-4"
            style={{ borderColor: 'var(--nl-ok)', background: 'var(--nl-okw)' }}>
            <p className="flex items-center gap-2 text-[14px] font-semibold" style={{ color: 'var(--nl-ok)' }}>
              <Check size={16} /> Imported {done.intakes + done.entries}.
            </p>
            <p className="mt-1.5 text-[12.5px]" style={{ color: 'var(--nl-ink2)' }}>
              {done.intakes} {done.intakes === 1 ? 'assessment' : 'assessments'} went to the Intakes
              list — those now occupy their slot on the booking page. {done.entries}{' '}
              {done.entries === 1 ? 'entry' : 'entries'} went on the calendar.
            </p>
          </div>
        ) : !rows ? (
          <>
            <p className="text-[13px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
              In Google Calendar: <b>Settings → Import &amp; export → Export</b>. That gives a
              .zip with one <code>.ics</code> per calendar — unzip it and pick the one you want.
            </p>
            <button type="button" onClick={() => fileRef.current?.click()}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border-2 border-dashed px-5 py-4 text-[13px] font-semibold"
              style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
              <Upload size={16} /> Choose a .ics file
            </button>
            <input ref={fileRef} type="file" accept=".ics,text/calendar" className="hidden"
              onChange={e => pick(e.target.files?.[0])} />
            <p className="mt-3 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
              Nothing is saved until you have looked at what it found.
            </p>
          </>
        ) : (
          <>
            <div className="mb-3 rounded-xl border p-3"
              style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-paper)' }}>
              <p className="text-[13px]">
                <b>{fileName}</b> — {summary.total} events.
                {' '}Ready to bring in <b>{summary.importing}</b>:{' '}
                {summary.assessments} as {summary.assessments === 1 ? 'an assessment' : 'assessments'},
                {' '}{summary.entries} as calendar {summary.entries === 1 ? 'entry' : 'entries'}.
              </p>
              {Object.keys(summary.skipped).length > 0 && (
                <p className="mt-1 text-[12px]" style={{ color: 'var(--nl-muted)' }}>
                  Skipping {Object.entries(summary.skipped)
                    .map(([k, n]) => `${n} ${SKIP_REASONS[k].toLowerCase()}`).join(', ')}.
                </p>
              )}
              {summary.missingNames > 0 && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[12px] font-medium" style={{ color: 'var(--nl-warn)' }}>
                  <AlertTriangle size={13} className="mt-[1px] shrink-0" />
                  {summary.missingNames} {summary.missingNames === 1 ? 'assessment has' : 'assessments have'}
                  {' '}no child&rsquo;s name — type it in below, or untick the row.
                </p>
              )}
              <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
                An assessment goes to the Intakes list, not the calendar entries — that is the only
                place that takes its slot off the public booking page. It still shows here.
              </p>
            </div>

            <div className="max-h-[46vh] overflow-auto rounded-xl border"
              style={{ borderColor: 'var(--nl-rule)' }}>
              <table className="w-full text-[12px]">
                <thead className="sticky top-0" style={{ background: 'var(--nl-raised)' }}>
                  <tr style={{ color: 'var(--nl-muted)' }}>
                    {['', 'When', 'Goes to', 'What', 'Child', 'Grade', 'Guardian'].map(h => (
                      <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-[0.08em]">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="border-t" style={{ borderColor: 'var(--nl-hair)', opacity: r.skip ? 0.5 : 1 }}>
                      <td className="px-2 py-1.5">
                        <input type="checkbox" checked={r.include && !r.skip} disabled={!!r.skip}
                          aria-label={`Import ${r.title}`}
                          onChange={e => edit(r.id, { include: e.target.checked })} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">
                        {r.date}{r.allDay ? ' · all day' : ` · ${r.startTime}`}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        {r.skip ? (
                          <span style={{ color: 'var(--nl-muted)' }}>{SKIP_REASONS[r.skip]}</span>
                        ) : (
                          <select value={r.target}
                            aria-label={`Where ${r.title} goes`}
                            onChange={e => edit(r.id, { target: e.target.value })}
                            className="rounded border px-1.5 py-1 text-[11.5px]"
                            style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)' }}>
                            <option value="intake">Assessment</option>
                            <option value="entry">{kindLabel(r.kind)}</option>
                          </select>
                        )}
                      </td>
                      <td className="max-w-[190px] truncate px-2 py-1.5" title={r.title}>{r.title}</td>
                      {r.target === 'intake' && !r.skip ? (
                        <>
                          <Cell value={r.childName} placeholder="Child" invalid={!r.childName?.trim()}
                            onChange={v => edit(r.id, { childName: v })} label={`Child for ${r.title}`} />
                          <Cell value={r.childGrade} placeholder="Gr" width={54}
                            onChange={v => edit(r.id, { childGrade: v })} label={`Grade for ${r.title}`} />
                          <Cell value={r.guardianName} placeholder="Guardian"
                            onChange={v => edit(r.id, { guardianName: v })} label={`Guardian for ${r.title}`} />
                        </>
                      ) : (
                        <td className="px-2 py-1.5" colSpan={3} style={{ color: 'var(--nl-muted)' }}>—</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {error && <p className="mt-3 text-[12.5px] font-medium" style={{ color: 'var(--nl-brand)' }}>{error}</p>}

        <div className="mt-4 flex items-center gap-2 border-t pt-4" style={{ borderColor: 'var(--nl-rule)' }}>
          <button type="button" onClick={onClose}
            className="ml-auto rounded-lg border px-4 py-2 text-[12.5px] font-semibold"
            style={{ borderColor: 'var(--nl-rule)', color: 'var(--nl-ink2)' }}>
            {done ? 'Done' : 'Cancel'}
          </button>
          {rows && !done && (
            <button type="button" onClick={run} disabled={busy || !summary.importing}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-60"
              style={{ background: 'var(--nl-brand)' }}>
              {busy && <Loader2 size={13} className="animate-spin" />}
              Import {summary.importing}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Cell({ value, onChange, placeholder, label, width = 120, invalid = false }) {
  return (
    <td className="px-2 py-1.5">
      <input value={value || ''} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} aria-label={label}
        className="rounded border px-1.5 py-1 text-[11.5px]"
        style={{
          width, background: 'var(--nl-card)',
          borderColor: invalid ? 'var(--nl-warn)' : 'var(--nl-rule)',
        }} />
    </td>
  );
}
