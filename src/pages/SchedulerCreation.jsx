// Scheduler Creation — Enterprise sidebar page.
//
// Three sub-tabs:
//   1. Setup    — iCal URLs, ratio, instructor pool, student roster (CSV
//                 import + per-row edit), parent-name aliases.
//   2. Today    — Live daily ops dashboard: HS/EM side-by-side, click to
//                 check students in, assign instructors per slot, print.
//   3. Forecast — Next 7/14/30 days, peak demand vs. ratio.
//
// All data is per-centre. Reads `activeCenterId` from AuthContext. iCal
// fetching happens server-side via /api/scheduler/appointments to avoid
// shipping private feed URLs to the browser.

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { auth } from '../firebase';
import {
  ClipboardList, Settings, CalendarCheck, BarChart3, Printer,
  Upload, Plus, Trash2, AlertTriangle, RefreshCw,
} from 'lucide-react';
import {
  getSettings, saveSettings,
  watchStudents, upsertStudent, deleteStudent, bulkImportStudents,
  watchAliases, upsertAlias, deleteAlias,
  watchCheckIns, setCheckIn, setStudentTag, setStudentDesk,
  watchInstructorAssignments, setInstructorAssignment,
} from '../lib/scheduler-data';

// Standard parent-name aliases — one click in Setup loads all of them
// into Firestore so staff don't have to type them in one by one.
// Edit / extend at any time; the Setup button just upserts these.
const STANDARD_ALIASES = [
  { parentName: 'Aiden Thomas',         replacements: ['Aiden Aby Thomas'] },
  { parentName: 'Kelly Nelson',         replacements: ['Aria Nelson', 'Oliver Nelson'] },
  { parentName: 'Heather Booth',        replacements: ['Kaitlyn Booth'] },
  { parentName: 'Zhirong Zhu',          replacements: ['Zhirong Zhu'] },
  { parentName: 'JackHarry Thorne',     replacements: ['Jackson Thorne', 'Harrison Thorne'] },
  { parentName: 'Michelle Gu',          replacements: ['Joseph Gu'] },
  { parentName: 'Khalee Thai',          replacements: ['Jaide Thai'] },
  { parentName: 'Nassereddine Sabeur',  replacements: ['Zakaria Sabeur'] },
  { parentName: 'Alejandra Gonzalez',   replacements: ['Joanna Barreto-gonzalez'] },
  { parentName: 'Madhvi Rogers',        replacements: ['Neha Rogers'] },
  { parentName: 'Neeharika Yeshala',    replacements: ['Kritin Hanumanla'] },
  { parentName: 'Daryl Rasmussen',      replacements: ['James Rasmussen'] },
  { parentName: 'Nadim Al-barqhouty',   replacements: ['Talia Al-barqhouty'] },
];
import { toast } from '../lib/notify';

// ───── Helpers ──────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// Map a hybrid student to the side they should appear on. The dashboard
// only has HS and EM columns, so grade 8+ hybrids go to HS, everyone
// else goes to EM. They're still tagged isHybrid for the UI's (H) badge.
function hybridDisplaySide(grade) {
  const g = (grade || '').trim().toUpperCase();
  return /^(8|9|10|11|12)$/.test(g) ? 'HS' : 'EM';
}
// Minimal CSV parser — handles quoted fields with embedded commas.
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ───── Page ─────────────────────────────────────────────────────────────
export default function SchedulerCreation() {
  const { activeCenterId, isSuperAdmin, isOwner, isAdminAssistant } = useAuth();
  const allowed = isSuperAdmin || isOwner || isAdminAssistant;
  const [tab, setTab] = useState('today');

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm text-center">
        <p className="text-3xl mb-2">🔒</p>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Not available</h1>
        <p className="text-sm text-gray-500">Scheduler Creation is open to Owners, Admin Assistants, and Enterprise only.</p>
      </div>
    );
  }
  if (!activeCenterId) {
    return <div className="rounded-xl bg-white p-8 text-center text-gray-500">Pick a centre from the switcher above to begin.</div>;
  }

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-4 flex items-center gap-3 print:hidden">
        <ClipboardList className="text-red-600" size={28} />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Scheduler Creation</h1>
          <p className="text-sm text-gray-500">Daily schedule, staffing forecast, and configuration for the active centre.</p>
        </div>
      </header>

      <div className="mb-4 flex gap-1 border-b border-gray-200 print:hidden">
        <TabButton active={tab==='today'}    onClick={() => setTab('today')}    icon={CalendarCheck} label="Today" />
        <TabButton active={tab==='forecast'} onClick={() => setTab('forecast')} icon={BarChart3}     label="Forecast" />
        <TabButton active={tab==='setup'}    onClick={() => setTab('setup')}    icon={Settings}      label="Setup" />
      </div>

      {tab === 'today'    && <TodayTab    centerId={activeCenterId} />}
      {tab === 'forecast' && <ForecastTab centerId={activeCenterId} />}
      {tab === 'setup'    && <SetupTab    centerId={activeCenterId} />}
    </div>
  );
}

function TabButton(props) {
  const { active, onClick, icon: Icon, label } = props;
  return (
    <button onClick={onClick}
      className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
        active ? 'border-b-2 border-red-600 text-red-600 bg-white' : 'text-gray-500 hover:text-gray-800'
      }`}>
      <Icon size={16} /> {label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  TODAY TAB — daily ops dashboard (HS|EM side-by-side, check-ins)
// ═══════════════════════════════════════════════════════════════════════
function TodayTab({ centerId }) {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [checkIns, setCheckIns] = useState({});
  const [assignments, setAssignments] = useState({});
  const [settings, setSettings] = useState(null);
  // When set to 'HS' or 'EM', only that side is rendered — used by the
  // split print buttons so the printer never sees the other side and
  // we don't have to fight Chrome's page-break rules.
  const [printOnly, setPrintOnly] = useState(null);

  // Trigger a print run for the named side. We render exclusively that
  // side, calculate a per-day zoom level so the content fills (but doesn't
  // overflow) one page, fire window.print(), then put both sides back
  // after the print dialog closes.
  //
  // The auto-zoom matters because a quiet HS day with 40 students should
  // not be shrunk as hard as a packed EM day with 64 — we want the busy
  // case to barely fit and the quiet case to fill comfortably.
  const printSide = (side) => {
    setPrintOnly(side);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Measure the visible section that's about to be printed, then pick
      // a zoom factor so its content height lands inside one letter page
      // worth of usable vertical space (~9.5 inches × 96dpi ≈ 912 px).
      // Capped between 0.5 and 1.0 — at 1.0 a quiet day prints actual size.
      const section = document.querySelector('main section');
      const usablePageHeight = 912;
      let zoom = 1.0;
      if (section) {
        const contentHeight = section.scrollHeight || section.offsetHeight;
        if (contentHeight > 0) {
          zoom = Math.min(1.0, Math.max(0.5, usablePageHeight / contentHeight));
        }
      }
      document.documentElement.style.setProperty('--print-zoom', zoom.toFixed(3));

      window.print();
      setTimeout(() => {
        document.documentElement.style.removeProperty('--print-zoom');
        setPrintOnly(null);
      }, 500);
    }));
  };

  // Load settings (for the instructor pool + ratio).
  useEffect(() => { getSettings(centerId).then(setSettings); }, [centerId]);

  // Subscribe to today's check-ins + instructor assignments.
  useEffect(() => watchCheckIns(centerId, date, setCheckIns), [centerId, date]);
  useEffect(() => watchInstructorAssignments(centerId, date, setAssignments), [centerId, date]);

  // Fetch the schedule from the server (which reads iCal + categorizes).
  async function loadSchedule() {
    setLoading(true); setError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      const r = await fetch(`/api/scheduler/appointments?centerId=${encodeURIComponent(centerId)}&date=${encodeURIComponent(date)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadSchedule(); }, [centerId, date]);

  const ratio = settings?.studentsPerInstructor || 4;
  const pool = settings?.instructorPool || [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 print:hidden">
        <label className="text-sm">Date
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="ml-2 rounded border border-gray-300 px-2 py-1 text-sm" />
        </label>
        <button onClick={loadSchedule}
          className="flex items-center gap-1 rounded bg-gray-100 px-3 py-1 text-sm hover:bg-gray-200">
          <RefreshCw size={14} /> Refresh
        </button>
        {/* Two print buttons — one per side. Each conditionally renders only
            its own section, so the resulting print output is single-side
            and the page break is implicit. */}
        <button onClick={() => printSide('HS')}
          className="flex items-center gap-1 rounded bg-blue-900 px-3 py-1 text-sm text-white hover:bg-blue-800">
          <Printer size={14} /> Print HS
        </button>
        <button onClick={() => printSide('EM')}
          className="flex items-center gap-1 rounded bg-emerald-800 px-3 py-1 text-sm text-white hover:bg-emerald-700">
          <Printer size={14} /> Print EM
        </button>
        <span className="text-xs text-gray-500">Ratio 1:{ratio} · click name to check in</span>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {data?.warning && (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          {data.warning} <span className="underline cursor-pointer" onClick={() => {
            // jump to Setup
            window.dispatchEvent(new Event('scheduler-go-setup'));
          }}>Go to Setup</span>
        </div>
      )}
      {loading && <div className="rounded-lg bg-white p-8 text-center text-gray-500">Loading…</div>}

      {data && data.totals.all === 0 && !loading && (
        <div className="rounded-lg bg-white border border-gray-200 p-8 text-center text-gray-500">
          No appointments for {date}.
        </div>
      )}

      {data && data.totals.Unknown > 0 && (
        <UnknownBanner data={data} centerId={centerId} onFix={loadSchedule} />
      )}

      {data && data.totals.all > 0 && (
        // On-screen view: 2-col grid.
        // While `printOnly` is set (during a Print HS / Print EM click),
        // only that side is rendered so the printer sees a clean
        // single-side page.
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {(!printOnly || printOnly === 'HS') && (
            <div>
              <SideTable side="HS" data={data} centerId={centerId} date={date}
                checkIns={checkIns} assignments={assignments} ratio={ratio} pool={pool} />
            </div>
          )}
          {(!printOnly || printOnly === 'EM') && (
            <div>
              <SideTable side="EM" data={data} centerId={centerId} date={date}
                checkIns={checkIns} assignments={assignments} ratio={ratio} pool={pool} />
            </div>
          )}
        </div>
      )}

      {/* Print rules — FIT THE WHOLE SIDE ON ONE PAGE regardless of how
          busy the day is.
          Strategy:
            1. Hide chrome + every overflow / height limit on ancestors.
            2. Shrink fonts and padding to bare minimum.
            3. Hide tag/desk inputs + +add buttons — they're for the live
               app, not for paper, and they steal lots of width.
            4. Use CSS `zoom` (Chrome/Safari, which staff uses) to actually
               reflow the layout at a smaller scale. Unlike transform: scale
               (which only resizes visually and leaves Chrome calculating
               page breaks from the ORIGINAL height — that was what split
               the EM into 3 pages), zoom shrinks the real box model so
               page-break math is recomputed and the content lands on a
               single sheet.
            5. Discourage page breaks inside the section so Chrome doesn't
               opportunistically split a row that almost-but-not-quite fits. */}
      <style>{`
        @media print {
          /* size: auto respects whichever paper the user picks in the
             print dialog (Letter, A4, Legal, …). A4 is taller than Letter
             so anything that fits on Letter fits on A4 too — the zoom
             below adapts either way. */
          @page { size: auto; margin: 0.25in; }
          html, body { background: white !important; height: auto !important; overflow: visible !important; }
          aside, .print\\:hidden, [data-print-hide], header.lg\\:hidden { display: none !important; }
          main, .flex, .grid, body > div, #root, #root > div, [class*="overflow-"], [class*="h-screen"] {
            height: auto !important;
            min-height: 0 !important;
            max-height: none !important;
            overflow: visible !important;
          }
          /* Hide interactive UI that isn't useful on paper. */
          table.sched input { display: none !important; }
          button { display: none !important; }
          /* Compact typography. */
          table.sched { font-size: 9px !important; line-height: 1.1 !important;
                        border-collapse: collapse !important; }
          table.sched th, table.sched td { padding: 1px 3px !important; }
          /* Plain section, no shadows / rounded corners. */
          section { box-shadow: none !important; border-radius: 0 !important; overflow: visible !important; height: auto !important; border: 1.5px solid #000 !important; }
          /* Stronger black borders on every cell so the grid reads clearly
             on paper, and an extra-thick divider down the middle between
             "On the hour" and "On the half hour". */
          table.sched th, table.sched td { border: 0.5px solid #555 !important; }
          table.sched th:nth-child(3), table.sched td:nth-child(3) {
            border-left: 1.5px solid #000 !important;
          }
          /* Dynamic shrink-to-fit. JS sets --print-zoom right before
             window.print() based on the section's actual height, so a
             64-student EM day prints smaller than a 40-student HS day. */
          main { zoom: var(--print-zoom, 0.6); }
          /* Belt-and-suspenders: in browsers that ignore zoom, we still
             want the content to flow without ugly breaks. */
          table tr { page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}

function SideTable({ side, data, centerId, date, checkIns, assignments, ratio, pool }) {
  const title = side === 'HS' ? 'High School' : 'Elementary';
  const color = side === 'HS' ? 'bg-blue-900' : 'bg-emerald-800';
  const dayLabel = (() => {
    try {
      return new Date(date + 'T12:00').toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    } catch { return date; }
  })();

  return (
    <section className="rounded-lg border border-gray-200 bg-white overflow-hidden print:overflow-visible">
      {/* Print-only big header — gives each printed page a clear "Friday, June 13 · High School" title */}
      <div className="hidden print:block px-3 pt-2 pb-1 border-b border-black">
        <div className="text-base font-bold">{dayLabel} · {title}</div>
        <div className="text-xs text-gray-700">{data.totals[side]} total students · ratio 1:{ratio}</div>
      </div>
      <div className={`flex justify-between items-center px-4 py-2 text-white ${color} print:hidden`}>
        <span className="font-semibold">{title}</span>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">{data.totals[side]} total</span>
      </div>
      <table className="w-full text-sm table-fixed">
        <thead className="bg-gray-100 text-[10px] uppercase text-gray-500">
          <tr>
            <th className="px-1 py-1 text-left w-14">Time</th>
            <th className="px-1 py-1 text-left">On the hour</th>
            <th className="px-1 py-1 text-left border-l border-gray-200">On the half hour</th>
            <th className="px-1 py-1 text-center w-8">#</th>
            <th className="px-1 py-1 text-left w-28">Instructors</th>
          </tr>
        </thead>
        <tbody>
          {data.slots.map((row, i) => (
            <SlotRow key={row.slot} row={row} side={side} alt={i % 2 === 1}
              centerId={centerId} date={date}
              checkIns={checkIns} assignments={assignments} ratio={ratio} pool={pool} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SlotRow({ row, side, alt, centerId, date, checkIns, assignments, ratio, pool }) {
  const onHour = row.students[side].onHour;
  const halfHour = row.students[side].halfHour;
  const count = row.counts[side];
  const need = Math.max(1, Math.ceil(count / ratio));
  const instructors = assignments[`${side}|${row.slot}`] || [];
  const understaffed = instructors.length < need;

  const handleStatus = async (sid) => {
    const cur = checkIns[sid]?.status || '';
    const next = cur === 'in' ? '' : 'in';
    try { await setCheckIn(centerId, date, sid, next); }
    catch (e) { toast.error(e.message); }
  };
  const handleStatusMenu = async (e, sid) => {
    e.preventDefault();
    const cur = checkIns[sid]?.status || '';
    const next = prompt(`Status (in / late / noshow / cancel / blank to clear). Current: "${cur}"`, cur);
    if (next === null) return;
    try { await setCheckIn(centerId, date, sid, next.trim() || ''); }
    catch (e) { toast.error(e.message); }
  };
  const handleAddInstructor = async () => {
    const choices = pool.filter(n => !instructors.includes(n));
    const pick = prompt(
      `Add instructor to ${side} ${row.label}.\nPool: ${pool.join(', ') || '(set the pool in Setup)'}\nName:`,
      choices[0] || ''
    );
    if (!pick) return;
    try { await setInstructorAssignment(centerId, date, side, row.slot, [...instructors, pick.trim()]); }
    catch (e) { toast.error(e.message); }
  };
  const handleRemoveInstructor = async (name) => {
    try { await setInstructorAssignment(centerId, date, side, row.slot, instructors.filter(n => n !== name)); }
    catch (e) { toast.error(e.message); }
  };

  return (
    <tr className={alt ? 'bg-gray-50' : ''}>
      <td className="px-1 py-1.5 align-top text-xs font-semibold text-gray-700 whitespace-nowrap">
        {row.label.split('–')[0]}<br/>
        <span className="font-normal text-[10px] text-gray-400">{row.label.split('–')[1]}</span>
      </td>
      {/* On the hour column */}
      <td className="px-1 py-1 align-top">
        <StudentList students={onHour} checkIns={checkIns}
          centerId={centerId} date={date}
          onStatusClick={handleStatus} onStatusMenu={handleStatusMenu} />
      </td>
      {/* Half-hour column, visually offset down a touch so on-shift staff
          can see at a glance that these arrive 30 min after the hour. */}
      <td className="px-1 py-1 align-top border-l border-gray-100 pt-3">
        <StudentList students={halfHour} checkIns={checkIns}
          centerId={centerId} date={date}
          onStatusClick={handleStatus} onStatusMenu={handleStatusMenu} />
      </td>
      <td className={`px-1 py-1 align-top text-center text-base font-bold ${understaffed ? 'text-red-600' : 'text-gray-700'}`}>
        {count}
      </td>
      <td className="px-1 py-1 align-top">
        <div className="flex flex-wrap gap-0.5">
          {instructors.map(n => (
            <span key={n} className="cursor-pointer rounded-full bg-gray-100 px-1.5 py-0 text-[10px] hover:bg-red-100"
              onClick={() => handleRemoveInstructor(n)} title="Click to remove">
              {n} <span className="text-red-600">×</span>
            </span>
          ))}
          <button onClick={handleAddInstructor}
            className="rounded-full border border-dashed border-gray-300 px-1.5 py-0 text-[10px] text-gray-500 hover:border-red-400 hover:text-red-600 print:hidden">
            + add
          </button>
        </div>
        <div className={`mt-0.5 text-[9px] ${understaffed ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
          need {need} · have {instructors.length}
        </div>
      </td>
    </tr>
  );
}

function StudentList({ students, checkIns, centerId, date, onStatusClick, onStatusMenu }) {
  if (students.length === 0) return <div className="text-[10px] text-gray-300">—</div>;
  return (
    <ul className="space-y-0.5">
      {students.map(s => (
        <StudentRow key={s.id} s={s} entry={checkIns[s.id] || {}}
          centerId={centerId} date={date}
          onStatusClick={onStatusClick} onStatusMenu={onStatusMenu} />
      ))}
    </ul>
  );
}

function StudentRow({ s, entry, centerId, date, onStatusClick, onStatusMenu }) {
  const status = entry.status || '';
  const cls = {
    in:      'text-emerald-700',
    late:    'text-amber-600',
    noshow:  'text-red-600 line-through',
    cancel:  'text-gray-400 line-through',
  }[status] || '';

  // Uncontrolled inputs: typing only touches the DOM; saves fire on blur.
  // `key={...}` forces remount when another staff member updates the value
  // on a different device, so the input always shows the latest Firestore
  // value without a controlled-component sync loop.
  const saveTag = (v) => setStudentTag(centerId, date, s.id, v).catch(e => toast.error(e.message));
  const saveDesk = (v) => setStudentDesk(centerId, date, s.id, v).catch(e => toast.error(e.message));

  return (
    <li className={`flex items-center gap-1 leading-tight ${cls}`}>
      <span className="cursor-pointer w-3 text-center shrink-0" onClick={() => onStatusClick(s.id)}>
        {status === 'in' ? '✓' : '☐'}
      </span>
      <span className="cursor-pointer hover:underline truncate"
        onClick={() => onStatusClick(s.id)}
        onContextMenu={e => onStatusMenu(e, s.id)}
        title={s.aliasedFrom ? `Booked under: ${s.aliasedFrom}` : ''}>
        {s.name}
      </span>
      {s.isAssessment && <span className="text-[9px] text-amber-700 shrink-0" title="Assessment">(A)</span>}
      {s.isHybrid && <span className="text-[9px] text-purple-700 shrink-0" title="Hybrid student">(H)</span>}
      {s.uncertainAlias && (
        <span className="text-[10px] text-amber-600 font-semibold shrink-0"
          title={`Couldn't confidently pick a student for parent "${s.aliasedFrom}". Verify.`}>?</span>
      )}
      {/* Tag input — A / FT / N / HM / etc.
          Borderless when empty so the row stays compact. Light gray hover
          band hints it's editable; full input style appears on focus. */}
      <input
        key={`tag-${entry.tag || ''}`}
        type="text" defaultValue={entry.tag || ''} maxLength={3}
        onBlur={e => saveTag(e.target.value.toUpperCase())}
        title="A=Assessment · FT=Free Trial · N=New · HM=High Maintenance"
        className="ml-auto w-6 shrink-0 border-0 bg-transparent px-0 text-[10px] uppercase text-center text-gray-700 rounded hover:bg-gray-100 focus:bg-white focus:outline focus:outline-1 focus:outline-blue-400 focus:w-8"
      />
      {/* Desk input — same compact treatment. */}
      <input
        key={`desk-${entry.desk || ''}`}
        type="text" defaultValue={entry.desk || ''} maxLength={4}
        onBlur={e => saveDesk(e.target.value)}
        title="Desk number"
        className="w-8 shrink-0 border-0 bg-transparent px-0 text-[10px] text-center text-gray-700 rounded hover:bg-gray-100 focus:bg-white focus:outline focus:outline-1 focus:outline-blue-400 focus:w-10"
      />
    </li>
  );
}

function UnknownBanner({ data, centerId, onFix }) {
  const fix = async (name) => {
    try {
      const real = prompt(`What's the real student's name for "${name}"? (Used for the dashboard label + category lookup.)`, '');
      if (real && real.trim()) {
        await upsertAlias(centerId, { parentName: name, replacements: [real.trim()] });
        toast.success('Alias saved. Refreshing…');
        onFix();
      }
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 print:hidden">
      <div className="mb-1 flex items-center gap-1 text-sm font-semibold text-amber-800">
        <AlertTriangle size={14} /> Uncategorized: {data.unknownList.length}
      </div>
      <ul className="space-y-1 text-sm">
        {data.unknownList.map(s => (
          <li key={s.id} className="flex flex-wrap items-center gap-2">
            <span>{s.name}</span>
            <span className="text-xs text-gray-500">({s.type})</span>
            <button onClick={() => fix(s.name)}
              className="rounded bg-white border border-amber-300 px-2 py-0.5 text-xs hover:bg-amber-100">
              → Map to student…
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  FORECAST TAB
// ═══════════════════════════════════════════════════════════════════════
function ForecastTab({ centerId }) {
  const [days, setDays] = useState(14);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const token = await auth.currentUser?.getIdToken();
      const start = new Date();
      const out = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(start.getTime() + i*24*60*60*1000);
        const day = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const r = await fetch(`/api/scheduler/appointments?centerId=${encodeURIComponent(centerId)}&date=${day}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        let peakStudents = 0, peakNeeded = 0, peakSlot = null;
        for (const s of (j.slots || [])) {
          const total = (s.counts.HS || 0) + (s.counts.EM || 0);
          const need = Math.max(1, Math.ceil(total / 4));
          if (total > peakStudents) { peakStudents = total; peakSlot = s.label; }
          if (need > peakNeeded) peakNeeded = need;
        }
        out.push({ day, peakStudents, peakNeeded, peakSlot, total: j.totals.all });
      }
      setRows(out);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [centerId, days]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-3">
        <label className="text-sm">Window
          <select value={days} onChange={e => setDays(+e.target.value)}
            className="ml-2 rounded border border-gray-300 px-2 py-1 text-sm">
            <option value={7}>Next 7 days</option>
            <option value={14}>Next 14 days</option>
            <option value={30}>Next 30 days</option>
          </select>
        </label>
        <button onClick={load} className="rounded bg-gray-100 px-3 py-1 text-sm hover:bg-gray-200">Refresh</button>
      </div>
      {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      {loading && <div className="text-sm text-gray-500">Loading {days} days…</div>}
      {rows && (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-gray-500">
            <tr>
              <th className="text-left">Day</th>
              <th className="text-right">Total</th>
              <th className="text-right">Peak students</th>
              <th className="text-right">Instructors needed</th>
              <th className="text-left pl-3">Peak slot</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.day} className="border-t border-gray-100">
                <td className="py-1">{new Date(r.day + 'T00:00').toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' })}</td>
                <td className="py-1 text-right">{r.total}</td>
                <td className="py-1 text-right">{r.peakStudents}</td>
                <td className="py-1 text-right font-semibold">{r.peakNeeded}</td>
                <td className="py-1 pl-3 text-gray-500">{r.peakSlot || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  SETUP TAB
// ═══════════════════════════════════════════════════════════════════════
function SetupTab({ centerId }) {
  const [settings, setSettings] = useState(null);
  const [students, setStudents] = useState([]);
  const [aliases, setAliases] = useState([]);
  const fileRef = useRef(null);

  useEffect(() => { getSettings(centerId).then(setSettings); }, [centerId]);
  useEffect(() => watchStudents(centerId, setStudents), [centerId]);
  useEffect(() => watchAliases(centerId, setAliases), [centerId]);

  if (!settings) return <div>Loading…</div>;

  const updateSetting = async (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try { await saveSettings(centerId, patch); }
    catch (e) { toast.error(e.message); }
  };

  // CSV import handler.
  //
  // The Student Assessment Tracker uses SECTION HEADERS in column A
  // ("High School", "Online", with Elementary implicit at the top) to
  // separate students into categories. We walk the rows in order,
  // tracking the current section, so a grade-9 student living in the
  // Elementary section correctly ends up on the EM side.
  //
  // Inside the "Online" section, students with status "hybrid" come to
  // the centre too — they're routed to HS or EM by grade and tagged
  // isHybrid. Status "@home" stays as Online (not shown on the daily
  // ops dashboard since they're remote).
  const importCsv = async (file) => {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) { toast.error('CSV is empty'); return; }

    const out = [];
    let assessmentCount = 0, hybridCount = 0;
    let section = 'EM';   // implicit start: Elementary

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = (r[0] || '').trim();
      const grade = (r[1] || '').trim();
      const status = (r[2] || '').trim();

      // Section header row: column A is set, B and C are empty.
      if (name && !grade && !status) {
        const h = name.toLowerCase();
        if (/high\s*school/.test(h)) section = 'HS';
        else if (/elementary/.test(h)) section = 'EM';
        else if (/online/.test(h)) section = 'ONLINE_SECTION';
        // Unknown header → leave section as-is; skip the row either way.
        continue;
      }
      if (!name) continue;

      // Resolve display category and hybrid flag.
      let category, isHybrid = false;
      if (section === 'ONLINE_SECTION') {
        if (/hybrid|hyrid/i.test(status)) {
          isHybrid = true;
          category = hybridDisplaySide(grade);
          hybridCount++;
        } else {
          category = 'Online';
        }
      } else {
        category = section;   // 'EM' or 'HS'
      }

      const hasAssessment = r.some(cell => /binder/i.test(cell || ''));
      if (hasAssessment) assessmentCount++;

      out.push({
        name, grade, status,
        category, isHybrid,
        assignedInstructor: (r[8] || '').trim(),
        hasAssessment,
      });
    }
    try {
      await bulkImportStudents(centerId, out);
      toast.success(`Imported ${out.length} students (${assessmentCount} assessment, ${hybridCount} hybrid)`);
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="space-y-6">
      {/* Settings card */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 font-semibold">Connection & ratios</h2>
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Acuity iCal URLs (one per line)</label>
            <textarea rows={3} value={(settings.icalUrls || []).join('\n')}
              onChange={e => updateSetting({ icalUrls: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
              className="w-full rounded border border-gray-300 px-2 py-1 text-xs font-mono"
              placeholder="https://acuityscheduling.com/ical.php?owner=...&calendarID=..." />
            <p className="mt-1 text-xs text-gray-500">Get from Acuity → Calendars → click your calendar → Sync with Other Calendars → 1-way Calendar Sync.</p>
          </div>
          <div className="flex gap-4">
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">Students per instructor</span>
              <input type="number" value={settings.studentsPerInstructor || 4}
                onChange={e => updateSetting({ studentsPerInstructor: +e.target.value })}
                className="w-24 rounded border border-gray-300 px-2 py-1" />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-1">Minimum instructors</span>
              <input type="number" value={settings.minInstructors || 1}
                onChange={e => updateSetting({ minInstructors: +e.target.value })}
                className="w-24 rounded border border-gray-300 px-2 py-1" />
            </label>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Default instructor pool (comma-separated)</label>
            <input type="text" value={(settings.instructorPool || []).join(', ')}
              onChange={e => updateSetting({ instructorPool: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              className="w-full rounded border border-gray-300 px-2 py-1"
              placeholder="Joanne, Pavit, DevP, Arham, Bri, Luke, Homer, Sabrina" />
          </div>
        </div>
      </section>

      {/* Roster card */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">
            Student roster
            <span className="ml-2 text-xs text-gray-500">({students.length} total</span>
            <span className="ml-1 text-xs text-amber-700">· {students.filter(s => s.hasAssessment).length} (A)</span>
            <span className="ml-1 text-xs text-purple-700">· {students.filter(s => s.isHybrid).length} (H))</span>
          </h2>
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ''; }} />
            <button onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1 rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700">
              <Upload size={14} /> Import CSV
            </button>
            <button onClick={async () => {
              const name = prompt('Student name'); if (!name) return;
              const grade = prompt('Grade (K, 1–12)') || '';
              const status = (prompt('Status (centre, hybrid, @home)') || 'centre').toLowerCase();
              // Manual adds skip the section-header logic, so we pick the
              // category here: @home → Online; hybrid → side by grade
              // (with isHybrid flagged); otherwise grade decides HS vs EM.
              let category, isHybrid = false;
              if (status === '@home') category = 'Online';
              else if (/hybrid|hyrid/.test(status)) {
                isHybrid = true;
                category = hybridDisplaySide(grade);
              } else {
                category = /^(8|9|10|11|12)$/.test(grade.toUpperCase()) ? 'HS' : 'EM';
              }
              await upsertStudent(centerId, { name, grade, status, category, isHybrid });
            }} className="flex items-center gap-1 rounded bg-gray-100 px-3 py-1 text-sm hover:bg-gray-200">
              <Plus size={14} /> Add
            </button>
          </div>
        </div>
        <p className="mb-2 text-xs text-gray-500">CSV layout matches your Student Assessment Tracker: column A name, B grade, C status. Re-import any time to refresh.</p>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-100 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-2 py-1">Name</th>
                <th className="text-left">Grade</th>
                <th className="text-left">Status</th>
                <th className="text-left">Category</th>
                <th className="text-left">Assessment</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {students.slice(0, 500).map(s => (
                <tr key={s.id} className="border-t border-gray-100">
                  <td className="px-2 py-1">{s.name}</td>
                  <td>{s.grade}</td>
                  <td>{s.status}</td>
                  <td><span className={`rounded px-2 py-0.5 text-xs ${
                    s.category === 'HS' ? 'bg-blue-100 text-blue-700' :
                    s.category === 'EM' ? 'bg-emerald-100 text-emerald-700' :
                    'bg-purple-100 text-purple-700'
                  }`}>{s.category}</span></td>
                  <td>
                    {s.hasAssessment
                      ? <span className="rounded px-2 py-0.5 text-xs bg-amber-100 text-amber-800">(A)</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="text-right pr-2">
                    <button onClick={() => deleteStudent(centerId, s.id)} className="text-gray-400 hover:text-red-600" title="Delete">
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {students.length > 500 && (
            <p className="mt-1 text-center text-xs text-gray-400">{students.length - 500} more rows — use search later</p>
          )}
        </div>
      </section>

      {/* Aliases card */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Parent-name aliases <span className="text-xs text-gray-500">({aliases.length})</span></h2>
          <div className="flex gap-2">
            <button onClick={async () => {
              try {
                for (const a of STANDARD_ALIASES) await upsertAlias(centerId, a);
                toast.success(`Imported ${STANDARD_ALIASES.length} standard aliases`);
              } catch (e) { toast.error(e.message); }
            }} className="flex items-center gap-1 rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700"
              title="Bulk-import the 13 known parent-name mappings (Kelly Nelson, JackHarry Thorne, etc.)">
              <Upload size={14} /> Import 13 standard
            </button>
            <button onClick={async () => {
              const parent = prompt('Parent name (as it appears in Acuity)'); if (!parent) return;
              const reps = prompt('Replacement student name(s), comma-separated', '') || '';
              const replacements = reps.split(',').map(s => s.trim()).filter(Boolean);
              if (!replacements.length) return;
              await upsertAlias(centerId, { parentName: parent, replacements });
            }} className="flex items-center gap-1 rounded bg-gray-100 px-3 py-1 text-sm hover:bg-gray-200">
              <Plus size={14} /> Add alias
            </button>
          </div>
        </div>
        <p className="mb-2 text-xs text-gray-500">When Acuity shows the parent's name, the 1st appearance becomes the 1st student, 2nd → 2nd, etc.</p>
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-xs uppercase text-gray-500">
            <tr><th className="text-left px-2 py-1">Parent name</th><th className="text-left">Becomes</th><th></th></tr>
          </thead>
          <tbody>
            {aliases.map(a => (
              <tr key={a.id} className="border-t border-gray-100">
                <td className="px-2 py-1">{a.parentName}</td>
                <td>{(a.replacements || []).join(' → ')}</td>
                <td className="text-right pr-2">
                  <button onClick={() => deleteAlias(centerId, a.id)} className="text-gray-400 hover:text-red-600">
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-gray-400">
        Data is per centre and persisted in Firestore.
        iCal URLs are stored encrypted at rest and never sent to the browser — only the server fetches them.
      </p>

      {/* Print rules so the Today tab prints cleanly */}
      <style>{`
        @media print {
          header, .print\\:hidden { display: none !important; }
          body { background: white; }
        }
      `}</style>
    </div>
  );
}
