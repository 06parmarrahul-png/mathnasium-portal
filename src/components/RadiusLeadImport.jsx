import { useState } from 'react';
import { writeBatch, doc, serverTimestamp } from 'firebase/firestore';
import { Upload, Loader2, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { db } from '../firebase';
import { readExport, importId } from '../lib/radiusLeads';
import { LEAD_STATUS_LABELS } from '../lib/leads';
import { toast } from '../lib/notify';

/**
 * Eleven years of Langley's leads, out of Radius and into Ratio.
 *
 * NOTHING IS WRITTEN BEFORE SOMEBODY READS THE COUNTS. The file is parsed
 * in the browser, summarised, and sits there until the button is pressed
 * — the same shape the Google Calendar import uses, for the same reason:
 * 1,300 rows written on a file-picker change is not a thing anybody can
 * take back.
 *
 * RE-RUNNING IS SAFE. Each lead is written under `radius_<Lead Id>`, so a
 * second import rewrites the same documents rather than handing the centre
 * a second copy of eleven years. That also means a corrected export can
 * simply be imported again.
 *
 * IT DOES NOT TOUCH LEADS RATIO ALREADY HAS. Anything created here or
 * through a booking has its own id; only `radius_*` documents are
 * written, so nothing a person has worked on since is overwritten.
 */

const CHUNK = 400;   // Firestore allows 500 writes a batch; leave headroom.

export default function RadiusLeadImport({ centerId }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  // The cut-off, and it defaults to something rather than nothing: the
  // first of July is what the centre picked, and 57 leads is a pipeline
  // where 926 is a scroll.
  const [since, setSince] = useState('2026-07-01');

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setDone(null); setReading(true);
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      // cellDates so a real date cell arrives as a Date rather than a
      // serial number; readDate() copes with either, but not with both
      // being wrong at once.
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      const got = readExport(rows, { since: since || null });
      if (got.leads.length === 0) {
        setError('Nothing in that file looked like a lead. Expected the Radius export, with a Lead Name column.');
        setSummary(null);
      } else {
        setSummary(got);
        setFileName(file.name);
      }
    } catch (err) {
      setError(err.message || 'Could not read that file.');
    } finally {
      setReading(false);
    }
  };

  // Re-read when the date moves, so the counts answer the date on screen.
  const reread = (next) => {
    setSince(next);
    setSummary(null);
    setFileName('');
  };

  const write = async () => {
    if (!summary) return;
    setWriting(true); setError('');
    try {
      let written = 0;
      for (let at = 0; at < summary.leads.length; at += CHUNK) {
        const batch = writeBatch(db);
        for (const lead of summary.leads.slice(at, at + CHUNK)) {
          const { createdOn, ...rest } = lead;
          batch.set(doc(db, 'centers', centerId, 'leads', importId(lead)), {
            ...rest,
            notes: '',
            intakeId: null,
            imported: 'radius',
            // The day the family actually enquired, not the day the file
            // was read — "in 9 days" has to mean something.
            createdAt: createdOn ? new Date(`${createdOn}T12:00:00`) : new Date(),
            updatedAt: serverTimestamp(),
            history: [{
              at: new Date().toISOString(),
              by: 'system',
              text: `Imported from Radius — ${lead.outcomeReason || 'no status'}${createdOn ? `, created ${createdOn}` : ''}`,
            }],
          }, { merge: true });
          written += 1;
        }
        await batch.commit();
      }
      setDone(written);
      toast.success(`${written} leads imported.`);
    } catch (err) {
      setError(err.message || 'The import failed partway. Re-running is safe.');
    } finally {
      setWriting(false);
    }
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left">
        {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        <span className="text-sm font-semibold text-gray-900">Import leads from Radius</span>
        <span className="text-xs text-gray-500">One-off — brings the centre&rsquo;s history across</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 py-3">
          <p className="mb-3 text-xs text-gray-500">
            Radius → Lead Management → <b>Export to Excel</b>, then the file here. Nothing is
            written until you press the button, and running it twice is safe: each lead keeps
            its Radius id, so a second import updates the same rows rather than duplicating them.
            Grade <b>College</b> is dropped — it is Radius&rsquo;s catch-all, not a school grade.
            Pick a date below: only leads from then on come across, and they arrive as live
            work rather than history.
          </p>

          <label className="mb-3 block max-w-xs">
            <span className="mb-1 block text-xs font-medium text-gray-700">Only leads created on or after</span>
            <input type="date" value={since} onChange={e => reread(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
            <span className="mt-1 block text-[11px] text-gray-500">
              Everything before this stays in Radius and is not brought over at all.
              Clear the date to import the whole file.
            </span>
          </label>

          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-blue-300 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-100">
            {reading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            {fileName || 'Choose the Radius export (.xlsx)'}
            <input type="file" accept=".xlsx,.xls,.csv" onChange={pick} className="hidden" />
          </label>

          {error && (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}

          {summary && !done && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat n={summary.leads.length} label="will be imported" strong />
                <Stat n={summary.skipped['before-cutoff'] || 0} label="before the date — left out" />
                <Stat n={summary.skipped.college || 0} label="College — dropped" />
                <Stat n={summary.assessedAlready} label="already assessed" />
              </div>
              <p className="mt-2 text-[11.5px] text-gray-600">
                {summary.from} → {summary.to} ·{' '}
                {Object.entries(summary.byStatus)
                  .map(([k, v]) => `${v} ${LEAD_STATUS_LABELS[k] || k}`).join(' · ')}
                {summary.doNotContact > 0 && (
                  <> · <b className="text-rose-700">{summary.doNotContact} marked do-not-contact</b></>
                )}
              </p>
              {(summary.skipped['no-name'] || 0) > 0 && (
                <p className="mt-1 text-[11.5px] text-amber-800">
                  {summary.skipped['no-name']} rows had no name on them and are skipped.
                </p>
              )}
              <button type="button" onClick={write} disabled={writing}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                {writing && <Loader2 size={14} className="animate-spin" />}
                Import {summary.leads.length} leads
              </button>
            </div>
          )}

          {done !== null && (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
              {done} leads imported. They are in the table below, dated when the family
              actually enquired.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ n, label, strong }) {
  return (
    <div>
      <div className={`font-bold tabular-nums ${strong ? 'text-xl text-gray-900' : 'text-base text-gray-700'}`}>{n}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  );
}
