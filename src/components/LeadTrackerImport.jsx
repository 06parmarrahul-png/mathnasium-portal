/**
 * Vin's Lead Tracker workbook, into Ratio.
 *
 * The tracker screen is the layout; this is the people. Without it the
 * copy is a convincing empty shell of a sheet somebody is still keeping
 * open in the other window, which is the thing it is meant to replace.
 *
 * NOTHING IS WRITTEN BEFORE SOMEBODY READS THE COUNTS. The workbook is
 * parsed in the browser, summarised tab by tab, and sits there until the
 * button is pressed — the same shape the Radius and Google Calendar
 * imports use, for the same reason: two hundred rows written on a
 * file-picker change is not a thing anybody can take back.
 *
 * RE-RUNNING IS SAFE. Each row is written under
 * `tracker_<created>_<name>`, so a second import of a workbook somebody
 * has kept working rewrites the same documents rather than handing the
 * centre a second copy of the quarter.
 *
 * IT DOES NOT TOUCH ANYTHING ELSE. Only `tracker_*` documents are
 * written; leads created in Ratio, booked through Apptoto, or brought in
 * from Radius keep their own ids and are left alone.
 */

import { useState } from 'react';
import { writeBatch, doc, serverTimestamp } from 'firebase/firestore';
import {
  Upload, Loader2, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
} from 'lucide-react';
import { db } from '../firebase';
import { readTrackerWorkbook } from '../lib/trackerImport';
import { TRACKER_FROM, monthLabel } from '../lib/leadTracker';
import { toast } from '../lib/notify';

const CHUNK = 400;   // Firestore allows 500 writes a batch; leave headroom.

/** First of the month, two months back — recent enough to still be worked. */
function defaultLiveFrom() {
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-01`;
}

export default function LeadTrackerImport({ centerId }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  // Everything comes in; this only decides what stays on the call sheet.
  // An older month is history — it belongs in the tracker, not ringing a
  // phone — and importing a quarter straight onto the worklist is how
  // the Radius import put 687 families on it the first time.
  const [liveFrom, setLiveFrom] = useState(defaultLiveFrom);
  const [fileBuf, setFileBuf] = useState(null);

  const parse = async (buf, name, from) => {
    const XLSX = await import('xlsx');
    // cellDates so a real date cell arrives as a Date rather than a
    // serial; readDate() copes with either, but not with both at once.
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheets = wb.SheetNames.map(sheet => ({
      name: sheet,
      // header:1 keeps the rows as arrays — the tabs disagree about
      // their column names, so the header row is read rather than
      // trusted. blankrows keeps the shape of the sheet intact.
      rows: XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '', blankrows: true }),
    }));
    const got = readTrackerWorkbook(sheets, { from: TRACKER_FROM, liveFrom: from });
    if (got.leads.length === 0) {
      setError('No tracker tabs in that workbook. Expected the Lead Tracker, with a "Lead Name/Student Name" column on each month.');
      setSummary(null);
      return;
    }
    setSummary(got);
    setFileName(name);
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setDone(null); setReading(true);
    try {
      const buf = await file.arrayBuffer();
      setFileBuf(buf);
      await parse(buf, file.name, liveFrom);
    } catch (err) {
      setError(err.message || 'Could not read that file.');
    } finally {
      setReading(false);
    }
  };

  // Re-read when the date moves, so the counts answer the date on screen.
  const reread = async (next) => {
    setLiveFrom(next);
    if (!fileBuf) return;
    setReading(true);
    try {
      await parse(fileBuf, fileName, next);
    } catch (err) {
      setError(err.message || 'Could not re-read that file.');
    } finally {
      setReading(false);
    }
  };

  const write = async () => {
    if (!summary) return;
    setWriting(true); setError('');
    try {
      let written = 0;
      for (let at = 0; at < summary.leads.length; at += CHUNK) {
        const batch = writeBatch(db);
        for (const lead of summary.leads.slice(at, at + CHUNK)) {
          const { id, createdAt, contactedAt, assessedAt, enrolledAt, lostAt, ...rest } = lead;
          const when = (v) => (v ? new Date(v) : null);
          batch.set(doc(db, 'centers', centerId, 'leads', id), {
            ...rest,
            intakeId: null,
            imported: 'lead-tracker',
            // The day the family actually enquired, not the day the file
            // was read — "in 9 days" has to mean something.
            createdAt: when(createdAt) || new Date(),
            contactedAt: when(contactedAt),
            assessedAt: when(assessedAt),
            enrolledAt: when(enrolledAt),
            lostAt: when(lostAt),
            updatedAt: serverTimestamp(),
            history: [{
              at: new Date().toISOString(),
              by: 'system',
              text: `Imported from the Lead Tracker — ${lead.tracker.sheet} tab`,
            }],
          }, { merge: true });
          written += 1;
        }
        await batch.commit();
      }
      setDone(written);
      toast.success(`${written} families imported from the tracker.`);
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
        <span className="text-sm font-semibold text-gray-900">Import Vin&rsquo;s Lead Tracker</span>
        <span className="text-xs text-gray-500">The monthly tabs, families and all</span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 py-3">
          <p className="mb-3 text-xs leading-relaxed text-gray-500">
            The <b>Lead Tracker.xlsx</b> workbook, as it is. Every monthly tab from{' '}
            {monthLabel(TRACKER_FROM)} on is read — the columns are found by name, so the tabs
            disagreeing with each other about what column D is called does not matter. Nothing is
            written until you press the button, and running it twice is safe: each family keeps
            the same id, so a second import updates the same rows rather than duplicating them.
          </p>

          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-medium text-gray-700">Keep on the call sheet from</span>
            <input type="date" value={liveFrom} onChange={e => reread(e.target.value)}
              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm focus:border-red-400 focus:outline-none" />
            <span className="mt-1 block text-[11px] leading-snug text-gray-500">
              Everything comes in and shows in the tracker. Months before this date are brought in
              as history, so a quarter of closed leads does not land on the call sheet.
            </span>
          </label>

          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            {reading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {reading ? 'Reading…' : 'Choose the workbook'}
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={pick} disabled={reading} />
          </label>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {summary && !done && (
            <div className="mt-3 rounded-lg bg-gray-50 p-3 ring-1 ring-gray-200">
              <p className="text-xs font-semibold text-gray-900">{fileName}</p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['Families', summary.leads.length],
                  ['On the call sheet', summary.live],
                  ['As history', summary.archived],
                  ['Enrolled', summary.enrolled],
                ].map(([label, n]) => (
                  <div key={label}>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
                    <div className="text-lg font-bold tabular-nums text-gray-900">{n}</div>
                  </div>
                ))}
              </div>
              <ul className="mt-2 space-y-0.5">
                {summary.bySheet.map(s => (
                  <li key={s.sheet} className="flex justify-between text-[11px] text-gray-600">
                    <span>{s.sheet}</span>
                    <span className="tabular-nums">{s.rows} rows</span>
                  </li>
                ))}
              </ul>
              {summary.duplicates > 0 && (
                <p className="mt-2 text-[11px] text-gray-500">
                  {summary.duplicates} {summary.duplicates === 1 ? 'family appears' : 'families appear'} on
                  more than one tab — a lead chased into the next month. The later tab wins.
                </p>
              )}
              <button type="button" onClick={write} disabled={writing}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                {writing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {writing ? 'Writing…' : `Import ${summary.leads.length} families`}
              </button>
            </div>
          )}

          {done !== null && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900 ring-1 ring-emerald-200">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              {done} families imported. They are in the Tracker tab, month by month.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
