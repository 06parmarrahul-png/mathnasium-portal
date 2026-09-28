import { useRef, useState } from 'react';
import { collection, doc, getDocs, query, where, writeBatch } from 'firebase/firestore';
import { Upload, AlertTriangle, Check, Trash2, Loader2 } from 'lucide-react';
import { db } from '../firebase';
import { notesFromRows, importSummary, chunk } from '../lib/deskImport';
import { DESK_COLLECTIONS, resetPlan, confirmWordFor } from '../lib/deskReset';
import { toast, confirmDialog } from '../lib/notify';

/**
 * Bringing the spreadsheet in.
 *
 * A one-off that writes about 1,900 documents into a live centre, so it is
 * built to be un-scary rather than quick: pick the file, read what it is
 * ABOUT to do, then confirm. Nothing is written before that second press.
 *
 * The file is not in the repository and never should be — it carries
 * students' and parents' names. It is generated locally by
 * scripts/desk_import_convert.py and goes straight from that machine into
 * Ratio.
 *
 * RE-RUNNING IT DUPLICATES EVERYTHING. There is no id in the spreadsheet
 * to match rows on, so there is nothing to make this idempotent with. The
 * panel says so, in those words, whenever the desk already has notes in
 * it — which is the only state where that warning matters.
 *
 * WHICH IS WHY IT ALSO TAKES THE IMPORT BACK OUT. Bringing an updated
 * sheet across means clearing the last one first, so the panel offers
 * that — scoped to the rows an import wrote (`imported: true`) and never
 * to the notes the team has typed in Ratio since. See deskReset.js.
 */
export default function DeskImport({
  centerId, members, students = [], existingCount = 0, canReset = false,
  onCleared = null,
}) {
  const [payload, setPayload] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null);   // { done, total } | 'finished'
  const [plan, setPlan] = useState(null);           // what a reset would remove
  const [counting, setCounting] = useState(false);
  const [removing, setRemoving] = useState(null);   // { done, total }
  const fileRef = useRef(null);

  const pick = async (file) => {
    setError(''); setPayload(null); setSummary(null); setProgress(null);
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || !Array.isArray(data.notes)) {
        setError('That doesn’t look like a desk export — no notes in it.');
        return;
      }
      setPayload(data);
      setSummary(importSummary(data, members, students));
    } catch (e) {
      setError(e?.message || 'Could not read that file.');
    }
  };

  /**
   * Count what is there before offering to remove any of it.
   *
   * Two queries per collection rather than one read of everything: the
   * desk is ~1,900 rows and the kept count is the number that decides
   * whether this is safe, so it is worth being exact about.
   */
  const countRows = async () => {
    if (!centerId) return;
    setError(''); setCounting(true); setPlan(null);
    try {
      const counts = {};
      for (const spec of DESK_COLLECTIONS) {
        const coll = collection(db, 'centers', centerId, spec.key);
        const [mine, all] = await Promise.all([
          getDocs(query(coll, where('imported', '==', true))),
          getDocs(coll),
        ]);
        counts[spec.key] = { imported: mine.size, kept: all.size - mine.size };
      }
      setPlan(resetPlan(counts));
    } catch (e) {
      setError(e?.message || 'Could not read what is there.');
    } finally {
      setCounting(false);
    }
  };

  const removeImported = async () => {
    if (!plan || plan.isEmpty || !centerId) return;
    const word = confirmWordFor(centerId);
    const ok = await confirmDialog({
      title: `Remove ${plan.total} imported rows?`,
      message: `This deletes every row the last import wrote into ${centerId}, `
        + 'along with anything done in Ratio to those notes — settling, replies, due dates. '
        + `${plan.kept > 0 ? `The ${plan.kept} rows the team has written here since are kept. ` : ''}`
        + 'There is no undo. Import the new spreadsheet straight afterwards.',
      confirmText: `Remove ${plan.total}`,
      danger: true,
      requireText: word,
    });
    if (!ok) return;

    let done = 0;
    setRemoving({ done, total: plan.total });
    try {
      for (const spec of DESK_COLLECTIONS) {
        const snap = await getDocs(
          query(collection(db, 'centers', centerId, spec.key), where('imported', '==', true)));
        for (const part of chunk(snap.docs)) {
          const batch = writeBatch(db);
          for (const d of part) batch.delete(d.ref);
          await batch.commit();
          done += part.length;
          setRemoving({ done, total: plan.total });
        }
      }
      setRemoving(null);
      setPlan(null);
      if (onCleared) onCleared({ removed: done, byCollection: plan.lines });
      toast.success(`${done} imported ${done === 1 ? 'row' : 'rows'} removed. Import the new file now.`);
    } catch (e) {
      setRemoving(null);
      setError(`Stopped after ${done} of ${plan.total}: ${e?.message || 'delete failed'}`);
    }
  };

  const run = async () => {
    if (!payload || !centerId) return;
    const jobs = [
      ['notes', notesFromRows(payload.notes, members, { students })],
      ['giftCards', payload.giftCards || []],
      ['receipts', payload.receipts || []],
      ['referrals', payload.referrals || []],
      ['studentOfMonth', payload.studentOfMonth || []],
    ];
    const total = jobs.reduce((n, [, rows]) => n + rows.length, 0);
    let done = 0;
    setProgress({ done, total });
    try {
      for (const [name, rows] of jobs) {
        for (const part of chunk(rows)) {
          const batch = writeBatch(db);
          for (const row of part) {
            batch.set(doc(collection(db, 'centers', centerId, name)), {
              ...row, imported: true, importedAt: new Date().toISOString(),
            });
          }
          await batch.commit();
          done += part.length;
          setProgress({ done, total });
        }
      }
      setProgress('finished');
    } catch (e) {
      setError(`Stopped after ${done} of ${total}: ${e?.message || 'write failed'}`);
      setProgress(null);
    }
  };

  if (progress === 'finished') {
    return (
      <div className="mt-8 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
          <Check size={16} /> Imported. It’s all on the tabs above.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-bold uppercase tracking-widest text-gray-500">
        Import the old spreadsheet
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-gray-600">
        Generate the file with <code className="rounded bg-gray-200 px-1 py-0.5 text-[12px]">
        scripts/desk_import_convert.py</code>, then pick it here. It never leaves
        your machine except to come straight into Ratio.
      </p>

      {existingCount > 0 && (
        <p className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-900">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span>
            There {existingCount === 1 ? 'is' : 'are'} already <b>{existingCount}</b> note
            {existingCount === 1 ? '' : 's'} here. Running the import again would
            add a second copy of everything — the spreadsheet has no id to
            match rows on, so there is no way to merge instead.
            {canReset && ' To bring an updated sheet across, clear the last import first.'}
          </span>
        </p>
      )}

      {/* ── Taking the last import back out ──────────────────────────
          Owner tier only, because that is who the Firestore rules let
          delete a desk row — offering it to anyone else would fail
          halfway through and leave the desk in two minds. */}
      {canReset && !progress && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
          <p className="text-[13px] font-semibold text-gray-900">Clear the last import</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-gray-600">
            Removes the rows a previous import wrote, so the new file lands once
            instead of twice. Notes and tracker rows written in Ratio are not
            touched — they aren&apos;t in the spreadsheet, so nothing would put
            them back.
          </p>

          <button onClick={countRows} disabled={counting || !!removing}
            className="mt-2 flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">
            {counting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {counting ? 'Counting…' : 'Count what the import left'}
          </button>

          {plan && plan.isEmpty && (
            <p className="mt-2 text-[13px] text-gray-600">
              Nothing here came from an import — there is nothing to clear.
            </p>
          )}

          {plan && !plan.isEmpty && !removing && (
            <div className="mt-2.5 rounded-lg border bg-gray-50 p-3 text-[13px] text-gray-700">
              <p className="font-semibold text-gray-900">This would remove:</p>
              <ul className="mt-1 space-y-0.5">
                {plan.lines.map(line => <li key={line.key}>{line.label}</li>)}
              </ul>
              <p className="mt-2 font-semibold text-gray-900">
                {plan.kept > 0 ? 'And keep:' : 'Nothing here was written in Ratio, so nothing is kept back.'}
              </p>
              {plan.kept > 0 && (
                <>
                  <ul className="mt-1 space-y-0.5">
                    {plan.keptLines.map(line => <li key={line.key}>{line.label} written in Ratio</li>)}
                  </ul>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-gray-500">
                    Those stay exactly where they are.
                  </p>
                </>
              )}
              <p className="mt-2 text-[12.5px] leading-relaxed text-gray-500">
                Replies, settling and due dates added in Ratio to an imported note go
                with the note. The new file brings the spreadsheet&apos;s version.
              </p>
              <button onClick={removeImported}
                className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-bold text-white hover:bg-red-700">
                <Trash2 size={15} /> Remove {plan.total} imported rows
              </button>
            </div>
          )}

          {removing && (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                <div className="h-full rounded-full bg-red-600 transition-all"
                  style={{ width: `${Math.round((removing.done / Math.max(1, removing.total)) * 100)}%` }} />
              </div>
              <p className="mt-1.5 text-[13px] text-gray-600">
                {removing.done} of {removing.total} removed — leave this tab open.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
          onChange={e => pick(e.target.files?.[0])} />
        <button onClick={() => fileRef.current?.click()} disabled={!!progress}
          className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">
          <Upload size={15} /> Pick the file
        </button>
        {summary && !progress && (
          <button onClick={run}
            className="rounded-lg bg-red-600 px-3.5 py-2 text-sm font-bold text-white hover:bg-red-700">
            Import {summary.notes + summary.giftCards + summary.receipts
              + summary.referrals + summary.studentOfMonth} rows
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-sm font-semibold text-red-600">{error}</p>}

      {summary && !progress && (
        <div className="mt-3 rounded-lg border bg-white p-3 text-[13px] text-gray-700">
          <p className="mb-1.5 font-semibold text-gray-900">This is what it will add:</p>
          <ul className="space-y-0.5">
            <li>{summary.notes} notes — {summary.open} of them still open</li>
            <li>
              {summary.linkedToStudent} linked to a student on file,
              {' '}{summary.namedOnly} more carrying a name it can&apos;t link
              {' '}<span className="text-gray-400">(parents, mostly — Ratio holds no parent list)</span>
            </li>
            <li>{summary.topicKnown} filed under a topic automatically</li>
            <li>{summary.giftCards} gift cards</li>
            <li>{summary.receipts} receipts</li>
            <li>{summary.referrals} referral rally rows</li>
            <li>{summary.studentOfMonth} student of the month rows</li>
          </ul>
          {summary.notesUnmatched > 0 && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-gray-500">
              {summary.notesUnmatched} of those notes are addressed to initials
              with no Ratio account — people who have left, mostly. They keep
              the initials the sheet had, so nothing is lost; they just won’t
              land in anybody’s “For me”.
            </p>
          )}
        </div>
      )}

      {progress && progress !== 'finished' && (
        <div className="mt-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div className="h-full rounded-full bg-red-600 transition-all"
              style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
          <p className="mt-1.5 text-[13px] text-gray-600">
            {progress.done} of {progress.total} written — leave this tab open.
          </p>
        </div>
      )}
    </div>
  );
}
