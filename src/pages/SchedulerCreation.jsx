// Scheduler Creation — Enterprise sidebar page.
//
// Three sub-tabs:
//   1. Setup    — iCal URLs, ratio, instructor pool, student roster (CSV
//                 import + per-row edit), parent-name aliases.
//   2. Today    — Live daily ops dashboard: Elementary stacked above High
//                 School, click to check students in, assign instructors
//                 per slot, print.
//   3. Forecast — Next 7/14/30 days, peak demand vs. ratio.
//
// All data is per-centre. Reads `activeCenterId` from AuthContext. iCal
// fetching happens server-side via /api/scheduler/appointments to avoid
// shipping private feed URLs to the browser.

import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { auth, db } from '../firebase';
import {
  ClipboardList, Settings, CalendarCheck, BarChart3, Printer,
  Upload, Plus, Trash2, AlertTriangle, RefreshCw,
  Sheet, Copy, CheckCircle2, Link2Off, Clipboard, ClipboardCheck, X,
} from 'lucide-react';
import {
  getSettings, saveSettings,
  watchStudents, upsertStudent, deleteStudent, bulkImportStudents,
  watchAliases, upsertAlias, deleteAlias,
  watchCheckIns, setCheckIn, setStudentDesk,
  watchInstructorAssignments, setInstructorAssignment,
  watchWalkIns, addWalkIn, removeWalkIn,
  setSlotOverride, clearSlotOverride,
  enableSheetSync, rotateSheetSyncToken, disableSheetSync,
} from '../lib/scheduler-data';
// Legacy hardcoded fixed-staff map (Sabrina, Neeru, Rachel). Used as a
// fallback so the Today tab knows about them even when the live Firestore
// config doc has no `fixedStaff` key. Same fallback the auto-scheduler
// uses in scheduler.js → getFixedStaffForDay, so the two stay in sync.
import { FIXED_SCHEDULES } from '../lib/scheduler';
import {
  hasSlotEnded, classifyStudent,
  computeDayAnalytics, recommendationFor, isDayComplete,
  fmtRatio, fmtPct,
} from '../lib/scheduler-analytics';
import {
  saveSnapshot, getSnapshot, getSnapshotsInRange,
  computeWeeklyAverages, rangeForLookback, MIN_SAMPLES_FOR_AVG,
} from '../lib/schedule-snapshots';

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
  { parentName: 'Claire and Julia Eddy', replacements: ['Claire Eddy', 'Julia Eddy'] },
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
  // Scheduler Creation is part of daily ops, so anyone running a shift
  // can use it — super_admin, owner, admin_assistant, plain admin, AND
  // lead instructors (per the centre's request — Leads often run the
  // floor and need to assign instructors / check students in / print).
  const { activeCenterId, canRunScheduler } = useAuth();
  const allowed = canRunScheduler;
  const [tab, setTab] = useState('today');

  if (!allowed) {
    return (
      <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm text-center">
        <p className="text-3xl mb-2">🔒</p>
        <h1 className="text-xl font-bold text-gray-900 mb-2">Not available</h1>
        <p className="text-sm text-gray-500">Scheduler Creation is open to Admins, Owners, Admin Assistants, and Enterprise.</p>
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
//  TODAY TAB — daily ops dashboard (EM on top, HS below, check-ins)
// ═══════════════════════════════════════════════════════════════════════
function TodayTab({ centerId }) {
  // Pull centerConfig so we can read fixedStaff (auto-populates the
  // pool dropdown with Sabrina, Neeru, etc. — users who don't have
  // a Firebase account but ARE part of daily centre staffing).
  const { centerConfig: activeCenterConfig, profile } = useAuth();
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
  // Live list of instructor users at the active centre. Used to populate
  // the per-slot "+ add" dropdown so staff doesn't have to maintain a
  // separate text list.
  const [staffUsers, setStaffUsers] = useState([]);
  // Map of stored-name → canonical full-name, populated from the user
  // roster subscription below. Lets old assignment docs containing
  // "Bri" or "Sabrina" render as "Brianna MacDonald" / "Sabrina Kedzior"
  // without backfilling Firestore.
  const [staffNameAliases, setStaffNameAliases] = useState(() => new Map());
  // Instructor clipboard — when a row's "copy" button is hit, we stash
  // { names: [...], from: 'HS|14:00' } here so any other row (either side)
  // can paste it. Lives in component state only — clears on refresh / day
  // change so a stale yesterday-clipboard can't surprise anyone tomorrow.
  const [instructorClipboard, setInstructorClipboard] = useState(null);
  useEffect(() => setInstructorClipboard(null), [date]);

  // Pull the centre's per-day fixed staff so the Today tab knows about
  // staff who don't have Firebase accounts (Sabrina, Neeru, Rachel).
  //
  // Source of truth, in order:
  //   1. centerConfig.fixedStaff from the live Firestore doc.
  //   2. Fallback to FIXED_SCHEDULES (legacy hardcoded Langley set)
  //      when the live config is empty. Same fallback the auto-scheduler
  //      uses, so the two paths stay in sync.
  //
  // Filter: only include fixed staff whose ROLE means they can actually
  // be scheduled to run student sessions — Manager, Lead, Instructor,
  // Host. Director / Admin roles stay out of the dropdown because they
  // aren't slot-eligible (they're support staff who never get assigned
  // to an EM/HS time slot).
  const SLOT_ELIGIBLE_ROLES = new Set(['Manager', 'Lead', 'Instructor', 'Host']);
  const centerConfig = activeCenterConfig;
  const fixedStaffNames = useMemo(() => {
    const m = centerConfig?.fixedStaff;
    const map = (m && Object.keys(m).length > 0) ? m : FIXED_SCHEDULES;
    return Object.entries(map)
      .filter(([, sched]) => SLOT_ELIGIBLE_ROLES.has(sched?.role))
      .map(([name]) => name)
      .filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerConfig]);

  // Subscribe to the centre's user roster. We include instructors and
  // admin assistants since both get scheduled to slots in practice.
  //
  // Two outputs from the same subscription:
  //   1. staffUsers  — string[], canonical names used to populate the
  //      "+ add" dropdown and dedupe against the manual instructorPool.
  //      Prefers full displayName ("Brianna MacDonald") over a possibly-
  //      nickname firstName ("Bri") so the pitch-quality schedule reads
  //      well without anyone hand-editing user profiles.
  //   2. staffNameAliases — Map<storedName, canonicalName>. Handles
  //      OLD assignment docs that still contain short names like "Bri"
  //      or "Sabrina" — they get rendered as the full canonical name
  //      without requiring a backfill of the assignments collection.
  //      Also seeded from centerConfig.fixedStaff keys so "Sabrina"
  //      maps to "Sabrina Kedzior" even though she has no user account.
  useEffect(() => {
    if (!centerId) return;
    const q = query(
      collection(db, 'users'),
      where('centerIds', 'array-contains', centerId),
    );
    return onSnapshot(q, snap => {
      const members = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u =>
          u.approved !== false &&
          (u.role === 'instructor' || u.role === 'admin_assistant')
        )
        .map(u => ({
          firstName:   (u.firstName   || '').trim(),
          displayName: (u.displayName || '').trim(),
        }))
        .filter(m => m.firstName || m.displayName);

      const canonicalFor = (m) => m.displayName || m.firstName;
      const list = members.map(canonicalFor).filter(Boolean).sort((a, b) => a.localeCompare(b));
      setStaffUsers([...new Set(list)]);

      // Build the stored-name → canonical map so old assignments still
      // render the full name. We map both the firstName field and the
      // FIRST WORD of the displayName, since either could have been
      // stored in earlier assignment writes. Fixed-staff entries from
      // centerConfig get the same treatment so a manually-added "Sabrina"
      // resolves to "Sabrina Kedzior" even though she has no user account.
      const aliases = new Map();
      for (const m of members) {
        const canonical = canonicalFor(m);
        if (!canonical) continue;
        if (m.firstName && !aliases.has(m.firstName)) aliases.set(m.firstName, canonical);
        const firstWord = (m.displayName || '').split(/\s+/)[0];
        if (firstWord && !aliases.has(firstWord)) aliases.set(firstWord, canonical);
      }
      for (const fullName of fixedStaffNames) {
        const firstWord = fullName.split(/\s+/)[0];
        if (firstWord && !aliases.has(firstWord)) aliases.set(firstWord, fullName);
      }
      setStaffNameAliases(aliases);
    });
  }, [centerId, fixedStaffNames]);

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
    // Two RAFs to let React commit + layout the single-side render
    // (without the other side's column-width competition) before we
    // measure. This is important: at small viewports the side could be
    // wrapping differently on-screen than when it's full-width on paper.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // Strategy: measure the actual rendered height of the schedule
      // section, then pick a zoom so it lands inside one letter page's
      // usable vertical space (~9.5 inches of writable area × 96 dpi =
      // ~912 px). We hedge by trying multiple measurements and picking
      // the largest — handles cases where the on-screen layout is more
      // compressed (e.g. half-screen during the split view) than what
      // the printer will see.
      const sections = document.querySelectorAll('main section');
      let maxHeight = 0;
      for (const s of sections) {
        const h = Math.max(s.scrollHeight || 0, s.offsetHeight || 0);
        if (h > maxHeight) maxHeight = h;
      }
      const usablePageHeight = 912;
      // Also feed the row count in as a secondary signal — if both agree
      // (busy day = tall + many rows), we shrink harder. If they
      // disagree, the larger shrink wins.
      const rowCount = data?.slots?.length || 0;
      const heightZoom = maxHeight > 0
        ? Math.min(1.0, usablePageHeight / maxHeight)
        : 1.0;
      const rowZoom = Math.min(1.0, 1.0 - Math.max(0, rowCount - 10) * 0.03);
      // Pick the more aggressive shrink, floor at 0.45 so we never go
      // unreadably small. 0.45 still fits a ~85-student EM day.
      const zoom = Math.max(0.45, Math.min(heightZoom, rowZoom));
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

  // Subscribe to today's check-ins + instructor assignments + walk-ins.
  useEffect(() => watchCheckIns(centerId, date, setCheckIns), [centerId, date]);
  useEffect(() => watchInstructorAssignments(centerId, date, setAssignments), [centerId, date]);
  const [walkIns, setWalkIns] = useState({});
  useEffect(() => watchWalkIns(centerId, date, setWalkIns), [centerId, date]);

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
  // Pool = live Firestore staff list, plus any custom names from Setup
  // (so one-off helpers can still be added without being approved users).
  // Pool = live Firestore staff (instructors + AAs) + slot-eligible
  // fixed staff (Manager / Lead / Host) + any freeform names the owner
  // typed under Setup. Deduped, then sorted alphabetically so fixed
  // staff slot in by first name instead of bunching at the bottom of
  // the dropdown. Rendered in the +add picker on every slot row.
  const pool = [...new Set([...staffUsers, ...fixedStaffNames, ...((settings?.instructorPool) || [])])]
    .sort((a, b) => a.localeCompare(b));

  // ── Day-level analytics ──────────────────────────────────────────────
  // Pure derivation from the data already in memory. Recomputes when
  // anything material changes (slot data, assignments, check-ins,
  // ratio). The timezone comes from the server response so the
  // "has this slot ended?" math is centre-local, not browser-local.
  const dayAnalytics = useMemo(() => {
    if (!data) return { hasData: false };
    return computeDayAnalytics({
      data, assignments, checkIns, ratio, dateStr: date,
    });
  }, [data, assignments, checkIns, ratio, date]);
  const recommendation = useMemo(() => recommendationFor(dayAnalytics), [dayAnalytics]);

  // ── Today's scheduled staff (from the shifts collection) ────────────
  // Drives the "On shift today" pre-filter on the +add dropdown so
  // staff doesn't scroll through every approved instructor when picking
  // someone for a slot. Falls back to the day-of-week fixed-staff
  // entries — Sabrina works Mon-Fri implicitly even though there's no
  // shift doc for her.
  const [todayShifts, setTodayShifts] = useState([]);
  useEffect(() => {
    if (!centerId || !date) return;
    return onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', centerId),
        where('date', '==', date),
      ),
      snap => setTodayShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.status !== 'draft')),
      () => setTodayShifts([]),
    );
  }, [centerId, date]);

  const scheduledTodayNames = useMemo(() => {
    const set = new Set();
    // From actual shift docs:
    for (const s of todayShifts) if (s.userName) set.add(s.userName);
    // From fixed staff schedule for this day of week:
    const fixedMap = (centerConfig?.fixedStaff && Object.keys(centerConfig.fixedStaff).length > 0)
      ? centerConfig.fixedStaff
      : FIXED_SCHEDULES;
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(date + 'T12:00').getDay()];
    for (const [name, sched] of Object.entries(fixedMap)) {
      if (!SLOT_ELIGIBLE_ROLES.has(sched?.role)) continue;
      const shift = sched?.[dayName];
      if (shift && shift.toLowerCase() !== 'off') set.add(name);
    }
    // Manual instructorPool — these are explicit owner overrides, treat
    // them as "always on shift" so they're visible without expanding.
    for (const n of (settings?.instructorPool || [])) if (n) set.add(n);
    return set;
    // SLOT_ELIGIBLE_ROLES is a module-level constant — safe to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayShifts, centerConfig, date, settings]);

  // ── Lazy snapshot capture ────────────────────────────────────────────
  // When the viewed day is COMPLETE (all slots have ended) and no
  // snapshot exists yet for it, save one. This builds the historical
  // record used by the Forecast tab's "Weekly patterns" section without
  // requiring a cron — the dashboard being opened is the trigger.
  // Guards: requires centre + final data + still-correct date in view
  // (so a stale snapshot doesn't write after the date input changes).
  useEffect(() => {
    if (!centerId || !data || !dayAnalytics?.hasData) return;
    const tz = data.timezone || 'America/Vancouver';
    if (!isDayComplete(data, date, tz)) return;
    let cancelled = false;
    (async () => {
      try {
        const existing = await getSnapshot(centerId, date);
        if (cancelled) return;
        if (existing) return;   // already captured
        await saveSnapshot(centerId, date, dayAnalytics);
      } catch (e) {
        // Capture failures are non-blocking — schedule still works.
        // eslint-disable-next-line no-console
        console.warn('[snapshot] capture skipped:', e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, [centerId, date, data, dayAnalytics]);

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
        {/* Default print is both sides stacked (EM then HS on separate
            pages). Single-side buttons remain for staff who want to hand
            one section to each room. */}
        <button onClick={() => printSide('BOTH')}
          className="flex items-center gap-1 rounded bg-gray-900 px-3 py-1 text-sm text-white hover:bg-gray-700">
          <Printer size={14} /> Print Both
        </button>
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

      {/* Day-level supply / demand summary — visible whenever the day
          has something to measure. Renders one number per dimension
          and (when confident enough) a single actionable sentence. */}
      {dayAnalytics?.hasData && data?.totals?.all > 0 && (
        <DaySummary analytics={dayAnalytics} recommendation={recommendation} ratio={ratio} />
      )}

      {/* Floating clipboard chip — appears when something is copied. Lets
          the user see at a glance what's pending and clear it without
          having to find the source row. */}
      {instructorClipboard && (
        <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-800 border border-blue-200 print:hidden">
          <ClipboardCheck size={12} />
          <span>
            Copied {instructorClipboard.names.length} instructor{instructorClipboard.names.length === 1 ? '' : 's'} from {instructorClipboard.from}
            {instructorClipboard.names.length > 0 && (
              <> · {instructorClipboard.names.join(', ')}</>
            )}
          </span>
          <button onClick={() => setInstructorClipboard(null)}
            className="ml-1 inline-flex items-center rounded-full hover:bg-blue-100 p-0.5"
            title="Clear clipboard">
            <X size={12} />
          </button>
        </div>
      )}

      {data && data.totals.all > 0 && (
        // On-screen layout: always vertically stacked, Elementary on top,
        // High School below. Each side gets the full viewport width so the
        // 6-column HS grid renders without horizontal scrolling and there's
        // no need to track two side-by-side tables at once.
        //
        // Print modes (printOnly state):
        //   null   → on-screen view, both sections visible
        //   'EM'   → printer sees only Elementary (single-side handoff)
        //   'HS'   → printer sees only High School
        //   'BOTH' → both sections render with a page break between them,
        //            so the printer produces two sheets — one per side.
        <div className="flex flex-col gap-3">
          {(!printOnly || printOnly === 'EM' || printOnly === 'BOTH') && (
            <div>
              <SideTable side="EM" data={data} centerId={centerId} date={date}
                checkIns={checkIns} assignments={assignments} ratio={ratio} pool={pool}
                clipboard={instructorClipboard} setClipboard={setInstructorClipboard}
                nameAliases={staffNameAliases}
                timezone={data?.timezone}
                scheduledTodayNames={scheduledTodayNames}
                walkIns={walkIns} profile={profile} />
            </div>
          )}
          {(!printOnly || printOnly === 'HS' || printOnly === 'BOTH') && (
            // Force a page break before HS when printing both — keeps each
            // side on its own sheet so staff can hand the right page to
            // the right room without splitting one section across pages.
            <div className={printOnly === 'BOTH' ? 'print:break-before-page' : ''}>
              <SideTable side="HS" data={data} centerId={centerId} date={date}
                checkIns={checkIns} assignments={assignments} ratio={ratio} pool={pool}
                clipboard={instructorClipboard} setClipboard={setInstructorClipboard}
                nameAliases={staffNameAliases}
                timezone={data?.timezone}
                scheduledTodayNames={scheduledTodayNames}
                walkIns={walkIns} profile={profile} />
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
          table.sched { font-size: 9px !important; line-height: 1.2 !important;
                        border-collapse: collapse !important;
                        /* Auto layout lets columns size to fit the widest
                           student name, so we can keep every name on one
                           line without truncating or stretching the wider
                           columns. */
                        table-layout: auto !important; }
          table.sched th, table.sched td { padding: 2px 4px !important; }
          /* Single-line names, full visibility, no truncation. */
          table.sched td, table.sched td span { white-space: nowrap !important; }
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

// (Removed — was used to detect walk-ins spilling from the prior slot
// under a hard-coded 60-min lookback. Replaced by the duration-aware
// scan in SlotRow that iterates every walk-in on the side and keeps
// the ones whose [start, start+duration) window overlaps the row's
// slot, so 90-min walk-ins carry over the extra slot correctly.)

function SideTable({ side, data, centerId, date, checkIns, assignments, ratio, pool, clipboard, setClipboard, nameAliases, timezone, scheduledTodayNames, walkIns, profile }) {
  const title = side === 'HS' ? 'High School' : 'Elementary';
  const color = side === 'HS' ? 'bg-blue-900' : 'bg-emerald-800';
  const otherSide = side === 'HS' ? 'EM' : 'HS';
  const otherTitle = otherSide === 'HS' ? 'HS staff' : 'EM staff';
  const dayLabel = (() => {
    try {
      return new Date(date + 'T12:00').toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    } catch { return date; }
  })();

  // ── Apply slot overrides ─────────────────────────────────────────────
  // Override map shape: { studentId: "HH:MM" } (same side as original).
  // Compute moved-out set + moved-in map up front, then build adjusted
  // rows so SlotRow renders the post-move picture without knowing the
  // override exists. Counts are adjusted to match.
  const slotOverrides = walkIns?.slotOverrides || {};
  const adjustedSlots = (() => {
    if (!data?.slots || Object.keys(slotOverrides).length === 0) {
      return data?.slots || [];
    }
    const movedOutIds = new Set();
    const movedInBySlot = new Map(); // slotKey -> [students]
    const originalSlotById = new Map(); // studentId -> original slot key (for the badge tooltip)
    for (const row of data.slots) {
      const all = [...((row.students[side] || {}).onHour || []),
                   ...((row.students[side] || {}).halfHour || [])];
      for (const s of all) {
        const target = slotOverrides[s.id];
        if (target && target !== row.slot) {
          movedOutIds.add(s.id);
          originalSlotById.set(s.id, row.slot);
          if (!movedInBySlot.has(target)) movedInBySlot.set(target, []);
          movedInBySlot.get(target).push({ ...s, isMoved: true, originalSlot: row.slot });
        }
      }
    }
    return data.slots.map(row => {
      const orig = row.students[side] || { onHour: [], halfHour: [] };
      const filteredOnHour   = (orig.onHour   || []).filter(s => !movedOutIds.has(s.id));
      const filteredHalfHour = (orig.halfHour || []).filter(s => !movedOutIds.has(s.id));
      const movedIn = movedInBySlot.get(row.slot) || [];
      // Route moved-in students to the slot's natural column (matches
      // walk-in logic — :30 slots are half-hour, :00 are on-hour).
      const slotIsHalfHour = (row.slot || '').endsWith(':30');
      const newOnHour   = slotIsHalfHour ? filteredOnHour   : [...filteredOnHour,   ...movedIn];
      const newHalfHour = slotIsHalfHour ? [...filteredHalfHour, ...movedIn] : filteredHalfHour;
      const removed = (orig.onHour || []).length + (orig.halfHour || []).length
                      - filteredOnHour.length - filteredHalfHour.length;
      const newCount = (row.counts?.[side] || 0) - removed + movedIn.length;
      return {
        ...row,
        students: {
          ...row.students,
          [side]: { onHour: newOnHour, halfHour: newHalfHour },
        },
        counts: { ...row.counts, [side]: newCount },
      };
    });
  })();

  // Slot picker options for the per-student Move dropdown. All distinct
  // slot keys + their human label, sorted by time.
  const slotPickerOptions = (data?.slots || []).map(r => ({
    value: r.slot, label: r.label,
  }));

  // ── Cross-slot occupancy map ─────────────────────────────────────────
  // For each slot key, the set of student IDs that "occupy" it —
  // including students whose start was an earlier slot but whose session
  // duration spans into this one. The server only places a name at the
  // start slot, so without this map a no-show at 3:00 wouldn't reduce
  // 3:30's count even though the student would have been present in both.
  //
  // Built from the POST-MOVE adjusted slots so manual moves are honoured.
  // Walk-ins (always 60 min) are added separately from the walkIns doc.
  const slotMins = (k) => {
    const [h, m] = (k || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const slotStudentsHere = new Map(); // 'HH:MM' → Set of student IDs that span this slot
  const allSlotKeys = adjustedSlots.map(r => r.slot);
  const addToSlot = (k, id) => {
    if (!id) return;
    if (!slotStudentsHere.has(k)) slotStudentsHere.set(k, new Set());
    slotStudentsHere.get(k).add(id);
  };
  // iCal + moved-in students — iterate visible students at each row's
  // start slot and project across their duration to all overlapping
  // slot keys.
  for (const row of adjustedSlots) {
    const visible = [
      ...((row.students[side] || {}).onHour   || []),
      ...((row.students[side] || {}).halfHour || []),
    ];
    const startMin = slotMins(row.slot);
    for (const s of visible) {
      const dur = s.duration || 30;
      const endMin = startMin + dur;
      for (const k of allSlotKeys) {
        const km = slotMins(k);
        if (km >= startMin && km < endMin) addToSlot(k, s.id);
      }
    }
  }
  // Walk-ins stored separately — they're not in adjustedSlots' student
  // arrays for their start slot (they're added to onHour/halfHour at
  // render time in SlotRow). Project each by its stored duration (60 min
  // by default, 90 min for 1.5 hr walk-ins added from the HS long-hour
  // column). Fallback to 60 so pre-existing walk-in docs still project
  // exactly as before.
  if (walkIns) {
    for (const [key, list] of Object.entries(walkIns)) {
      if (!key.startsWith(`${side}|`) || !Array.isArray(list)) continue;
      const slot = key.split('|')[1];
      const startMin = slotMins(slot);
      for (const w of list) {
        const dur = w.duration || 60;
        for (const k of allSlotKeys) {
          const km = slotMins(k);
          if (km >= startMin && km < startMin + dur) addToSlot(k, w.id);
        }
      }
    }
  }

  // Distinct students scheduled on this side today (iCal + walk-ins, after
  // moves), counted once even if a session spans multiple slots. Replaces
  // sideTotal, which only knew the raw iCal roster and so missed
  // walk-ins and any same-day additions.
  const sideStudentIds = new Set();
  for (const set of slotStudentsHere.values()) for (const id of set) sideStudentIds.add(id);
  const sideTotal = sideStudentIds.size;

  // Per-row presence summary — drives the new "present/scheduled" display
  // and the now-dynamic `need` calc in SlotRow. We classify each
  // occupying student against the centre's current time so live no-show /
  // presumed-absent flips update the count immediately.
  const presenceByRow = new Map(); // slot → { scheduled, absent, effectivePresent, anyExplicit }
  for (const row of adjustedSlots) {
    const ids = slotStudentsHere.get(row.slot) || new Set();
    const slotEnded = hasSlotEnded(date, row.slot, timezone || 'America/Vancouver');
    let absent = 0, anyExplicit = false;
    for (const id of ids) {
      const k = classifyStudent(checkIns[id], slotEnded);
      if (k === 'absent' || k === 'presumed-absent') absent++;
      if (checkIns[id]?.status) anyExplicit = true;
    }
    // Scheduled = the number of students who actually OCCUPY this slot after
    // moves, walk-ins, and multi-slot spanning — the same set `absent` is
    // counted from. Using row.counts here (server iCal start-slot math) drifted
    // out of sync the moment a student was moved or a longer session spilled
    // into the next slot, which is what made the numbers look off.
    const scheduled = ids.size;
    presenceByRow.set(row.slot, {
      scheduled,
      absent,
      effectivePresent: Math.max(0, scheduled - absent),
      anyExplicit,
    });
  }

  // Handlers — passed down to each SlotRow / StudentRow.
  const handleMoveStudent = async (studentId, newSlotKey) => {
    try {
      if (!newSlotKey) await clearSlotOverride(centerId, date, studentId);
      else await setSlotOverride(centerId, date, studentId, newSlotKey);
    } catch (e) { toast.error(e.message); }
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white overflow-hidden print:overflow-visible">
      {/* Print-only big header — gives each printed page a clear "Friday, June 13 · High School" title */}
      <div className="hidden print:block px-3 pt-2 pb-1 border-b border-black">
        <div className="text-base font-bold">{dayLabel} · {title}</div>
        <div className="text-xs text-gray-700">{sideTotal} total students · ratio 1:{ratio}</div>
      </div>
      <div className={`flex justify-between items-center px-4 py-2 text-white ${color} print:hidden`}>
        <span className="font-semibold">{title}</span>
        <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">{sideTotal} total</span>
      </div>
      {/* Switched both sides to table-fixed + w-full so every column sizes
          to a fraction of the section's width instead of growing to fit
          its widest name. Combined with white-space:normal on student
          names (long names wrap inside the cell), this guarantees zero
          horizontal scroll on any viewport ≥ 1024 px. */}
      <table className="w-full text-sm table-fixed">
        <colgroup>
          <col className="w-14" />
          {/* Student columns expand to fill remaining space; widths are
              relative thanks to table-fixed. HS gets 3 student columns,
              EM gets 2. */}
          <col />
          <col />
          {side === 'HS' && <col />}
          {/* Count columns — w-12 leaves room for the "of N" line that
              appears below the big number when some students are absent. */}
          <col className="w-12" />
          <col className="w-12" />
          <col className="w-32" />
          {/* Cross-side instructor column — visible on screen AND in
              print. Front-desk staff use the printed sheet to confirm
              the OTHER side is covered at a glance, so hiding it on
              paper was a regression we just reversed. */}
          <col className="w-28" />
        </colgroup>
        <thead className="bg-gray-100 text-[10px] uppercase text-gray-600">
          <tr>
            <th className="px-1 py-1 text-left border-b-2 border-gray-600">Time</th>
            <th className="px-1 py-1 text-left border-b-2 border-gray-600">
              On the hour{side === 'HS' && <span className="ml-1 normal-case text-gray-500">(1 hr)</span>}
            </th>
            <th className="px-1 py-1 text-left border-l-2 border-gray-600 border-b-2 border-gray-600">
              On the half hour{side === 'HS' && <span className="ml-1 normal-case text-gray-500">(1 hr)</span>}
            </th>
            {side === 'HS' && (
              <th className="px-1 py-1 text-left border-l-2 border-gray-600 border-b-2 border-gray-600">
                1.5 hr
              </th>
            )}
            {/* Own-side count: labeled with the side name so a printout
                read out of context is unambiguous. Cross-side count follows
                for at-a-glance awareness of what the other room is doing. */}
            <th className="px-1 py-1 text-center border-l border-gray-500 border-b-2 border-gray-600">
              {side === 'HS' ? 'HS' : 'EM'}
            </th>
            <th className="px-1 py-1 text-center border-l border-gray-500 border-b-2 border-gray-600">
              {side === 'HS' ? 'EM' : 'HS'}
            </th>
            <th className="px-1 py-1 text-left border-l border-gray-500 border-b-2 border-gray-600">Instructors</th>
            <th className="px-1 py-1 text-left border-l border-gray-500 border-b-2 border-gray-600">
              {otherTitle}
            </th>
          </tr>
        </thead>
        <tbody>
          {adjustedSlots.map((row, i) => (
            <SlotRow key={row.slot} row={row} side={side} alt={i % 2 === 1}
              centerId={centerId} date={date}
              checkIns={checkIns} assignments={assignments} ratio={ratio} pool={pool}
              clipboard={clipboard} setClipboard={setClipboard}
              nameAliases={nameAliases}
              timezone={timezone}
              scheduledTodayNames={scheduledTodayNames}
              walkIns={walkIns} profile={profile}
              slotPickerOptions={slotPickerOptions}
              onMoveStudent={handleMoveStudent}
              presence={presenceByRow.get(row.slot)} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SlotRow({ row, side, alt, centerId, date, checkIns, assignments, ratio, pool, clipboard, setClipboard, nameAliases, timezone, scheduledTodayNames, walkIns, profile, slotPickerOptions, onMoveStudent, presence }) {
  // Two-tier dropdown. By default we show only staff scheduled today
  // (from the `shifts` collection + fixed-staff schedule). A "+ More"
  // option at the bottom expands the picker to the full pool — useful
  // for substitutes / one-off assignments. Per-row state because each
  // row's expand decision is independent.
  const [showAllStaff, setShowAllStaff] = useState(false);
  // Map a stored instructor name to its canonical display version
  // ("Bri" → "Brianna MacDonald"). Falls through unchanged when no
  // alias is registered (custom pool names, deleted users, etc.).
  const displayName = (stored) => (nameAliases && nameAliases.get(stored)) || stored;
  // Has this slot's 30-min window finished? Drives the no-show
  // inference + the per-slot efficiency badge. Recomputed every render
  // so a slot that ends mid-session flips state without a refresh.
  const slotEnded = hasSlotEnded(date, row.slot, timezone || 'America/Vancouver');
  const rawOnHour = row.students[side].onHour;
  const rawHalfHour = row.students[side].halfHour;

  // Walk-ins that are ACTIVE in this slot (start-here + still-running
  // from an earlier slot), grouped by whether they started here or
  // spilled in. Old code hard-coded a 60-min lookback (prev-slot only);
  // that misses 90-min walk-ins whose overlap spans an extra slot. This
  // scan iterates every walk-in on THIS side, checks its stored
  // duration, and keeps the ones whose [start, start+duration) window
  // covers `row.slot`.
  const slotMinsOf = (k) => {
    const [h, m] = (k || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const thisMin = slotMinsOf(row.slot);
  const activeSideWalkIns = [];
  if (walkIns) {
    for (const [key, list] of Object.entries(walkIns)) {
      if (!key.startsWith(`${side}|`) || !Array.isArray(list)) continue;
      const wStart = slotMinsOf(key.split('|')[1]);
      for (const w of list) {
        const dur = w.duration || 60;
        if (wStart <= thisMin && wStart + dur > thisMin) {
          activeSideWalkIns.push({
            id: w.id,
            name: w.name,
            isAssessment: !!w.isAssessment,
            duration: dur,
            isWalkIn: true,
            _wStart: wStart,
          });
        }
      }
    }
  }
  const slotWalkIns     = activeSideWalkIns.filter(w => w._wStart === thisMin);
  const overflowWalkIns = activeSideWalkIns.filter(w => w._wStart <  thisMin);

  // Which sub-column owns this row visually? Rows whose slot key ends
  // in :30 (e.g. "15:30") are inherently half-hour rows — the on-hour
  // column is structurally empty for them. Route walk-ins + the
  // +student button to the matching side so they appear where staff
  // expects, not in the empty cell next to it.
  const slotIsHalfHour = (row.slot || '').endsWith(':30');
  // Split walk-ins by duration. 60-min ones live in the on-hour /
  // half-hour column matching the row's slot type. 90-min ones live in
  // the HS 1.5 hr column alongside iCal-sourced 1.5 hr sessions.
  const shortSlotWalkIns = slotWalkIns.filter(w => w.duration === 60);
  const longSlotWalkIns  = slotWalkIns.filter(w => w.duration !== 60);
  // HS only: 1-hour students stay in their start-time column; everyone
  // else (1.5 hr, etc.) is pulled into the dedicated long-session column.
  const onHour    = side === 'HS'
    ? [...rawOnHour.filter(s => s.duration === 60), ...(slotIsHalfHour ? [] : shortSlotWalkIns)]
    : [...rawOnHour, ...(slotIsHalfHour ? [] : shortSlotWalkIns)];
  const halfHour  = side === 'HS'
    ? [...rawHalfHour.filter(s => s.duration === 60), ...(slotIsHalfHour ? shortSlotWalkIns : [])]
    : [...rawHalfHour, ...(slotIsHalfHour ? shortSlotWalkIns : [])];
  const longHour  = side === 'HS'
    ? [...[...rawOnHour, ...rawHalfHour].filter(s => s.duration !== 60), ...longSlotWalkIns]
    : [];
  // Two demand numbers per slot:
  //   scheduled = total students booked (server iCal + spanning) + walk-ins.
  //   effective = scheduled minus students we KNOW aren't here (explicit
  //               no-show / cancel, or unset after slot ended). Driven by
  //               presence.absent which is computed in SideTable across
  //               ALL students that occupy this slot (start-here + iCal
  //               overflow + walk-in overflow), so a no-show at 3:00pm
  //               correctly reduces both 3:00 AND 3:30 counts.
  //
  // Display uses both ("20/24"); `need` math uses effective so the moment
  // a student is marked no-show, "need" drops and the owner sees the
  // overstaffed signal in real time. Falls back to scheduled when
  // SideTable didn't pass a presence summary (defensive).
  // Prefer the authoritative per-slot occupancy computed in SideTable
  // (spanning-, move-, and walk-in-aware). Fall back to the old local sum
  // only if SideTable didn't pass a presence summary.
  const scheduled = presence
    ? presence.scheduled
    : row.counts[side] + slotWalkIns.length + overflowWalkIns.length;
  const count = presence ? Math.max(0, scheduled - presence.absent) : scheduled;
  const showFraction = presence && presence.absent > 0;
  // addingWalkIn drives which "+ student" form is open. Values:
  //   null    → no form open
  //   'short' → the row's normal on/half hour column, adds a 60-min walk-in
  //   'long'  → the HS 1.5 hr column, adds a 90-min walk-in
  const [addingWalkIn, setAddingWalkIn] = useState(null);
  const need = Math.max(1, Math.ceil(count / ratio));
  const instructors = assignments[`${side}|${row.slot}`] || [];

  // Per-slot efficiency badge — uses IN-CENTRE demand so it lines up with
  // the "N of M" count rendered right above this row. Previous version
  // called computeSlotEfficiency with only the start-here students, which
  // undercounted demand whenever a 60-min session from an earlier slot
  // was still in the centre (and inflated the ratio the wrong way —
  // 14/7 instead of the 24/7 the owner actually sees on the row).
  //
  // - scheduled = students physically in centre this slot (row.counts +
  //               walk-ins + previous-slot walk-in overflow).
  // - present   = scheduled − presence.absent. `presence.absent` is built
  //               in SideTable across ALL occupants (start-here + iCal
  //               overflow + walk-in overflow) so this is the right
  //               denominator even after the slot has ended.
  // - realised  = present once the slot ends, else scheduled (planned).
  const efficiencyScheduled = scheduled;
  const efficiencyPresent   = count;
  const realisedDemand      = slotEnded ? efficiencyPresent : efficiencyScheduled;
  const targetInstructors   = Math.max(1, Math.ceil(realisedDemand / Math.max(1, ratio)));
  const slack               = instructors.length - targetInstructors;
  const effectiveRatio      = instructors.length > 0 ? realisedDemand / instructors.length : null;
  let efficiencyState;
  if (!slotEnded)                                                  efficiencyState = 'pending';
  else if (efficiencyScheduled === 0)                              efficiencyState = 'idle';
  else if (slack > 0 && efficiencyPresent < efficiencyScheduled)   efficiencyState = 'overstaffed';
  else if (slack < 0)                                              efficiencyState = 'understaffed';
  else                                                              efficiencyState = 'on-target';
  const efficiency = {
    scheduled:      efficiencyScheduled,
    present:        efficiencyPresent,
    instructors:    instructors.length,
    effectiveRatio,
    slack,
    state:          efficiencyState,
  };
  const otherSide = side === 'HS' ? 'EM' : 'HS';
  // Read-only view of who the OTHER side has staffed at the same time
  // slot. Lets a HS shift lead see at a glance that EM is covered (and
  // vice versa) without flipping back and forth.
  const otherInstructors = assignments[`${otherSide}|${row.slot}`] || [];
  const understaffed = instructors.length < need;
  const slotLabel = `${side} ${row.label.split('–')[0]}`;
  const isCopySource = clipboard && clipboard.from === slotLabel;
  const canPaste = clipboard && clipboard.from !== slotLabel;

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
  // Replaces the old prompt() dialog. We render an invisible <select>
  // and trigger it via the + add button — that gives a native dropdown
  // of the daily pool, one tap to add, no typing.
  //
  // Two pseudo-options live in the dropdown alongside real names:
  //   __SHOW_ALL__   — toggle showAllStaff true (expand list)
  //   __SHOW_LESS__  — toggle it back false (collapse list)
  // The pseudo-values are caught here and routed away from the actual
  // assignment write.
  const handlePickInstructor = async (e) => {
    const name = e.target.value;
    if (!name) return;
    e.target.value = '';
    if (name === '__SHOW_ALL__')  { setShowAllStaff(true);  return; }
    if (name === '__SHOW_LESS__') { setShowAllStaff(false); return; }
    try { await setInstructorAssignment(centerId, date, side, row.slot, [...instructors, name]); }
    catch (err) { toast.error(err.message); }
  };
  const handleRemoveInstructor = async (name) => {
    try { await setInstructorAssignment(centerId, date, side, row.slot, instructors.filter(n => n !== name)); }
    catch (e) { toast.error(e.message); }
  };
  const handleCopy = () => {
    if (instructors.length === 0) {
      toast.error('Nothing to copy — this slot has no instructors yet.');
      return;
    }
    setClipboard({ names: [...instructors], from: slotLabel });
  };
  // Paste REPLACES the row's instructors with the clipboard contents.
  // Replace (not append) matches the mental model — "copy 3pm to 4pm"
  // means "make 4pm look like 3pm", not "add 3pm's people to 4pm's".
  const handlePaste = async () => {
    if (!clipboard) return;
    try {
      await setInstructorAssignment(centerId, date, side, row.slot, [...clipboard.names]);
    } catch (e) { toast.error(e.message); }
  };
  const handleAddWalkIn = async ({ name, isAssessment }, duration = 60) => {
    try {
      await addWalkIn(centerId, date, side, row.slot, {
        name, isAssessment, duration,
        addedByName: profile?.displayName || profile?.firstName || '',
      });
      setAddingWalkIn(null);
    } catch (e) { toast.error(e.message); }
  };
  const handleRemoveWalkIn = async (id) => {
    try { await removeWalkIn(centerId, date, side, row.slot, id); }
    catch (e) { toast.error(e.message); }
  };

  return (
    <tr className={alt ? 'bg-gray-50' : ''}>
      <td className="px-1 py-1.5 align-top text-xs font-semibold text-gray-700 whitespace-nowrap border-b border-gray-500">
        {row.label.split('–')[0]}<br/>
        <span className="font-normal text-[10px] text-gray-400">{row.label.split('–')[1]}</span>
      </td>
      {/* On the hour column — also hosts the +student button when the
          row's natural side is on-hour (slot key ends :00). */}
      <td className="px-1 py-1 align-top border-b border-gray-500 break-words">
        <StudentList students={onHour} checkIns={checkIns}
          centerId={centerId} date={date} side={side}
          onStatusClick={handleStatus} onStatusMenu={handleStatusMenu}
          onRemoveWalkIn={handleRemoveWalkIn}
          slotEnded={slotEnded}
          slotPickerOptions={slotPickerOptions}
          onMoveStudent={onMoveStudent}
          currentSlot={row.slot} />
        {!slotIsHalfHour && (
          addingWalkIn === 'short' ? (
            <WalkInForm onSave={(payload) => handleAddWalkIn(payload, 60)} onCancel={() => setAddingWalkIn(null)} />
          ) : (
            <button onClick={() => setAddingWalkIn('short')}
              className="mt-1 inline-flex items-center gap-0.5 rounded text-[10px] text-gray-400 hover:text-emerald-700 print:hidden">
              <Plus size={10} /> student
            </button>
          )
        )}
      </td>
      {/* Half-hour column with thicker divider on the left — matches the
          header divider and gives clear column separation. Slight top
          padding so half-hour rows visually offset down. The +student
          button lives here when the row's natural side is half-hour
          (slot key ends :30) so it sits next to the students it adds to. */}
      <td className="px-1 py-1 align-top border-l-2 border-gray-600 border-b border-gray-500 pt-3 break-words">
        <StudentList students={halfHour} checkIns={checkIns}
          centerId={centerId} date={date} side={side}
          onStatusClick={handleStatus} onStatusMenu={handleStatusMenu}
          onRemoveWalkIn={handleRemoveWalkIn}
          slotEnded={slotEnded}
          slotPickerOptions={slotPickerOptions}
          onMoveStudent={onMoveStudent}
          currentSlot={row.slot} />
        {slotIsHalfHour && (
          addingWalkIn === 'short' ? (
            <WalkInForm onSave={(payload) => handleAddWalkIn(payload, 60)} onCancel={() => setAddingWalkIn(null)} />
          ) : (
            <button onClick={() => setAddingWalkIn('short')}
              className="mt-1 inline-flex items-center gap-0.5 rounded text-[10px] text-gray-400 hover:text-emerald-700 print:hidden">
              <Plus size={10} /> student
            </button>
          )
        )}
      </td>
      {/* HS only: dedicated 1.5-hour student column to the right of the
          half-hour column. Holds anyone in this row's slot whose session
          is longer than 60 min, regardless of start time. Its "+ student"
          button adds a 90-min walk-in that starts in this row's slot and
          occupies the next two slots too — counts propagate automatically
          because slotStudentsHere honours per-walk-in duration. */}
      {side === 'HS' && (
        <td className="px-1 py-1 align-top border-l-2 border-gray-600 border-b border-gray-500 break-words">
          <StudentList students={longHour} checkIns={checkIns}
            centerId={centerId} date={date} side={side}
            onStatusClick={handleStatus} onStatusMenu={handleStatusMenu}
            onRemoveWalkIn={handleRemoveWalkIn}
            slotEnded={slotEnded}
            slotPickerOptions={slotPickerOptions}
            onMoveStudent={onMoveStudent}
            currentSlot={row.slot} />
          {addingWalkIn === 'long' ? (
            <WalkInForm onSave={(payload) => handleAddWalkIn(payload, 90)} onCancel={() => setAddingWalkIn(null)} />
          ) : (
            <button onClick={() => setAddingWalkIn('long')}
              className="mt-1 inline-flex items-center gap-0.5 rounded text-[10px] text-gray-400 hover:text-emerald-700 print:hidden">
              <Plus size={10} /> student <span className="text-gray-300">(1.5 hr)</span>
            </button>
          )}
        </td>
      )}
      <td className={`px-1 py-1 align-top text-center border-l border-gray-500 border-b border-gray-500 ${understaffed ? 'text-red-600' : 'text-gray-700'}`}>
        {/* When some students are absent, render present over scheduled
            vertically so 2-digit pairs like 20/24 fit cleanly in the
            narrow column. When nobody is absent yet, just the single
            number (cleaner for the common pre-slot / fully-present case). */}
        {showFraction ? (
          <div className="flex flex-col items-center leading-none">
            <span className="text-base font-bold tabular-nums">{count}</span>
            <span className="text-[9px] text-gray-400 tabular-nums">of {scheduled}</span>
          </div>
        ) : (
          <span className="text-base font-bold tabular-nums">{count}</span>
        )}
      </td>
      {/* Other-side count: small, gray — informational, not the decision number. */}
      <td className="px-1 py-1 align-top text-center text-xs font-semibold text-gray-500 border-l border-gray-500 border-b border-gray-500">
        {row.counts[otherSide]}
      </td>
      <td className="px-1 py-1 align-top border-l border-gray-500 border-b border-gray-500">
        {/* Stacked vertically, one name per row. No chip / bubble — staff
            said the rounded pill background was visually noisy; the bare
            name reads cleaner against the row. Click-to-remove still
            works on the whole row; the × on the right is print-hidden. */}
        <div className="flex flex-col gap-0.5">
          {instructors.map(n => (
            <span key={n}
              onClick={() => handleRemoveInstructor(n)} title="Click to remove"
              className="cursor-pointer text-[11px] leading-tight text-gray-800 hover:text-red-700 flex items-baseline gap-1">
              <span>{displayName(n)}</span>
              <span className="text-red-600 print:hidden">×</span>
            </span>
          ))}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 print:hidden">
          {/* Native select with a two-tier list:
                - "On shift today" group (default; from shifts + fixed staff)
                - "+ More (N more)" pseudo-option that expands to the full
                  pool (substitutes, anyone). When expanded, an "Everyone
                  else" optgroup appears + "Show fewer" to collapse. */}
          {(() => {
            const available = pool.filter(n => !instructors.includes(n));
            const onShift   = available.filter(n => scheduledTodayNames?.has(n));
            const others    = available.filter(n => !scheduledTodayNames?.has(n));
            const visibleOthers = showAllStaff ? others : [];
            return (
              <select
                onChange={handlePickInstructor}
                defaultValue=""
                className="rounded-md border border-dashed border-gray-400 bg-white px-1.5 py-0 text-[10px] text-gray-500 hover:border-red-400 hover:text-red-600">
                <option value="">+ add</option>
                {onShift.length > 0 && (
                  <optgroup label={`On shift today (${onShift.length})`}>
                    {onShift.map(n => <option key={n} value={n}>{n}</option>)}
                  </optgroup>
                )}
                {!showAllStaff && others.length > 0 && (
                  <option value="__SHOW_ALL__">+ More ({others.length} more)</option>
                )}
                {showAllStaff && others.length > 0 && (
                  <optgroup label="Everyone else">
                    {visibleOthers.map(n => <option key={n} value={n}>{n}</option>)}
                  </optgroup>
                )}
                {showAllStaff && (
                  <option value="__SHOW_LESS__">– Show only on-shift</option>
                )}
                {available.length === 0 && pool.length === 0 && (
                  <option value="" disabled>Set pool in Setup</option>
                )}
                {available.length === 0 && pool.length > 0 && (
                  <option value="" disabled>All staff already added</option>
                )}
              </select>
            );
          })()}
          {/* Copy & paste buttons. Copy is always visible (no-op'd if the
              row is empty). Paste shows only when something is on the
              clipboard from a different row. */}
          <button onClick={handleCopy}
            title={isCopySource ? 'This row is on the clipboard' : 'Copy these instructors'}
            className={`inline-flex items-center rounded-md border border-dashed px-1 py-0 text-[10px] ${
              isCopySource
                ? 'border-blue-400 bg-blue-50 text-blue-700'
                : 'border-gray-400 text-gray-500 hover:border-blue-400 hover:text-blue-600'
            }`}>
            {isCopySource ? <ClipboardCheck size={10} /> : <Copy size={10} />}
          </button>
          {canPaste && (
            <button onClick={handlePaste}
              title={`Paste ${clipboard.names.length} from ${clipboard.from}`}
              className="inline-flex items-center rounded-md border border-dashed border-blue-400 bg-blue-50 px-1 py-0 text-[10px] text-blue-700 hover:bg-blue-100">
              <Clipboard size={10} />
            </button>
          )}
        </div>
        <div className={`mt-0.5 text-[9px] ${understaffed ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
          need {need} · have {instructors.length}
        </div>
        {/* Realised efficiency, only shown once the slot has ended. The
            colour reflects state: overstaffed (orange), understaffed
            (red), on-target (green), idle (gray). Owner sees per-slot
            whether the staffing call paid off against actual demand. */}
        {slotEnded && efficiency.scheduled > 0 && (
          <div className={`mt-0.5 text-[9px] font-medium ${
            efficiency.state === 'understaffed' ? 'text-red-600'
            : efficiency.state === 'overstaffed' ? 'text-amber-700'
            : efficiency.state === 'on-target' ? 'text-emerald-700'
            : 'text-gray-500'
          }`}>
            actual {efficiency.present}/{efficiency.scheduled}
            {efficiency.instructors > 0 && <> · {fmtRatio(efficiency.effectiveRatio)}</>}
            {efficiency.state === 'overstaffed'   && <> · over by {efficiency.slack}</>}
            {efficiency.state === 'understaffed'  && <> · short by {Math.abs(efficiency.slack)}</>}
          </div>
        )}
      </td>
      {/* Cross-side instructor column — read-only, intentionally low
          contrast. Visible in print. No chip background — plain text
          stacked vertically, matching the own-side column. */}
      <td className="px-1 py-1 align-top border-l border-gray-500 border-b border-gray-500">
        {otherInstructors.length === 0 ? (
          <span className="text-[10px] text-gray-300">—</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            {otherInstructors.map(n => (
              <span key={n} className="text-[11px] leading-tight text-gray-600">
                {displayName(n)}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

function StudentList({ students, checkIns, centerId, date, onStatusClick, onStatusMenu, onRemoveWalkIn, slotEnded, slotPickerOptions, onMoveStudent, currentSlot }) {
  if (students.length === 0) return <div className="text-[10px] text-gray-300">—</div>;
  return (
    <ul className="space-y-0.5">
      {students.map(s => (
        <StudentRow key={s.id} s={s} entry={checkIns[s.id] || {}}
          centerId={centerId} date={date}
          onStatusClick={onStatusClick} onStatusMenu={onStatusMenu}
          onRemoveWalkIn={onRemoveWalkIn}
          slotEnded={slotEnded}
          slotPickerOptions={slotPickerOptions}
          onMoveStudent={onMoveStudent}
          currentSlot={currentSlot} />
      ))}
    </ul>
  );
}

function StudentRow({ s, entry, centerId, date, onStatusClick, onStatusMenu, onRemoveWalkIn, slotEnded, slotPickerOptions, onMoveStudent, currentSlot }) {
  // Move picker handler — onChange of the ↔ <select>. Sends '' to clear
  // an existing override, the new slot key otherwise. The select is
  // hidden for walk-ins (they're stored at one slot only; remove + re-add
  // is the correct workflow) and when no move handler was passed (some
  // call sites — print preview, future code — may skip it).
  const handleMovePick = (e) => {
    const next = e.target.value;
    e.target.value = '';
    if (!onMoveStudent) return;
    if (next === '__CLEAR__') onMoveStudent(s.id, null);
    else if (next) onMoveStudent(s.id, next);
  };
  const canMove = !s.isWalkIn && typeof onMoveStudent === 'function';
  const status = entry.status || '';
  // classifyStudent decides 'present' / 'absent' / 'presumed-absent' /
  // 'pending'. Presumed-absent gets a SOFT visual (low-contrast gray,
  // strike-through) — never red — to communicate "best guess" not
  // "verdict." Staff who realise they forgot to check the student in
  // can still click the row to flip the status to 'in'.
  const klass = classifyStudent(entry, slotEnded);
  const cls = {
    in:      'text-emerald-700',
    late:    'text-amber-600',
    noshow:  'text-red-600 line-through',
    cancel:  'text-gray-400 line-through',
  }[status] || (klass === 'presumed-absent' ? 'text-gray-400 italic' : '');

  // Uncontrolled inputs: typing only touches the DOM; saves fire on blur.
  // `key={...}` forces remount when another staff member updates the value
  // on a different device, so the input always shows the latest Firestore
  // value without a controlled-component sync loop.
  //
  // The manual TAG input (A / FT / N / HM) was removed per staff feedback —
  // it cluttered the row and the only useful signal it carried (Assessment)
  // is now sourced automatically from the Student Assessment Tracker via
  // s.isAssessment. Desk number stays — that's an operational detail
  // staff legitimately needs to set per-day.
  const saveDesk = (v) => setStudentDesk(centerId, date, s.id, v).catch(e => toast.error(e.message));

  return (
    <li className={`flex items-start gap-1 leading-tight ${cls}`}>
      <span className="cursor-pointer w-3 text-center shrink-0" onClick={() => onStatusClick(s.id)}>
        {status === 'in' ? '✓' : '☐'}
      </span>
      {/* On screen: allow long names to wrap so a narrow column never
          forces a horizontal scrollbar. On print: keep one-line names
          (paper has more horizontal room thanks to the zoom shrink and
          we want each row scannable at a glance). */}
      <span className="cursor-pointer hover:underline leading-tight break-words print:whitespace-nowrap"
        onClick={() => onStatusClick(s.id)}
        onContextMenu={e => onStatusMenu(e, s.id)}
        title={s.aliasedFrom ? `Booked under: ${s.aliasedFrom}` : ''}>
        {s.name}
      </span>
      {/* Badges sit inline at the same baseline as the name so they read
          as "Sara Kbeili (A)" rather than as a tiny superscript. */}
      {s.isAssessment && (
        <span className="text-xs font-semibold text-amber-700 shrink-0" title="Assessment">
          (A)
        </span>
      )}
      {s.uncertainAlias && (
        <span className="text-xs font-bold text-amber-600 shrink-0"
          title={`Couldn't confidently pick a student for parent "${s.aliasedFrom}". Verify.`}>
          (?)
        </span>
      )}
      {s.isWalkIn && (
        <span className="text-[10px] font-semibold text-emerald-700 shrink-0" title="Added manually (walk-in / call-in)">
          (W)
        </span>
      )}
      {s.isWalkIn && onRemoveWalkIn && (
        <button onClick={() => onRemoveWalkIn(s.id)}
          title="Remove walk-in"
          className="ml-0.5 inline-flex items-center text-[10px] text-gray-300 hover:text-red-600 print:hidden">
          ×
        </button>
      )}
      {/* Moved-here marker — appears on students whose original iCal
          slot was elsewhere. The original time shows in the tooltip
          so an admin can audit what got reshuffled. */}
      {s.isMoved && (
        <span className="text-[10px] font-semibold text-blue-700 shrink-0"
          title={`Moved from ${s.originalSlot || 'another slot'}`}>
          (M)
        </span>
      )}
      {/* Move picker — native select so it's free keyboard nav + mobile.
          Hidden for walk-ins (delete + re-add is the correct workflow
          there). Shows ↔ as the closed-state label; the open menu lists
          every slot time in the day plus a "Reset to original" option
          for moved students. print:hidden — paper schedule never needs
          interactive controls. */}
      {canMove && slotPickerOptions?.length > 0 && (
        <select
          onChange={handleMovePick}
          defaultValue=""
          title="Move student to another slot"
          className="ml-0.5 rounded border border-dashed border-gray-300 bg-white px-0.5 py-0 text-[10px] text-gray-400 hover:border-blue-400 hover:text-blue-600 print:hidden">
          <option value="">↔</option>
          {s.isMoved && <option value="__CLEAR__">↺ Reset to original</option>}
          {slotPickerOptions
            .filter(o => o.value !== currentSlot)
            .map(o => (
              <option key={o.value} value={o.value}>
                Move to {o.label}
              </option>
            ))}
        </select>
      )}
      {/* Desk number — kept (operational, set per day, useful on print).
          Borderless when empty so the row stays compact. */}
      <input
        key={`desk-${entry.desk || ''}`}
        type="text" defaultValue={entry.desk || ''} maxLength={4}
        onBlur={e => saveDesk(e.target.value)}
        title="Desk number"
        className="ml-auto w-8 shrink-0 border-0 bg-transparent px-0 text-[10px] text-center text-gray-700 rounded hover:bg-gray-100 focus:bg-white focus:outline focus:outline-1 focus:outline-blue-400 focus:w-10"
      />
    </li>
  );
}

// Inline walk-in entry form — appears below the on-hour student list
// when staff clicks "+ student" on a slot. Just a name + assessment
// toggle; the slot/side/date are implicit from where it was clicked.
function WalkInForm({ onSave, onCancel }) {
  const [name, setName] = useState('');
  const [isAssessment, setIsAssessment] = useState(false);
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e?.preventDefault?.();
    if (!name.trim()) return;
    setSaving(true);
    try { await onSave({ name: name.trim(), isAssessment }); }
    finally { setSaving(false); }
  };
  return (
    <form onSubmit={submit}
      className="mt-1 rounded-md border border-emerald-300 bg-emerald-50 p-1.5 print:hidden">
      <input
        autoFocus
        type="text" value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Student name"
        className="w-full rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[11px] focus:border-emerald-500 focus:outline-none"
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
      />
      <label className="mt-1 flex items-center gap-1 text-[10px] text-gray-700">
        <input type="checkbox" checked={isAssessment}
          onChange={e => setIsAssessment(e.target.checked)} />
        Assessment
      </label>
      <div className="mt-1 flex gap-1">
        <button type="submit" disabled={saving || !name.trim()}
          className="flex-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
          {saving ? '…' : 'Add'}
        </button>
        <button type="button" onClick={onCancel}
          className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </form>
  );
}

// Day-level supply/demand summary card — the at-a-glance number for
// owners. Three tiles + (when confident) a one-sentence recommendation.
// Numbers come from src/lib/scheduler-analytics.js so the math stays
// testable and re-usable for weekly / monthly rollups later.
function DaySummary({ analytics, recommendation, ratio }) {
  if (!analytics?.hasData) return null;
  const {
    totalScheduled, totalPresent, totalAbsent,
    totalInstructorSlots,
    onTargetSlots, overstaffedSlots, understaffedSlots,
    attendanceRate, utilisation,
  } = analytics;

  return (
    <section className="mb-4 rounded-xl border border-gray-200 bg-white p-3 print:hidden">
      <div className="mb-2 flex items-center justify-between flex-wrap gap-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
          Supply vs demand · today
        </div>
        <div className="text-[10px] text-gray-400">Target ratio 1:{ratio} · live as the day plays out</div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryTile
          label="Attendance"
          value={attendanceRate == null ? '—' : fmtPct(attendanceRate)}
          sub={`${totalPresent} of ${totalPresent + totalAbsent} booked${totalAbsent ? ` · ${totalAbsent} no-show` : ''}`}
          tone={attendanceRate == null ? 'neutral'
                : attendanceRate >= 0.85 ? 'good'
                : attendanceRate >= 0.7 ? 'warn'
                : 'bad'}
        />
        <SummaryTile
          label="Demand"
          value={String(totalScheduled)}
          sub={`students scheduled${totalScheduled ? '' : ' — empty day'}`}
          tone="neutral"
        />
        <SummaryTile
          label="Supply"
          value={String(totalInstructorSlots)}
          sub={`instructor-slots${utilisation != null ? ` · ${fmtPct(utilisation)} utilised` : ''}`}
          tone="neutral"
        />
        <SummaryTile
          label="Slot fit"
          value={`${onTargetSlots} / ${onTargetSlots + overstaffedSlots + understaffedSlots}`}
          sub={[
            understaffedSlots ? `${understaffedSlots} short` : null,
            overstaffedSlots  ? `${overstaffedSlots} over`   : null,
          ].filter(Boolean).join(' · ') || 'on target'}
          tone={understaffedSlots > 0 ? 'bad' : overstaffedSlots > 2 ? 'warn' : 'good'}
        />
      </div>
      {recommendation && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
          recommendation.kind === 'understaffed'   ? 'bg-red-50 border-red-200 text-red-800'
          : recommendation.kind === 'overstaffed'  ? 'bg-amber-50 border-amber-200 text-amber-900'
          : recommendation.kind === 'low-attendance' ? 'bg-orange-50 border-orange-200 text-orange-900'
          : 'bg-emerald-50 border-emerald-200 text-emerald-900'
        }`}>
          <span className="font-semibold">Today's signal: </span>{recommendation.text}
        </div>
      )}
      <p className="mt-2 text-[10px] text-gray-400">
        Unchecked students past a slot's end time are presumed no-shows (dimmed below). Click a student row to flip them to present if they actually attended.
      </p>
    </section>
  );
}

function SummaryTile({ label, value, sub, tone = 'neutral' }) {
  const toneClasses = {
    good:    'bg-emerald-50 border-emerald-200',
    warn:    'bg-amber-50  border-amber-200',
    bad:     'bg-red-50    border-red-200',
    neutral: 'bg-gray-50   border-gray-200',
  }[tone];
  const valueColour = {
    good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-700', neutral: 'text-gray-900',
  }[tone];
  return (
    <div className={`rounded-lg border p-2 ${toneClasses}`}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`mt-0.5 text-xl font-bold ${valueColour}`}>{value}</div>
      <div className="text-[10px] text-gray-600">{sub}</div>
    </div>
  );
}

function UnknownBanner({ data, centerId, onFix }) {
  // Group the unknown list by parent name so siblings booked under the
  // same Acuity account get treated as one alias problem. For each group
  // we show every booking time in order, then a single "Map siblings"
  // button that asks for all the student names at once and stores them
  // as a multi-replacement alias.
  const groups = new Map();
  for (const s of data.unknownList) {
    const key = (s.name || '').toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: s.name, bookings: [] });
    groups.get(key).bookings.push(s);
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  }

  const fix = async (group) => {
    const n = group.bookings.length;
    const prompt_msg = n === 1
      ? `Map "${group.name}" to which student?\nEnter the real student's name as it appears in your tracker.`
      : `"${group.name}" has ${n} bookings today:\n` +
        group.bookings.map((b, i) => `   ${i + 1}. ${fmtTime(b.start)} – ${b.type || ''}`).join('\n') +
        `\n\nEnter the ${n} student names, comma-separated, in BOOKING ORDER (earliest first).\nExample: "Claire Eddy, Julia Eddy"`;
    try {
      const real = prompt(prompt_msg, '');
      if (!real) return;
      const replacements = real.split(',').map(s => s.trim()).filter(Boolean);
      if (replacements.length === 0) return;
      await upsertAlias(centerId, { parentName: group.name, replacements });
      toast.success(`Saved ${replacements.length}-student alias for "${group.name}"`);
      onFix();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 print:hidden">
      <div className="mb-1 flex items-center gap-1 text-sm font-semibold text-amber-800">
        <AlertTriangle size={14} /> Uncategorized: {data.unknownList.length}
      </div>
      <ul className="space-y-2 text-sm">
        {[...groups.values()].map(g => (
          <li key={g.name} className="flex flex-wrap items-start gap-2">
            <div className="flex-1 min-w-0">
              <span className="font-medium">{g.name}</span>
              {g.bookings.length > 1 && (
                <span className="ml-1 text-xs text-amber-700 font-semibold">× {g.bookings.length}</span>
              )}
              <ul className="text-xs text-gray-600 ml-3 mt-0.5">
                {g.bookings.map((b, i) => (
                  <li key={b.id}>
                    <span className="font-mono">{i + 1}.</span> <span className="font-semibold">{fmtTime(b.start)}</span> · {b.type || '(no type)'}
                  </li>
                ))}
              </ul>
            </div>
            <button onClick={() => fix(g)}
              className="rounded bg-white border border-amber-300 px-2 py-0.5 text-xs hover:bg-amber-100 whitespace-nowrap">
              {g.bookings.length > 1 ? `→ Map ${g.bookings.length} siblings…` : '→ Map to student…'}
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
    <div className="space-y-4">
      {/* Historical "an average Tuesday looks like…" patterns first,
          since they shape the staffing decision the owner will make
          about the upcoming-days table below. */}
      <WeeklyPatterns centerId={centerId} />

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
    </div>
  );
}

// ─── Weekly patterns ────────────────────────────────────────────────────
// Aggregates the last 90 days of daily snapshots into per-DOW averages
// + per-DOW × slot tables. Owner picks a day of week and sees what
// average demand looks like, what the centre typically staffs, and what
// the target ratio would suggest. Three pieces of info per slot.
function WeeklyPatterns({ centerId }) {
  const [snapshots, setSnapshots] = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);
  const [activeDow, setActiveDow] = useState(() => {
    const today = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()];
    // Default to today's day-of-week if it's an operating day, else Monday.
    return today === 'Sunday' ? 'Monday' : today;
  });
  const [ratio, setRatio] = useState(4);

  useEffect(() => {
    if (!centerId) return;
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        const range = rangeForLookback();
        const snaps = await getSnapshotsInRange(centerId, range.from, range.to);
        if (cancelled) return;
        setSnapshots(snaps);
      } catch (e) { if (!cancelled) setError(e.message); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [centerId]);

  // Pull the centre's target ratio so suggestedInstructors uses the
  // real value, not the 4 default baked into the aggregator.
  useEffect(() => {
    if (!centerId) return;
    getSettings(centerId).then(s => setRatio(s.studentsPerInstructor || 4));
  }, [centerId]);

  const aggregated = useMemo(
    () => snapshots ? computeWeeklyAverages(snapshots, { ratio }) : null,
    [snapshots, ratio],
  );

  const dows = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dowBucket = aggregated?.byDow?.[activeDow] || null;
  const slotKeys = dowBucket
    ? Object.keys(dowBucket.perSlot).sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]))
    : [];

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-semibold text-gray-900">Weekly patterns</h3>
          <p className="text-xs text-gray-500">
            What an average {activeDow} looks like at this centre — based on the last 90 days of daily snapshots.
          </p>
        </div>
        {snapshots && (
          <div className="text-xs text-gray-500">
            {snapshots.length} day{snapshots.length === 1 ? '' : 's'} captured
            {snapshots.length < MIN_SAMPLES_FOR_AVG * 6 && (
              <span className="ml-1 text-amber-700">· still collecting</span>
            )}
          </div>
        )}
      </div>

      {loading && <div className="text-sm text-gray-500">Loading patterns…</div>}
      {error   && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}

      {snapshots && snapshots.length === 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">
          No snapshots yet. Open the <b>Today</b> tab on any completed past day and the page will save a snapshot in the background. Once you have ~4 records for each weekday (≈ 4 weeks of operation), the table below populates with averages you can plan against.
        </div>
      )}

      {aggregated && snapshots && snapshots.length > 0 && (
        <>
          {/* Day-of-week selector */}
          <div className="mb-3 flex flex-wrap gap-1">
            {dows.map(d => {
              const n = aggregated.byDow[d]?.sampleSize || 0;
              const active = d === activeDow;
              return (
                <button key={d} onClick={() => setActiveDow(d)}
                  className={`rounded-md border-2 px-3 py-1.5 text-xs font-bold transition-colors ${
                    active
                      ? 'bg-emerald-50 border-emerald-500 text-emerald-700'
                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}>
                  {d}<span className="ml-1 font-normal text-gray-400">{n}</span>
                </button>
              );
            })}
          </div>

          {dowBucket && dowBucket.sampleSize >= MIN_SAMPLES_FOR_AVG ? (
            <>
              {/* DOW headline numbers */}
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Mini label="Avg students" value={dowBucket.avgScheduled.toFixed(1)} sub="scheduled" />
                <Mini label="Avg attended" value={dowBucket.avgPresent.toFixed(1)} sub={dowBucket.avgAttendance != null ? `${fmtPct(dowBucket.avgAttendance)} show rate` : ''} />
                <Mini label="Avg staffed" value={dowBucket.avgInstructors.toFixed(1)} sub="instructor-slots" />
                <Mini label="Sample" value={String(dowBucket.sampleSize)} sub={`past ${activeDow}s`} />
              </div>

              {/* Per-slot detail */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase text-gray-500">
                    <tr>
                      <th className="text-left py-1">Slot</th>
                      <th className="text-center py-1">Side</th>
                      <th className="text-right py-1">Avg scheduled</th>
                      <th className="text-right py-1">Avg attended</th>
                      <th className="text-right py-1">Avg staffed</th>
                      <th className="text-right py-1 pr-1">Target staff (1:{ratio})</th>
                      <th className="text-right py-1">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slotKeys.map(k => {
                      const s = dowBucket.perSlot[k];
                      const enoughSamples = s.sampleSize >= MIN_SAMPLES_FOR_AVG;
                      const diff = enoughSamples ? s.avgInstructors - s.suggestedInstructors : null;
                      const verdict = diff == null ? null
                        : diff >= 1 ? { label: `over by ${diff.toFixed(1)}`, cls: 'text-amber-700' }
                        : diff <= -1 ? { label: `short by ${Math.abs(diff).toFixed(1)}`, cls: 'text-red-600' }
                        : { label: 'on target', cls: 'text-emerald-700' };
                      return (
                        <tr key={k} className="border-t border-gray-100">
                          <td className="py-1 font-mono text-xs">{s.slot}</td>
                          <td className="py-1 text-center text-xs">{s.side}</td>
                          <td className="py-1 text-right">{enoughSamples ? s.avgScheduled.toFixed(1) : '—'}</td>
                          <td className="py-1 text-right">{enoughSamples ? s.avgPresent.toFixed(1) : '—'}</td>
                          <td className="py-1 text-right">{enoughSamples ? s.avgInstructors.toFixed(1) : '—'}</td>
                          <td className="py-1 text-right pr-1 font-semibold">{enoughSamples ? s.suggestedInstructors : '—'}</td>
                          <td className={`py-1 text-right text-xs font-semibold ${verdict?.cls || 'text-gray-400'}`}>
                            {enoughSamples ? verdict?.label : `n=${s.sampleSize}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-gray-500">
                "Verdict" compares typical staffing on this weekday to what the target ratio would call for given typical attendance. Over = consistent slack to consider trimming; short = consistent shortfall to consider covering.
              </p>
            </>
          ) : (
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 text-sm text-gray-700">
              Only {dowBucket?.sampleSize || 0} {activeDow} snapshot{dowBucket?.sampleSize === 1 ? '' : 's'} so far —
              need at least {MIN_SAMPLES_FOR_AVG} before averages become meaningful. Keep using the Today tab on each {activeDow} and this view will fill in within a few weeks.
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Mini({ label, value, sub }) {
  return (
    <div className="rounded border border-gray-200 bg-gray-50 p-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-xl font-bold text-gray-900">{value}</div>
      {sub && <div className="text-[10px] text-gray-500">{sub}</div>}
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
  const [rosterSearch, setRosterSearch] = useState('');
  const fileRef = useRef(null);

  // Filter for the search box. Empty query = show everything.
  const visibleStudents = rosterSearch.trim()
    ? students.filter(s => s.name?.toLowerCase().includes(rosterSearch.trim().toLowerCase()))
    : students;

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
            <label className="block text-xs text-gray-500 mb-1">
              Extra instructors (optional, comma-separated)
            </label>
            <input type="text" value={(settings.instructorPool || []).join(', ')}
              onChange={e => updateSetting({ instructorPool: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              className="w-full rounded border border-gray-300 px-2 py-1"
              placeholder="e.g. a one-off substitute who isn't in your staff list" />
            <p className="mt-1 text-xs text-gray-500">
              The instructor dropdown on the Today tab is automatically populated from
              your approved staff in <b>Manage Staff</b> (instructors + admin assistants).
              Names typed here are added on top — useful for substitutes who aren't formal staff yet.
            </p>
          </div>
        </div>
      </section>

      {/* Google Sheets auto-sync card */}
      <SheetSyncCard
        centerId={centerId}
        settings={settings}
        onRefresh={() => getSettings(centerId).then(setSettings)}
      />

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
        <input
          type="text"
          value={rosterSearch}
          onChange={e => setRosterSearch(e.target.value)}
          placeholder="Search a student by name…"
          className="mb-2 w-full rounded border border-gray-300 px-2 py-1 text-sm"
        />
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
              {visibleStudents.slice(0, 500).map(s => (
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
          {visibleStudents.length > 500 && (
            <p className="mt-1 text-center text-xs text-gray-400">{visibleStudents.length - 500} more rows — refine your search</p>
          )}
          {rosterSearch && visibleStudents.length === 0 && (
            <p className="mt-2 text-center text-xs text-amber-600">
              No students match "{rosterSearch}".
              They might be missing from your tracker — add them to the CSV and re-import.
            </p>
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
              title="Bulk-import the known parent-name mappings (Kelly Nelson, JackHarry Thorne, Claire and Julia Eddy, etc.)">
              <Upload size={14} /> Import standard ({STANDARD_ALIASES.length})
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

// ─── Google Sheets auto-sync card ────────────────────────────────────────
// Lives in the Setup tab right above the roster. UX flow:
//   - Not connected → big "Enable auto-sync" button. Click it and we mint a
//     token, then reveal setup steps + a copy-to-clipboard for token & ID.
//   - Connected     → green status + last-synced summary + rotate / disconnect.
//
// The actual sync happens in the user's Google Sheet via Apps Script — see
// scripts/google-sheets-sync/RatioSync.gs.
function SheetSyncCard({ centerId, settings, onRefresh }) {
  const sync = settings?.sheetSync || null;
  const enabled = !!sync?.token;
  const [working, setWorking] = useState(false);
  const [showSetup, setShowSetup] = useState(!enabled);
  const [revealedToken, setRevealedToken] = useState(null); // shown only right after enable/rotate
  const [copied, setCopied] = useState('');

  // Pretty "x minutes ago" for the last sync line.
  const lastSyncedLabel = sync?.lastSyncedAt ? relativeTime(sync.lastSyncedAt) : null;

  const copy = async (label, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      toast.error('Copy failed — select the value and copy manually.');
    }
  };

  const handleEnable = async () => {
    setWorking(true);
    try {
      const token = await enableSheetSync(centerId);
      setRevealedToken(token);
      setShowSetup(true);
      toast.success('Auto-sync enabled. Follow the steps to connect your sheet.');
    } catch (e) { toast.error(e.message); }
    finally { setWorking(false); onRefresh?.(); }
  };

  const handleRotate = async () => {
    if (!confirm('Rotating the token will stop the current sheet from syncing until you paste the new token into Apps Script. Continue?')) return;
    setWorking(true);
    try {
      const token = await rotateSheetSyncToken(centerId);
      setRevealedToken(token);
      setShowSetup(true);
      toast.success('New token generated. Paste it into your Apps Script.');
    } catch (e) { toast.error(e.message); }
    finally { setWorking(false); onRefresh?.(); }
  };

  const handleDisable = async () => {
    if (!confirm('Disconnect Google Sheets auto-sync? Your sheet will stop pushing updates to Ratio. You can re-enable later.')) return;
    setWorking(true);
    try {
      await disableSheetSync(centerId);
      setRevealedToken(null);
      setShowSetup(false);
      toast.success('Auto-sync disconnected.');
    } catch (e) { toast.error(e.message); }
    finally { setWorking(false); onRefresh?.(); }
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-semibold flex items-center gap-2">
          <Sheet size={16} className="text-emerald-600" />
          Auto-sync from Google Sheets
        </h2>
        {enabled && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
            <CheckCircle2 size={12} /> Connected
          </span>
        )}
      </div>

      {!enabled && (
        <div className="rounded border border-dashed border-gray-300 bg-gray-50 p-4 text-sm">
          <p className="mb-3 text-gray-700">
            Stop exporting CSVs. Ratio can pull the Student Assessment Tracker
            from your Google Sheet automatically every time you edit it.
            Sheet stays fully private — only you and Ratio's server see it.
          </p>
          <button
            onClick={handleEnable}
            disabled={working}
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {working ? 'Enabling…' : 'Enable auto-sync'}
          </button>
        </div>
      )}

      {enabled && (
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-gray-700">
              {lastSyncedLabel ? (
                <>
                  Last synced <b>{lastSyncedLabel}</b>
                  {' · '}
                  {sync.lastSyncedCount} students
                  {sync.lastSyncedAssessments ? ` · ${sync.lastSyncedAssessments} assessment` : ''}
                  {sync.lastSyncedHybrids ? ` · ${sync.lastSyncedHybrids} hybrid` : ''}
                  {sync.lastSyncedDeletions ? ` · ${sync.lastSyncedDeletions} removed` : ''}
                </>
              ) : (
                <span className="text-amber-700">
                  Token generated — paste it into Apps Script to start syncing.
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowSetup(s => !s)}
                className="rounded border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
              >
                {showSetup ? 'Hide setup' : 'Setup steps'}
              </button>
              <button
                onClick={handleRotate}
                disabled={working}
                className="rounded border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
              >
                Rotate token
              </button>
              <button
                onClick={handleDisable}
                disabled={working}
                className="inline-flex items-center gap-1 rounded border border-red-200 px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                <Link2Off size={12} /> Disconnect
              </button>
            </div>
          </div>

          {showSetup && (
            <div className="rounded border border-emerald-200 bg-emerald-50/40 p-3 text-xs text-gray-800">
              <p className="mb-2 font-semibold text-gray-900">Setup (one-time, ~2 minutes)</p>
              <ol className="ml-4 list-decimal space-y-2">
                <li>
                  Open your <b>Student Assessment Tracker</b> Google Sheet.
                </li>
                <li>
                  Click <b>Extensions → Apps Script</b>. Delete anything that's in <code>Code.gs</code>.
                </li>
                <li>
                  Paste in the contents of{' '}
                  <code className="rounded bg-gray-200 px-1">scripts/google-sheets-sync/RatioSync.gs</code>{' '}
                  from your Ratio repo. (Open it on your computer and copy the whole file.)
                </li>
                <li>
                  At the top of the script, fill in these two values:
                  <div className="mt-2 space-y-2">
                    <CopyField
                      label="CENTER_ID"
                      value={centerId}
                      copied={copied === 'center'}
                      onCopy={() => copy('center', centerId)}
                    />
                    <CopyField
                      label="SYNC_TOKEN"
                      value={revealedToken || '••••••••••••  (rotate to view a new one)'}
                      copied={copied === 'token'}
                      onCopy={() => revealedToken && copy('token', revealedToken)}
                      monospace
                      muted={!revealedToken}
                    />
                    {!revealedToken && (
                      <p className="text-xs text-gray-500">
                        For security, the token is only shown right after it's generated. Click "Rotate token" above to mint a new one.
                      </p>
                    )}
                  </div>
                </li>
                <li>
                  Click <b>Save</b> (disk icon), then run the function called <code>setup</code>.
                  Apps Script will ask for permissions — accept them. You'll see "Ratio sync installed" when it's done.
                </li>
                <li>
                  That's it. Edits to the sheet now push to Ratio within seconds. You can also click
                  <b> Ratio → Sync now</b> in the sheet's menu bar to force one manually.
                </li>
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Small copy-to-clipboard row used inside the setup steps.
function CopyField({ label, value, onCopy, copied, monospace, muted }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-gray-500">{label}</span>
      <code
        className={`flex-1 truncate rounded border border-gray-300 bg-white px-2 py-1 ${monospace ? 'font-mono text-[11px]' : 'text-xs'} ${muted ? 'text-gray-400' : 'text-gray-800'}`}
      >
        {value}
      </code>
      <button
        onClick={onCopy}
        disabled={muted}
        className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-40"
        title="Copy to clipboard"
      >
        {copied ? <CheckCircle2 size={12} className="text-emerald-600" /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// Short "5 minutes ago" formatter. Avoids pulling in date-fns just for this.
function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}
