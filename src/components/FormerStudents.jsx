import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, writeBatch, doc, serverTimestamp } from 'firebase/firestore';
import {
  Upload, Loader2, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Phone, GraduationCap,
} from 'lucide-react';
import { db } from '../firebase';
import { toast } from '../lib/notify';
import { todayISO } from '../lib/payProjection';
import {
  readStudentExport, callBackList, studentImportId, gradeLabel, MAX_AWAY_YEARS,
  leadFromCallBack,
} from '../lib/formerStudents';
import { createLead } from '../lib/leads';

/**
 * Worth a call back — the families who already know you.
 *
 * The ask was "tell them to reach out, it's a new year and they're in
 * middle school now". That needs the child's DATE OF BIRTH, which is the
 * only field that stays true while they get older, and the day they were
 * last in. Both are in the Radius student export; neither was in Ratio.
 *
 * EVERY ROW NAMES SOMETHING THAT CHANGED. "Veerin was in Grade 7 when
 * they last came in. They are in Grade 8 now — secondary." A list that
 * said "away a while" would be a list nobody rings from.
 *
 * On the real file: 1,763 students, 332 currently enrolled, and 341
 * former students worth a call. Uncapped it was 602 and opened with
 * children who left in Grade 2 and are in Grade 12 now — see
 * MAX_AWAY_YEARS.
 */

const CHUNK = 400;

const KIND = {
  'moved-up':   { label: 'Changed school stage', tone: 'bg-rose-100 text-rose-800' },
  'grades-on':  { label: 'Grades on',            tone: 'bg-amber-100 text-amber-800' },
  recent:       { label: 'Recent leaver',        tone: 'bg-sky-100 text-sky-800' },
};

export default function FormerStudents({ centerId, onLoaded, actor }) {
  const today = useMemo(() => todayISO(), []);
  const [students, setStudents] = useState(null);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [making, setMaking] = useState('');

  // Turning a call-back into a lead is what gets it WORKED: it lands on
  // the call sheet due today and is chased like any other. The former
  // student stays exactly where it is — that record is history, and the
  // lead is the conversation about it.
  const makeLead = async (call) => {
    const id = call.student.id || call.student.source_radiusId;
    setMaking(id);
    try {
      await createLead(centerId, leadFromCallBack(call, today), actor);
      toast.success(`${call.student.name} is on the call sheet.`);
    } catch (err) {
      toast.error(err.message || 'Could not make that lead.');
    } finally { setMaking(''); }
  };

  useEffect(() => {
    if (!centerId) return undefined;
    return onSnapshot(
      collection(db, 'centers', centerId, 'formerStudents'),
      snap => {
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setStudents(rows);
        onLoaded?.(rows);
      },
      () => { setStudents([]); onLoaded?.([]); },
    );
  }, [centerId, onLoaded]);

  const calls = useMemo(() => callBackList(students || [], today), [students, today]);
  const shown = showAll ? calls : calls.slice(0, 12);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setDone(null); setBusy('reading');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      const got = readStudentExport(rows, today);
      if (got.students.length === 0) {
        setError('Nothing in that file looked like a student. Expected the Radius student export.');
      } else { setSummary(got); setFileName(file.name); }
    } catch (err) {
      setError(err.message || 'Could not read that file.');
    } finally { setBusy(''); }
  };

  const write = async () => {
    if (!summary) return;
    setBusy('writing'); setError('');
    try {
      let n = 0;
      for (let at = 0; at < summary.students.length; at += CHUNK) {
        const batch = writeBatch(db);
        for (const s of summary.students.slice(at, at + CHUNK)) {
          batch.set(doc(db, 'centers', centerId, 'formerStudents', studentImportId(s)),
            { ...s, imported: 'radius', updatedAt: serverTimestamp() }, { merge: true });
          n += 1;
        }
        await batch.commit();
      }
      setDone(n); setSummary(null);
      toast.success(`${n} students imported.`);
    } catch (err) {
      setError(err.message || 'The import failed partway. Re-running is safe.');
    } finally { setBusy(''); }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        <GraduationCap size={15} className="text-gray-500" />
        <span className="text-sm font-semibold text-gray-900">Worth a call back</span>
        {calls.length > 0 && (
          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800">{calls.length}</span>
        )}
        <span className="text-xs text-gray-500">Former students whose school year has moved on</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 py-3">
          {students === null ? (
            <p className="flex items-center gap-2 py-4 text-xs text-gray-500">
              <Loader2 size={13} className="animate-spin" /> Reading former students…
            </p>
          ) : calls.length === 0 && !summary && done === null ? (
            <p className="mb-3 text-xs text-gray-500">
              Nothing here yet. Import the Radius student export and this fills with the
              families who already know you — the child&rsquo;s date of birth is what makes it
              possible to say which grade they are in <em>now</em>, which the grade column
              cannot (Radius rolls it forward, so long-gone students all read &ldquo;College&rdquo;).
            </p>
          ) : (
            <>
              <ul className="mb-3 divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200">
                {shown.map(c => {
                  const kind = KIND[c.kind] || KIND.recent;
                  return (
                    <li key={c.student.id || c.student.source_radiusId}
                      className="flex items-start gap-3 px-3 py-2.5">
                      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${kind.tone}`}>
                        {kind.label}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <b className="text-[13.5px] text-gray-900">{c.student.name}</b>
                          {c.student.account && (
                            <span className="text-[11.5px] text-gray-500">{c.student.account}</span>
                          )}
                          <span className="text-[11px] text-gray-400">
                            {gradeLabel(c.student.grade)} · last in {c.student.lastSeen}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[12.5px] leading-snug text-gray-600">{c.why}</span>
                      </span>
                      <button type="button" onClick={() => makeLead(c)}
                        disabled={making === (c.student.id || c.student.source_radiusId)}
                        className="shrink-0 self-center rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                        {making === (c.student.id || c.student.source_radiusId) ? 'Adding…' : 'Make a lead'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {calls.length > shown.length && (
                <button type="button" onClick={() => setShowAll(true)}
                  className="mb-3 text-xs font-semibold text-gray-600 hover:text-gray-900">
                  Show all {calls.length}
                </button>
              )}
              <p className="mb-3 flex items-start gap-1.5 text-[11px] text-gray-500">
                <Phone size={11} className="mt-0.5 shrink-0" />
                Anyone away more than {MAX_AWAY_YEARS} years is left off: they are history rather
                than a call, and a list people stop believing is worse than a short one.
              </p>
            </>
          )}

          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-blue-300 bg-blue-50 px-4 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100">
            {busy === 'reading' ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {fileName || 'Import the Radius student export (.xlsx)'}
            <input type="file" accept=".xlsx,.xls,.csv" onChange={pick} className="hidden" />
          </label>

          {error && (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}

          {summary && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
              <p className="text-gray-700">
                <b className="text-sm">{summary.students.length}</b> students ·{' '}
                <b>{summary.enrolled}</b> currently enrolled ·{' '}
                <b>{summary.schoolAge}</b> former and still school age ·{' '}
                <b>{summary.callBacks}</b> worth a call
              </p>
              <p className="mt-0.5 text-[11px] text-gray-500">
                {Object.entries(summary.byStatus).map(([k, v]) => `${v} ${k}`).join(' · ')}
                {' · '}{summary.withDob} with a date of birth
              </p>
              <button type="button" onClick={write} disabled={busy === 'writing'}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                {busy === 'writing' && <Loader2 size={13} className="animate-spin" />}
                Import {summary.students.length} students
              </button>
            </div>
          )}

          {done !== null && (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> {done} students imported.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
