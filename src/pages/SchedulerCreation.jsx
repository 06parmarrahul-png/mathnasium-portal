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
  watchCheckIns, setCheckIn,
  watchInstructorAssignments, setInstructorAssignment,
} from '../lib/scheduler-data';
import { toast } from '../lib/notify';

// ───── Helpers ──────────────────────────────────────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function categoryFor(grade, status) {
  const s = (status || '').trim().toLowerCase();
  if (s === '@home') return 'Online';
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
      <header className="mb-4 flex items-center gap-3">
        <ClipboardList className="text-red-600" size={28} />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Scheduler Creation</h1>
          <p className="text-sm text-gray-500">Daily schedule, staffing forecast, and configuration for the active centre.</p>
        </div>
      </header>

      <div className="mb-4 flex gap-1 border-b border-gray-200">
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
        <button onClick={() => window.print()}
          className="flex items-center gap-1 rounded bg-gray-900 px-3 py-1 text-sm text-white hover:bg-gray-700">
          <Printer size={14} /> Print
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <SideTable side="HS" data={data} centerId={centerId} date={date}
            checkIns={checkIns} assignments={assignments} ratio={ratio} pool={pool} />
          <SideTable side="EM" data={data} centerId={centerId} date={date}
            checkIns={checkIns} assignments={assignments} ratio={ratio} pool={pool} />
        </div>
      )}

      {data && data.totals.Online > 0 && (
        <OnlineStrip data={data} />
      )}
    </div>
  );
}

function SideTable({ side, data, centerId, date, checkIns, assignments, ratio, pool }) {
  const title = side === 'HS' ? 'High School' : 'Elementary';
  const color = side === 'HS' ? 'bg-blue-900' : 'bg-emerald-800';

  return (
    <section className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className={`flex justify-between items-center px-4 py-2 text-white ${color}`}>
        <span className="font-semibold">{title}</span>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">{data.totals[side]} total</span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-gray-100 text-xs uppercase text-gray-500">
          <tr>
            <th className="px-2 py-1 text-left w-20">Time</th>
            <th className="px-2 py-1 text-left">Students</th>
            <th className="px-2 py-1 text-center w-10">#</th>
            <th className="px-2 py-1 text-left w-40">Instructors</th>
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
    const cur = checkIns[sid] || '';
    const next = cur === 'in' ? '' : 'in';
    try { await setCheckIn(centerId, date, sid, next); }
    catch (e) { toast.error(e.message); }
  };
  const handleStatusMenu = async (e, sid) => {
    e.preventDefault();
    const cur = checkIns[sid] || '';
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
      <td className="px-2 py-2 align-top text-xs font-semibold text-gray-700 whitespace-nowrap">
        {row.label.split('–')[0]}<br/>
        <span className="font-normal text-gray-400">{row.label.split('–')[1]}</span>
      </td>
      <td className="px-2 py-1 align-top">
        <StudentGroup label="On the hour" students={onHour} checkIns={checkIns}
          onClick={handleStatus} onContextMenu={handleStatusMenu} />
        <StudentGroup label="On the half hour" students={halfHour} checkIns={checkIns}
          onClick={handleStatus} onContextMenu={handleStatusMenu} />
      </td>
      <td className={`px-2 py-2 align-top text-center text-lg font-bold ${understaffed ? 'text-red-600' : 'text-gray-700'}`}>
        {count}
      </td>
      <td className="px-2 py-2 align-top">
        <div className="flex flex-wrap gap-1">
          {instructors.map(n => (
            <span key={n} className="cursor-pointer rounded-full bg-gray-100 px-2 py-0.5 text-xs hover:bg-red-100"
              onClick={() => handleRemoveInstructor(n)} title="Click to remove">
              {n} <span className="text-red-600">×</span>
            </span>
          ))}
          <button onClick={handleAddInstructor}
            className="rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-xs text-gray-500 hover:border-red-400 hover:text-red-600 print:hidden">
            + add
          </button>
        </div>
        <div className={`mt-1 text-[10px] ${understaffed ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
          need {need} · have {instructors.length}
        </div>
      </td>
    </tr>
  );
}

function StudentGroup({ label, students, checkIns, onClick, onContextMenu }) {
  if (students.length === 0) return null;
  return (
    <div className="py-1">
      <div className="text-[9px] uppercase tracking-wide text-gray-400">{label}</div>
      <ul className="mt-0.5">
        {students.map(s => {
          const st = checkIns[s.id] || '';
          const cls = {
            in:      'text-emerald-700',
            late:    'text-amber-600',
            noshow:  'text-red-600 line-through',
            cancel:  'text-gray-400 line-through',
          }[st] || '';
          return (
            <li key={s.id + label} className={`flex items-center gap-1.5 leading-tight ${cls}`}>
              <span className="cursor-pointer w-3 text-center" onClick={() => onClick(s.id)}>
                {st === 'in' ? '✓' : '☐'}
              </span>
              <span className="cursor-pointer hover:underline"
                onClick={() => onClick(s.id)}
                onContextMenu={e => onContextMenu(e, s.id)}>
                {s.name}{s.isAssessment && <span className="ml-1 text-[9px] text-gray-400">(A)</span>}
              </span>
              {s.aliasedFrom && <span className="text-[9px] text-gray-400" title={`Booked under: ${s.aliasedFrom}`}>•</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OnlineStrip({ data }) {
  const rows = data.slots
    .map(r => ({ slot: r.label, count: r.counts.Online }))
    .filter(r => r.count > 0);
  if (!rows.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-purple-200 bg-purple-50 p-3">
      <div className="mb-1 text-sm font-semibold text-purple-700">Online ({data.totals.Online})</div>
      <div className="flex flex-wrap gap-1 text-xs">
        {rows.map((r, i) => (
          <span key={i} className="rounded bg-white px-2 py-0.5">{r.slot}: <b>{r.count}</b></span>
        ))}
      </div>
    </div>
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

  // CSV import handler
  const importCsv = async (file) => {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) { toast.error('CSV is empty'); return; }
    // Column layout matches the Student Assessment Tracker:
    //   A=name, B=grade, C=status, ... I=assigned instructor
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; const name = (r[0] || '').trim();
      if (!name) continue;
      const grade = (r[1] || '').trim();
      const status = (r[2] || '').trim();
      out.push({
        name, grade, status,
        category: categoryFor(grade, status),
        assignedInstructor: (r[8] || '').trim(),
      });
    }
    try {
      await bulkImportStudents(centerId, out);
      toast.success(`Imported ${out.length} students`);
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
          <h2 className="font-semibold">Student roster <span className="text-xs text-gray-500">({students.length})</span></h2>
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
              const status = prompt('Status (centre, hybrid, @home)') || 'centre';
              await upsertStudent(centerId, { name, grade, status, category: categoryFor(grade, status) });
            }} className="flex items-center gap-1 rounded bg-gray-100 px-3 py-1 text-sm hover:bg-gray-200">
              <Plus size={14} /> Add
            </button>
          </div>
        </div>
        <p className="mb-2 text-xs text-gray-500">CSV layout matches your Student Assessment Tracker: column A name, B grade, C status. Re-import any time to refresh.</p>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-100 text-xs uppercase text-gray-500">
              <tr><th className="text-left px-2 py-1">Name</th><th className="text-left">Grade</th><th className="text-left">Status</th><th className="text-left">Category</th><th></th></tr>
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
