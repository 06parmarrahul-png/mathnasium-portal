import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc,
  addDoc, query, where, orderBy, writeBatch, getDoc, getDocs, setDoc,
} from 'firebase/firestore';
import { db, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import {
  Settings, UserCheck, UserX, Trash2, Clock, Tag,
  ChevronLeft, ChevronRight, ChevronDown, Table, Wand2, CheckCircle, Check,
  AlertTriangle, Send, RotateCcw, Edit3, ArrowRightLeft, Plus, X,
  DollarSign, Download, CalendarRange, BarChart3,
  Users, TrendingUp, Activity, Briefcase, Copy, CalendarX,
} from 'lucide-react';
import {
  format, startOfWeek, addWeeks, subWeeks, addDays, isSameDay,
  startOfMonth, endOfMonth,
} from 'date-fns';
import { generateSchedule, FIXED_SCHEDULES } from '../lib/scheduler';
import { SUB_ROLES, SUB_ROLE_STYLES, styleFor as subRoleStyleFor } from '../lib/subRoles';
import { DEFAULT_CENTER_ID } from '../lib/centers';
import {
  LANGLEY_DEFAULT_CONFIG, SHIFT_ASSIGNMENTS, DEFAULT_CENTER_CONFIG,
  assignmentFor, assignmentColorHex, assignmentShort, contrastText,
  isOperatingDay, holidayFor, ALL_WEEKDAYS,
} from '../lib/centerConfig';
import CoverageGrid from '../components/CoverageGrid';
import CenterSettingsTab from '../components/CenterSettingsTab';
import HolidaysEditor from '../components/HolidaysEditor';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const ROLE_OPTIONS = [
  'Instructor', 'Lead', 'Host', 'Admin',
  'Manager', 'Center Director', 'Dir. of Education',
];

// Sub-roles (teaching specializations) live in src/lib/subRoles.js.
// Each shift is shown on the admin grid with a single "assignment" color
// (Elementary Instructor, Highschool Instructor, …) — see assignmentFor()
// and assignmentColorHex() in src/lib/centerConfig.js. Those nine colors
// are per-center and editable from Super Admin → Appearance.

// Friendly hour-of-day label, '9a', '12p', '5p' style. Used by the
// coverage heatmap on the Analytics tab.
function hourLabel(h) {
  const hh = ((h % 24) + 24) % 24;
  const ampm = hh < 12 ? 'a' : 'p';
  let display = hh % 12;
  if (display === 0) display = 12;
  return `${display}${ampm}`;
}

function fmtHHMM(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const ampm = h >= 12 ? 'p' : 'a';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2,'0')}${ampm}`;
}

function shiftHours(s) {
  if (!s.startTime || !s.endTime) return 0;
  const [sh, sm] = s.startTime.split(':').map(Number);
  const [eh, em] = s.endTime.split(':').map(Number);
  const result = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
  return isNaN(result) || result < 0 ? 0 : result;
}

function normalizeTimeToHHMM(str) {
  if (!str) return '';
  str = str.trim();
  if (/^\d{1,2}:\d{2}$/.test(str)) return str.padStart(5, '0');
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(str)) return str.slice(0, 5).padStart(5, '0');
  const m = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2];
    const ampm = m[4].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  return str;
}

function calcTimeDiffHours(timeInStr, timeOutStr) {
  const t1 = normalizeTimeToHHMM(timeInStr);
  const t2 = normalizeTimeToHHMM(timeOutStr);
  if (!t1 || !t2) return 0;
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2)) return 0;
  const diff = ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60;
  return diff > 0 ? Math.round(diff * 100) / 100 : 0;
}

// ── Shared Modal Shell ─────────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 rounded p-1 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Add Shift Modal ────────────────────────────────────────────────────────────
function AddShiftModal({ date, user, users, availability, onClose, onSave }) {
  const [selectedUser, setSelectedUser] = useState(user?.uid || '');
  const [startTime, setStartTime] = useState('15:00');
  const [endTime, setEndTime] = useState('20:00');
  const [role, setRole] = useState(user?.instructorType || '');
  const [shiftType, setShiftType] = useState('In-Centre');
  // Default sub-role guesses from the instructor's teaching track.
  // Online is its own platform — anyone tagged Online gets Online shifts.
  const guessSubRole = (u) => {
    const subs = u?.subRoles || [];
    if (subs.includes('Online')) return 'Online';
    if (subs.includes('Highschool')) return 'Highschool';
    return 'Elementary';
  };
  const [subRole, setSubRole] = useState(guessSubRole(user));

  const avail = availability.filter(a => a.userId === selectedUser && a.date === date);
  const availComment = avail.find(a => a.comment)?.comment || '';

  // When the instructor selection changes, re-guess the sub-role default
  const handleSelectUser = (uid) => {
    setSelectedUser(uid);
    const next = users.find(u => u.uid === uid);
    setSubRole(guessSubRole(next));
  };

  const handleSubmit = async () => {
    if (!selectedUser || !date) return;
    const profile = users.find(u => u.uid === selectedUser);
    await onSave({
      userId: profile.uid,
      userName: profile.displayName,
      date,
      startTime,
      endTime,
      role,
      shiftType,
      subRole,
      status: 'live',
    });
    onClose();
  };

  return (
    <Modal
      title={`Add Shift — ${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        {/* Instructor selector — only shown when no user pre-selected */}
        {!user && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Instructor</label>
            <select
              value={selectedUser}
              onChange={e => handleSelectUser(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              <option value="">Select instructor...</option>
              {users.map(u => <option key={u.uid} value={u.uid}>{u.displayName}</option>)}
            </select>
          </div>
        )}

        {/* Show selected instructor name when pre-filled */}
        {user && (
          <div className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2">
            <div className="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center text-xs font-bold text-red-700">
              {user.displayName?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2)}
            </div>
            <span className="text-sm font-medium text-gray-800">{user.displayName}</span>
            {user.instructorType && <span className="text-xs text-gray-400">· {user.instructorType}</span>}
          </div>
        )}

        {/* Availability hint */}
        {selectedUser && (
          <div className={`rounded-lg px-3 py-2 text-xs ${avail.length > 0 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
            {avail.length > 0
              ? <>✓ Available: {avail.map(a => `${a.startTime}–${a.endTime}`).join(', ')}</>
              : '⚠ No availability submitted for this date'}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Start Time</label>
            <input
              type="time" value={startTime}
              onChange={e => setStartTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">End Time</label>
            <input
              type="time" value={endTime}
              onChange={e => setEndTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Instructor comment from availability */}
        {availComment && (
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
            <span className="font-semibold">Instructor note: </span>{availComment}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <select
              value={role}
              onChange={e => setRole(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              <option value="">No role</option>
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Shift Type</label>
            <select
              value={shiftType}
              onChange={e => setShiftType(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              <option value="In-Centre">In-Centre</option>
              <option value="Online">Online</option>
              <option value="Both">In-Centre + Online</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Teaching Level <span className="text-red-500">*</span>
          </label>
          <select
            value={subRole}
            onChange={e => setSubRole(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
          >
            {SUB_ROLES.map(sr => <option key={sr} value={sr}>{sr}</option>)}
          </select>
          <p className="mt-1 text-xs text-gray-400">
            Required for shift swaps — only instructors with this sub-role can take it.
          </p>
        </div>

        <button
          onClick={handleSubmit}
          disabled={!selectedUser}
          className="w-full rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 transition-colors mt-1"
        >
          Add Shift
        </button>
      </div>
    </Modal>
  );
}

// ── Edit Shift Modal ───────────────────────────────────────────────────────────
function EditShiftModal({ shift, onClose, onSave, onDelete }) {
  const [startTime, setStartTime] = useState(shift.startTime || '15:00');
  const [endTime, setEndTime] = useState(shift.endTime || '20:00');
  const [role, setRole] = useState(shift.role || '');
  const [shiftType, setShiftType] = useState(shift.shiftType || 'In-Centre');
  const [subRole, setSubRole] = useState(shift.subRole || 'Elementary');

  return (
    <Modal
      title="Edit Shift"
      onClose={onClose}
    >
      <p className="text-sm text-gray-500 mb-4">
        {shift.userName} · {new Date(shift.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
      </p>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Start Time</label>
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">End Time</label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <select value={role} onChange={e => setRole(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
              <option value="">No role</option>
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Shift Type</label>
            <select value={shiftType} onChange={e => setShiftType(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
              <option value="In-Centre">In-Centre</option>
              <option value="Online">Online</option>
              <option value="Both">In-Centre + Online</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">
            Teaching Level <span className="text-red-500">*</span>
          </label>
          <select value={subRole} onChange={e => setSubRole(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
            {SUB_ROLES.map(sr => <option key={sr} value={sr}>{sr}</option>)}
          </select>
          <p className="mt-1 text-xs text-gray-400">
            Required for shift swaps — only instructors with this sub-role can take it.
          </p>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={() => onSave({ startTime, endTime, role, shiftType, subRole })}
            className="flex-1 rounded-lg bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-700">
            Save Changes
          </button>
          <button onClick={onDelete}
            className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Add Open Shift Modal ───────────────────────────────────────────────────────
function AddOpenShiftModal({ date, onClose, onSave }) {
  const [startTime, setStartTime] = useState('15:00');
  const [endTime, setEndTime] = useState('20:00');
  const [role, setRole] = useState('');
  const [subRole, setSubRole] = useState('Elementary');

  const handleSubmit = async () => {
    await onSave({ date, startTime, endTime, role, subRole });
    onClose();
  };

  return (
    <Modal
      title={`Add Open Shift — ${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-500">An open shift can be claimed by any instructor whose sub-role matches.</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Start Time</label>
            <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">End Time</label>
            <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role / Tag (optional)</label>
            <select value={role} onChange={e => setRole(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
              <option value="">Any role</option>
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Teaching Level <span className="text-red-500">*</span>
            </label>
            <select value={subRole} onChange={e => setSubRole(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm focus:border-red-500 focus:outline-none">
              {SUB_ROLES.map(sr => <option key={sr} value={sr}>{sr}</option>)}
            </select>
          </div>
        </div>
        <button onClick={handleSubmit}
          className="w-full rounded-lg bg-orange-500 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 transition-colors mt-1">
          Post Open Shift
        </button>
      </div>
    </Modal>
  );
}

// ── Main Admin Component ───────────────────────────────────────────────────────
export default function Admin() {
  const { activeCenterId, centerConfig, canSeeAdminPanel, canSeeCenterSettings } = useAuth();
  const [users, setUsers]               = useState([]);
  const [availability, setAvailability] = useState([]);
  const [shifts, setShifts]             = useState([]);
  const [openShiftsList, setOpenShiftsList] = useState([]);
  const [timeOffRequests, setTimeOffRequests] = useState([]);
  // Active tab. Sidebar deep-links (?tab=analytics, ?tab=settings) seed the
  // initial state and re-sync if the URL changes — so clicking "Center
  // Analytics" in the super-admin sidebar opens the right tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') || 'spreadsheet');
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && t !== tab) setTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  // Keep the URL in sync when the user clicks a tab so refreshing or sharing
  // the URL lands you back where you were.
  const selectTab = (key) => {
    setTab(key);
    const next = new URLSearchParams(searchParams);
    if (key === 'spreadsheet') next.delete('tab');
    else next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  // Spreadsheet state
  const [weekStart, setWeekStart]       = useState(startOfWeek(new Date()));

  // Modals
  const [addShiftModal, setAddShiftModal]       = useState(null); // { date, user }
  const [editShiftModal, setEditShiftModal]     = useState(null); // shift object
  const [addOpenShiftModal, setAddOpenShiftModal] = useState(null); // { date }

  // Auto-scheduler state
  const [schedMonth, setSchedMonth]   = useState(MONTHS[new Date().getMonth()]);
  const [schedYear, setSchedYear]     = useState(new Date().getFullYear());
  const [draftSchedule, setDraftSchedule] = useState(null);
  const [generating, setGenerating]   = useState(false);
  const [posting, setPosting]         = useState(false);
  const [schedConfig, setSchedConfig] = useState({
    minPerDay: 8, maxPerDay: 11, maxDaysPerWeek: 5, fairDistribution: true,
  });
  const [editingDay, setEditingDay]   = useState(null);
  const [schedError, setSchedError]   = useState('');
  // Set of day-indexes that have their CoverageGrid expanded.
  const [expandedDays, setExpandedDays] = useState(new Set());

  const toggleDayExpanded = (i) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const expandAllDays = () => {
    if (!draftSchedule) return;
    setExpandedDays(new Set(draftSchedule.days.map((_, i) => i)));
  };

  const collapseAllDays = () => setExpandedDays(new Set());

  // Payroll state
  const today = new Date();
  const defaultPeriod = today.getDate() >= 11 && today.getDate() <= 25
    ? { start: `${format(today, 'yyyy-MM')}-11`, end: `${format(today, 'yyyy-MM')}-25` }
    : today.getDate() > 25
      ? { start: `${format(today, 'yyyy-MM')}-26`, end: format(new Date(today.getFullYear(), today.getMonth() + 1, 10), 'yyyy-MM-dd') }
      : { start: format(new Date(today.getFullYear(), today.getMonth() - 1, 26), 'yyyy-MM-dd'), end: `${format(new Date(today.getFullYear(), today.getMonth(), 10), 'yyyy-MM')}-10` };
  const [payStart, setPayStart] = useState(defaultPeriod.start);
  const [payEnd,   setPayEnd]   = useState(defaultPeriod.end);
  const [radiusData, setRadiusData] = useState([]); // parsed Radius timesheet rows
  const [radiusFileName, setRadiusFileName] = useState('');
  const [radiusError, setRadiusError] = useState('');

  // Firestore subscriptions — all scoped to the active center.
  // Users use array-contains on centerIds (since some staff work at multiple
  // centers); everything else filters on the single centerId field.
  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u2 = onSnapshot(
      query(collection(db, 'availability'), where('centerId', '==', activeCenterId), orderBy('date')),
      snap => setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u3 = onSnapshot(
      query(collection(db, 'shifts'), where('centerId', '==', activeCenterId), orderBy('date')),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u4 = onSnapshot(
      query(collection(db, 'openShifts'), where('centerId', '==', activeCenterId), orderBy('date')),
      snap => setOpenShiftsList(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u5 = onSnapshot(
      query(collection(db, 'timeOffRequests'), where('centerId', '==', activeCenterId)),
      snap => setTimeOffRequests(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => {
        const ta = a.createdAt?.seconds ?? 0;
        const tb = b.createdAt?.seconds ?? 0;
        return tb - ta;
      }))
    );
    return () => { u1(); u2(); u3(); u4(); u5(); };
  }, [activeCenterId]);

  // Owners, super-admins, and the shared "Admin Team" account are internal —
  // they shouldn't show up on the weekly grid, the Manage Users list, or
  // any other "actual working staff" surface.
  const isVisibleStaff = (u) =>
    u && u.role !== 'owner' && u.role !== 'super_admin' && u.displayName !== 'Admin Team';

  const approvedUsers = users
    .filter(u => u.approved && isVisibleStaff(u))
    .sort((a, b) => {
      const firstName = name => (name || '').split(' ')[0].toLowerCase();
      return firstName(a.displayName).localeCompare(firstName(b.displayName));
    });
  const pendingUsers  = users.filter(u => !u.approved && isVisibleStaff(u));

  // User management
  const handleApprove = uid => updateDoc(doc(db, 'users', uid), { approved: true });
  const handleReject  = uid => deleteDoc(doc(db, 'users', uid));
  const handleUpdateUserField = (uid, field, value) =>
    updateDoc(doc(db, 'users', uid), { [field]: value });

  // Shift CRUD
  const handleAddShift = async (shiftData) => {
    await addDoc(collection(db, 'shifts'), { ...shiftData, centerId: shiftData.centerId || activeCenterId });
  };

  const handleSaveEditShift = async ({ startTime, endTime, role, shiftType, subRole }) => {
    await updateDoc(doc(db, 'shifts', editShiftModal.id), { startTime, endTime, role, shiftType, subRole });
    setEditShiftModal(null);
  };

  const handleDeleteEditShift = async () => {
    await deleteDoc(doc(db, 'shifts', editShiftModal.id));
    setEditShiftModal(null);
  };

  // Open Shifts
  const handleAddOpenShift = async ({ date, startTime, endTime, role, subRole }) => {
    await addDoc(collection(db, 'openShifts'), {
      date, startTime, endTime, role,
      subRole: subRole || 'Elementary',
      centerId: activeCenterId,
      status: 'open', claimedBy: null, claimedByName: null,
      postedAt: new Date().toISOString(),
    });
  };

  const handleDeleteOpenShift = id => deleteDoc(doc(db, 'openShifts', id));

  // Calendar grid — only days this centre actually operates on (Super Admin
  // → Operating Days). Holidays stay in the grid so it's obvious at a glance
  // when a day is a stat closure vs a regular off-day; each holiday column
  // renders as "Closed" with the holiday name below.
  const weekDays = useMemo(() =>
    Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
      .filter(d => isOperatingDay(d, centerConfig)),
  [weekStart, centerConfig]);

  const totalAssignedHours = useMemo(() => {
    const ws = format(weekStart, 'yyyy-MM-dd');
    const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
    return shifts
      .filter(s => s.date >= ws && s.date <= we && s.status !== 'draft')
      .reduce((sum, s) => sum + shiftHours(s), 0);
  }, [shifts, weekStart]);

  // Auto-scheduler
  const handleGenerate = async () => {
    setGenerating(true); setSchedError(''); setDraftSchedule(null);
    try {
      const approvedTimeOff = new Set();
      timeOffRequests
        .filter(r => r.status === 'approved' && r.startDate && r.endDate)
        .forEach(r => {
          let d = new Date(r.startDate + 'T00:00:00');
          const end = new Date(r.endDate + 'T00:00:00');
          while (d <= end) {
            approvedTimeOff.add(`${r.userId}-${format(d, 'yyyy-MM-dd')}`);
            d.setDate(d.getDate() + 1);
          }
        });

      const filteredAvailability = availability.filter(a =>
        !approvedTimeOff.has(`${a.userId}-${a.date}`)
      );

      // Build previous months availability fallback (up to 6 months back)
      const previousMonthsAvail = [];
      const MONTH_NAMES = ['january','february','march','april','may','june',
        'july','august','september','october','november','december'];
      const monthNum = MONTH_NAMES.indexOf(schedMonth.toLowerCase()) + 1;
      for (let i = 1; i <= 6; i++) {
        let prevMonth = monthNum - i;
        let prevYear = Number(schedYear);
        if (prevMonth <= 0) { prevMonth += 12; prevYear -= 1; }
        const startStr = `${prevYear}-${String(prevMonth).padStart(2,'0')}-01`;
        const endStr = `${prevYear}-${String(prevMonth).padStart(2,'0')}-31`;
        const monthAvail = availability.filter(a =>
          a.date >= startStr && a.date <= endStr &&
          !approvedTimeOff.has(`${a.userId}-${a.date}`)
        );
        previousMonthsAvail.push(monthAvail);
      }

      const result = generateSchedule({
        instructors: approvedUsers,
        availability: filteredAvailability,
        previousMonthsAvail,
        month: schedMonth,
        year: schedYear,
        config: schedConfig,
        centerConfig,   // per-center hours, fixed staff, guaranteed names
      });
      setDraftSchedule(result);
    } catch (err) {
      setSchedError(`Scheduler error: ${err.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const handleEditDay = (i) => setEditingDay({ index: i, ...draftSchedule.days[i] });
  const handleSaveEditDay = () => {
    if (!editingDay) return;
    const newDays = [...draftSchedule.days];
    newDays[editingDay.index] = {
      date: editingDay.date, dayOfWeek: editingDay.dayOfWeek,
      dayNumber: editingDay.dayNumber,
      assignedEmployees: editingDay.assignedEmployees,
      availableEmployees: editingDay.availableEmployees,
      shiftTimes: editingDay.shiftTimes,
      roles: editingDay.roles,
      subRoles: editingDay.subRoles,
      countingStaffCount: editingDay.assignedEmployees.filter(
        n => ['Instructor','Lead'].includes(editingDay.roles?.[n] || 'Instructor')
      ).length,
    };
    setDraftSchedule({ ...draftSchedule, days: newDays });
    setEditingDay(null);
  };

  const handleRemoveFromDay = name =>
    setEditingDay(p => ({ ...p, assignedEmployees: p.assignedEmployees.filter(n => n !== name) }));
  // Default instructional / full-day hours per day-of-week, used when an
  // admin adds someone to a day in the draft editor (and we have no
  // submitted availability to read from).
  const DRAFT_DEFAULT_HOURS = {
    Monday:    { instr: ['15:00', '19:00'], host: ['10:00', '20:00'] },
    Tuesday:   { instr: ['15:00', '19:00'], host: ['10:00', '20:00'] },
    Wednesday: { instr: ['15:00', '19:00'], host: ['10:00', '20:00'] },
    Thursday:  { instr: ['15:00', '19:00'], host: ['10:00', '20:00'] },
    Friday:    { instr: ['15:00', '18:00'], host: ['10:00', '19:00'] },
    Saturday:  { instr: ['10:00', '14:00'], host: ['09:00', '15:00'] },
  };

  const handleAddToDay = name => {
    if (editingDay.assignedEmployees.includes(name)) return;
    // Look up the user's teaching track so the new shift gets tagged.
    // Online is its own platform — anyone tagged Online gets Online shifts.
    const u = approvedUsers.find(usr => usr.displayName === name);
    const subs = u?.subRoles || [];
    let pickedSubRole;
    if (subs.includes('Online')) pickedSubRole = 'Online';
    else if (subs.includes('Highschool')) pickedSubRole = 'Highschool';
    else pickedSubRole = 'Elementary';
    // Default shift time: Hosts get full-day, everyone else gets instructional hours
    const defaults = DRAFT_DEFAULT_HOURS[editingDay.dayOfWeek] || DRAFT_DEFAULT_HOURS.Monday;
    const isHost = u?.instructorType === 'Host';
    const [defStart, defEnd] = isHost ? defaults.host : defaults.instr;
    setEditingDay(p => ({
      ...p,
      assignedEmployees: [...p.assignedEmployees, name],
      subRoles:   { ...(p.subRoles   || {}), [name]: pickedSubRole },
      shiftTimes: { ...(p.shiftTimes || {}), [name]: `${defStart} - ${defEnd}` },
    }));
  };

  // Parse a shift-time string ("15:00 - 19:00" or "11:00 AM - 7:00 PM")
  // back into [startHHMM, endHHMM]. Used by the draft time editor below.
  const parseShiftTimeStr = (str) => {
    if (!str) return ['15:00', '19:00'];
    const parts = String(str).split(' - ');
    if (parts.length !== 2) return ['15:00', '19:00'];
    const norm = (p) => {
      const t = p.trim();
      if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5, '0');
      const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (m) {
        let h = parseInt(m[1], 10);
        const min = m[2];
        const ampm = m[3].toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return `${String(h).padStart(2,'0')}:${min}`;
      }
      return '15:00';
    };
    return [norm(parts[0]), norm(parts[1])];
  };

  const handleUpdateDayShiftTime = (name, field, value) => {
    setEditingDay(p => {
      const current = p.shiftTimes?.[name] || '';
      const [s, e] = parseShiftTimeStr(current);
      const ns = field === 'start' ? value : s;
      const ne = field === 'end'   ? value : e;
      return {
        ...p,
        shiftTimes: { ...(p.shiftTimes || {}), [name]: `${ns} - ${ne}` },
      };
    });
  };

  const handleUpdateDaySubRole = (name, value) => {
    setEditingDay(p => ({
      ...p,
      subRoles: { ...(p.subRoles || {}), [name]: value },
    }));
  };

  // Convert "11:00 AM" → "11:00", "2:00 PM" → "14:00" for Firestore storage
  const toHHMM = (timeStr) => {
    const m = timeStr.trim().match(/^(\d+):(\d+)\s*(AM|PM)$/i);
    if (!m) return '15:00';
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = m[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  };

  // Write fixed staff shifts for a set of date strings to Firestore.
  // Reads from the active center's fixedStaff config when available,
  // falling back to legacy FIXED_SCHEDULES so behavior is preserved
  // pre-migration.
  const seedFixedShiftsForDates = async (dates) => {
    const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const fixedStaffMap = (centerConfig?.fixedStaff && Object.keys(centerConfig.fixedStaff).length > 0)
      ? centerConfig.fixedStaff
      : FIXED_SCHEDULES;
    const fixedNames = Object.keys(fixedStaffMap).map(n => n.toLowerCase());

    // Step 1: Delete ALL existing fixed staff shifts for these dates (prevents duplicates)
    const deleteBatch = writeBatch(db);
    let deleteCount = 0;
    for (const s of shifts) {
      if (dates.includes(s.date) && fixedNames.includes(s.userName?.toLowerCase())) {
        deleteBatch.delete(doc(db, 'shifts', s.id));
        deleteCount++;
      }
    }
    if (deleteCount > 0) await deleteBatch.commit();

    // Step 2: Write fresh shifts
    const insertBatch = writeBatch(db);
    for (const dateStr of dates) {
      const d = new Date(dateStr + 'T00:00:00');
      const jsDay = d.getDay();
      const pythonWeekday = jsDay === 0 ? 6 : jsDay - 1;
      const dayName = DAY_NAMES[pythonWeekday];
      if (!dayName) continue;
      const weekOfMonth = Math.floor((d.getDate() - 1) / 7) + 1;
      for (const [name, sched] of Object.entries(fixedStaffMap)) {
        const shiftStr = sched[dayName];
        if (!shiftStr || shiftStr.toLowerCase() === 'off') continue;
        if (dayName === 'Saturday' && sched.saturday_weeks) {
          if (!sched.saturday_weeks.includes(weekOfMonth)) continue;
        }
        const parts = shiftStr.split(' - ');
        if (parts.length !== 2) continue;
        const user = users.find(u => u.displayName?.trim().toLowerCase() === name.toLowerCase());
        const ref = doc(collection(db, 'shifts'));
        insertBatch.set(ref, {
          userId: user?.uid || name,
          userName: name,
          centerId: activeCenterId,
          date: dateStr,
          startTime: toHHMM(parts[0]),
          endTime: toHHMM(parts[1]),
          role: sched.role,
          subRole: 'Elementary',
          status: 'live',
          autoScheduled: true,
          fixedStaff: true,
        });
      }
    }
    await insertBatch.commit();
  };

  // Clear ALL fixed staff shifts for a week, then reseed properly
  const handleSeedFixedStaffWeek = async () => {
    const dates = weekDays.map(d => format(d, 'yyyy-MM-dd'));
    await seedFixedShiftsForDates(dates);
    alert('✅ Fixed staff shifts synced for this week with correct times.');
  };

  // One-time cleanup: delete ALL fixed staff shifts across all dates, then reseed the current week
  const handlePurgeAndReseed = async () => {
    if (!confirm('This will delete ALL fixed staff shifts from Firestore and reseed the current week fresh. Continue?')) return;
    const fixedNames = Object.keys(FIXED_SCHEDULES).map(n => n.toLowerCase());
    // Delete in chunks of 500 (Firestore batch limit)
    const toDelete = shifts.filter(s => fixedNames.includes(s.userName?.toLowerCase()));
    const CHUNK = 490;
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const b = writeBatch(db);
      toDelete.slice(i, i + CHUNK).forEach(s => b.delete(doc(db, 'shifts', s.id)));
      await b.commit();
    }
    // Reseed current week
    const dates = weekDays.map(d => format(d, 'yyyy-MM-dd'));
    await seedFixedShiftsForDates(dates);
    alert(`✅ Purged ${toDelete.length} old fixed staff shifts and reseeded this week.`);
  };

  // Reset ALL shifts in Firestore — complete clean slate
  const handleResetAllShifts = async () => {
    if (!confirm('⚠️ This will permanently delete EVERY shift from Firestore for ALL staff. This cannot be undone. Are you sure?')) return;
    if (!confirm('Last chance — delete all shifts?')) return;
    const CHUNK = 490;
    for (let i = 0; i < shifts.length; i += CHUNK) {
      const b = writeBatch(db);
      shifts.slice(i, i + CHUNK).forEach(s => b.delete(doc(db, 'shifts', s.id)));
      await b.commit();
    }
    alert(`✅ All ${shifts.length} shifts deleted. Fresh start!`);
  };

  // ── Multi-center migration (Phase 1 groundwork) ──────────────────────────
  // One-time backfill: creates the centers/langley doc and stamps centerId
  // onto every existing doc that doesn't already have one. Safe to run
  // multiple times — it skips docs that already have centerId.
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [migrationResult, setMigrationResult] = useState(null);
  const handleRunCenterMigration = async () => {
    if (!confirm(
      'Multi-center migration:\n\n' +
      `• Creates a "${DEFAULT_CENTER_ID}" center doc if one doesn't exist\n` +
      '• Stamps centerId="' + DEFAULT_CENTER_ID + '" onto every existing user, shift, availability, openShift, time-off request, chat, announcement, and notificationPreferences doc\n' +
      '• Skips any doc that already has a centerId (safe to run multiple times)\n\n' +
      'Continue?'
    )) return;
    setMigrationRunning(true);
    setMigrationResult(null);
    try {
      const stats = { center: 0, config: 0, users: 0, shifts: 0, availability: 0, openShifts: 0, timeOffRequests: 0, chat: 0, announcements: 0, notificationPreferences: 0 };

      // 1. Ensure centers/{DEFAULT_CENTER_ID} exists
      const centerRef = doc(db, 'centers', DEFAULT_CENTER_ID);
      const centerSnap = await getDoc(centerRef);
      if (!centerSnap.exists()) {
        await setDoc(centerRef, {
          id: DEFAULT_CENTER_ID,
          name: 'Mathnasium Langley',
          city: 'Langley',
          province: 'BC',
          country: 'Canada',
          timezone: 'America/Vancouver',
          createdAt: serverTimestamp(),
        });
        stats.center = 1;
      }

      // 1b. Ensure centers/{DEFAULT_CENTER_ID}/config/main exists.
      // Seeds with Langley's current values (instructional hours, fixed staff,
      // guaranteed names, salary list) so the data-driven config doesn't
      // accidentally come up empty and break the scheduler.
      const configRef = doc(db, 'centers', DEFAULT_CENTER_ID, 'config', 'main');
      const configSnap = await getDoc(configRef);
      if (!configSnap.exists()) {
        await setDoc(configRef, {
          ...LANGLEY_DEFAULT_CONFIG,
          createdAt: serverTimestamp(),
        });
        stats.config = 1;
      }

      // 2. Backfill every other collection. Users get extra love: if they
      // already have centerId (from a previous partial migration) but not the
      // centerIds[] array, we add it — otherwise the new array-contains query
      // and rules can't find them.
      const collectionsToMigrate = [
        'users', 'shifts', 'availability', 'openShifts',
        'timeOffRequests', 'chat', 'announcements', 'notificationPreferences',
      ];
      for (const colName of collectionsToMigrate) {
        const snap = await getDocs(collection(db, colName));
        const toUpdate = snap.docs.filter(d => {
          const data = d.data();
          if (colName === 'users') {
            return !data.centerId || !Array.isArray(data.centerIds);
          }
          return !data.centerId;
        });
        const CHUNK = 450;
        for (let i = 0; i < toUpdate.length; i += CHUNK) {
          const b = writeBatch(db);
          for (const d of toUpdate.slice(i, i + CHUNK)) {
            const data = d.data();
            const updates = {};
            if (!data.centerId) updates.centerId = DEFAULT_CENTER_ID;
            if (colName === 'users' && !Array.isArray(data.centerIds)) {
              updates.centerIds = [data.centerId || DEFAULT_CENTER_ID];
            }
            if (Object.keys(updates).length > 0) {
              b.update(d.ref, updates);
            }
          }
          await b.commit();
        }
        stats[colName] = toUpdate.length;
      }
      setMigrationResult({ ok: true, stats });
    } catch (err) {
      setMigrationResult({ ok: false, error: err?.message || String(err) });
    } finally {
      setMigrationRunning(false);
    }
  };

  const handlePostSchedule = async () => {
    if (!draftSchedule) return;
    setPosting(true);
    try {
      const batch = writeBatch(db);
      for (const day of draftSchedule.days) {
        for (const name of day.assignedEmployees) {
          if (FIXED_SCHEDULES[name]) continue;
          const user = approvedUsers.find(u => u.displayName === name);
          const shiftStr = day.shiftTimes?.[name] || '';
          const [startRaw, endRaw] = shiftStr.includes(' - ')
            ? shiftStr.split(' - ') : ['15:00', '20:00'];
          const startTime = startRaw?.includes('M') ? toHHMM(startRaw) : (startRaw || '15:00');
          const endTime   = endRaw?.includes('M')   ? toHHMM(endRaw)   : (endRaw   || '20:00');
          const ref = doc(collection(db, 'shifts'));
          batch.set(ref, {
            userId: user?.uid || name, userName: name,
            centerId: activeCenterId,
            date: day.date, startTime, endTime,
            role: day.roles?.[name] || 'Instructor',
            subRole: day.subRoles?.[name] || 'Elementary',
            status: 'live', autoScheduled: true,
          });
        }
      }
      await batch.commit();

      const allDates = draftSchedule.days.map(d => d.date);
      await seedFixedShiftsForDates(allDates);

      const totalShifts = draftSchedule.days.reduce((s, d) => s + d.assignedEmployees.length, 0);

      await addDoc(collection(db, 'chat'), {
        text: `📅 The ${draftSchedule.month} ${draftSchedule.year} schedule has been posted!\n\n${totalShifts} shifts across ${draftSchedule.days.length} working days. Check your schedule on the Schedule page.`,
        userId: 'system', userName: 'Mathnasium Langley', userRole: 'system',
        centerId: activeCenterId,
        createdAt: serverTimestamp(), type: 'schedule_posted',
      });

      const staffEmails = approvedUsers.filter(u => u.email).map(u => ({ email: u.email, displayName: u.displayName }));
      // Email notification - uncomment when EmailJS is configured
      // await notifySchedulePosted(draftSchedule, staffEmails);
      void staffEmails; // suppress unused warning

      setDraftSchedule(null);
      alert(`✅ Schedule posted! ${totalShifts} instructor shifts + fixed staff created. Staff notified.`);
    } catch (err) {
      setSchedError(`Failed to post: ${err.message}`);
    } finally {
      setPosting(false);
    }
  };

  // Salaried staff are excluded from hourly payroll (read from this center's
  // config so each location can have its own list).
  const salaryStaff = useMemo(() => (
    new Set(Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [])
  ), [centerConfig]);

  // Owners, super-admins, and the shared "Admin Team" account never belong
  // on payroll either — keep their names out by display name (which is what
  // shifts reference).
  const hiddenFromOps = useMemo(() => {
    const set = new Set();
    for (const u of users) {
      const hidden = u.role === 'owner' || u.role === 'super_admin' || u.displayName === 'Admin Team';
      if (hidden && u.displayName) set.add(u.displayName);
    }
    return set;
  }, [users]);

  // Payroll summary — all shifts in the selected pay period grouped by person
  const payrollSummary = useMemo(() => {
    if (!payStart || !payEnd) return [];
    const periodShifts = shifts.filter(s =>
      s.date >= payStart &&
      s.date <= payEnd &&
      s.status !== 'draft' &&
      !salaryStaff.has(s.userName) &&
      !hiddenFromOps.has(s.userName)
    );

    // Also include fixed staff from FIXED_SCHEDULES who may not have Firestore shifts yet
    const byPerson = {};

    // From Firestore shifts
    for (const s of periodShifts) {
      const key = s.userName || s.userId;
      if (!byPerson[key]) {
        const user = users.find(u => u.displayName === s.userName || u.uid === s.userId);
        byPerson[key] = {
          name: s.userName || key,
          role: s.role || user?.instructorType || 'Instructor',
          shifts: [],
          totalHours: 0,
        };
      }
      const hrs = shiftHours(s);
      byPerson[key].shifts.push({
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        hours: hrs,
        shiftId: s.id,
      });
      byPerson[key].totalHours += hrs;
    }

    // Sort each person's shifts by date
    for (const key of Object.keys(byPerson)) {
      byPerson[key].shifts.sort((a, b) => a.date.localeCompare(b.date));
      byPerson[key].totalHours = Math.round(byPerson[key].totalHours * 100) / 100;
    }

    // Sort people alphabetically by last name
    return Object.values(byPerson).sort((a, b) => {
      const lastA = a.name.split(' ').pop() || a.name;
      const lastB = b.name.split(' ').pop() || b.name;
      return lastA.localeCompare(lastB);
    });
  }, [shifts, users, payStart, payEnd, salaryStaff, hiddenFromOps]);

  // Pay period helpers
  const payPeriodLabel = payStart && payEnd
    ? `${new Date(payStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(payEnd + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';

  const totalPayrollHours = payrollSummary.reduce((s, p) => s + p.totalHours, 0);

  // Add / remove a staff member from the salaryStaff list (which the payroll
  // filter uses to keep salaried people off the hourly sheet). Writes are
  // merged so the rest of the centre config is untouched.
  const handleExcludeFromPayroll = async (name) => {
    if (!activeCenterId || !name) return;
    const current = Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [];
    if (current.includes(name)) return;
    await setDoc(
      doc(db, 'centers', activeCenterId, 'config', 'main'),
      { salaryStaff: [...current, name], updatedAt: serverTimestamp() },
      { merge: true },
    );
  };
  const handleIncludeInPayroll = async (name) => {
    if (!activeCenterId || !name) return;
    const current = Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : [];
    if (!current.includes(name)) return;
    await setDoc(
      doc(db, 'centers', activeCenterId, 'config', 'main'),
      { salaryStaff: current.filter(n => n !== name), updatedAt: serverTimestamp() },
      { merge: true },
    );
  };

  // Export to CSV
  const handleExportPayroll = () => {
    const fmtTime = (t) => {
      if (!t) return '';
      const [hStr, mStr] = t.split(':');
      let h = parseInt(hStr, 10);
      const m = parseInt(mStr, 10);
      const ampm = h >= 12 ? 'PM' : 'AM';
      if (h > 12) h -= 12;
      if (h === 0) h = 12;
      return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
    };

    const rows = [['Name', 'Role', 'Date', 'Start', 'End', 'Hours']];
    for (const person of payrollSummary) {
      for (const s of person.shifts) {
        const dateLabel = new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        rows.push([person.name, person.role, dateLabel, fmtTime(s.startTime), fmtTime(s.endTime), s.hours.toFixed(2)]);
      }
      rows.push([person.name, '', 'TOTAL', '', '', person.totalHours.toFixed(2)]);
      rows.push([]);
    }
    rows.push(['', '', 'GRAND TOTAL', '', '', Math.round(totalPayrollHours * 100) / 100]);

    const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll_${payStart}_to_${payEnd}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Parse Radius XLSX export — loads xlsx via script tag (no npm needed)
  const handleRadiusImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRadiusError('');
    setRadiusFileName(file.name);

    try {
      // Dynamically load SheetJS from CDN if not already loaded
      if (!window.XLSX) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }

      const buf = await file.arrayBuffer();
      const wb = window.XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });

      const parsed = [];
      for (const row of rows) {
        const attendanceId = row[1];
        const name = String(row[2] || '').trim();
        const dateRaw = String(row[4] || '').trim();
        const timeIn  = String(row[5] || '').trim();
        const timeOut = String(row[6] || '').trim();
        const durationHours = parseFloat(row[8]);

        if (!name || name === 'Employee Name') continue;
        if (typeof attendanceId !== 'number' || isNaN(attendanceId)) continue;
        if (!dateRaw || isNaN(durationHours)) continue;

        // Parse DD/MM/YYYY → YYYY-MM-DD
        if (!dateRaw.includes('/')) continue;
        const parts = dateRaw.split('/');
        if (parts.length !== 3) continue;
        const [d, m, y] = parts;
        const dateStr = `${y.trim()}-${String(m.trim()).padStart(2,'0')}-${String(d.trim()).padStart(2,'0')}`;

        parsed.push({ name, date: dateStr, timeIn, timeOut, actualHours: durationHours });
      }

      if (parsed.length === 0) {
        setRadiusError('No valid entries found. Make sure this is the Radius Employee Timesheet export.');
        return;
      }
      setRadiusData(parsed);
    } catch (err) {
      setRadiusError('Failed to parse file. Make sure it is the Radius Excel export.');
      console.error(err);
    }
    e.target.value = '';
  };

  const updateRadiusEntry = (index, field, value) => {
    setRadiusData(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === 'timeIn' || field === 'timeOut') {
        const entry = updated[index];
        updated[index] = { ...updated[index], actualHours: calcTimeDiffHours(entry.timeIn, entry.timeOut) };
      }
      return updated;
    });
  };

  const deleteRadiusEntry = (index) => {
    setRadiusData(prev => prev.filter((_, i) => i !== index));
  };

  const addRadiusEntry = (name) => {
    setRadiusData(prev => [...prev, { name, date: payStart, timeIn: '', timeOut: '', actualHours: 0 }]);
  };

  // Build comparison: for each person in payroll, match Radius rows
  const comparisonSummary = useMemo(() => {
    if (radiusData.length === 0) return null;
    return payrollSummary.map(person => {
      // Fuzzy name match — Radius uses "First Last", portal uses "First Last"
      const radiusRows = radiusData
        .map((r, idx) => ({ ...r, _idx: idx }))
        .filter(r => r.name.toLowerCase().trim() === person.name.toLowerCase().trim());
      const actualHours = radiusRows.reduce((s, r) => s + r.actualHours, 0);
      const scheduledHours = person.totalHours;
      const diff = Math.round((actualHours - scheduledHours) * 100) / 100;
      const hasDiscrepancy = Math.abs(diff) > 0.25; // >15 min difference flags it

      // Per-shift comparison
      const shiftComparisons = person.shifts.map(s => {
        const match = radiusRows.find(r => r.date === s.date);
        const shiftDiff = match ? Math.round((match.actualHours - s.hours) * 100) / 100 : null;
        return {
          ...s,
          actual: match || null,
          shiftDiff,
          shiftDiscrepancy: match ? Math.abs(shiftDiff) > 0.25 : false,
          missingFromRadius: !match,
        };
      });

      // Radius entries with no matching scheduled shift
      const unmatchedRadius = radiusRows.filter(r =>
        !person.shifts.find(s => s.date === r.date)
      );

      return {
        ...person,
        actualHours: Math.round(actualHours * 100) / 100,
        scheduledHours,
        diff,
        hasDiscrepancy,
        shiftComparisons,
        unmatchedRadius,
      };
    });
  }, [payrollSummary, radiusData]);

  // Admin Panel is open to admins, owners, and super-admins. Plain
  // instructors get bounced (the route guard also enforces this).
  if (!canSeeAdminPanel) {
    return <div className="text-center text-gray-500 py-16">Access denied. Admin / owner only.</div>;
  }

  const pendingRequestsCount = timeOffRequests.filter(r => r.status === 'pending').length;

  // Center Settings is owner / super-admin only — plain admins run
  // day-to-day operations but don't change the center's configuration.
  const tabs = [
    { key: 'spreadsheet',  label: 'Scheduler',      icon: Table },
    { key: 'users',        label: 'Manage Users',   icon: UserCheck },
    { key: 'scheduler',    label: 'Auto-Scheduler', icon: Wand2, badge: 'AI', badgeStyle: 'purple' },
    { key: 'payroll',      label: 'Payroll',        icon: DollarSign },
    { key: 'requests',     label: 'Requests',       icon: CalendarRange },
    // Holidays is visible to all admin-panel roles (admin / owner / super-admin)
    // so anyone who manages day-to-day ops can add a closure.
    { key: 'holidays',     label: 'Holidays',       icon: CalendarX },
    // Analytics is owner / super-admin only — strategic view, not daily ops.
    ...(canSeeCenterSettings
      ? [{ key: 'analytics', label: 'Analytics', icon: BarChart3 }]
      : []),
    ...(canSeeCenterSettings
      ? [{ key: 'settings', label: 'Center Settings', icon: Settings }]
      : []),
  ];

  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="rounded-lg bg-purple-100 p-2 text-purple-600"><Settings size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
          <p className="text-sm text-gray-500">Manage instructors and shifts</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 border-b overflow-x-auto">
        {tabs.map(t => (
          <button key={t.key} onClick={() => selectTab(t.key)}
            className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors ${tab === t.key ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <t.icon size={16} /> {t.label}
            {t.badge && (
              <span className={`rounded-full px-1.5 py-0.5 text-xs ${t.badgeStyle === 'purple' ? 'bg-purple-100 text-purple-700' : 'bg-orange-100 text-orange-700'}`}>
                {t.badge}
              </span>
            )}
            {t.key === 'requests' && pendingRequestsCount > 0 && (
              <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-xs font-bold text-white">
                {pendingRequestsCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── SPREADSHEET (Weekly Calendar Grid) ──────────────────────────────── */}
      {tab === 'spreadsheet' && (
        <div className="space-y-2">
          {/* Legend + tips. Swatches use this center's custom shift colors. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 mb-2 text-xs text-gray-500">
            <span className="font-semibold text-gray-600 mr-1">Shift:</span>
            <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-full bg-orange-500" /> Open Shift</span>
            {SHIFT_ASSIGNMENTS.map(a => (
              <span key={a} className="flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: assignmentColorHex(a, centerConfig) }} />
                {a}
              </span>
            ))}
            <span className="ml-auto flex items-center gap-1 text-gray-400 italic">
              Click any cell to add a shift · Click <Plus size={10} className="inline" /> to add open shift
            </span>
          </div>

          <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
            {/* Week nav */}
            <div className="flex items-center justify-between px-4 py-3 border-b bg-white">
              <div className="flex items-center gap-2">
                <button onClick={() => setWeekStart(w => subWeeks(w, 1))}
                  className="rounded p-1 hover:bg-gray-100"><ChevronLeft size={18} /></button>
                <button onClick={() => setWeekStart(startOfWeek(new Date()))}
                  className="rounded border px-3 py-1 text-xs font-medium hover:bg-gray-50">Today</button>
                <button onClick={() => setWeekStart(w => addWeeks(w, 1))}
                  className="rounded p-1 hover:bg-gray-100"><ChevronRight size={18} /></button>
                <span className="ml-2 text-sm font-semibold text-gray-800">
                  {format(weekStart, 'MMM d')} – {format(addDays(weekStart, 6), 'MMM d, yyyy')}
                </span>
              </div>
              <span className="text-xs text-gray-500">
                Total assigned: <strong>{Math.round(totalAssignedHours * 10) / 10} hrs</strong>
              </span>
              <button onClick={handleSeedFixedStaffWeek}
                className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors">
                <Plus size={12} /> Sync Fixed Staff This Week
              </button>
              <button onClick={handlePurgeAndReseed}
                title="Delete all fixed staff shifts and reseed this week — use once to fix duplicates"
                className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors">
                <RotateCcw size={12} /> Fix Duplicates
              </button>
              <button onClick={handleResetAllShifts}
                title="Wipe every shift from Firestore — complete fresh start"
                className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-colors">
                <Trash2 size={12} /> Reset All Shifts
              </button>
            </div>

            {/* Grid — table-fixed so columns share the width evenly and long
                shift labels can't stretch the table sideways. The wrapper is a
                scroll pane (max-height) so the day-header row can stay pinned
                via position:sticky while you scroll through instructors. */}
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-xs border-collapse table-fixed min-w-[680px]">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="sticky top-0 z-30 bg-gray-50 text-left px-4 py-2 font-semibold text-gray-600 w-32 border-r shadow-[inset_0_-1px_0_#e5e7eb]">INSTRUCTOR</th>
                    {weekDays.map(d => {
                      const isToday = isSameDay(d, new Date());
                      const ds = format(d, 'yyyy-MM-dd');
                      const holiday = holidayFor(d, centerConfig);
                      const portalNames = new Set(users.map(u => u.displayName));
                      const dayTotalHrs = shifts
                        .filter(s => s.date === ds && s.status !== 'draft' && portalNames.has(s.userName))
                        .reduce((sum, s) => sum + shiftHours(s), 0);
                      const dayHrsDisplay = isNaN(dayTotalHrs) ? 0 : Math.round(dayTotalHrs * 10) / 10;
                      const headerBg = holiday
                        ? 'bg-amber-50 text-amber-700'
                        : isToday
                          ? 'bg-red-50 text-red-700'
                          : 'bg-gray-50 text-gray-600';
                      return (
                        <th key={d.toISOString()} className={`sticky top-0 z-30 text-center py-2 px-1 font-medium shadow-[inset_0_-1px_0_#e5e7eb] ${headerBg}`}>
                          <div className="text-xs uppercase tracking-wide">{format(d, 'EEE')}</div>
                          <div className={`text-base font-bold ${holiday ? 'text-amber-700' : isToday ? 'text-red-600' : 'text-gray-800'}`}>{format(d, 'd')}</div>
                          {holiday ? (
                            <div className="mx-auto mt-0.5 max-w-full truncate text-[10px] font-semibold uppercase tracking-wide text-amber-700" title={`Closed — ${holiday.name}`}>
                              {holiday.name || 'Closed'}
                            </div>
                          ) : dayHrsDisplay > 0 ? (
                            <div className={`text-xs font-semibold mt-0.5 ${isToday ? 'text-red-500' : 'text-purple-600'}`}>
                              {dayHrsDisplay}h
                            </div>
                          ) : null}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {/* ── Open Shifts row ── */}
                  <tr className="border-b bg-orange-50">
                    <td className="px-4 py-2 border-r">
                      <div className="flex items-center gap-1.5">
                        <div className="w-5 h-5 rounded-full bg-orange-400 flex items-center justify-center">
                          <Plus size={11} className="text-white" />
                        </div>
                        <span className="font-semibold text-orange-700 text-xs">Open Shifts</span>
                      </div>
                    </td>
                    {weekDays.map(d => {
                      const ds = format(d, 'yyyy-MM-dd');
                      const holiday = holidayFor(d, centerConfig);
                      // On holidays the centre is closed — no open shifts,
                      // no add button. Just a calm "Closed" marker.
                      if (holiday) {
                        return (
                          <td key={ds} className="bg-amber-50/40 px-1 py-2 text-center align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                            Closed
                          </td>
                        );
                      }
                      const dayOpenShifts = openShiftsList.filter(s => s.date === ds);
                      return (
                        <td key={ds} className="px-1 py-1 align-top">
                          {dayOpenShifts.map(s => (
                            <div key={s.id}
                              className={`rounded px-1.5 py-1 mb-0.5 text-xs ${s.status === 'claimed' ? 'bg-green-100 border border-green-300' : 'bg-orange-100 border border-orange-300'}`}>
                              <div className="font-semibold text-orange-800">{fmtHHMM(s.startTime)}–{fmtHHMM(s.endTime)}</div>
                              {s.role && <div className="text-orange-600 uppercase tracking-wide" style={{fontSize:'10px'}}>{s.role}</div>}
                              {s.claimedByName && <div className="text-green-700" style={{fontSize:'10px'}}>→ {s.claimedByName}</div>}
                              <button
                                onClick={() => handleDeleteOpenShift(s.id)}
                                className="text-orange-300 hover:text-red-500 float-right -mt-4"
                                title="Remove"
                              >
                                <X size={10} />
                              </button>
                            </div>
                          ))}
                          {/* Add open shift button */}
                          <button
                            onClick={() => setAddOpenShiftModal({ date: ds })}
                            className="w-full rounded border border-dashed border-orange-300 py-0.5 text-orange-400 hover:bg-orange-100 hover:text-orange-600 transition-colors flex items-center justify-center gap-0.5 mt-0.5"
                            title="Add open shift"
                          >
                            <Plus size={10} />
                          </button>
                        </td>
                      );
                    })}
                  </tr>

                  {/* ── Instructor rows ── */}
                  {approvedUsers.map(u => {
                    const totalHrs = weekDays.reduce((sum, d) => {
                      const ds = format(d, 'yyyy-MM-dd');
                      return sum + shifts.filter(s => s.userId === u.uid && s.date === ds && s.status !== 'draft')
                        .reduce((s2, sh) => s2 + shiftHours(sh), 0);
                    }, 0);
                    const displayHrs = isNaN(totalHrs) ? 0 : Math.round(totalHrs * 10) / 10;
                    const initials = u.displayName?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
                    return (
                      <tr key={u.uid} className="border-b hover:bg-gray-50 transition-colors group">
                        <td className="px-4 py-2 border-r">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center text-xs font-bold text-red-700 shrink-0">{initials}</div>
                            <div>
                              <div className="font-semibold text-gray-800 text-xs">{u.displayName}</div>
                              <div className="text-gray-400" style={{fontSize:'10px'}}>{displayHrs}h · {u.instructorType || 'Instructor'}</div>
                            </div>
                          </div>
                        </td>
                        {weekDays.map(d => {
                          const ds = format(d, 'yyyy-MM-dd');
                          const holiday = holidayFor(d, centerConfig);
                          // Holiday column — empty greyed cell. The header
                          // already labels it "Closed — [holiday]", so the
                          // per-instructor cells just stay quiet.
                          if (holiday) {
                            return (
                              <td key={ds} className="bg-amber-50/40 px-1 py-2 text-center align-middle text-[10px] uppercase tracking-wide text-amber-500/70">
                                —
                              </td>
                            );
                          }
                          const dayShifts = shifts.filter(s => s.userId === u.uid && s.date === ds);
                          const dayAvail = availability.filter(a => a.userId === u.uid && a.date === ds);
                          const hasAvail = dayAvail.length > 0;
                          return (
                            <td
                              key={ds}
                              className={`px-1 py-1 align-top relative ${hasAvail && dayShifts.length === 0 ? 'bg-green-50/40' : ''}`}
                            >
                              {/* Green triangle availability indicator */}
                              {hasAvail && (
                                <div className="group/avail absolute top-0 right-0 z-10">
                                  <div className="w-0 h-0 border-l-[14px] border-l-transparent border-t-[14px] border-t-green-400 cursor-pointer" />
                                  {/* Hover tooltip showing availability times */}
                                  <div className="hidden group-hover/avail:block absolute right-0 top-4 z-20 w-52 rounded-lg border border-green-200 bg-white shadow-lg p-2">
                                    <p className="text-xs font-semibold text-green-700 mb-1">Available</p>
                                    {dayAvail.map((a, i) => (
                                      <div key={i}>
                                        <p className="text-xs text-gray-600">{fmtHHMM(a.startTime)} – {fmtHHMM(a.endTime)}</p>
                                        {a.comment && <p className="text-xs text-blue-600 italic mt-0.5">"{a.comment}"</p>}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {/* Existing shifts — the whole block is filled
                                  with the shift's assignment color (editable
                                  in Super Admin → Appearance). */}
                              {dayShifts.map(s => {
                                const assignment = assignmentFor(s);
                                const bg   = assignmentColorHex(assignment, centerConfig);
                                const text = contrastText(bg);
                                const hrs = shiftHours(s);
                                const hrsDisplay = isNaN(hrs) || hrs <= 0 ? '' : `${Math.round(hrs * 10) / 10}h`;
                                const where = s.shiftType === 'Online' ? 'Online'
                                  : s.shiftType === 'Both' ? 'In-Centre + Online'
                                  : 'In-Centre';
                                // Compact label: short assignment name, plus a
                                // location flag only when it's not the usual
                                // in-centre (and not an online instructor, for
                                // whom "online" is already implied). Full text
                                // lives in the hover tooltip.
                                const showWhere = where !== 'In-Centre' && assignment !== 'Online Instructor';
                                return (
                                  <div key={s.id}
                                    onClick={() => setEditShiftModal(s)}
                                    title={`${assignment} · ${where}`}
                                    className="rounded px-1.5 py-1 mb-0.5 cursor-pointer hover:opacity-80 transition-opacity overflow-hidden"
                                    style={{ backgroundColor: bg, color: text }}>
                                    <div className="font-semibold leading-tight" style={{fontSize:'11px'}}>{fmtHHMM(s.startTime)}–{fmtHHMM(s.endTime)}{hrsDisplay ? ` · ${hrsDisplay}` : ''}</div>
                                    <div className="uppercase tracking-wide opacity-90 leading-tight" style={{fontSize:'10px'}}>{assignmentShort(assignment)}{showWhere ? ` · ${where}` : ''}</div>
                                  </div>
                                );
                              })}
                              {/* Add shift button */}
                              <button
                                onClick={() => setAddShiftModal({ date: ds, user: u })}
                                className="w-full rounded border border-dashed py-0.5 transition-colors flex items-center justify-center gap-0.5 border-gray-200 text-gray-300 hover:border-red-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100"
                                title={`Add shift for ${u.displayName}`}
                              >
                                <Plus size={10} />
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}

                  {/* Day Totals row */}
                  <tr className="bg-gray-50 border-t">
                    <td className="px-4 py-2 border-r text-xs font-semibold text-gray-600">Day Totals</td>
                    {weekDays.map(d => {
                      const ds = format(d, 'yyyy-MM-dd');
                      const holiday = holidayFor(d, centerConfig);
                      if (holiday) {
                        return (
                          <td key={ds} className="bg-amber-50/40 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                            Closed
                          </td>
                        );
                      }
                      const portalNames2 = new Set(users.map(u => u.displayName));
                      const dayShiftsAll = shifts.filter(s => s.date === ds && s.status !== 'draft');
                      const dayShiftsPortal = dayShiftsAll.filter(s => portalNames2.has(s.userName));
                      const dayShiftsNoAccount = dayShiftsAll.filter(s => !portalNames2.has(s.userName));
                      const count = dayShiftsAll.length;
                      const hrs = dayShiftsPortal.reduce((sum, s) => sum + shiftHours(s), 0);
                      const hrsDisplay = isNaN(hrs) ? 0 : Math.round(hrs * 10) / 10;
                      return (
                        <td key={ds} className="text-center py-2 text-xs text-gray-500">
                          {count > 0 ? (
                            <div className="space-y-0.5">
                              <span className="font-semibold text-gray-700">{count} staff</span>
                              <div className="text-purple-600 font-semibold">{hrsDisplay}h total</div>
                              {dayShiftsNoAccount.length > 0 && (
                                <div className="text-gray-400 text-xs">
                                  +{dayShiftsNoAccount.length} no account
                                </div>
                              )}
                            </div>
                          ) : '–'}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Open Shifts summary below grid */}
          {openShiftsList.filter(s => {
            const ws = format(weekStart, 'yyyy-MM-dd');
            const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
            return s.date >= ws && s.date <= we;
          }).length > 0 && (
            <div className="rounded-xl border bg-orange-50 border-orange-200 p-4">
              <h4 className="text-xs font-semibold text-orange-800 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <ArrowRightLeft size={13} /> Open Shifts This Week
              </h4>
              <div className="flex flex-wrap gap-2">
                {openShiftsList
                  .filter(s => {
                    const ws = format(weekStart, 'yyyy-MM-dd');
                    const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
                    return s.date >= ws && s.date <= we;
                  })
                  .sort((a, b) => a.date.localeCompare(b.date))
                  .map(s => (
                    <div key={s.id} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs border ${s.status === 'claimed' ? 'bg-green-100 border-green-300 text-green-800' : 'bg-white border-orange-300 text-orange-800'}`}>
                      <span className="font-medium">{new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                      <span>{fmtHHMM(s.startTime)}–{fmtHHMM(s.endTime)}</span>
                      {s.role && <span className="text-orange-500">{s.role}</span>}
                      {s.claimedByName ? <span className="text-green-700">→ {s.claimedByName}</span> : <span className="italic text-orange-400">unclaimed</span>}
                      <button onClick={() => handleDeleteOpenShift(s.id)} className="text-orange-300 hover:text-red-500 ml-1">
                        <X size={12} />
                      </button>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MANAGE USERS ────────────────────────────────────────────────────── */}
      {tab === 'users' && (
        <div className="space-y-6">
          {/* Admins, owners, and super-admins can all approve new sign-ups —
              Firestore rules let admins flip `approved` on non-elevated
              users. (Owners and super-admin docs are protected from admin
              edits at the rule level.) */}
          {pendingUsers.length > 0 && canSeeAdminPanel && (
            <div className="rounded-xl border bg-white p-5 shadow-sm">
              <h3 className="mb-4 font-semibold text-yellow-700">⏳ Pending Approval ({pendingUsers.length})</h3>
              <div className="space-y-3">
                {pendingUsers.map(u => (
                  <div key={u.id} className="flex items-center justify-between rounded-lg bg-yellow-50 px-4 py-3">
                    <div>
                      <p className="font-medium text-gray-900">{u.displayName}</p>
                      <p className="text-sm text-gray-500">{u.email}</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => handleApprove(u.uid)}
                        className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700">
                        <UserCheck size={14} /> Approve
                      </button>
                      <button onClick={() => handleReject(u.id)}
                        className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700">
                        <UserX size={14} /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <h3 className="mb-4 font-semibold text-gray-900">Approved Instructors ({approvedUsers.length})</h3>
            {approvedUsers.length === 0 ? (
              <p className="text-sm text-gray-400">No approved instructors yet.</p>
            ) : (
              <div className="space-y-3">
                {approvedUsers.map(u => (
                  <div key={u.id} className="rounded-lg border bg-gray-50 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-red-100 text-sm font-bold text-red-700">
                          {u.displayName?.charAt(0)?.toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{u.displayName}</p>
                          <p className="text-xs text-gray-500">{u.email}</p>
                        </div>
                      </div>
                      {/* Admins, owners, and super-admins can delete staff
                          — Firestore rules block deleting owner / super_admin
                          docs, so admins clicking on those would just bounce. */}
                      {canSeeAdminPanel && (
                        <button onClick={() => handleReject(u.id)} className="rounded p-1 text-gray-400 hover:text-red-500">
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">Role / Type</label>
                        <select value={u.instructorType || 'Instructor'}
                          onChange={e => handleUpdateUserField(u.uid, 'instructorType', e.target.value)}
                          className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none">
                          {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">Priority</label>
                        <select value={u.priority || 2}
                          onChange={e => handleUpdateUserField(u.uid, 'priority', Number(e.target.value))}
                          className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none">
                          <option value={1}>1 – High</option>
                          <option value={2}>2 – Medium</option>
                          <option value={3}>3 – Low</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-gray-500">Max Days/Week</label>
                        <input type="number" min={1} max={6} value={u.maxDaysPerWeek || 5}
                          onChange={e => handleUpdateUserField(u.uid, 'maxDaysPerWeek', Number(e.target.value))}
                          className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none" />
                      </div>
                    </div>

                    {/* Sub-roles / Teaching specializations.
                        Online is its own platform — it's mutually exclusive
                        with Elementary/Highschool. Selecting Online clears
                        the in-centre sub-roles and vice versa. */}
                    <div>
                      <label className="mb-1.5 block text-xs text-gray-500 font-medium">Teaching Sub-Roles</label>
                      <div className="flex flex-wrap gap-2">
                        {SUB_ROLES.map(sr => {
                          const current = u.subRoles || [];
                          const active = current.includes(sr);
                          const style = SUB_ROLE_STYLES[sr];
                          const isOnline = sr === 'Online';
                          // Online is locked out while an in-centre sub-role is set;
                          // in-centre sub-roles are locked out while Online is set.
                          const onlineActive   = current.includes('Online');
                          const inCentreActive = current.includes('Elementary') || current.includes('Highschool');
                          const disabled = !active && (
                            (isOnline && inCentreActive) ||
                            (!isOnline && onlineActive)
                          );
                          return (
                            <button
                              key={sr}
                              disabled={disabled}
                              title={disabled
                                ? (isOnline
                                    ? 'Online is a separate platform — remove Elementary/Highschool first'
                                    : 'This instructor is Online-only — remove Online first')
                                : ''}
                              onClick={() => {
                                let updated;
                                if (active) {
                                  updated = current.filter(r => r !== sr);
                                } else if (isOnline) {
                                  // Picking Online wipes the in-centre sub-roles.
                                  updated = ['Online'];
                                } else {
                                  // Picking an in-centre sub-role wipes Online.
                                  updated = [...current.filter(r => r !== 'Online'), sr];
                                }
                                handleUpdateUserField(u.uid, 'subRoles', updated);
                              }}
                              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border-2 transition-all ${
                                active
                                  ? `${style.pillBg} ${style.pillText} border-transparent`
                                  : disabled
                                    ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed'
                                    : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                              }`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${active ? style.dot : 'bg-gray-300'}`} />
                              {sr}
                            </button>
                          );
                        })}
                        {(u.subRoles || []).length === 0 && (
                          <span className="text-xs text-gray-400 italic">No sub-roles assigned</span>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-gray-400">
                        Online is a separate platform — can't be combined with Elementary or Highschool.
                      </p>
                    </div>

                    {/* Guaranteed shift toggle — for Hosts and key staff who
                        should always be scheduled when they submit availability. */}
                    <div className="mt-3 flex items-start justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
                      <div className="pr-3">
                        <p className="text-xs font-semibold text-gray-700">Guaranteed shift</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Always scheduled when they submit availability — overrides priority and fairness rules.
                          {u.instructorType === 'Host' && ' Hosts also auto-promote to Instructor on shortage days (Elementary required).'}
                        </p>
                      </div>
                      <label className="relative inline-flex cursor-pointer items-center shrink-0 mt-0.5">
                        <input
                          type="checkbox"
                          checked={u.guaranteed === true}
                          onChange={e => handleUpdateUserField(u.uid, 'guaranteed', e.target.checked)}
                          className="peer sr-only"
                        />
                        <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-600 peer-checked:after:translate-x-full peer-checked:after:border-white" />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Multi-Center Setup (Phase 1 groundwork) ─────────────────────── */}
          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Settings size={18} className="text-purple-600" />
              <h3 className="font-semibold text-gray-900">Multi-Center Setup</h3>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Adds a <code className="px-1 rounded bg-gray-100 text-gray-700">centerId</code> field to every existing user, shift, availability, time-off, chat, announcement, and notification doc — so the portal can later support multiple Mathnasium locations. <span className="font-semibold">Run this once after deploying the multi-center groundwork.</span> Safe to run multiple times.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleRunCenterMigration}
                disabled={migrationRunning}
                className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:opacity-50 transition-colors"
              >
                {migrationRunning ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    Running…
                  </>
                ) : 'Run multi-center migration'}
              </button>
              {migrationResult?.ok && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 font-semibold text-emerald-700">
                    ✓ Migration complete
                  </span>
                  {Object.entries(migrationResult.stats).map(([k, v]) => (
                    <span key={k} className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">
                      {k}: <strong>{v}</strong>
                    </span>
                  ))}
                </div>
              )}
              {migrationResult?.ok === false && (
                <span className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
                  Migration failed: {migrationResult.error}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-3 italic">
              The numbers show how many docs were updated per collection. Already-migrated docs are skipped.
            </p>
          </div>
        </div>
      )}

      {/* ── AUTO-SCHEDULER ──────────────────────────────────────────────────── */}
      {tab === 'scheduler' && (
        <div className="space-y-6">
          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Wand2 size={18} className="text-purple-600" />
              <h3 className="font-semibold text-gray-900">Generate Schedule</h3>
            </div>
            <p className="text-sm text-gray-500 mb-5">
              Reads instructor availability from Firestore and builds an optimized schedule respecting priorities, max days/week, and fair distribution.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Month</label>
                <select value={schedMonth} onChange={e => setSchedMonth(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none">
                  {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Year</label>
                <input type="number" value={schedYear} min={2025} max={2030}
                  onChange={e => setSchedYear(Number(e.target.value))}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Min staff/day</label>
                <input type="number" value={schedConfig.minPerDay} min={1} max={20}
                  onChange={e => setSchedConfig(c => ({ ...c, minPerDay: Number(e.target.value) }))}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Max staff/day</label>
                <input type="number" value={schedConfig.maxPerDay} min={1} max={30}
                  onChange={e => setSchedConfig(c => ({ ...c, maxPerDay: Number(e.target.value) }))}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 mb-5">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Max days/instructor/week</label>
                <input type="number" value={schedConfig.maxDaysPerWeek} min={1} max={6}
                  onChange={e => setSchedConfig(c => ({ ...c, maxDaysPerWeek: Number(e.target.value) }))}
                  className="w-24 rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer mt-4">
                <input type="checkbox" checked={schedConfig.fairDistribution}
                  onChange={e => setSchedConfig(c => ({ ...c, fairDistribution: e.target.checked }))}
                  className="accent-red-600 h-4 w-4" />
                Fair distribution (spread shifts evenly)
              </label>
            </div>
            <div className="flex gap-3">
              <button onClick={handleGenerate} disabled={generating || approvedUsers.length === 0}
                className="flex items-center gap-2 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-purple-700 disabled:opacity-50 transition-colors">
                <Wand2 size={16} />
                {generating ? 'Generating…' : 'Generate Draft Schedule'}
              </button>
              {draftSchedule && (
                <button onClick={() => setDraftSchedule(null)}
                  className="flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  <RotateCcw size={15} /> Clear Draft
                </button>
              )}
            </div>
            {approvedUsers.length === 0 && (
              <p className="mt-2 text-xs text-amber-600">⚠ No approved instructors found. Approve users first.</p>
            )}
            {schedError && (
              <div className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 border border-red-200">{schedError}</div>
            )}
          </div>

          {draftSchedule && (
            <>
              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                  <div>
                    <h3 className="font-bold text-gray-900 text-lg">Draft: {draftSchedule.month} {draftSchedule.year}</h3>
                    <p className="text-sm text-gray-500">Review and edit before posting. Instructors won't see this until you post.</p>
                  </div>
                  <button onClick={handlePostSchedule} disabled={posting}
                    className="flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-bold text-white shadow-md hover:bg-green-700 disabled:opacity-50 transition-colors">
                    <Send size={16} />
                    {posting ? 'Posting…' : 'Post Schedule'}
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-purple-700">{draftSchedule.days.length}</p>
                    <p className="text-xs text-gray-500">Working Days</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-blue-700">
                      {draftSchedule.days.reduce((s,d) => s + d.assignedEmployees.length, 0)}
                    </p>
                    <p className="text-xs text-gray-500">Total Shifts</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-amber-600">{draftSchedule.warnings.length}</p>
                    <p className="text-xs text-gray-500">Warnings</p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3 text-center">
                    <p className="text-2xl font-bold text-orange-600">
                      {draftSchedule.days.reduce((s,d) => s + (d.openSlotsNeeded || 0), 0)}
                    </p>
                    <p className="text-xs text-gray-500">Open Shifts Needed</p>
                  </div>
                </div>
              </div>

              {draftSchedule.warnings.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle size={18} className="text-amber-600" />
                    <h4 className="font-semibold text-amber-800">Scheduling Warnings</h4>
                  </div>
                  <ul className="space-y-1">
                    {draftSchedule.warnings.map((w,i) => <li key={i} className="text-sm text-amber-700">• {w}</li>)}
                  </ul>
                </div>
              )}

              <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
                <div className="border-b bg-gray-50 px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h4 className="font-semibold text-gray-900">Day-by-Day Schedule</h4>
                    <p className="text-xs text-gray-500">Edit any day's roster, times, or sub-roles — changes save to the draft, not posted yet.</p>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={expandAllDays}
                      className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                    >
                      Expand all
                    </button>
                    <button
                      onClick={collapseAllDays}
                      className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-gray-300 hover:bg-gray-50 transition-colors"
                    >
                      Collapse all
                    </button>
                  </div>
                </div>
                <div className="divide-y divide-gray-100">
                  {draftSchedule.days.map((day, i) => {
                    const isLow = day.countingStaffCount < schedConfig.minPerDay;
                    const isEditing = editingDay?.index === i;

                    // Sort assigned names by role priority: Instructor/Lead first,
                    // then Host, then Online, then everything else.
                    const rolePriority = (r) => {
                      if (r === 'Instructor' || r === 'Lead') return 0;
                      if (r === 'Host')                       return 1;
                      if (r === 'Online Instructor')          return 2;
                      return 3;
                    };
                    const sortedNames = [...day.assignedEmployees].sort((a, b) => {
                      const ra = day.roles?.[a] || 'Instructor';
                      const rb = day.roles?.[b] || 'Instructor';
                      const dp = rolePriority(ra) - rolePriority(rb);
                      if (dp !== 0) return dp;
                      return a.localeCompare(b);
                    });

                    return (
                      <div
                        key={day.date}
                        className={`group relative px-5 py-4 transition-colors ${isLow ? 'bg-red-50/50' : 'hover:bg-gray-50/40'}`}
                      >
                        {/* Left edge accent for low-staff days */}
                        {isLow && <span className="absolute left-0 top-0 bottom-0 w-1 bg-red-500" />}

                        {/* Day header */}
                        <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-sm font-bold ${isLow ? 'text-red-800' : 'text-gray-900'}`}>
                              {day.dayOfWeek}, {draftSchedule.month} {day.dayNumber}
                            </span>
                            {isLow ? (
                              <span className="flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
                                <AlertTriangle size={11} />
                                Low staff — need {schedConfig.minPerDay - day.countingStaffCount} more
                              </span>
                            ) : (
                              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                Staffed
                              </span>
                            )}
                            <span className="text-xs text-gray-500">
                              {day.countingStaffCount} instructor{day.countingStaffCount === 1 ? '' : 's'} · {day.assignedEmployees.length} total
                            </span>
                          </div>
                          {!isEditing && (
                            <button onClick={() => handleEditDay(i)}
                              className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-300 hover:text-gray-900 hover:bg-gray-50 transition-colors">
                              <Edit3 size={12} /> Edit
                            </button>
                          )}
                        </div>

                        {isEditing ? (
                          <div className="rounded-xl border-2 border-blue-200 bg-blue-50/40 p-4">
                            <div className="flex items-center justify-between mb-3">
                              <p className="text-xs font-bold text-blue-700 uppercase tracking-widest">Editing roster</p>
                              <p className="text-xs text-gray-500 italic">Tweak times and sub-roles below — saves to draft only.</p>
                            </div>

                            {/* Editable rows: avatar + name + start/end + sub-role */}
                            <div className="grid gap-2 mb-4 lg:grid-cols-2">
                              {editingDay.assignedEmployees.map(name => {
                                const sub = subRoleStyleFor(editingDay.subRoles?.[name]);
                                const [startTime, endTime] = parseShiftTimeStr(editingDay.shiftTimes?.[name]);
                                const initials = (name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
                                return (
                                  <div key={name} className="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 shadow-sm">
                                    <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${sub?.blockBg || 'bg-gray-400'}`}>
                                      {initials || '?'}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between mb-1.5">
                                        <p className="text-xs font-semibold text-gray-900 truncate pr-1">{name}</p>
                                        <button
                                          onClick={() => handleRemoveFromDay(name)}
                                          className="shrink-0 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 w-5 h-5 flex items-center justify-center transition-colors"
                                          title={`Remove ${name}`}
                                        >
                                          <X size={12} />
                                        </button>
                                      </div>
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="time"
                                          value={startTime}
                                          onChange={e => handleUpdateDayShiftTime(name, 'start', e.target.value)}
                                          className="w-[88px] rounded border border-gray-200 px-1.5 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                                        />
                                        <span className="text-gray-400 text-xs">–</span>
                                        <input
                                          type="time"
                                          value={endTime}
                                          onChange={e => handleUpdateDayShiftTime(name, 'end', e.target.value)}
                                          className="w-[88px] rounded border border-gray-200 px-1.5 py-0.5 text-xs focus:border-blue-400 focus:outline-none"
                                        />
                                        <select
                                          value={editingDay.subRoles?.[name] || 'Elementary'}
                                          onChange={e => handleUpdateDaySubRole(name, e.target.value)}
                                          className="ml-auto rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs font-medium focus:border-blue-400 focus:outline-none"
                                          title="Teaching level"
                                        >
                                          {SUB_ROLES.map(sr => (
                                            <option key={sr} value={sr}>{sr}</option>
                                          ))}
                                        </select>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                              {editingDay.assignedEmployees.length === 0 && (
                                <p className="col-span-full text-sm text-gray-400 italic px-1">
                                  No one assigned — add from below
                                </p>
                              )}
                            </div>

                            <p className="mb-2 text-xs font-semibold text-gray-600">Add from approved staff:</p>
                            <div className="flex flex-wrap gap-1.5 mb-4">
                              {approvedUsers.filter(u => !editingDay.assignedEmployees.includes(u.displayName)).map(u => {
                                const subs = u.subRoles || [];
                                // Online is its own platform — check it first.
                                const primarySub = subs.includes('Online')
                                  ? 'Online'
                                  : subs.includes('Highschool') ? 'Highschool' : subs.length > 0 ? 'Elementary' : null;
                                const sub = subRoleStyleFor(primarySub);
                                return (
                                  <button key={u.uid} onClick={() => handleAddToDay(u.displayName)}
                                    className="flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-600 hover:border-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors"
                                  >
                                    <span className={`w-1.5 h-1.5 rounded-full ${sub ? sub.dot : 'bg-gray-300'}`} />
                                    + {u.displayName}
                                  </button>
                                );
                              })}
                              {approvedUsers.filter(u => !editingDay.assignedEmployees.includes(u.displayName)).length === 0 && (
                                <span className="text-xs text-gray-400 italic">All approved staff are already assigned.</span>
                              )}
                            </div>

                            <div className="flex gap-2">
                              <button onClick={handleSaveEditDay} className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-green-700 transition-colors">
                                <Check size={12} /> Save day
                              </button>
                              <button onClick={() => setEditingDay(null)} className="rounded-lg border border-gray-200 px-4 py-1.5 text-xs font-medium text-gray-600 hover:bg-white transition-colors">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {day.assignedEmployees.length === 0 ? (
                              <div className="rounded-xl border-2 border-dashed border-gray-200 bg-gray-50/50 px-4 py-6 text-center">
                                <p className="text-sm text-gray-400 italic">No staff assigned for this day</p>
                              </div>
                            ) : (
                              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {sortedNames.map(name => {
                                  const role = day.roles?.[name] || 'Instructor';
                                  const subRole = day.subRoles?.[name];
                                  const time = day.shiftTimes?.[name];
                                  const sub = subRoleStyleFor(subRole);
                                  const initials = (name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
                                  const isHostRow   = role === 'Host';
                                  const isOnlineRow = role === 'Online Instructor';
                                  return (
                                    <div
                                      key={name}
                                      className="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 hover:border-gray-300 hover:shadow-sm transition-all"
                                    >
                                      <div
                                        className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${sub ? sub.blockBg : 'bg-gray-400'}`}
                                        title={subRole || 'No sub-role'}
                                      >
                                        {initials || '?'}
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <p className="text-xs font-semibold text-gray-900 truncate">{name}</p>
                                        <p className="text-xs text-gray-500 truncate">
                                          {time || '—'}
                                        </p>
                                      </div>
                                      <div className="shrink-0 flex flex-col items-end gap-0.5">
                                        {isHostRow && (
                                          <span className="rounded-full bg-amber-100 text-amber-800 px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide">Host</span>
                                        )}
                                        {isOnlineRow && (
                                          <span className="rounded-full bg-indigo-100 text-indigo-800 px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide">Online</span>
                                        )}
                                        {!isHostRow && !isOnlineRow && role !== 'Instructor' && (
                                          <span className="rounded-full bg-gray-100 text-gray-700 px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide">{role}</span>
                                        )}
                                        {sub && (
                                          <span className={`rounded-full px-1.5 py-0 text-[10px] font-bold uppercase tracking-wide ${sub.pillBg} ${sub.pillText}`} title={sub.label}>
                                            {sub.label[0]}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}

                        {/* Coverage toggle + grid — works in both view and edit modes.
                            Lets the admin see staffing density per half-hour slot
                            so they can decide student capacity. */}
                        {day.assignedEmployees.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-gray-100">
                            <button
                              onClick={() => toggleDayExpanded(i)}
                              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
                            >
                              {expandedDays.has(i)
                                ? <ChevronDown size={14} />
                                : <ChevronRight size={14} />}
                              <BarChart3 size={12} />
                              {expandedDays.has(i) ? 'Hide coverage' : 'Show coverage'}
                              <span className="ml-1 text-gray-400 font-normal">— half-hour density</span>
                            </button>
                            {expandedDays.has(i) && (
                              <div className="mt-3">
                                {/* In edit mode, render against editingDay so the
                                    admin sees coverage update live as they tweak times. */}
                                <CoverageGrid day={isEditing ? editingDay : day} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border bg-white p-5 shadow-sm">
                <h4 className="font-semibold text-gray-900 mb-3">Shift Distribution</h4>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.entries(draftSchedule.employeeSummary).sort(([,a],[,b]) => b-a).map(([name, count]) => (
                    <div key={name} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                      <span className="text-sm text-gray-800">{name}</span>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${count > 0 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-400'}`}>{count} shifts</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pb-4">
                <button onClick={handlePostSchedule} disabled={posting}
                  className="flex items-center gap-2 rounded-lg bg-green-600 px-6 py-3 text-sm font-bold text-white shadow-lg hover:bg-green-700 disabled:opacity-50">
                  <CheckCircle size={18} />
                  {posting ? 'Posting…' : `Post Schedule for ${draftSchedule.month} ${draftSchedule.year}`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PAYROLL ─────────────────────────────────────────────────────── */}
      {tab === 'payroll' && (
        <div className="space-y-6">

          {/* Pay period selector */}
          <div className="rounded-xl border bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <CalendarRange size={18} className="text-green-600" />
              <h3 className="font-semibold text-gray-900">Select Pay Period</h3>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Start Date</label>
                <input type="date" value={payStart} onChange={e => setPayStart(e.target.value)}
                  className="rounded-lg border px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-500/20" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">End Date</label>
                <input type="date" value={payEnd} onChange={e => setPayEnd(e.target.value)}
                  className="rounded-lg border px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-2 focus:ring-green-500/20" />
              </div>
              {/* Quick select buttons */}
              <div className="flex flex-wrap gap-2">
                {[
                  { label: '11th – 25th', fn: () => {
                    const y = today.getMonth() === 0 && today.getDate() < 11 ? today.getFullYear() - 1 : today.getFullYear();
                    const m = String(today.getMonth() + 1).padStart(2,'0');
                    setPayStart(`${y}-${m}-11`); setPayEnd(`${y}-${m}-25`);
                  }},
                  { label: '26th – 10th', fn: () => {
                    const start = new Date(today.getFullYear(), today.getMonth(), 26);
                    const end   = new Date(today.getFullYear(), today.getMonth() + 1, 10);
                    setPayStart(format(start, 'yyyy-MM-dd')); setPayEnd(format(end, 'yyyy-MM-dd'));
                  }},
                ].map(q => (
                  <button key={q.label} onClick={q.fn}
                    className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs font-medium text-green-700 hover:bg-green-100 transition-colors">
                    {q.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Summary bar */}
            {payrollSummary.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 px-4 py-3">
                <div className="flex flex-wrap gap-6 text-sm">
                  <div>
                    <span className="text-gray-500">Pay period: </span>
                    <span className="font-semibold text-gray-800">{payPeriodLabel}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Staff: </span>
                    <span className="font-semibold text-gray-800">{payrollSummary.length}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Total shifts: </span>
                    <span className="font-semibold text-gray-800">{payrollSummary.reduce((s,p) => s + p.shifts.length, 0)}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Total hours: </span>
                    <span className="font-bold text-green-700">{Math.round(totalPayrollHours * 100) / 100}h</span>
                  </div>
                </div>
                <button onClick={handleExportPayroll}
                  className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 transition-colors">
                  <Download size={15} /> Export CSV
                </button>
              </div>
            )}
          </div>

          {/* Radius Import */}
          {payrollSummary.length > 0 && (
            <div className="rounded-xl border bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <h3 className="font-semibold text-gray-900">Radius Timesheet Import</h3>
                {radiusData.length > 0 && (
                  <span className="ml-2 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                    {radiusData.length} entries loaded
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500 mb-4">
                Upload the Radius Excel export for this pay period. The portal will compare actual sign-in/out times against scheduled shifts and flag any discrepancies.
              </p>
              <label className="flex items-center gap-3 cursor-pointer w-fit">
                <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-blue-300 bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors">
                  <Download size={15} className="rotate-180" />
                  {radiusFileName ? `Loaded: ${radiusFileName}` : 'Upload Radius Export (.xlsx)'}
                </div>
                <input type="file" accept=".xlsx" onChange={handleRadiusImport} className="hidden" />
              </label>
              {radiusError && <p className="mt-2 text-sm text-red-600">{radiusError}</p>}
              {radiusData.length > 0 && (
                <button onClick={() => { setRadiusData([]); setRadiusFileName(''); }}
                  className="mt-2 text-xs text-gray-400 hover:text-red-500">
                  Clear Radius data
                </button>
              )}
            </div>
          )}

          {/* Currently-excluded salary staff. Click × on any chip to add them
              back to payroll for this period. */}
          {Array.isArray(centerConfig?.salaryStaff) && centerConfig.salaryStaff.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                <UserX size={13} /> Excluded from hourly payroll
                <span className="text-[10px] font-normal text-amber-700">(salaried — paid outside this sheet)</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {centerConfig.salaryStaff.map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => handleIncludeInPayroll(n)}
                    title={`Include ${n} on payroll again`}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                  >
                    {n}
                    <X size={11} className="text-amber-500" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Per-person breakdown — with Radius comparison if loaded */}
          {payrollSummary.length === 0 ? (
            <div className="rounded-xl border bg-white p-10 text-center shadow-sm">
              <DollarSign size={36} className="mx-auto mb-3 text-gray-300" />
              <p className="text-gray-500 font-medium">No shifts found for this pay period.</p>
              <p className="text-sm text-gray-400 mt-1">Make sure shifts are posted and the date range is correct.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {(comparisonSummary || payrollSummary).map(person => {
                const bg = assignmentColorHex(assignmentFor(person), centerConfig);
                const hasRadius = !!comparisonSummary;
                const isDiscrepant = hasRadius && person.hasDiscrepancy;
                const shiftRows = hasRadius ? person.shiftComparisons : person.shifts;
                return (
                  <div key={person.name} className={`rounded-xl border shadow-sm overflow-hidden bg-white ${isDiscrepant ? 'border-red-300' : ''}`}>
                    {/* Person header */}
                    <div className={`flex items-center justify-between px-5 py-3 border-b ${isDiscrepant ? 'bg-red-50' : 'bg-gray-50'}`}>
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                          style={{ backgroundColor: bg, color: contrastText(bg) }}>
                          {person.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2)}
                        </div>
                        <div>
                          <span className="font-semibold text-gray-900">{person.name}</span>
                          <span className="ml-2 text-xs text-gray-500">{person.role}</span>
                          {isDiscrepant && (
                            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">⚠ Discrepancy</span>
                          )}
                          {/* Quick toggle: mark this person as salaried so they
                              drop off the hourly payroll on the next render. */}
                          <button
                            type="button"
                            onClick={() => handleExcludeFromPayroll(person.name)}
                            title="Mark as salary staff and exclude from this payroll"
                            className="ml-2 inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700"
                          >
                            <UserX size={10} /> Exclude
                          </button>
                        </div>
                      </div>
                      <div className="text-right">
                        {hasRadius ? (
                          <>
                            <div className="text-xs text-gray-500">
                              Scheduled: <span className="font-semibold text-gray-800">{person.scheduledHours.toFixed(2)}h</span>
                              <span className="mx-1.5 text-gray-300">·</span>
                              Actual: <span className="font-semibold text-blue-700">{person.actualHours.toFixed(2)}h</span>
                            </div>
                            <div className={`text-sm font-bold ${isDiscrepant ? 'text-red-600' : 'text-green-600'}`}>
                              {person.diff > 0 ? '+' : ''}{person.diff.toFixed(2)}h {isDiscrepant ? '← investigate' : '✓ match'}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-sm font-bold text-green-700">{person.totalHours.toFixed(2)}h total</div>
                            <div className="text-xs text-gray-400">{person.shifts.length} shift{person.shifts.length !== 1 ? 's' : ''}</div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Shift rows */}
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-white">
                          <th className="text-left px-5 py-2 text-xs font-medium text-gray-500 w-40">Date</th>
                          <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">Scheduled</th>
                          {hasRadius && <th className="text-left px-4 py-2 text-xs font-medium text-blue-500">Radius Actual</th>}
                          <th className="text-right px-5 py-2 text-xs font-medium text-gray-500">{hasRadius ? 'Sched. h' : 'Hours'}</th>
                          {hasRadius && <th className="text-right px-5 py-2 text-xs font-medium text-blue-500">Actual h</th>}
                          {hasRadius && <th className="text-right px-5 py-2 text-xs font-medium text-gray-500">Diff</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {shiftRows.map((s, i) => {
                          const fmtT = (t) => {
                            if (!t) return '–';
                            const [hStr, mStr] = t.split(':');
                            let h = parseInt(hStr, 10);
                            const m = parseInt(mStr, 10);
                            const ampm = h >= 12 ? 'PM' : 'AM';
                            if (h > 12) h -= 12;
                            if (h === 0) h = 12;
                            return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
                          };
                          const dateLabel = new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', {
                            weekday: 'short', month: 'short', day: 'numeric',
                          });
                          const rowFlag = hasRadius && (s.shiftDiscrepancy || s.missingFromRadius);
                          return (
                            <tr key={i} className={`transition-colors ${rowFlag ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'}`}>
                              <td className="px-5 py-2.5 text-gray-800 font-medium">{dateLabel}</td>
                              <td className="px-4 py-2.5 text-gray-600 text-xs">{fmtT(s.startTime)} – {fmtT(s.endTime)}</td>
                              {hasRadius && (
                                <td className="px-4 py-2.5 text-xs">
                                  {s.missingFromRadius
                                    ? <span className="text-red-500 font-medium">Not in Radius</span>
                                    : <div className="flex items-center gap-1">
                                        <input type="time" value={normalizeTimeToHHMM(s.actual.timeIn)}
                                          onChange={e => updateRadiusEntry(s.actual._idx, 'timeIn', e.target.value)}
                                          className="rounded border border-blue-200 px-1.5 py-0.5 text-xs text-blue-700 w-[90px] focus:border-blue-500 focus:outline-none" />
                                        <span className="text-gray-400">–</span>
                                        <input type="time" value={normalizeTimeToHHMM(s.actual.timeOut)}
                                          onChange={e => updateRadiusEntry(s.actual._idx, 'timeOut', e.target.value)}
                                          className="rounded border border-blue-200 px-1.5 py-0.5 text-xs text-blue-700 w-[90px] focus:border-blue-500 focus:outline-none" />
                                        <button onClick={() => deleteRadiusEntry(s.actual._idx)}
                                          className="ml-1 text-gray-300 hover:text-red-500 transition-colors" title="Remove entry">
                                          <Trash2 size={12} />
                                        </button>
                                      </div>}
                                </td>
                              )}
                              <td className="px-5 py-2.5 text-right font-semibold text-gray-800">{s.hours.toFixed(2)}h</td>
                              {hasRadius && (
                                <td className="px-5 py-2.5 text-right font-semibold text-blue-700">
                                  {s.missingFromRadius ? '–' : `${s.actual.actualHours.toFixed(2)}h`}
                                </td>
                              )}
                              {hasRadius && (
                                <td className={`px-5 py-2.5 text-right font-bold text-xs ${s.missingFromRadius ? 'text-red-500' : s.shiftDiscrepancy ? 'text-red-600' : 'text-green-600'}`}>
                                  {s.missingFromRadius ? '⚠ missing' : s.shiftDiff > 0 ? `+${s.shiftDiff.toFixed(2)}h` : `${s.shiftDiff.toFixed(2)}h`}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                        {hasRadius && person.unmatchedRadius?.map((r, i) => (
                          <tr key={`ur-${i}`} className="bg-amber-50 hover:bg-amber-100 transition-colors">
                            <td className="px-5 py-2.5">
                              <input type="date" value={r.date}
                                onChange={e => updateRadiusEntry(r._idx, 'date', e.target.value)}
                                className="rounded border border-amber-200 px-1.5 py-0.5 text-xs text-gray-800 font-medium focus:border-amber-500 focus:outline-none" />
                            </td>
                            <td className="px-4 py-2.5 text-xs text-amber-600 font-medium">Not scheduled</td>
                            <td className="px-4 py-2.5 text-xs">
                              <div className="flex items-center gap-1">
                                <input type="time" value={normalizeTimeToHHMM(r.timeIn)}
                                  onChange={e => updateRadiusEntry(r._idx, 'timeIn', e.target.value)}
                                  className="rounded border border-blue-200 px-1.5 py-0.5 text-xs text-blue-700 w-[90px] focus:border-blue-500 focus:outline-none" />
                                <span className="text-gray-400">–</span>
                                <input type="time" value={normalizeTimeToHHMM(r.timeOut)}
                                  onChange={e => updateRadiusEntry(r._idx, 'timeOut', e.target.value)}
                                  className="rounded border border-blue-200 px-1.5 py-0.5 text-xs text-blue-700 w-[90px] focus:border-blue-500 focus:outline-none" />
                                <button onClick={() => deleteRadiusEntry(r._idx)}
                                  className="ml-1 text-gray-300 hover:text-red-500 transition-colors" title="Remove entry">
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </td>
                            <td className="px-5 py-2.5 text-right text-gray-400">–</td>
                            <td className="px-5 py-2.5 text-right font-semibold text-blue-700">{r.actualHours.toFixed(2)}h</td>
                            <td className="px-5 py-2.5 text-right text-xs font-bold text-amber-600">⚠ unscheduled</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className={`border-t ${isDiscrepant ? 'bg-red-50' : 'bg-green-50'}`}>
                          <td colSpan={hasRadius ? 3 : 3} className={`px-5 py-2 text-sm font-semibold ${isDiscrepant ? 'text-red-800' : 'text-green-800'}`}>Total</td>
                          <td className={`px-5 py-2 text-right text-sm font-bold ${isDiscrepant ? 'text-red-800' : 'text-green-800'}`}>{person.totalHours.toFixed(2)}h</td>
                          {hasRadius && <td className="px-5 py-2 text-right text-sm font-bold text-blue-700">{person.actualHours.toFixed(2)}h</td>}
                          {hasRadius && (
                            <td className={`px-5 py-2 text-right text-sm font-bold ${isDiscrepant ? 'text-red-600' : 'text-green-600'}`}>
                              {person.diff > 0 ? '+' : ''}{person.diff.toFixed(2)}h
                            </td>
                          )}
                        </tr>
                      </tfoot>
                    </table>
                    {hasRadius && (
                      <div className="px-5 py-2.5 border-t bg-gray-50/50">
                        <button onClick={() => addRadiusEntry(person.name)}
                          className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium transition-colors">
                          <Plus size={14} /> Add Radius Entry
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── INSTRUCTOR REQUESTS ────────────────────────────────────────── */}
      {tab === 'requests' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">Instructor Requests</h3>
              <p className="text-sm text-gray-500">Time off requests from your team</p>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="rounded-full bg-yellow-100 px-2.5 py-1 font-medium text-yellow-700">
                {timeOffRequests.filter(r => r.status === 'pending').length} pending
              </span>
              <span className="rounded-full bg-green-100 px-2.5 py-1 font-medium text-green-700">
                {timeOffRequests.filter(r => r.status === 'approved').length} approved
              </span>
            </div>
          </div>

          {timeOffRequests.length === 0 ? (
            <div className="rounded-xl border bg-white p-10 text-center shadow-sm">
              <CalendarRange size={36} className="mx-auto mb-3 text-gray-300" />
              <p className="text-gray-500 font-medium">No requests yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {timeOffRequests.map(req => {
                if (!req.startDate || !req.endDate) return null;
                const startLabel = new Date(req.startDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                const endLabel   = new Date(req.endDate   + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                const sameDay    = req.startDate === req.endDate;
                const statusColors = {
                  pending:  'bg-yellow-100 text-yellow-700',
                  approved: 'bg-green-100 text-green-700',
                  denied:   'bg-red-100 text-red-600',
                };
                return (
                  <div key={req.id} className={`rounded-xl border bg-white p-5 shadow-sm ${req.status === 'pending' ? 'border-yellow-200' : ''}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center text-xs font-bold text-white">
                            {req.userName?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2)}
                          </div>
                          <span className="font-semibold text-gray-900">{req.userName}</span>
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusColors[req.status] || statusColors.pending}`}>
                            {req.status?.charAt(0).toUpperCase() + req.status?.slice(1)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-sm text-gray-600 mb-2">
                          <CalendarRange size={14} className="text-gray-400" />
                          <span className="font-medium">{sameDay ? startLabel : `${startLabel} – ${endLabel}`}</span>
                        </div>
                        <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                          <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Reason: </span>
                          {req.reason}
                        </div>
                        {req.createdAt?.seconds && (
                          <p className="mt-2 text-xs text-gray-400">
                            Submitted {new Date(req.createdAt.seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                        )}
                      </div>

                      {req.status === 'pending' && (
                        <div className="flex flex-col gap-2 shrink-0">
                          <button
                            onClick={async () => {
                              await updateDoc(doc(db, 'timeOffRequests', req.id), { status: 'approved' });
                            }}
                            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors">
                            <Check size={14} /> Approve
                          </button>
                          <button
                            onClick={async () => {
                              await updateDoc(doc(db, 'timeOffRequests', req.id), { status: 'denied' });
                            }}
                            className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors">
                            <X size={14} /> Deny
                          </button>
                        </div>
                      )}

                      {req.status !== 'pending' && (
                        <button
                          onClick={async () => {
                            if (confirm('Delete this request?')) await deleteDoc(doc(db, 'timeOffRequests', req.id));
                          }}
                          className="text-gray-300 hover:text-red-400 transition-colors shrink-0">
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── HOLIDAYS ───────────────────────────────────────────────────────── */}
      {tab === 'holidays' && (
        <HolidaysEditor
          activeCenterId={activeCenterId}
          centerConfig={centerConfig}
          activeCenterName={centerConfig?.name || activeCenterId}
        />
      )}

      {/* ── ANALYTICS ──────────────────────────────────────────────────────── */}
      {tab === 'analytics' && canSeeCenterSettings && (
        <AnalyticsTab
          shifts={shifts}
          users={users}
          centerConfig={centerConfig}
          activeCenterId={activeCenterId}
        />
      )}

      {/* ── CENTER SETTINGS ────────────────────────────────────────────────── */}
      {tab === 'settings' && (
        <CenterSettingsTab activeCenterId={activeCenterId} centerConfig={centerConfig} />
      )}

      {/* ── MODALS ──────────────────────────────────────────────────────────── */}
      {addShiftModal && (
        <AddShiftModal
          date={addShiftModal.date}
          user={addShiftModal.user}
          users={approvedUsers}
          availability={availability}
          onClose={() => setAddShiftModal(null)}
          onSave={handleAddShift}
        />
      )}

      {editShiftModal && (
        <EditShiftModal
          shift={editShiftModal}
          onClose={() => setEditShiftModal(null)}
          onSave={handleSaveEditShift}
          onDelete={handleDeleteEditShift}
        />
      )}

      {addOpenShiftModal && (
        <AddOpenShiftModal
          date={addOpenShiftModal.date}
          onClose={() => setAddOpenShiftModal(null)}
          onSave={handleAddOpenShift}
        />
      )}
    </div>
  );
}

// ─── Sub-component: Analytics tab ────────────────────────────────────────
// Owner-only dashboard. Pulls from the existing shifts + users + center
// config — no new data plumbing for Phase 1. Active student count is a
// manual entry on this page (Phase 2 will add automated enrollment import).

function AnalyticsTab({ shifts, users, centerConfig, activeCenterId }) {
  const now = new Date();
  const todayStr      = format(now, 'yyyy-MM-dd');
  const weekStartStr  = format(startOfWeek(now), 'yyyy-MM-dd');
  const weekEndStr    = format(addDays(startOfWeek(now), 6), 'yyyy-MM-dd');
  const monthStartStr = format(startOfMonth(now), 'yyyy-MM-dd');
  const monthEndStr   = format(endOfMonth(now), 'yyyy-MM-dd');
  const yearStartStr  = `${now.getFullYear()}-01-01`;
  const yearEndStr    = `${now.getFullYear()}-12-31`;

  // Only posted (non-draft) shifts count toward analytics.
  const posted = shifts.filter(s => s.status !== 'draft');
  const sumHrs = (rows) => rows.reduce((sum, s) => sum + shiftHours(s), 0);
  const round1 = (h) => Math.round((isNaN(h) ? 0 : h) * 10) / 10;

  const hoursToday  = sumHrs(posted.filter(s => s.date === todayStr));
  const hoursWeek   = sumHrs(posted.filter(s => s.date >= weekStartStr && s.date <= weekEndStr));
  const monthShifts = posted.filter(s => s.date >= monthStartStr && s.date <= monthEndStr);
  const hoursMonth  = sumHrs(monthShifts);
  const hoursYear   = sumHrs(posted.filter(s => s.date >= yearStartStr && s.date <= yearEndStr));

  // Active employees: approved staff at this centre, excluding super-admins.
  const activeEmployees = users.filter(u => u.approved && u.role !== 'super_admin').length;

  // Avg hours per instructor working this month.
  const monthInstructors = new Set(monthShifts.map(s => s.userName).filter(Boolean));
  const avgPerInstructor = monthInstructors.size > 0 ? hoursMonth / monthInstructors.size : 0;

  // Hours by assignment (this month) — drives the horizontal-bar breakdown.
  const byAssignment = {};
  for (const s of monthShifts) {
    const a = assignmentFor(s);
    byAssignment[a] = (byAssignment[a] || 0) + shiftHours(s);
  }
  const assignmentRows = SHIFT_ASSIGNMENTS
    .map(a => ({ name: a, hours: byAssignment[a] || 0 }))
    .filter(r => r.hours > 0)
    .sort((a, b) => b.hours - a.hours);
  const maxAssign = Math.max(1, ...assignmentRows.map(r => r.hours));

  // Last 30 days trend.
  const last30 = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = format(d, 'yyyy-MM-dd');
    last30.push({ date: ds, hours: sumHrs(posted.filter(s => s.date === ds)) });
  }
  const max30 = Math.max(1, ...last30.map(d => d.hours));

  // Top instructors leaderboard (this month).
  const byInstructor = {};
  for (const s of monthShifts) {
    const key = s.userName || s.userId || '—';
    if (!byInstructor[key]) byInstructor[key] = { name: key, hours: 0, shifts: 0 };
    byInstructor[key].hours  += shiftHours(s);
    byInstructor[key].shifts += 1;
  }
  const leaderboard = Object.values(byInstructor)
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 12);
  const maxLeaderHrs = Math.max(1, ...leaderboard.map(p => p.hours));

  // ─── Coverage by day of week (rolling 8-week look-back) ────────────────
  // For each operating day, count distinct instructors scheduled that date,
  // then average across the days observed. Compares to defaultMinPerDay so
  // owners can see at a glance which weekdays are routinely under-staffed.
  const COVERAGE_WEEKS = 8;
  const coverageLookbackStart = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() - COVERAGE_WEEKS * 7);
    return format(d, 'yyyy-MM-dd');
  })();
  // Distinct instructor count per date in the look-back window.
  const dateInstructors = {};
  for (const s of posted) {
    if (s.date < coverageLookbackStart || s.date > todayStr) continue;
    if (!dateInstructors[s.date]) dateInstructors[s.date] = new Set();
    if (s.userName) dateInstructors[s.date].add(s.userName);
  }
  // Bucket those counts by weekday name, skipping closed days & holidays.
  const byDow = {}; // 'Monday' -> [4, 5, 3, ...]
  for (const [date, names] of Object.entries(dateInstructors)) {
    const d = new Date(date + 'T12:00:00');
    if (!isOperatingDay(d, centerConfig)) continue;
    if (holidayFor(d, centerConfig)) continue;
    const dayName = ALL_WEEKDAYS[d.getDay()];
    if (!byDow[dayName]) byDow[dayName] = [];
    byDow[dayName].push(names.size);
  }
  const coverageTarget = Number(centerConfig?.defaultMinPerDay) || 8;
  const operatingDaysList = (Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0)
    ? centerConfig.operatingDays
    : DEFAULT_CENTER_CONFIG.operatingDays;
  const coverageRows = operatingDaysList.map(day => {
    const counts = byDow[day] || [];
    const samples = counts.length;
    const avg = samples > 0 ? counts.reduce((a, b) => a + b, 0) / samples : 0;
    const worst = samples > 0 ? Math.min(...counts) : 0;
    const best  = samples > 0 ? Math.max(...counts) : 0;
    const shortDays = counts.filter(c => c < coverageTarget).length;
    return {
      day, avg, worst, best, samples, shortDays,
      pct: samples > 0 ? avg / coverageTarget : 0,
    };
  });
  const coverageHasData = coverageRows.some(r => r.samples > 0);
  // Normalise bar widths against whichever is bigger — the target line or
  // the best-observed-day — so the threshold marker always stays in view.
  const coverageScale = Math.max(coverageTarget, ...coverageRows.map(r => r.best || 0));

  // ─── Hour-by-hour coverage heatmap (same look-back window) ─────────────
  // Goal: a day×hour grid showing average distinct-instructor count covering
  // each hour. "Covering hour H" means the shift's startTime <= H:00 and
  // endTime is strictly after H:00 (so 15:00–19:00 covers 15, 16, 17, 18).
  const opHoursMap = centerConfig?.operatingHours || DEFAULT_CENTER_CONFIG.operatingHours;
  let earliestHour = 24;
  let latestHour = 0;
  for (const day of operatingDaysList) {
    const h = opHoursMap[day];
    if (!h) continue;
    earliestHour = Math.min(earliestHour, parseInt(h.start.split(':')[0], 10));
    latestHour   = Math.max(latestHour,   parseInt(h.end.split(':')[0], 10));
  }
  if (earliestHour >= latestHour) { earliestHour = 9; latestHour = 20; }
  const heatmapHours = [];
  for (let h = earliestHour; h < latestHour; h++) heatmapHours.push(h);

  const dateShiftMap = {};
  for (const s of posted) {
    if (s.date < coverageLookbackStart || s.date > todayStr) continue;
    if (!dateShiftMap[s.date]) dateShiftMap[s.date] = [];
    dateShiftMap[s.date].push(s);
  }
  const hourBuckets = {}; // dayName -> hour -> [counts per date]
  for (const [date, shiftsThisDate] of Object.entries(dateShiftMap)) {
    const d = new Date(date + 'T12:00:00');
    if (!isOperatingDay(d, centerConfig)) continue;
    if (holidayFor(d, centerConfig)) continue;
    const dayName = ALL_WEEKDAYS[d.getDay()];
    if (!hourBuckets[dayName]) hourBuckets[dayName] = {};
    for (const hour of heatmapHours) {
      const onAtHour = new Set();
      for (const s of shiftsThisDate) {
        const sh = parseInt(((s.startTime || '0').split(':')[0]), 10);
        const eh = parseInt(((s.endTime   || '0').split(':')[0]), 10);
        const em = parseInt(((s.endTime   || '0').split(':')[1]) || '0', 10);
        const startsByHour = sh <= hour;
        // Still on if their end-hour is strictly after this hour OR the end
        // is exactly this hour but with leftover minutes.
        const stillThere = eh > hour || (eh === hour && em > 0);
        if (startsByHour && stillThere && s.userName) onAtHour.add(s.userName);
      }
      if (!hourBuckets[dayName][hour]) hourBuckets[dayName][hour] = [];
      hourBuckets[dayName][hour].push(onAtHour.size);
    }
  }
  const heatmapCells = {};
  for (const day of operatingDaysList) {
    heatmapCells[day] = {};
    for (const h of heatmapHours) {
      const arr = hourBuckets[day]?.[h] || [];
      heatmapCells[day][h] = {
        avg: arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
        samples: arr.length,
      };
    }
  }
  const heatmapHasData = Object.keys(dateShiftMap).length > 0;

  // Lowest-coverage hour buckets (skip thinly-sampled and closed hours).
  const gapCandidates = [];
  for (const day of operatingDaysList) {
    const dayOpen = opHoursMap[day];
    if (!dayOpen) continue;
    const dayStartH = parseInt(dayOpen.start.split(':')[0], 10);
    const dayEndH   = parseInt(dayOpen.end.split(':')[0], 10);
    for (const h of heatmapHours) {
      if (h < dayStartH || h >= dayEndH) continue;
      const cell = heatmapCells[day][h];
      if (cell.samples < 2) continue;
      gapCandidates.push({ day, hour: h, avg: cell.avg, samples: cell.samples });
    }
  }
  gapCandidates.sort((a, b) => a.avg - b.avg);
  const coverageGaps = gapCandidates.slice(0, 5);

  // Manual student count + edit modal.
  const studentCount     = Number(centerConfig?.activeStudentCount ?? 0) || 0;
  const studentUpdatedAt = centerConfig?.studentCountUpdatedAt;
  const [editingStudents, setEditingStudents] = useState(false);
  const [studentInput,    setStudentInput]    = useState(studentCount);
  const [savingStudents,  setSavingStudents]  = useState(false);
  const [studentSaveError,setStudentSaveError]= useState('');

  // Re-sync input when the saved value changes (e.g. someone else updated it).
  useEffect(() => {
    if (!editingStudents) setStudentInput(studentCount);
  }, [studentCount, editingStudents]);

  const saveStudentCount = async () => {
    const n = Math.max(0, parseInt(studentInput, 10) || 0);
    setSavingStudents(true);
    setStudentSaveError('');
    try {
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { activeStudentCount: n, studentCountUpdatedAt: serverTimestamp() },
        { merge: true },
      );
      setEditingStudents(false);
    } catch (err) {
      setStudentSaveError(err?.message || 'Failed to save.');
    } finally {
      setSavingStudents(false);
    }
  };

  const studentsPerEmployee = activeEmployees > 0
    ? Math.round((studentCount / activeEmployees) * 10) / 10
    : 0;
  const updatedAtLabel = studentUpdatedAt?.seconds
    ? format(new Date(studentUpdatedAt.seconds * 1000), "MMM d, yyyy 'at' h:mm a")
    : null;

  // ─── Hiring forecast (Phase 2) ─────────────────────────────────────────
  // Roll up staff `careerPlan` fields into a projected headcount for each of
  // the next 4 months. "No" is treated as a definite departure on/by the
  // expected last month; "Unsure" is surfaced separately so the owner can
  // check in, but isn't deducted from the projection.
  const REASON_LABELS = {
    graduating: 'Graduating',
    moving:     'Moving away',
    career:     'Career change',
    school:     'School / workload',
    other:      'Other',
  };
  const formatPlanMonthLabel = (key) => {
    if (!key) return 'soon';
    const [y, m] = key.split('-');
    const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  const activeStaff = users.filter(u => u.approved && u.role !== 'super_admin');
  const currentHeadcount = activeStaff.length;

  // Build next 4 months as { key:'YYYY-MM', label:'Aug 2026' }.
  const nextMonths = [];
  for (let i = 1; i <= 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    nextMonths.push({
      key:   `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
    });
  }

  const leavers = activeStaff
    .filter(u => u.careerPlan?.stayingIn4Months === 'no' && u.careerPlan?.expectedDepartureMonth)
    .map(u => ({
      name:          u.displayName || '(no name)',
      role:          u.instructorType || 'Instructor',
      monthKey:      u.careerPlan.expectedDepartureMonth,
      reason:        u.careerPlan.reason,
      reasonNotes:   u.careerPlan.reasonNotes,
      aspirations:   u.careerPlan.aspirations,
    }))
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey));

  const unsureStaff = activeStaff
    .filter(u => u.careerPlan?.stayingIn4Months === 'unsure')
    .map(u => ({
      name:        u.displayName || '(no name)',
      role:        u.instructorType || 'Instructor',
      aspirations: u.careerPlan?.aspirations,
    }));

  // Staff who shared aspirations regardless of staying status — useful
  // signal for mentoring + retention conversations.
  const aspirationsList = activeStaff
    .filter(u => (u.careerPlan?.aspirations || '').trim().length > 0)
    .map(u => ({
      name:        u.displayName || '(no name)',
      aspirations: u.careerPlan.aspirations,
      staying:     u.careerPlan?.stayingIn4Months,
    }));

  const projection = nextMonths.map(m => {
    const cumDepart = leavers.filter(l => l.monthKey <= m.key).length;
    return { ...m, departures: cumDepart, projected: Math.max(0, currentHeadcount - cumDepart) };
  });
  const totalDepart   = leavers.filter(l => l.monthKey <= nextMonths[3].key).length;
  const projectedEnd  = Math.max(0, currentHeadcount - totalDepart);
  const showRiskBanner = totalDepart > 0;

  // Informational floor — roughly "you need this many staff total to fill a
  // typical week given your per-day minimum". Helps spot dangerous drops.
  const minStaffFloor = Math.max(4, (centerConfig?.defaultMinPerDay || 8) * 2);

  // Coverage of next 4 months — how many staff haven't filled out a plan.
  const noPlanCount = activeStaff.filter(u => !u.careerPlan || !u.careerPlan.updatedAt).length;

  // Job posting modal state.
  const [jobModalOpen, setJobModalOpen] = useState(false);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-gray-900">Centre Analytics</h2>
        <p className="text-sm text-gray-500">Headcount, hours, and what your team's been working on at a glance.</p>
      </div>

      {/* Metric cards — eight tiles in a 1/2/4-column grid. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-purple-100 text-purple-700"><Users size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Active Employees</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{activeEmployees}</p>
          <p className="mt-1 text-xs text-gray-400">approved staff at this centre</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="w-fit rounded-lg p-1.5 bg-emerald-100 text-emerald-700"><Activity size={16}/></div>
            <button
              type="button"
              onClick={() => { setStudentInput(studentCount); setEditingStudents(true); }}
              className="flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline"
            >
              <Edit3 size={11}/> Edit
            </button>
          </div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Active Students</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{studentCount}</p>
          <p className="mt-1 text-xs text-gray-400">
            {updatedAtLabel ? `Updated ${updatedAtLabel}` : 'Click Edit to set a starting value'}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-blue-100 text-blue-700"><Clock size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours Today</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursToday)}h</p>
          <p className="mt-1 text-xs text-gray-400">{format(now, 'EEE MMM d')}</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-indigo-100 text-indigo-700"><CalendarRange size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Week</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursWeek)}h</p>
          <p className="mt-1 text-xs text-gray-400">Sun–Sat scheduled</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-amber-100 text-amber-700"><CalendarRange size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Month</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursMonth)}h</p>
          <p className="mt-1 text-xs text-gray-400">{format(now, 'MMMM yyyy')}</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-rose-100 text-rose-700"><BarChart3 size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Year</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursYear)}h</p>
          <p className="mt-1 text-xs text-gray-400">{now.getFullYear()} so far</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-teal-100 text-teal-700"><TrendingUp size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Avg / Instructor</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(avgPerInstructor)}h</p>
          <p className="mt-1 text-xs text-gray-400">{monthInstructors.size} working this month</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-lime-100 text-lime-700"><UserCheck size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Students / Employee</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{studentsPerEmployee || '–'}</p>
          <p className="mt-1 text-xs text-gray-400">workload ratio</p>
        </div>
      </div>

      {/* Student count edit modal */}
      {editingStudents && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !savingStudents && setEditingStudents(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-gray-900 mb-1">Active Student Count</h3>
            <p className="text-xs text-gray-500 mb-3">Manually update the current enrollment for this centre.</p>
            <input
              type="number"
              min={0}
              value={studentInput}
              onChange={e => setStudentInput(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none mb-3"
              autoFocus
            />
            {studentSaveError && <p className="text-xs text-red-600 mb-2">{studentSaveError}</p>}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingStudents(false)}
                disabled={savingStudents}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveStudentCount}
                disabled={savingStudents}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {savingStudents ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Hours by assignment */}
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Hours by Assignment</h3>
          <p className="text-xs text-gray-500 mb-4">{format(now, 'MMMM yyyy')} · {round1(hoursMonth)}h scheduled</p>
          {assignmentRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No shifts scheduled this month yet.</p>
          ) : (
            <div className="space-y-2.5">
              {assignmentRows.map(row => (
                <div key={row.name}>
                  <div className="flex items-baseline justify-between text-xs mb-0.5">
                    <span className="font-medium text-gray-700">{row.name}</span>
                    <span className="text-gray-500">
                      {round1(row.hours)}h · {hoursMonth > 0 ? Math.round((row.hours / hoursMonth) * 100) : 0}%
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${(row.hours / maxAssign) * 100}%`,
                        backgroundColor: assignmentColorHex(row.name, centerConfig),
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Last-30-day trend */}
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Hours per Day</h3>
          <p className="text-xs text-gray-500 mb-4">Last 30 days · peak {round1(max30)}h</p>
          <div className="flex items-end gap-px h-32">
            {last30.map(d => {
              const isToday = d.date === todayStr;
              const h = d.hours > 0 ? Math.max(2, (d.hours / max30) * 100) : 2;
              const dateLabel = format(new Date(d.date + 'T12:00:00'), 'EEE MMM d');
              return (
                <div
                  key={d.date}
                  title={`${dateLabel}: ${round1(d.hours)}h`}
                  className={`flex-1 rounded-sm transition-colors ${
                    d.hours === 0
                      ? 'bg-gray-100'
                      : isToday
                        ? 'bg-red-500 hover:bg-red-600'
                        : 'bg-purple-500 hover:bg-purple-600'
                  }`}
                  style={{ height: `${h}%` }}
                />
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-gray-400 mt-1.5">
            <span>{format(new Date(last30[0].date + 'T12:00:00'), 'MMM d')}</span>
            <span>{format(now, 'MMM d')}</span>
          </div>
        </div>
      </div>

      {/* Leaderboard */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Top Instructors</h3>
        <p className="text-xs text-gray-500 mb-4">By hours scheduled · {format(now, 'MMMM yyyy')}</p>
        {leaderboard.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">No instructors have hours scheduled this month.</p>
        ) : (
          <div className="space-y-2">
            {leaderboard.map((p, i) => (
              <div key={p.name} className="flex items-center gap-3">
                <div className="w-5 text-right text-xs font-bold text-gray-400">{i + 1}</div>
                <div className="w-28 truncate text-sm font-medium text-gray-800 sm:w-40">{p.name}</div>
                <div className="h-2 flex-1 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-purple-500"
                    style={{ width: `${(p.hours / maxLeaderHrs) * 100}%` }}
                  />
                </div>
                <div className="w-20 text-right text-xs text-gray-500">
                  <span className="font-semibold text-gray-800">{round1(p.hours)}h</span>
                  <span className="ml-1.5 text-gray-400">· {p.shifts}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Coverage by Day of Week ─────────────────────────────────────── */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Average Coverage by Day</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Last {COVERAGE_WEEKS} weeks · target of {coverageTarget} instructors per day
              {' '}(set in Center Settings).
            </p>
          </div>
        </div>

        {!coverageHasData ? (
          <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-400">
            No posted schedules in the last {COVERAGE_WEEKS} weeks yet — once you start posting, this fills in.
          </p>
        ) : (
          <div className="space-y-2.5">
            {coverageRows.map(r => {
              const filledPct = coverageScale > 0 ? Math.min(100, (r.avg / coverageScale) * 100) : 0;
              const targetPct = coverageScale > 0 ? (coverageTarget / coverageScale) * 100 : 0;
              const status = r.samples === 0
                ? 'none'
                : r.avg < coverageTarget * 0.85
                  ? 'short'
                  : r.avg < coverageTarget
                    ? 'tight'
                    : 'ok';
              const barColor = status === 'short'
                ? 'bg-rose-500'
                : status === 'tight'
                  ? 'bg-amber-500'
                  : status === 'ok'
                    ? 'bg-emerald-500'
                    : 'bg-gray-300';
              const statusLabel = r.samples === 0
                ? 'No data'
                : r.shortDays > 0
                  ? `Short on ${r.shortDays} of ${r.samples} ${r.samples === 1 ? 'day' : 'days'}`
                  : `Hit target on all ${r.samples} ${r.samples === 1 ? 'day' : 'days'}`;
              return (
                <div key={r.day}>
                  <div className="mb-0.5 flex items-baseline justify-between text-xs">
                    <span className="font-semibold text-gray-700">{r.day}</span>
                    <span className="text-gray-500">
                      <span className={`font-semibold ${status === 'short' ? 'text-rose-600' : status === 'tight' ? 'text-amber-700' : status === 'ok' ? 'text-emerald-700' : 'text-gray-500'}`}>
                        {r.samples > 0 ? r.avg.toFixed(1) : '—'}
                      </span>
                      <span className="text-gray-400"> avg · {statusLabel}</span>
                    </span>
                  </div>
                  <div className="relative h-3 rounded-full bg-gray-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${filledPct}%` }}
                    />
                    {/* Dashed target threshold */}
                    <div
                      className="absolute top-0 bottom-0 border-l-2 border-dashed border-gray-500/60"
                      style={{ left: `${targetPct}%` }}
                      title={`Target: ${coverageTarget}`}
                    />
                  </div>
                  {r.samples > 0 && (
                    <p className="mt-1 text-[10px] text-gray-400">
                      Range {r.worst}–{r.best} over {r.samples} observed {r.samples === 1 ? 'day' : 'days'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {coverageHasData && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-gray-500">
            <span className="inline-block h-2 w-2 rounded-full bg-rose-500" /> below target
            <span className="mx-1">·</span>
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> tight
            <span className="mx-1">·</span>
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> meeting target
            <span className="mx-2 text-gray-300">|</span>
            <span className="text-gray-400">dashed line = target ({coverageTarget})</span>
          </p>
        )}
      </div>

      {/* ── Average Hourly Coverage By Day (day × hour heatmap) ─────────── */}
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Average Hourly Coverage By Day</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Hour-by-hour coverage over the last {COVERAGE_WEEKS} weeks vs your daily target of {coverageTarget}. Off-peak hours will naturally read red — focus on whether peak slots (3 PM onwards) are amber or green.
            </p>
          </div>
        </div>

        {!heatmapHasData ? (
          <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-400">
            No posted schedules in the look-back window yet — once you start posting, this fills in.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              {/* Column header — hours */}
              <div className="flex items-center gap-px pl-24">
                {heatmapHours.map(h => (
                  <div key={h} className="flex-1 py-1 text-center text-[10px] font-medium text-gray-400">
                    {hourLabel(h)}
                  </div>
                ))}
              </div>
              {/* Rows — one per operating day */}
              {operatingDaysList.map(day => {
                const dayOpen = opHoursMap[day];
                const dayStart = dayOpen ? parseInt(dayOpen.start.split(':')[0], 10) : 0;
                const dayEnd   = dayOpen ? parseInt(dayOpen.end.split(':')[0], 10) : 24;
                return (
                  <div key={day} className="mb-px flex items-center gap-px">
                    <div className="w-24 shrink-0 truncate pr-2 text-xs font-semibold text-gray-700">{day}</div>
                    {heatmapHours.map(h => {
                      const cell = heatmapCells[day]?.[h] || { avg: 0, samples: 0 };
                      const isOpen = h >= dayStart && h < dayEnd;
                      // Match the by-day chart's red / amber / green thresholds
                      // so both panels speak the same visual language.
                      let bgClass, textClass;
                      if (!isOpen) {
                        bgClass = 'bg-gray-200/60';
                        textClass = 'text-gray-400';
                      } else if (cell.samples === 0) {
                        bgClass = 'bg-gray-50';
                        textClass = 'text-gray-300';
                      } else if (cell.avg < coverageTarget * 0.85) {
                        bgClass = 'bg-rose-500';
                        textClass = 'text-white';
                      } else if (cell.avg < coverageTarget) {
                        bgClass = 'bg-amber-500';
                        textClass = 'text-white';
                      } else {
                        bgClass = 'bg-emerald-500';
                        textClass = 'text-white';
                      }
                      const label = !isOpen
                        ? '—'
                        : cell.samples === 0
                          ? '·'
                          : cell.avg.toFixed(1).replace(/\.0$/, '');
                      const tip = !isOpen
                        ? `${day} ${hourLabel(h)}–${hourLabel(h + 1)} · closed`
                        : cell.samples === 0
                          ? `${day} ${hourLabel(h)}–${hourLabel(h + 1)} · no data`
                          : `${day} ${hourLabel(h)}–${hourLabel(h + 1)} · ${cell.avg.toFixed(1)} avg over ${cell.samples} ${cell.samples === 1 ? 'day' : 'days'}`;
                      return (
                        <div
                          key={h}
                          title={tip}
                          className={`flex h-8 flex-1 items-center justify-center rounded-sm text-[10px] font-semibold transition-colors ${bgClass} ${textClass}`}
                        >
                          {label}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {/* Legend — same colour grammar as the by-day chart above. */}
              <div className="mt-3 flex flex-wrap items-center gap-3 pl-24 text-[10px] text-gray-500">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-3 w-3 rounded-sm bg-rose-500" /> below target
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-3 w-3 rounded-sm bg-amber-500" /> tight
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-3 w-3 rounded-sm bg-emerald-500" /> meeting target
                </span>
                <span className="text-gray-400">· grey = closed at that hour</span>
              </div>
            </div>
          </div>
        )}

        {/* Lowest-coverage hour buckets */}
        {coverageGaps.length > 0 && (
          <div className="mt-5 border-t border-gray-100 pt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Lowest-coverage hour buckets
            </p>
            <div className="space-y-1.5">
              {coverageGaps.map((g, i) => (
                <div key={`${g.day}-${g.hour}`} className="flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                  <span className="w-4 text-right text-xs font-bold text-gray-400">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-800">
                      {g.day} · {hourLabel(g.hour)}–{hourLabel(g.hour + 1)}
                    </p>
                    <p className="text-xs text-gray-500">
                      Avg <span className={`font-semibold ${g.avg < coverageTarget * 0.5 ? 'text-rose-600' : 'text-amber-700'}`}>{g.avg.toFixed(1)}</span> instructors over {g.samples} observed {g.samples === 1 ? 'day' : 'days'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-400">
              These are your thinnest hours — investigate whether they're real shortages (lots of students that hour) or natural slack (lunchtime, mid-morning weekdays).
            </p>
          </div>
        )}
      </div>

      {/* ── Hiring Forecast ─────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-900">Hiring Forecast</h3>
          <p className="text-xs text-gray-500">
            Projected headcount over the next 4 months, based on each staff
            member's plan. {noPlanCount > 0 && (
              <span className="text-amber-700">
                {noPlanCount} {noPlanCount === 1 ? 'person hasn\'t' : 'people haven\'t'} filled in their plan yet.
              </span>
            )}
          </p>
        </div>

        {/* Risk banner */}
        {showRiskBanner && (
          <div className="rounded-xl border-2 border-amber-200 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-amber-900">
                  {totalDepart} {totalDepart === 1 ? 'departure' : 'departures'} expected in the next 4 months — projected headcount {projectedEnd}
                </p>
                <p className="mt-0.5 text-xs text-amber-800">
                  Tutoring hires typically take 4–6 weeks from listing to onboarded. Posting now gives you runway and avoids burning out the staff who stay.
                </p>
                <button
                  type="button"
                  onClick={() => setJobModalOpen(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 transition-colors"
                >
                  <Briefcase size={14} /> Draft a job posting
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Projection bars */}
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-baseline justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Projected headcount</p>
            <p className="text-xs text-gray-400">Starting from {currentHeadcount} today</p>
          </div>
          <div className="grid grid-cols-4 gap-3">
            {projection.map(m => {
              const isBelowFloor = m.projected < minStaffFloor;
              const heightPct = currentHeadcount > 0
                ? Math.max(8, (m.projected / currentHeadcount) * 100)
                : 8;
              const barColor = isBelowFloor
                ? 'bg-rose-500'
                : m.departures > 0
                  ? 'bg-amber-500'
                  : 'bg-emerald-500';
              return (
                <div key={m.key} className="flex flex-col items-center">
                  <p className="mb-1 text-xs font-medium text-gray-500">{m.label}</p>
                  <div className="flex h-24 w-full items-end overflow-hidden rounded-lg bg-gray-100">
                    <div className={`w-full rounded-lg transition-all ${barColor}`} style={{ height: `${heightPct}%` }} />
                  </div>
                  <p className="mt-1 text-lg font-bold text-gray-900">{m.projected}</p>
                  <p className="text-xs text-gray-500">
                    {m.departures > 0 ? <span className="text-rose-600 font-semibold">−{m.departures}</span> : '—'}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-gray-400">
            Floor of ~{minStaffFloor} staff (your auto-scheduler's min/day × 2). Red months are below the floor.
            {unsureStaff.length > 0 && ` ${unsureStaff.length} staff marked "unsure" — not deducted, but worth a check-in.`}
          </p>
        </div>

        {/* Staff to plan for */}
        {(leavers.length > 0 || unsureStaff.length > 0) && (
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">Staff to plan for</p>
            <div className="space-y-2.5">
              {leavers.map(l => (
                <div key={`l-${l.name}`} className="flex items-start gap-3 rounded-lg border border-rose-100 bg-rose-50/40 p-3">
                  <span className="shrink-0 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-bold text-rose-700">Leaving</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">{l.name}</p>
                    <p className="text-xs text-gray-600">
                      {l.role} · expected last month <strong>{formatPlanMonthLabel(l.monthKey)}</strong>
                      {l.reason && ` · ${REASON_LABELS[l.reason] || l.reason}`}
                    </p>
                    {l.reasonNotes && <p className="mt-1 text-xs italic text-gray-500">"{l.reasonNotes}"</p>}
                    {l.aspirations && (
                      <p className="mt-1 text-xs text-purple-700">
                        <span className="font-semibold">Goals:</span> {l.aspirations}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {unsureStaff.map(u => (
                <div key={`u-${u.name}`} className="flex items-start gap-3 rounded-lg border border-amber-100 bg-amber-50/40 p-3">
                  <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-700">Unsure</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900">{u.name}</p>
                    <p className="text-xs text-gray-600">{u.role}</p>
                    {u.aspirations && (
                      <p className="mt-1 text-xs text-purple-700">
                        <span className="font-semibold">Goals:</span> {u.aspirations}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {leavers.length === 0 && (
              <button
                type="button"
                onClick={() => setJobModalOpen(true)}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <Briefcase size={13} /> Draft a job posting anyway
              </button>
            )}
          </div>
        )}

        {/* No-risk state: still let owners draft a posting on demand */}
        {leavers.length === 0 && unsureStaff.length === 0 && (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-5">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-gray-700">
              <CheckCircle size={13} className="text-emerald-500" /> No planned departures right now
            </p>
            <p className="text-xs text-gray-500">
              {noPlanCount > 0
                ? `${noPlanCount} ${noPlanCount === 1 ? 'person hasn\'t' : 'people haven\'t'} filled in their 4-month plan yet — projection assumes they're staying.`
                : 'Every active staff member has confirmed they\'re staying. Still want to grow? Draft a listing below.'}
            </p>
            <button
              type="button"
              onClick={() => setJobModalOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Briefcase size={13} /> Draft a job posting
            </button>
          </div>
        )}

        {/* Aspirations roundup (only shown if someone shared) */}
        {aspirationsList.length > 0 && (
          <div className="rounded-2xl border bg-white p-5 shadow-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Team aspirations</p>
            <p className="mb-3 text-xs text-gray-400">School, programs, dream jobs — useful for mentoring and timing transitions.</p>
            <div className="space-y-2">
              {aspirationsList.map(a => (
                <div key={a.name} className="rounded-lg bg-gray-50 px-3 py-2">
                  <p className="text-xs font-semibold text-gray-800">
                    {a.name}
                    {a.staying === 'no' && <span className="ml-2 rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">Leaving</span>}
                    {a.staying === 'unsure' && <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">Unsure</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-600">{a.aspirations}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Job posting template modal */}
      {jobModalOpen && (
        <JobPostingModal
          centerConfig={centerConfig}
          defaultRole={leavers[0]?.role}
          defaultStartMonth={leavers[0]?.monthKey || nextMonths[0]?.key}
          onClose={() => setJobModalOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Sub-component: Job-posting template modal ───────────────────────────

function JobPostingModal({ centerConfig, defaultRole, defaultStartMonth, onClose }) {
  const [role, setRole]     = useState(SHIFT_ASSIGNMENTS.includes(defaultRole) ? defaultRole : 'Elementary Instructor');
  const [startMonth, setStartMonth] = useState(defaultStartMonth || '');
  const [hoursRange, setHoursRange] = useState('10–15');
  const [contactEmail, setContactEmail] = useState('');
  const [copied, setCopied] = useState(false);

  const monthOptions = [];
  const dd = new Date(); dd.setDate(1);
  for (let i = 0; i < 9; i++) {
    const key = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}`;
    monthOptions.push({ key, label: dd.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) });
    dd.setMonth(dd.getMonth() + 1);
  }
  const startLabel = (() => {
    if (!startMonth) return 'soon';
    const [y, m] = startMonth.split('-');
    return new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  })();

  const centerName = centerConfig?.name || 'Mathnasium';
  const locationLine = [centerConfig?.city, centerConfig?.province].filter(Boolean).join(', ');

  const template = `${centerName} is hiring a ${role}!

About us
${centerName}${locationLine ? ` (${locationLine})` : ''} helps K–12 students build math confidence and skill. We're a small, close-knit team that plans staffing 4 months ahead so nobody gets overworked.

The role
• Position: ${role}
• Start: ${startLabel}
• Hours: ~${hoursRange} hours/week
• Location: In-centre${role === 'Online Instructor' ? '' : ' (online sessions also available)'}

What we're looking for
• Strong math skills — comfortable up through Algebra II${role.includes('Highschool') ? ' / Pre-Calc' : ''}
• Patience and clarity with students of all ages
• Reliable, on-time, takes ownership
• Bonus: previous tutoring or coaching experience

What you'll get
• Flexible schedule built around your school/work commitments
• Real mentorship and career coaching — we want you to grow
• A team that has your back

How to apply
Send a resume and a short note about why this role suits you to ${contactEmail || '[your email]'}.

#hiring #tutoring #mathjobs`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(template);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: do nothing; user can select+copy manually.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 bg-gradient-to-r from-amber-50 to-white px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-amber-100 p-2 text-amber-600"><Briefcase size={18} /></div>
            <div>
              <h3 className="text-base font-bold text-gray-900">Draft a job posting</h3>
              <p className="mt-0.5 text-xs text-gray-500">Fill in the role and dates — we'll generate a posting you can drop straight into Indeed, Handshake, or social.</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="overflow-y-auto px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none">
                {SHIFT_ASSIGNMENTS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">Start month</label>
              <select value={startMonth} onChange={(e) => setStartMonth(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none">
                <option value="">— Pick a month —</option>
                {monthOptions.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">Hours / week</label>
              <input value={hoursRange} onChange={(e) => setHoursRange(e.target.value)}
                placeholder="10–15"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-gray-500">Contact email</label>
              <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
            </div>
          </div>

          {/* Preview */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wide text-gray-500">Posting preview</label>
              <button type="button" onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50">
                {copied ? <><CheckCircle size={12} className="text-emerald-600" /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
            </div>
            <textarea
              readOnly
              value={template}
              rows={14}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs font-mono text-gray-800 focus:outline-none"
              onFocus={(e) => e.target.select()}
            />
            <p className="mt-1 text-xs text-gray-400">Edit the fields above and the preview regenerates.</p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button type="button" onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100">Close</button>
          <button type="button" onClick={handleCopy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700">
            {copied ? <><CheckCircle size={14} /> Copied!</> : <><Copy size={14} /> Copy posting</>}
          </button>
        </div>
      </div>
    </div>
  );
}
