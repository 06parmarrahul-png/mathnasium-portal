import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  collection, onSnapshot, doc, updateDoc, deleteDoc, deleteField,
  addDoc, query, where, orderBy, writeBatch, getDoc, getDocs, setDoc,
} from 'firebase/firestore';
import { db, auth, serverTimestamp } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast, confirmDialog } from '../lib/notify';
import {
  Settings, UserCheck, UserX, Trash2, Clock, Tag,
  ChevronLeft, ChevronRight, ChevronDown, Table, Wand2, CheckCircle, Check,
  AlertTriangle, Send, RotateCcw, Edit3, ArrowRightLeft, Plus, X,
  DollarSign, Download, CalendarRange, BarChart3, Mail, Loader2, UserPlus,
  Users, Activity, Briefcase, Copy, CalendarX, Upload, Search, ArrowUp,
  ArrowLeft, LayoutGrid, Calendar, HelpCircle, TrendingUp, HandHeart, Megaphone,
} from 'lucide-react';
import {
  format, startOfWeek, addWeeks, subWeeks, addDays, isSameDay,
  startOfMonth, endOfMonth, subMonths, addMonths,
} from 'date-fns';
import { generateSchedule, FIXED_SCHEDULES } from '../lib/scheduler';
import { SUB_ROLES, SUB_ROLE_STYLES, styleFor as subRoleStyleFor } from '../lib/subRoles';
import Avatar from '../components/Avatar';
import { DEFAULT_CENTER_ID } from '../lib/centers';
import {
  LANGLEY_DEFAULT_CONFIG, SHIFT_ASSIGNMENTS, DEFAULT_CENTER_CONFIG,
  assignmentFor, assignmentColorHex, assignmentShort, contrastText,
  isOperatingDay, holidayFor, ALL_WEEKDAYS, resolveInstructionalHours,
} from '../lib/centerConfig';
import CoverageGrid from '../components/CoverageGrid';
import ApptotoAppointmentsCard from '../components/ApptotoAppointmentsCard';
import IntakeAnalyticsCard from '../components/IntakeAnalyticsCard';
import CenterSettingsTab from '../components/CenterSettingsTab';
import HolidaysEditor from '../components/HolidaysEditor';
import {
  notifyOpenShift, notifySchedulePosted, notifyTimeOffDecision,
} from '../lib/emailService';
import { attachEmails } from '../lib/userContact';
import {
  resolveUserForCenter,
  membershipFieldPath,
  isPerCentreField,
  buildInitialMembership,
} from '../lib/centerMembership';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const ROLE_OPTIONS = [
  'Instructor', 'Lead', 'Host', 'Admin',
  'Manager', 'Center Director', 'Dir. of Education',
  'Volunteer',
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

// Map JS getDay() → centerConfig day name (Mon–Sat). Sunday returns null
// so callers can fall back gracefully on centres that don't operate Sundays.
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Resolve "what should the time fields default to?" for a given date + user
// from this centre's config. Hosts → operating hours (full open-to-close);
// everyone else → instructional hours (teaching window). Falls back to
// the legacy 3pm–8pm range only if the config doesn't have hours for the
// day-of-week at all (which shouldn't happen post-migration).
function defaultShiftTimesFor(date, userLike, centerConfig) {
  const FALLBACK = { start: '15:00', end: '20:00' };
  if (!date) return FALLBACK;
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00') : date;
  const dayName = DOW_NAMES[d.getDay()];
  if (!dayName) return FALLBACK;
  const isHost = (userLike?.instructorType || '').toLowerCase() === 'host';
  // Hosts get operating hours (unchanged). Instructors get the
  // date-resolved instructional hours so any active override (e.g.
  // summerHours2026) is reflected automatically in shift defaults.
  const bucket = isHost
    ? centerConfig?.operatingHours
    : resolveInstructionalHours(centerConfig, d);
  const hours = bucket?.[dayName];
  return hours && hours.start && hours.end ? hours : FALLBACK;
}

// ── Add Shift Modal ────────────────────────────────────────────────────────────
function AddShiftModal({ date, user, users, availability, centerConfig, onClose, onSave }) {
  const [selectedUser, setSelectedUser] = useState(user?.uid || '');
  // Default the time fields from this centre's configured hours for the
  // picked date's day-of-week — Hosts get operating hours, instructors
  // get instructional hours. Updates if the selected user changes.
  const initialDefaults = defaultShiftTimesFor(date, user, centerConfig);
  const [startTime, setStartTime] = useState(initialDefaults.start);
  const [endTime, setEndTime] = useState(initialDefaults.end);
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
  // AND re-default the time fields (Host vs Instructor have different
  // default windows).
  const handleSelectUser = (uid) => {
    setSelectedUser(uid);
    const next = users.find(u => u.uid === uid);
    setSubRole(guessSubRole(next));
    const d = defaultShiftTimesFor(date, next, centerConfig);
    setStartTime(d.start);
    setEndTime(d.end);
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
      // New shifts land as drafts. The owner reviews them on the weekly
      // grid (drafts show striped) and clicks Publish when ready.
      // Instructors don't see drafts on their Schedule page.
      status: 'draft',
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
            <Avatar user={user} size={28} />
            <span className="text-sm font-medium text-gray-800">{user.displayName}</span>
            {user.instructorType && <span className="text-xs text-gray-400">· {user.instructorType}</span>}
          </div>
        )}

        {/* Availability hint */}
        {selectedUser && (
          <div className={`rounded-lg px-3 py-2 text-xs ${avail.length > 0 ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
            {avail.length > 0
              ? <>✓ Available: {avail.map(a => (
                  (a.startTime === '00:00' && (a.endTime === '23:59' || a.endTime === '24:00'))
                    ? 'Full day'
                    : `${a.startTime}–${a.endTime}`
                )).join(', ')}</>
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
function EditShiftModal({ shift, onClose, onSave, onDelete, onPublish }) {
  const [startTime, setStartTime] = useState(shift.startTime || '15:00');
  const [endTime, setEndTime] = useState(shift.endTime || '20:00');
  const [role, setRole] = useState(shift.role || '');
  const [shiftType, setShiftType] = useState(shift.shiftType || 'In-Centre');
  const [subRole, setSubRole] = useState(shift.subRole || 'Elementary');
  // Sick Pay flag — set when an instructor calls in sick. The shift stays
  // on the schedule (so we have a record) but the payroll tab reports it
  // under a separate "Sick" column instead of regular worked hours.
  const [sickPay, setSickPay] = useState(!!shift.sickPay);

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

        {/* Sick Pay toggle — flips this shift into the "Sick" payroll bucket
            without removing it from the schedule. Useful when an instructor
            calls in sick and you still want them paid for the planned hours. */}
        <label className="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 cursor-pointer">
          <div className="pr-3">
            <p className="text-xs font-semibold text-amber-900">Sick Pay</p>
            <p className="text-xs text-amber-700/80 mt-0.5">
              Mark this shift as sick. Hours are tracked separately on the payroll tab.
            </p>
          </div>
          <div className="relative inline-flex shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={sickPay}
              onChange={e => setSickPay(e.target.checked)}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-amber-500 peer-checked:after:translate-x-full peer-checked:after:border-white" />
          </div>
        </label>

        {/* Draft state banner + Publish button — only shown when this shift
            is still in draft. Publishing flips status to 'live' so the
            instructor sees it on their Schedule. */}
        {shift.status === 'draft' && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
            <p className="font-semibold mb-0.5">This shift is a draft</p>
            <p className="text-amber-800/80">The instructor can&apos;t see it until you publish.</p>
            <button
              onClick={() => onPublish && onPublish()}
              className="mt-2 w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-700 transition-colors"
            >
              Publish this shift
            </button>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={() => onSave({ startTime, endTime, role, shiftType, subRole, sickPay })}
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

// ── User Availability (Week) Modal ─────────────────────────────────────────
// Owner / admin clicks a name in the weekly-grid left column → modal opens
// showing that person's availability for each day of the visible week.
// Read-only: this is a viewing tool, not an editor. Includes their already-
// scheduled shifts on each day so the admin can compare "available 3–7"
// vs "scheduled 4–6" at a glance.
function UserAvailabilityModal({ user, weekDays, availability, shifts, onClose }) {
  const userAvail = availability.filter(a => a.userId === user.uid);
  const userShifts = shifts.filter(s => s.userId === user.uid);
  const isFull = (a) => a?.startTime === '00:00' && (a?.endTime === '23:59' || a?.endTime === '24:00');
  // weekDays is pre-filtered to operating days only (e.g. Mon–Sat = 6
  // entries, not 7), so use first/last instead of index 6.
  const firstDay = weekDays[0];
  const lastDay  = weekDays[weekDays.length - 1];
  return (
    <Modal
      title={`Availability — ${user.displayName}`}
      onClose={onClose}
    >
      <div className="-mt-2 mb-3 flex items-center gap-2">
        <Avatar user={user} size={28} />
        <p className="text-xs text-gray-500">
          {firstDay && lastDay
            ? <>Week of {format(firstDay, 'MMM d')} – {format(lastDay, 'MMM d, yyyy')}</>
            : 'No operating days this week'}
        </p>
      </div>
      <div className="space-y-2">
        {weekDays.map(d => {
          const ds = format(d, 'yyyy-MM-dd');
          const dayAvail   = userAvail.filter(a => a.date === ds);
          const dayShifts  = userShifts.filter(s => s.date === ds);
          const hasAnything = dayAvail.length > 0 || dayShifts.length > 0;
          return (
            <div
              key={ds}
              className={`rounded-lg border px-3 py-2 ${hasAnything ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100'}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-gray-800">
                  {format(d, 'EEE')} <span className="text-gray-400 font-normal">· {format(d, 'MMM d')}</span>
                </p>
                {!hasAnything && (
                  <span className="text-xs text-gray-400 italic">No availability submitted</span>
                )}
              </div>
              {dayAvail.length > 0 && (
                <div className="mt-1 space-y-1">
                  {dayAvail.map((a, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-xs text-emerald-800 font-medium">
                        {isFull(a) ? 'Full day · anytime' : `${fmtHHMM(a.startTime)} – ${fmtHHMM(a.endTime)}`}
                      </span>
                      {a.comment && (
                        <span className="text-xs text-blue-600 italic truncate">&quot;{a.comment}&quot;</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {dayShifts.length > 0 && (
                <div className="mt-1 space-y-1">
                  {dayShifts.map(s => (
                    <div key={s.id} className="flex items-center gap-2">
                      <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                      <span className="text-xs text-gray-700">
                        Scheduled {fmtHHMM(s.startTime)} – {fmtHHMM(s.endTime)}
                        {s.role ? ` · ${s.role}` : ''}
                      </span>
                      {s.status === 'draft' && (
                        <span className="rounded bg-amber-100 px-1 py-px text-[10px] font-bold uppercase tracking-wider text-amber-700">Draft</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// ── Add Staff Modal ──────────────────────────────────────────────────────
// Owner / AA / admin creates a new staff account without making the new
// hire sign up themselves. The server-side handler (POST /api/users/
// create-staff) creates the Auth account, writes a pre-approved Firestore
// profile, and emails a "set your password" link. Owner never sees or
// touches a password.
function AddStaffModal({ onClose, onSubmit }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [instructorType, setInstructorType] = useState('Instructor');
  const [priority, setPriority] = useState(2);
  const [subRoles, setSubRoles] = useState(['Elementary']);
  const [sendResetEmail, setSendResetEmail] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleSubRole = (sr) => {
    setSubRoles(p => p.includes(sr) ? p.filter(x => x !== sr) : [...p, sr]);
  };

  const handleSubmit = async () => {
    setError('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email.');
      return;
    }
    if (!displayName.trim()) {
      setError('Enter the staff member\'s full name.');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({
        email: email.trim().toLowerCase(),
        displayName: displayName.trim(),
        phone: phone.trim(),
        instructorType,
        priority,
        subRoles,
        sendResetEmail,
      });
    } catch (err) {
      setError(err?.message || 'Could not create account.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add Staff" onClose={onClose}>
      <p className="text-xs text-gray-500 -mt-2 mb-3">
        Creates a pre-approved account at your centre. The new staff member
        gets an email with a link to set their own password and sign in.
      </p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Full name</label>
          <input
            type="text" autoFocus value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Email</label>
          <input
            type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="jane@example.com"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Phone <span className="text-gray-400 font-normal">(optional)</span></label>
          <input
            type="tel" value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="604-555-0199"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Role / Type</label>
            <select
              value={instructorType}
              onChange={e => setInstructorType(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Priority</label>
            <select
              value={priority}
              onChange={e => setPriority(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:outline-none"
            >
              <option value={1}>1 — High</option>
              <option value={2}>2 — Medium</option>
              <option value={3}>3 — Low</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1">Teaching Sub-Roles</label>
          <div className="flex flex-wrap gap-2">
            {SUB_ROLES.map(sr => {
              const active = subRoles.includes(sr);
              const style = SUB_ROLE_STYLES[sr];
              return (
                <button
                  key={sr}
                  type="button"
                  onClick={() => toggleSubRole(sr)}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border-2 transition-all ${
                    active
                      ? `${style.pillBg} ${style.pillText} border-transparent`
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${active ? style.dot : 'bg-gray-300'}`} />
                  {sr}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-gray-400">Required so they can claim and be auto-scheduled.</p>
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 cursor-pointer">
          <input
            type="checkbox" checked={sendResetEmail}
            onChange={e => setSendResetEmail(e.target.checked)}
            className="mt-0.5 accent-red-600 h-4 w-4"
          />
          <span className="text-xs text-gray-700">
            <strong>Email a &ldquo;set your password&rdquo; link now.</strong>{' '}
            <span className="text-gray-500">
              Off only if you&apos;ll resend later from the staff card.
            </span>
          </span>
        </label>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 flex items-start gap-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><UserPlus size={14} /> Create staff</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Edit Staff Modal ─────────────────────────────────────────────────────
// Owner / AA / admin tweaks role / priority / sub-roles / toggles on an
// existing staff member. All writes go through onUpdateField so per-centre
// membership semantics + Firestore rules apply automatically.
function EditStaffModal({ user, onClose, onUpdateField, onDelete, onSendReset }) {
  if (!user) return null;
  const subRoles = user.subRoles || [];
  return (
    <Modal title={`Edit — ${user.displayName || user.email}`} onClose={onClose}>
      <p className="text-xs text-gray-500 -mt-2 mb-3 truncate">
        {user.email}
        {user.phone ? ` · ${user.phone}` : ''}
      </p>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="mb-1 block text-xs text-gray-500">Role / Type</label>
            <select
              value={user.instructorType || 'Instructor'}
              onChange={e => onUpdateField(user.uid, 'instructorType', e.target.value)}
              className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none"
            >
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">Priority</label>
            <select
              value={user.priority || 2}
              onChange={e => onUpdateField(user.uid, 'priority', Number(e.target.value))}
              className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none"
            >
              <option value={1}>1 — High</option>
              <option value={2}>2 — Medium</option>
              <option value={3}>3 — Low</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">Max Days/Week</label>
            <input
              type="number" min={1} max={6}
              value={user.maxDaysPerWeek || 5}
              onChange={e => onUpdateField(user.uid, 'maxDaysPerWeek', Number(e.target.value))}
              className="w-full rounded border px-2 py-1.5 text-xs focus:border-red-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs text-gray-500 font-medium">Teaching Sub-Roles</label>
          <div className="flex flex-wrap gap-2">
            {SUB_ROLES.map(sr => {
              const active = subRoles.includes(sr);
              const style = SUB_ROLE_STYLES[sr];
              return (
                <button
                  key={sr}
                  type="button"
                  onClick={() => {
                    const updated = active
                      ? subRoles.filter(r => r !== sr)
                      : [...subRoles, sr];
                    onUpdateField(user.uid, 'subRoles', updated);
                  }}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border-2 transition-all ${
                    active
                      ? `${style.pillBg} ${style.pillText} border-transparent`
                      : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${active ? style.dot : 'bg-gray-300'}`} />
                  {sr}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-start justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <div className="pr-3">
            <p className="text-xs font-semibold text-gray-700">Guaranteed shift</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Always scheduled when they submit availability.
              {user.instructorType === 'Host' && ' Hosts also auto-promote to Instructor on shortage days.'}
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={user.guaranteed === true}
              onChange={e => onUpdateField(user.uid, 'guaranteed', e.target.checked)}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-600 peer-checked:after:translate-x-full peer-checked:after:border-white" />
          </label>
        </div>

        <div className="flex items-start justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <div className="pr-3">
            <p className="text-xs font-semibold text-gray-700">Volunteer</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Unpaid help. Excluded from payroll + Radius reports. Not auto-scheduled.
            </p>
          </div>
          <label className="relative inline-flex cursor-pointer items-center shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={user.isVolunteer === true}
              onChange={e => onUpdateField(user.uid, 'isVolunteer', e.target.checked)}
              className="peer sr-only"
            />
            <div className="peer h-5 w-9 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-amber-600 peer-checked:after:translate-x-full peer-checked:after:border-white" />
          </label>
        </div>

        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
          {user.email && (
            <button
              onClick={() => onSendReset(user)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Mail size={13} /> Send reset email
            </button>
          )}
          <button
            onClick={() => onDelete(user)}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
          >
            <Trash2 size={13} /> Remove staff
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Add Open Shift Modal ───────────────────────────────────────────────────────
function AddOpenShiftModal({ date, centerConfig, onClose, onSave }) {
  // Open shifts default to instructional hours for that day (it's the
  // teaching window someone would be claiming). Owner can override before
  // saving.
  const initial = defaultShiftTimesFor(date, null, centerConfig);
  const [startTime, setStartTime] = useState(initial.start);
  const [endTime, setEndTime] = useState(initial.end);
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

// ── Bulk delete shifts (single day or range) ───────────────────────────
// Dropdown widget on Manage Payroll. Single date deletes that day (e.g.
// stat holiday); two dates deletes everything in between (e.g. clean a
// whole month before importing from another tool).
function BulkDeleteShiftsByDate({ onConfirm }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 transition-colors"
        title="Bulk-delete shifts on a date or in a date range">
        <Trash2 size={14} /> Delete shifts
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-96 rounded-xl border border-gray-200 bg-white p-4 shadow-lg">
          <h4 className="font-bold text-gray-900 text-sm mb-1">Delete shifts in date range</h4>
          <p className="text-xs text-gray-500 mb-3">
            Set <b>From</b> only (leave To blank) to delete one day — e.g. a stat holiday.
            Set both to wipe a full range before importing payroll from another tool.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-xs text-gray-500 mb-0.5">From</span>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-500 mb-0.5">To (optional)</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm" />
            </label>
          </div>
          <div className="mt-3 flex gap-2 justify-end">
            <button onClick={() => { setOpen(false); setFrom(''); setTo(''); }}
              className="rounded px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100">
              Cancel
            </button>
            <button
              disabled={!from}
              onClick={async () => {
                await onConfirm(from, to || from);
                setOpen(false);
                setFrom(''); setTo('');
              }}
              className="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed">
              Delete shifts
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Import shifts from When I Work CSV ─────────────────────────────────
// Parses the WIW export format we already know:
//   col 2 = Employee Name, col 4 = date dd/mm/yyyy,
//   col 5 = Time In, col 6 = Time Out, col 8 = Duration (Hours)
// Preview lets the owner remap any unmatched employee name to a Ratio
// user (uses the radiusName alias same as payroll), then batch-imports.
function ImportFromWiwButton({ approvedUsers, onImport, onDeleteRange }) {
  const [open, setOpen] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [importing, setImporting] = useState(false);
  const [wipeFirst, setWipeFirst] = useState(false);
  const fileRef = useRef(null);

  // Tokenise + fuzzy compare (same logic as payroll matcher).
  const nameTokens = (raw) => String(raw || '').toLowerCase()
    .replace(/[.'`]/g, '').split(/[\s-]+/).filter(Boolean);
  const namesMatch = (a, b) => {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (ta.length === 0 || tb.length === 0) return false;
    if (ta.length === 1 || tb.length === 1) return ta[0] === tb[0];
    return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
  };
  const findUser = (wiwName) =>
    approvedUsers.find(u =>
      namesMatch(u.displayName, wiwName) ||
      (u.radiusName && namesMatch(u.radiusName, wiwName))
    );

  // dd/mm/yyyy OR yyyy-mm-dd → YYYY-MM-DD
  const isoDate = (d) => {
    const v = String(d || '').trim();
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    return null;
  };
  // "3:26 PM" / "10:30 am" / "15:30" → "15:26"
  const toHHMM = (t) => {
    const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mm = m[2];
    const ampm = (m[3] || '').toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2,'0')}:${mm}`;
  };
  // Hours between two HH:MM strings (positive even if end < start by 1 min
  // due to rounding — we cap at 24).
  const hoursBetween = (start, end) => {
    if (!start || !end) return 0;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm);
    return Math.max(0, Math.min(24, mins / 60));
  };
  // Map WIW position → Ratio role/subRole.
  const positionToRoleSub = (pos) => {
    const p = String(pos || '').toLowerCase();
    if (p.includes('high school')) return { role: 'Instructor', subRole: 'Highschool' };
    if (p.includes('elementary'))  return { role: 'Instructor', subRole: 'Elementary' };
    if (p.includes('@home') || p.includes('m@home') || p.includes('online'))
                                   return { role: 'Instructor', subRole: 'Online' };
    if (p.includes('training'))    return { role: 'Instructor', subRole: 'Elementary' };
    if (p.includes('lead'))        return { role: 'Lead Instructor', subRole: 'Highschool' };
    if (p.includes('admin'))       return { role: 'Host',  subRole: 'Elementary' };
    if (p.includes('manager') || p.includes('director'))
                                   return { role: 'Host',  subRole: 'Elementary' };
    if (p.includes('sick'))        return { role: 'Instructor', subRole: 'Elementary', sickPay: true };
    return { role: 'Instructor', subRole: 'Elementary' };
  };

  // Find column indexes by header label so we don't rely on fixed offsets
  // — WIW changes column order between Payroll and Schedule exports.
  const indexOfHeader = (headerRow, ...candidates) => {
    const lc = headerRow.map(h => String(h || '').trim().toLowerCase());
    for (const c of candidates) {
      const i = lc.indexOf(c.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };

  const handleFile = async (file) => {
    if (!file) return;
    // Accept both CSV and XLSX. WIW's native export is .xlsx with multiple
    // sheets; the Schedule export's per-shift rows live on the
    // "Schedules Summary" sheet. We pick that sheet by name when present,
    // otherwise fall back to the first sheet (which covers the legacy
    // Payroll CSV format).
    let rows;
    const isXlsx = /\.xlsx?$/i.test(file.name) ||
      file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.type === 'application/vnd.ms-excel';
    if (isXlsx) {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      // Prefer "Schedules Summary" or anything that contains "schedule";
      // otherwise first sheet.
      const preferred = wb.SheetNames.find(n => /schedules?\s*summary/i.test(n))
        || wb.SheetNames.find(n => /schedule/i.test(n))
        || wb.SheetNames[0];
      const sheet = wb.Sheets[preferred];
      rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    } else {
      const text = await file.text();
      rows = text.split(/\r?\n/).map(line => line.split(','));
    }

    // Find the header row — the first row that contains a recognisable
    // shift-date label. Then look up the columns we need by name.
    let headerIdx = -1, header = null;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const cells = rows[i].map(c => String(c || '').toLowerCase());
      if (cells.some(c => /shift start date|date/.test(c)) &&
          cells.some(c => /first name|employee name/.test(c) || c === 'name') ) {
        headerIdx = i; header = rows[i]; break;
      }
    }
    if (headerIdx < 0) {
      // Legacy Payroll CSV had no recognisable header on row 1 — fall back
      // to the original fixed-column path (col 2 name, col 4 dd/mm/yyyy,
      // col 5 in, col 6 out).
      const entries = parseLegacyFixedCols(rows);
      setParsed(entries);
      return;
    }

    const colDate    = indexOfHeader(header, 'Shift Start Date', 'Date');
    const colStart   = indexOfHeader(header, 'Shift Start Time', 'Time In', 'Start');
    const colEnd     = indexOfHeader(header, 'Shift End Time',   'Time Out', 'End');
    const colFirst   = indexOfHeader(header, 'First Name');
    const colLast    = indexOfHeader(header, 'Last Name');
    const colName    = indexOfHeader(header, 'Employee Name', 'Name');
    const colPos     = indexOfHeader(header, 'Position', 'Role');
    const colBreak   = indexOfHeader(header, 'Unpaid Break');

    const entries = [];
    const nameToUid = new Map();
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length === 0) continue;
      const date = isoDate(r[colDate]);
      if (!date) continue;
      // Build name from either First + Last or single Name column.
      const name = colFirst >= 0 && colLast >= 0
        ? `${(r[colFirst] || '').trim()} ${(r[colLast] || '').trim()}`.trim()
        : (r[colName] || '').trim();
      if (!name) continue;
      const startTime = toHHMM(r[colStart]);
      const endTime   = toHHMM(r[colEnd]);
      if (!startTime || !endTime) continue;
      const breakMin = colBreak >= 0 ? (parseFloat(r[colBreak]) || 0) : 0;
      const hours = Math.max(0, hoursBetween(startTime, endTime) - breakMin / 60);
      const rs = positionToRoleSub(r[colPos]);

      if (!nameToUid.has(name)) {
        const u = findUser(name);
        nameToUid.set(name, u ? u.uid : '');
      }
      const uid = nameToUid.get(name);
      const user = uid ? approvedUsers.find(u => u.uid === uid) : null;
      entries.push({
        wiwName: name,
        userId: uid,
        userName: user?.displayName || name,
        role:    user?.instructorType || rs.role,
        subRole: rs.subRole,
        sickPay: !!rs.sickPay,
        date, startTime, endTime,
        hours: Math.round(hours * 100) / 100,
      });
    }
    setParsed({ entries, nameToUid });
  };

  // Old Payroll CSV path — col 2 = name, col 4 = dd/mm/yyyy, col 5 = in,
  // col 6 = out, col 8 = hours. Kept so the old format still works.
  const parseLegacyFixedCols = (rows) => {
    const entries = [];
    const nameToUid = new Map();
    for (const row of rows) {
      if (row.length < 9) continue;
      const date = isoDate((row[4] || '').trim());
      if (!date) continue;
      const name = (row[2] || '').trim();
      if (!name) continue;
      const startTime = toHHMM(row[5]);
      const endTime   = toHHMM(row[6]);
      if (!startTime || !endTime) continue;
      const hours = parseFloat(row[8]);
      if (!nameToUid.has(name)) {
        const u = findUser(name);
        nameToUid.set(name, u ? u.uid : '');
      }
      const uid = nameToUid.get(name);
      const user = uid ? approvedUsers.find(u => u.uid === uid) : null;
      entries.push({
        wiwName: name,
        userId: uid,
        userName: user?.displayName || name,
        role:    user?.instructorType || 'Instructor',
        subRole: (user?.subRoles || []).includes('Online') ? 'Online'
              : (user?.subRoles || []).includes('Highschool') ? 'Highschool'
              : 'Elementary',
        date, startTime, endTime,
        hours: isNaN(hours) ? 0 : hours,
      });
    }
    return { entries, nameToUid };
  };

  // Remap one of the wiwName → uid choices and re-resolve all rows.
  const remap = (wiwName, uid) => {
    const next = new Map(parsed.nameToUid);
    next.set(wiwName, uid);
    const user = uid ? approvedUsers.find(u => u.uid === uid) : null;
    const entries = parsed.entries.map(e => e.wiwName === wiwName ? ({
      ...e,
      userId: uid,
      userName: user?.displayName || wiwName,
      role: user?.instructorType || e.role,
      subRole: (user?.subRoles || []).includes('Online') ? 'Online'
            : (user?.subRoles || []).includes('Highschool') ? 'Highschool'
            : 'Elementary',
    }) : e);
    setParsed({ entries, nameToUid: next });
  };

  // Per-name summary for the preview list.
  const summary = parsed
    ? [...new Set(parsed.entries.map(e => e.wiwName))].map(n => {
        const rows = parsed.entries.filter(e => e.wiwName === n);
        const totalHrs = rows.reduce((s, r) => s + (r.hours || 0), 0);
        const uid = parsed.nameToUid.get(n);
        return { wiwName: n, uid, rowCount: rows.length, totalHrs, dates: rows.map(r => r.date) };
      })
    : [];

  const minDate = parsed ? summary.flatMap(s => s.dates).sort()[0] : null;
  const maxDate = parsed ? summary.flatMap(s => s.dates).sort().pop() : null;

  const doImport = async () => {
    if (!parsed) return;
    setImporting(true);
    try {
      if (wipeFirst && minDate && maxDate) {
        await onDeleteRange(minDate, maxDate);
      }
      await onImport(parsed.entries);
      setOpen(false);
      setParsed(null);
      setWipeFirst(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 transition-colors"
        title="Import shifts from a When I Work CSV export">
        <Upload size={14} /> Import from WIW
      </button>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4" onClick={() => !importing && setOpen(false)}>
          <div className="relative w-full max-w-3xl rounded-xl bg-white shadow-2xl flex flex-col max-h-[85vh]" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-900">Import shifts from When I Work</h3>
                <p className="text-xs text-gray-500">
                  Drop your WIW CSV export — works with any date range. Each row becomes a shift in Ratio.
                </p>
              </div>
              <button onClick={() => !importing && setOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {!parsed && (
                <div>
                  <button onClick={() => fileRef.current?.click()}
                    className="w-full rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 py-12 text-center hover:bg-gray-100 transition-colors">
                    <Upload className="mx-auto text-gray-400 mb-2" size={32} />
                    <div className="text-sm font-semibold text-gray-700">Click to upload WIW payroll export</div>
                    <div className="text-xs text-gray-500 mt-1">Accepts .xlsx (native WIW export) and .csv</div>
                  </button>
                  <input ref={fileRef} type="file"
                    accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
                </div>
              )}

              {parsed && (
                <div className="space-y-4">
                  <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
                    Parsed <b>{parsed.entries.length}</b> shifts across <b>{summary.length}</b> employees
                    {minDate && maxDate && <> from <b>{minDate}</b> to <b>{maxDate}</b></>}.
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm text-gray-900 mb-2">Employee matching</h4>
                    <div className="rounded-lg border border-gray-200 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-xs text-gray-500">
                          <tr>
                            <th className="px-3 py-2 text-left">WIW name</th>
                            <th className="px-3 py-2 text-left">Maps to Ratio user</th>
                            <th className="px-3 py-2 text-right">Shifts</th>
                            <th className="px-3 py-2 text-right">Hours</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.map(s => (
                            <tr key={s.wiwName} className={`border-t border-gray-100 ${s.uid ? '' : 'bg-amber-50'}`}>
                              <td className="px-3 py-2 font-medium text-gray-900">{s.wiwName}</td>
                              <td className="px-3 py-2">
                                <select value={s.uid || ''} onChange={e => remap(s.wiwName, e.target.value)}
                                  className={`w-full rounded border px-2 py-1 text-xs ${s.uid ? 'border-gray-300' : 'border-amber-300 bg-white'}`}>
                                  <option value="">— skip this person —</option>
                                  {approvedUsers.map(u => (
                                    <option key={u.uid} value={u.uid}>{u.displayName}</option>
                                  ))}
                                </select>
                              </td>
                              <td className="px-3 py-2 text-right text-gray-700">{s.rowCount}</td>
                              <td className="px-3 py-2 text-right text-gray-700">{s.totalHrs.toFixed(2)}h</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {summary.some(s => !s.uid) && (
                      <p className="mt-2 text-xs text-amber-700">
                        Rows in amber will be SKIPPED on import. Map them to a Ratio user above or accept the skip.
                      </p>
                    )}
                  </div>
                  <label className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 cursor-pointer">
                    <input type="checkbox" checked={wipeFirst} onChange={e => setWipeFirst(e.target.checked)}
                      className="mt-0.5" />
                    <span className="text-sm">
                      <b className="text-red-800">Delete existing shifts from {minDate} to {maxDate} first</b>
                      <span className="block text-xs text-red-700 mt-0.5">
                        Use this when migrating from WIW so the imported numbers are clean.
                        Existing Ratio shifts in that range will be permanently removed.
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </div>

            {parsed && (
              <div className="border-t bg-gray-50 px-6 py-3 flex items-center justify-between">
                <button onClick={() => setParsed(null)} disabled={importing}
                  className="text-sm text-gray-600 hover:text-gray-900">
                  ← Upload a different file
                </button>
                <button onClick={doImport} disabled={importing}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:bg-gray-300">
                  {importing ? 'Importing…' : `Import ${parsed.entries.filter(e => e.userId).length} shifts`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sick Days roster (year-to-date) ────────────────────────────────────
// Per-employee tally of sick days used vs remaining for the current
// calendar year, with probation status. Policy: 5 sick days per year,
// available once the 3-month probation is over. "Used" counts distinct
// calendar dates where a sickPay-tagged shift exists for that person.
function SickDaysTab({ rows, year, maxPerYear, probationDays, onSetHireDate }) {
  const [query, setQuery] = useState('');
  const filtered = query
    ? rows.filter(r => r.name.toLowerCase().includes(query.toLowerCase()))
    : rows;

  // Roll-up tallies for the header summary.
  const eligibleCount = rows.filter(r => r.eligible).length;
  const onProbationCount = rows.length - eligibleCount;
  const totalUsed = rows.reduce((s, r) => s + r.used, 0);
  const totalRemaining = rows.reduce((s, r) => s + r.remaining, 0);

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b bg-amber-50/40">
        <div className="flex flex-wrap items-center gap-3">
          <Activity size={18} className="text-amber-700 shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900">
              Sick Days · {year}
            </h3>
            <p className="text-xs text-gray-600">
              Policy: {maxPerYear} paid sick days per calendar year, available after the {probationDays}-day probation period (BC ESA minimum).
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-1 font-semibold">{eligibleCount} eligible</span>
            <span className="rounded-full bg-gray-100 text-gray-700 px-2 py-1 font-semibold">{onProbationCount} on probation</span>
            <span className="rounded-full bg-amber-100 text-amber-800 px-2 py-1 font-semibold">{totalUsed} used</span>
            <span className="rounded-full bg-blue-100 text-blue-800 px-2 py-1 font-semibold">{totalRemaining} remaining</span>
          </div>
        </div>
        <div className="mt-3 relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search staff…"
            className="w-full rounded-md border border-gray-300 pl-8 pr-3 py-1.5 text-sm" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2 text-left">Staff</th>
              <th className="px-4 py-2 text-left">Role</th>
              <th className="px-4 py-2 text-left">Hire date</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-center">Used</th>
              <th className="px-4 py-2 text-center">Remaining</th>
              <th className="px-4 py-2 text-left">Sick dates this year</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.uid} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-900">{r.name}</td>
                <td className="px-4 py-2 text-xs text-gray-600">{r.role}</td>
                <td className="px-4 py-2">
                  <input type="date" defaultValue={r.hireDate || ''}
                    onBlur={e => onSetHireDate(r.uid, e.target.value)}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-700" />
                  {r.hireDate && (
                    <div className="text-[10px] text-gray-400 mt-0.5">{r.daysIn} day{r.daysIn === 1 ? '' : 's'} in</div>
                  )}
                </td>
                <td className="px-4 py-2">
                  {r.onProbation
                    ? <span className="rounded-full bg-gray-100 text-gray-700 px-2 py-0.5 text-xs font-semibold">On probation</span>
                    : <span className="rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-semibold">Eligible</span>}
                </td>
                <td className={`px-4 py-2 text-center font-bold ${r.used > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                  {r.used}
                </td>
                <td className={`px-4 py-2 text-center font-bold ${r.remaining === 0 && r.eligible ? 'text-red-600' : 'text-blue-700'}`}>
                  {r.eligible ? r.remaining : '—'}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {r.sickDates.length === 0
                    ? <span className="text-gray-300">— none —</span>
                    : r.sickDates.map(d => (
                        <span key={d} className="inline-block rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 mr-1 mb-1">{d}</span>
                      ))}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-500 text-sm">
                {query ? `No staff match "${query}".` : 'No active staff at this centre yet.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[11px] text-gray-500 border-t bg-gray-50/50">
        Tip: a shift becomes "sick" when you toggle the Sick Pay flag while editing it. Sick shifts are paid out under the sick budget line and don't count toward regular payroll hours.
      </p>
    </div>
  );
}

// ── Main Admin Component ───────────────────────────────────────────────────────
export default function Admin() {
  const { user, activeCenterId, centerConfig, canSeeAdminPanel, canSeeCenterSettings } = useAuth();
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
  const [availabilityModalUser, setAvailabilityModalUser] = useState(null); // user object
  const [addStaffOpen, setAddStaffOpen]     = useState(false);
  const [editStaffUser, setEditStaffUser]   = useState(null);
  const [userSearch, setUserSearch]         = useState('');

  // Auto-scheduler state
  const [schedMonth, setSchedMonth]   = useState(MONTHS[new Date().getMonth()]);
  const [schedYear, setSchedYear]     = useState(new Date().getFullYear());
  // Range type: 'month' (current behaviour), 'week' (Mon–Sat of picked
  // date), or 'day' (single picked date). When week/day, the scheduler
  // takes startDate/endDate instead of month/year.
  const [schedRangeType, setSchedRangeType] = useState('month');
  const [schedDayDate,   setSchedDayDate]   = useState(format(new Date(), 'yyyy-MM-dd'));
  // Default week-anchor is the current week's Monday.
  const [schedWeekDate,  setSchedWeekDate]  = useState(
    format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd')
  );
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
  // Whether the Radius import card is expanded. Defaults false so the
  // card auto-collapses to a 1-line chip once a timesheet is loaded,
  // freeing vertical space for the per-person reconciliation below.
  // Owner clicks Re-import on the chip to expand again.
  const [radiusExpanded, setRadiusExpanded] = useState(false);
  const [radiusError, setRadiusError] = useState('');

  // Firestore subscriptions — all scoped to the active center.
  // Users use array-contains on centerIds (since some staff work at multiple
  // centers); everything else filters on the single centerId field.
  useEffect(() => {
    // Sliding date window for shifts / availability / openShifts so live
    // reads don't scale with centre-age. 180 days back covers payroll
    // history, weekly grid navigation, and auto-scheduler look-back; older
    // docs still exist in Firestore for ad-hoc queries.
    const WINDOW_DAYS = 180;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    const y = cutoff.getFullYear();
    const m = String(cutoff.getMonth() + 1).padStart(2, '0');
    const d = String(cutoff.getDate()).padStart(2, '0');
    const windowStart = `${y}-${m}-${d}`;

    const u1 = onSnapshot(
      query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
      snap => setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u2 = onSnapshot(
      query(
        collection(db, 'availability'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', windowStart),
        orderBy('date'),
      ),
      snap => setAvailability(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u3 = onSnapshot(
      query(
        collection(db, 'shifts'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', windowStart),
        orderBy('date'),
      ),
      snap => setShifts(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    const u4 = onSnapshot(
      query(
        collection(db, 'openShifts'),
        where('centerId', '==', activeCenterId),
        where('date', '>=', windowStart),
        orderBy('date'),
      ),
      snap => setOpenShiftsList(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
    // timeOffRequests stays unbounded — low volume per centre and no
    // single `date` field to filter on (range lives in startDate/endDate).
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

  // Owners, super-admins, and any account flagged `internal: true` are
  // hidden from "actual working staff" surfaces (weekly grid, Manage Users,
  // payroll, etc.). The displayName === 'Admin Team' check is a legacy
  // fallback so the existing internal account stays hidden until someone
  // sets the flag on its user doc — once the flag is set the name match
  // becomes irrelevant.
  // Admin Assistants show up in the staff list — they get scheduled and
  // appear on payroll like anyone else. Only true Owners and super-admins
  // are hidden from operational surfaces.
  const isVisibleStaff = (u) =>
    u && u.role !== 'owner' && u.role !== 'super_admin'
      && u.internal !== true
      && u.displayName !== 'Admin Team';

  // Resolve every user against the active centre so per-centre fields
  // (instructorType, priority, subRoles, guaranteed, approved, etc.)
  // hoist to the top level for this centre's view. Reads downstream
  // (`u.priority`, `u.instructorType`, …) keep working unchanged but
  // now reflect the centre-scoped value instead of a global one.
  const usersForCentre = useMemo(
    () => users.map(u => resolveUserForCenter(u, activeCenterId)),
    [users, activeCenterId],
  );

  const approvedUsers = usersForCentre
    .filter(u => u.approved && isVisibleStaff(u))
    .sort((a, b) => {
      const firstName = name => (name || '').split(' ')[0].toLowerCase();
      return firstName(a.displayName).localeCompare(firstName(b.displayName));
    });
  const pendingUsers  = usersForCentre.filter(u => !u.approved && isVisibleStaff(u));

  // User management
  //
  // Approval is per-centre — an admin at Centre A approving a user
  // does NOT auto-approve them at Centre B. We also seed a default
  // membership entry the first time we touch this centre's record so
  // every other field has a per-centre row to live in.
  const handleApprove = async (uid) => {
    const target = users.find(u => u.uid === uid || u.id === uid);
    const existing = target?.centerMemberships?.[activeCenterId];
    const payload = existing
      ? { [membershipFieldPath(activeCenterId, 'approved')]: true }
      : {
          [`centerMemberships.${activeCenterId}`]: {
            ...buildInitialMembership({
              instructorType: target?.instructorType,
              priority:       target?.priority,
              maxDaysPerWeek: target?.maxDaysPerWeek,
              subRoles:       target?.subRoles,
              guaranteed:     target?.guaranteed,
              approved:       true,
              isVolunteer:    target?.isVolunteer,
            }),
          },
        };
    // Keep legacy top-level `approved` in sync the FIRST time a user
    // gets approved anywhere — so any code that still reads the top
    // level (or queries for approved:true) keeps working. After that
    // we leave it alone — per-centre is the source of truth.
    if (target && target.approved !== true) payload.approved = true;
    await updateDoc(doc(db, 'users', uid), payload);
  };

  // Reject = disable the Firebase Auth account AND delete the Firestore
  // profile. We can't do the Auth half from the client (the client SDK can
  // only touch the *current* user), so this routes through the server-side
  // endpoint at /api/users/reject-user, which uses the Admin SDK.
  //
  // Without the server route, a "rejected" user could still authenticate
  // and just bounce on the pending screen — their credential would linger
  // on the platform indefinitely. The endpoint fully removes them.
  // POST /api/users/create-staff — admin SDK creates the Auth account +
  // Firestore profile in one round trip so the owner doesn't have to
  // wait for the new hire to sign up. Optionally fires a password-reset
  // email so the new user can set their own password immediately.
  const handleCreateStaff = async (payload) => {
    const idToken = await auth.currentUser?.getIdToken();
    const r = await fetch('/api/users/create-staff', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        ...payload,
        centerId: activeCenterId,
        continueUrl: window.location.origin + '/login',
      }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data?.error || `Request failed (${r.status})`);
    }
    const data = await r.json();
    setAddStaffOpen(false);
    if (data.resetEmailSent) {
      toast.success(`Created ${data.displayName}. Reset email sent to ${data.email}.`);
    } else if (data.resetEmailError) {
      toast.error(`Created ${data.displayName}, but reset email failed: ${data.resetEmailError}`, 8000);
    } else {
      toast.success(`Created ${data.displayName}.`);
    }
  };

  // Fire a password reset email to an existing staff member from the
  // staff card. Uses the same /api/send-password-reset endpoint as the
  // login page so there's one delivery path to maintain.
  const handleSendStaffReset = async (target) => {
    if (!target?.email) {
      toast.error('No email on file for this staff member.');
      return;
    }
    const ok = await confirmDialog({
      title: 'Send password reset?',
      message: `An email will be sent to ${target.email} with a link to reset their password.`,
      confirmText: 'Send reset email',
    });
    if (!ok) return;
    try {
      const r = await fetch('/api/send-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: target.email,
          continueUrl: window.location.origin + '/login',
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data?.error || `Request failed (${r.status})`);
      }
      toast.success(`Reset email sent to ${target.email}.`);
    } catch (err) {
      toast.error(err?.message || 'Failed to send reset email.');
    }
  };

  const handleReject = async (uid) => {
    const target = users.find(u => u.id === uid);
    const niceName = target?.displayName || target?.email || 'this user';
    const ok = await confirmDialog({
      title: `Reject ${niceName}?`,
      message:
        'Their Firebase login will be disabled and their profile will be removed. ' +
        'They will need to sign up again from scratch if they want back in.',
      confirmText: 'Reject user',
      danger: true,
    });
    if (!ok) return;

    try {
      const idToken = user ? await user.getIdToken() : null;
      if (!idToken) throw new Error('Not signed in.');
      const r = await fetch('/api/users/reject-user', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ uid }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.error || `Reject failed (${r.status}).`);
      }
      if (data.warning) {
        toast.error(data.warning, 7000);
      } else {
        toast.success(`${niceName} has been rejected.`);
      }
    } catch (err) {
      toast.error(err?.message || 'Failed to reject user.');
    }
  };

  // Approving a time-off request also clears any shifts the user already
  // had inside that range — otherwise they'd stay on the schedule on a day
  // they have approved leave. We convert them to open shifts (rather than
  // delete) so coverage can still be picked up by someone else. All writes
  // go through a single batch so an interruption leaves a consistent state.
  // Date fields are 'YYYY-MM-DD' strings, which compare lexically as ISO.
  const handleApproveTimeOff = async (req) => {
    await updateDoc(doc(db, 'timeOffRequests', req.id), { status: 'approved' });

    const conflicting = shifts.filter(s =>
      s.userId === req.userId &&
      s.date && s.date >= req.startDate && s.date <= req.endDate,
    );
    if (conflicting.length > 0) {
      const batch = writeBatch(db);
      for (const s of conflicting) {
        batch.delete(doc(db, 'shifts', s.id));
        const newRef = doc(collection(db, 'openShifts'));
        batch.set(newRef, {
          date:        s.date,
          startTime:   s.startTime,
          endTime:     s.endTime,
          role:        s.role || 'Instructor',
          subRole:     s.subRole || 'Elementary',
          shiftType:   s.shiftType || 'In-Centre',
          centerId:    s.centerId || activeCenterId,
          status:      'open',
          claimedBy:   null,
          claimedByName: null,
          postedAt:    new Date().toISOString(),
          // Provenance so admins can tell where this open shift came from.
          openedFrom:        'time_off_approval',
          originalUserId:    s.userId || null,
          originalUserName:  s.userName || req.userName || null,
        });
      }
      await batch.commit();
    }

    const recipient = approvedUsers.find(u => u.id === req.userId);
    if (recipient?.email) {
      notifyTimeOffDecision(req, recipient, 'approved');
    }
  };
  // Per-centre operational fields (instructorType, priority, subRoles,
  // guaranteed, approved, maxDaysPerWeek) write to the active centre's
  // membership entry. Everything else writes to the top-level field as
  // before. See src/lib/centerMembership.js for the full list.
  //
  // First-touch seeding: if there's no membership entry for this centre
  // yet, we create the whole map so subsequent edits don't see undefined
  // siblings. This is what keeps a user's Centre A edits truly isolated
  // from their Centre B settings.
  const handleUpdateUserField = async (uid, field, value) => {
    if (!isPerCentreField(field)) {
      await updateDoc(doc(db, 'users', uid), { [field]: value });
      return;
    }
    const target = users.find(u => u.uid === uid || u.id === uid);
    const hasMembership = !!target?.centerMemberships?.[activeCenterId];
    if (hasMembership) {
      await updateDoc(doc(db, 'users', uid), {
        [membershipFieldPath(activeCenterId, field)]: value,
      });
      return;
    }
    // No row for this centre yet — seed it with sensible defaults
    // (carried over from the legacy top-level values so the user
    // doesn't appear to reset when an admin clicks one field) and
    // overlay the new value for the field being edited.
    const seeded = buildInitialMembership({
      instructorType: target?.instructorType,
      priority:       target?.priority,
      maxDaysPerWeek: target?.maxDaysPerWeek,
      subRoles:       target?.subRoles,
      guaranteed:     target?.guaranteed,
      approved:       target?.approved,
      isVolunteer:    target?.isVolunteer,
    });
    seeded[field] = value;
    await updateDoc(doc(db, 'users', uid), {
      [`centerMemberships.${activeCenterId}`]: seeded,
    });
  };

  // Shift CRUD
  const handleAddShift = async (shiftData) => {
    await addDoc(collection(db, 'shifts'), { ...shiftData, centerId: shiftData.centerId || activeCenterId });
  };

  // Bulk-delete shifts in a date range (single day if from === to).
  // Used both for stat-holiday days AND for cleaning out a whole period
  // before importing from When I Work. Currently UNREFERENCED — the
  // toolbar that used to surface it was removed. Kept around because
  // owner may want it back (in a Settings menu or admin-only context).
  // eslint-disable-next-line no-unused-vars
  const handleBulkDeleteShiftsForDate = async (from, to) => {
    if (!from) return;
    const end = to || from;
    const matching = shifts.filter(s => s.date >= from && s.date <= end);
    if (matching.length === 0) {
      toast.info(`No shifts found between ${from} and ${end}.`);
      return;
    }
    const names = [...new Set(matching.map(s => s.userName).filter(Boolean))];
    const isRange = from !== end;
    const ok = await confirmDialog({
      title: `Delete ${matching.length} shift${matching.length === 1 ? '' : 's'} ${isRange ? `from ${from} to ${end}` : `on ${from}`}?`,
      body: `This will permanently remove every Ratio shift in that ${isRange ? 'date range' : 'date'} at this centre.\n\nStaff affected (${names.length}):\n• ${names.slice(0, 12).join('\n• ')}${names.length > 12 ? `\n• …and ${names.length - 12} more` : ''}`,
      confirmLabel: `Delete ${matching.length} shift${matching.length === 1 ? '' : 's'}`,
      destructive: true,
    });
    if (!ok) return;
    // Firestore batches max out at 500 writes — chunk.
    for (let i = 0; i < matching.length; i += 400) {
      const batch = writeBatch(db);
      for (const s of matching.slice(i, i + 400)) batch.delete(doc(db, 'shifts', s.id));
      await batch.commit();
    }
    toast.success(`Deleted ${matching.length} shift${matching.length === 1 ? '' : 's'}.`);
  };

  // Bulk-import shifts from a parsed When I Work CSV. Each entry has been
  // pre-matched in the modal to either a Ratio user (by uid) or marked
  // "skip" by the owner. We just batch-write the chosen ones.
  // Currently UNREFERENCED — the WIW import button was removed from the
  // payroll toolbar. Kept so re-mounting the importer later doesn't
  // require re-writing the handler.
  // eslint-disable-next-line no-unused-vars
  const handleImportWiwShifts = async (entries) => {
    const valid = entries.filter(e => e.userId && e.date && e.startTime && e.endTime);
    if (valid.length === 0) {
      toast.info('No valid shifts to import.');
      return 0;
    }
    for (let i = 0; i < valid.length; i += 400) {
      const batch = writeBatch(db);
      for (const e of valid.slice(i, i + 400)) {
        const ref = doc(collection(db, 'shifts'));
        batch.set(ref, {
          userId: e.userId,
          userName: e.userName,
          date: e.date,
          startTime: e.startTime,
          endTime: e.endTime,
          role: e.role || 'Instructor',
          subRole: e.subRole || 'Elementary',
          shiftType: 'In-Centre',
          status: 'published',
          source: 'wiw-import',
          centerId: activeCenterId,
        });
      }
      await batch.commit();
    }
    toast.success(`Imported ${valid.length} shift${valid.length === 1 ? '' : 's'} from When I Work.`);
    return valid.length;
  };

  // One-click "Schedule shift" from a Radius CSV row.
  //
  // Use case: a staff member clocked into Radius but doesn't have a
  // Ratio-side shift for that day, so the Payroll tab flags them
  // "Not scheduled". Instead of forcing the owner to open Add Shift and
  // re-type the times, this turns the actual clock-in/out into a real
  // shift in one click.
  //
  // Behaviour: try to match the Radius row's staff name to an approved
  // user by displayName; if no match, fall back to opening the existing
  // AddShiftModal so the owner can pick the right person manually.
  // Currently UNREFERENCED — the "Schedule shift" button on unscheduled-
  // Radius rows was removed per owner request (payroll is not the right
  // surface for creating shifts). Kept around so it can be re-mounted
  // from elsewhere (e.g. Manage Schedule) without rewriting.
  // eslint-disable-next-line no-unused-vars
  const handleScheduleFromRadius = async (personName, radiusEntry) => {
    const user = approvedUsers.find(
      u => (u.displayName || '').toLowerCase() === (personName || '').toLowerCase()
    );
    if (!user) {
      // Can't match by name — open Add Shift modal pre-filled with the date.
      setAddShiftModal({ date: radiusEntry.date, user: null });
      return;
    }
    const subs = user.subRoles || [];
    const subRole = subs.includes('Online')     ? 'Online'
                  : subs.includes('Highschool') ? 'Highschool'
                  : 'Elementary';
    await handleAddShift({
      userId: user.uid,
      userName: user.displayName,
      date: radiusEntry.date,
      startTime: normalizeTimeToHHMM(radiusEntry.timeIn),
      endTime:   normalizeTimeToHHMM(radiusEntry.timeOut),
      role: user.instructorType || '',
      shiftType: 'In-Centre',
      subRole,
      // Created from Radius — mark the source so we can audit later
      // and so the existing payroll-compare logic treats it as confirmed.
      source: 'radius-import',
      status: 'published',
    });
    try {
      const { toast } = await import('../lib/notify');
      toast.success(`Shift created for ${user.displayName} on ${radiusEntry.date}`);
    } catch { /* notify optional */ }
  };

  const handleSaveEditShift = async ({ startTime, endTime, role, shiftType, subRole, sickPay }) => {
    await updateDoc(doc(db, 'shifts', editShiftModal.id), {
      startTime, endTime, role, shiftType, subRole,
      sickPay: !!sickPay,
    });
    setEditShiftModal(null);
  };

  const handleDeleteEditShift = async () => {
    await deleteDoc(doc(db, 'shifts', editShiftModal.id));
    setEditShiftModal(null);
  };

  // Open Shifts
  const handleAddOpenShift = async ({ date, startTime, endTime, role, subRole }) => {
    const shiftPayload = {
      date, startTime, endTime, role,
      subRole: subRole || 'Elementary',
      centerId: activeCenterId,
      status: 'open', claimedBy: null, claimedByName: null,
      postedAt: new Date().toISOString(),
    };
    await addDoc(collection(db, 'openShifts'), shiftPayload);

    // Email every approved staff member with a real email address.
    const staffEmails = approvedUsers
      .filter(u => u.email)
      .map(u => ({ email: u.email, displayName: u.displayName }));
    notifyOpenShift(shiftPayload, staffEmails);
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
    // Includes drafts — admin's header total is "planned hours this week",
    // not "hours instructors have been told about".
    return shifts
      .filter(s => s.date >= ws && s.date <= we)
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

      // Volunteers are not auto-scheduled — they're unpaid help that the
      // owner adds to specific days manually. They stay in approvedUsers
      // for the "Add from approved staff" picker in Edit Day mode, but
      // the auto-scheduler ignores them.
      const schedulableUsers = approvedUsers.filter(u => u.isVolunteer !== true);

      // Range routing — day/week passes explicit startDate/endDate so the
      // engine doesn't generate anything outside the picked window.
      const rangeArgs = (() => {
        if (schedRangeType === 'day') {
          return { startDate: schedDayDate, endDate: schedDayDate };
        }
        if (schedRangeType === 'week') {
          const wkStart = new Date(schedWeekDate + 'T00:00:00');
          const wkEnd   = addDays(wkStart, 6);
          return {
            startDate: format(wkStart, 'yyyy-MM-dd'),
            endDate:   format(wkEnd,   'yyyy-MM-dd'),
          };
        }
        return { month: schedMonth, year: schedYear };
      })();

      const result = generateSchedule({
        instructors: schedulableUsers,
        availability: filteredAvailability,
        previousMonthsAvail,
        ...rangeArgs,
        config: schedConfig,
        centerConfig,   // per-center hours, fixed staff, guaranteed names
        priorShifts: shifts,  // seed fairness from already-saved shifts this month
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
    // Volunteers get role='Volunteer' so the shift is visually labelled as
    // such on the schedule. Payroll filtering keys off the user flag, not
    // the shift role, so this is purely cosmetic / informational.
    const role = u?.isVolunteer === true
      ? 'Volunteer'
      : (u?.instructorType || 'Instructor');
    setEditingDay(p => ({
      ...p,
      assignedEmployees: [...p.assignedEmployees, name],
      roles:      { ...(p.roles      || {}), [name]: role },
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
          // Fixed-staff shifts also land as drafts so admin can review the
          // whole month together before publishing. (They have predictable
          // hours so review is fast, but the draft step keeps the
          // experience consistent.)
          status: 'draft',
          autoScheduled: true,
          fixedStaff: true,
        });
      }
    }
    await insertBatch.commit();
  };

  // (Removed: handleSeedFixedStaffWeek + handlePurgeAndReseed — the
  // associated "Sync Fixed Staff This Week" and "Fix Duplicates" buttons
  // are gone. If a one-time cleanup is ever needed again, check git
  // history for the previous implementations.)

  // Reset ALL shifts in Firestore — complete clean slate. Gated by a
  // type-to-confirm input so an accidental click can't wipe everything.
  // ── Multi-center migration (Phase 1 groundwork) ──────────────────────────
  // One-time backfill: creates the centers/langley doc and stamps centerId
  // onto every existing doc that doesn't already have one. Safe to run
  // multiple times — it skips docs that already have centerId.
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [migrationResult, setMigrationResult] = useState(null);
  const handleRunCenterMigration = async () => {
    const ok = await confirmDialog({
      title: 'Run multi-center migration?',
      message:
        `• Creates a "${DEFAULT_CENTER_ID}" center doc if one doesn't exist\n` +
        `• Stamps centerId="${DEFAULT_CENTER_ID}" onto every existing user, shift, availability, openShift, time-off request, chat, announcement, and notificationPreferences doc\n` +
        '• Skips any doc that already has a centerId (safe to run multiple times)',
      confirmText: 'Run migration',
    });
    if (!ok) return;
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

  // Publish a set of draft shifts. Flips each one's status from 'draft'
  // to 'live' atomically. Idempotent: anything that's already live is
  // skipped, so calling this on a mixed set is safe.
  //
  // Email/chat notification fires only the *first* time shifts are
  // published in a given month — we check whether any live shifts
  // already exist for that month before sending, so editing one shift
  // and re-publishing doesn't spam staff. `silent: true` skips notify
  // entirely (useful for per-shift publishes that follow a big bulk
  // publish in the same minute).
  const handlePublishShifts = async (shiftDocs, { silent = false } = {}) => {
    const drafts = (shiftDocs || []).filter(s => s.status === 'draft');
    if (drafts.length === 0) {
      toast.info('Nothing to publish — these shifts are already live.');
      return { published: 0 };
    }
    // Group dates by YYYY-MM so we can decide per-month whether this is
    // a first-publish (notify) or a follow-up (silent).
    const monthsTouched = new Set(drafts.map(s => (s.date || '').slice(0, 7)));

    const batch = writeBatch(db);
    for (const s of drafts) {
      batch.update(doc(db, 'shifts', s.id), {
        status: 'live',
        publishedAt: serverTimestamp(),
      });
    }
    await batch.commit();

    if (!silent) {
      // Per-month notification fan-out. Two distinct signals:
      //
      //  1. CHAT POST — gated to once-per-month-per-centre. The "schedule
      //     is live!" announcement is spammy if repeated; only fires on
      //     the FIRST publish for a given month (no prior live shifts).
      //
      //  2. EMAIL — fires on EVERY draft→live transition, because the
      //     emails are now PER-USER and each recipient only sees their
      //     own shifts. Mid-month additions (a missing shift, a new
      //     instructor onboarded) correctly notify just the affected
      //     people. The old "first publish" gate was hiding these.
      for (const ym of monthsTouched) {
        const monthStart = `${ym}-01`;
        const [yy, mm] = ym.split('-').map(Number);
        const lastDay = new Date(yy, mm, 0).getDate();
        const monthEnd = `${ym}-${String(lastDay).padStart(2, '0')}`;
        const publishedThisMonth = drafts.filter(s => s.date >= monthStart && s.date <= monthEnd);
        const monthLabel = new Date(yy, mm - 1, 1).toLocaleDateString('en-US',
          { month: 'long', year: 'numeric' });

        // ── Chat announcement (gated to first-publish of the month) ──
        const otherLiveInMonth = shifts.filter(s =>
          s.status !== 'draft' &&
          s.date >= monthStart && s.date <= monthEnd &&
          !drafts.some(d => d.id === s.id)
        );
        if (otherLiveInMonth.length === 0) {
          await addDoc(collection(db, 'chat'), {
            text: `📅 The ${monthLabel} schedule is live! Check your shifts on the Schedule page.`,
            userId: 'system',
            userName: centerConfig?.name || 'Mathnasium',
            userRole: 'system',
            centerId: activeCenterId,
            createdAt: serverTimestamp(),
            type: 'schedule_posted',
          });
        }

        // ── Per-user personalised emails (NOT gated) ──
        // Each instructor gets their own shift list + count — never the
        // centre total. Users with zero shifts in this batch are silently
        // skipped (no inbox spam). Emails live in users/{uid}/private/
        // contact post-privacy-split, so attachEmails() reads them from
        // the sub-doc when the user doc no longer carries the field.
        try {
          const usersWithEmail = await attachEmails(approvedUsers);
          await notifySchedulePosted({
            shifts:     publishedThisMonth,
            staffUsers: usersWithEmail,
            monthLabel: new Date(yy, mm - 1, 1).toLocaleDateString('en-US', { month: 'long' }),
            year:       yy,
          });
        } catch (notifyErr) {
          // Fire-and-forget — never block the publish flow on email send.
          console.error('[publish] notification batch failed:', notifyErr);
        }
      }
    }

    toast.success(`Published ${drafts.length} shift${drafts.length === 1 ? '' : 's'}.`);
    return { published: drafts.length };
  };

  // Wrappers for the three publish granularities — keep call sites simple.
  const handlePublishSingleShift = (s) => handlePublishShifts([s]);
  const handlePublishDay = (dateStr) => {
    const dayDrafts = shifts.filter(s => s.date === dateStr && s.status === 'draft');
    return handlePublishShifts(dayDrafts);
  };
  const handlePublishWeek = (weekStartDate, weekEndDate) => {
    const weekDrafts = shifts.filter(s =>
      s.date >= weekStartDate && s.date <= weekEndDate && s.status === 'draft'
    );
    return handlePublishShifts(weekDrafts);
  };
  const handlePublishAllDrafts = () => {
    const allDrafts = shifts.filter(s => s.status === 'draft');
    return handlePublishShifts(allDrafts);
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
            // Drafts by default — owner publishes from the weekly grid
            // (per-shift / per-day / per-week). Instructors don't see
            // drafts; the "schedule posted" email fires on first publish.
            status: 'draft', autoScheduled: true,
          });
        }
      }
      await batch.commit();

      const allDates = draftSchedule.days.map(d => d.date);
      await seedFixedShiftsForDates(allDates);

      const totalShifts = draftSchedule.days.reduce((s, d) => s + d.assignedEmployees.length, 0);

      // No chat post / staff email here anymore — those happen on Publish,
      // since instructors don't see drafts. Owner goes to the weekly grid
      // to review and publish.
      setDraftSchedule(null);
      toast.success(`${totalShifts} shifts saved as drafts. Open the weekly grid to review and publish.`);
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

  // Volunteers — per-user toggle in Manage Users. Excluded from hourly
  // payroll AND from the Radius timesheet compare so they don't appear on
  // pay reports at all. Resolved against the active centre so a person
  // can be a volunteer at one centre and paid staff at another.
  const volunteerNames = useMemo(() => {
    const set = new Set();
    for (const u of usersForCentre) {
      if (u.isVolunteer === true && u.displayName) set.add(u.displayName);
    }
    return set;
  }, [usersForCentre]);

  // Owners, super-admins, and the shared "Admin Team" account never belong
  // on payroll either — keep their names out by display name (which is what
  // shifts reference).
  const hiddenFromOps = useMemo(() => {
    const set = new Set();
    for (const u of users) {
      const hidden = u.role === 'owner' || u.role === 'super_admin'
        || u.internal === true
        || u.displayName === 'Admin Team';
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
      s.role !== 'Volunteer' &&
      !salaryStaff.has(s.userName) &&
      !volunteerNames.has(s.userName) &&
      !hiddenFromOps.has(s.userName)
    );

    // Also include fixed staff from FIXED_SCHEDULES who may not have Firestore shifts yet
    const byPerson = {};

    // From Firestore shifts. Each shift contributes to either the worked
    // bucket (totalHours / shifts) OR the sick bucket (sickHours / sick
    // shift count) based on its sickPay flag. Worked totals stay the
    // headline figure; sick totals show as a separate column so payroll
    // can pay them out under the sick-pay budget line.
    for (const s of periodShifts) {
      const key = s.userName || s.userId;
      if (!byPerson[key]) {
        // usersForCentre hoists the per-centre instructorType so payroll
        // shows "Host" vs "Instructor" based on what they did AT THIS
        // CENTRE, not whatever they happen to be at another one.
        const user = usersForCentre.find(u => u.displayName === s.userName || u.uid === s.userId);
        byPerson[key] = {
          name: s.userName || key,
          role: s.role || user?.instructorType || 'Instructor',
          shifts: [],
          totalHours: 0,
          // payHours = what we actually pay. Defaults to scheduled total
          // but each shift can override (e.g. instructor stayed an extra
          // half hour). See the Pay h column on the per-person table.
          payHours: 0,
          sickHours: 0,
          sickCount: 0,
        };
      }
      const hrs = shiftHours(s);
      const isSick = !!s.sickPay;
      // payHoursOverride is a per-shift owner override. When unset, pay
      // matches scheduled (the centre's default — "we pay what we
      // scheduled"). When set (via double-click on the Pay h cell), the
      // override wins and the diff between scheduled and paid is
      // intentional (early leave / stayed late / negotiated time).
      const payHrs = (typeof s.payHoursOverride === 'number' && isFinite(s.payHoursOverride))
        ? s.payHoursOverride
        : hrs;
      byPerson[key].shifts.push({
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        hours: hrs,
        payHours: payHrs,
        payHoursOverride: typeof s.payHoursOverride === 'number' ? s.payHoursOverride : null,
        // payrollResolved — admin has explicitly signed off this shift's
        // Pay h value (even when the Sched/Actual diff is flagged red).
        // The red flag dims to green once true; the value remains editable.
        payrollResolved: s.payrollResolved === true,
        shiftId: s.id,
        sick: isSick,
      });
      if (isSick) {
        byPerson[key].sickHours += hrs;
        byPerson[key].sickCount += 1;
      } else {
        byPerson[key].totalHours += hrs;
        byPerson[key].payHours   += payHrs;
      }
    }

    // Sort each person's shifts by date + round totals so the UI doesn't
    // show 7.000000001-style float dust.
    for (const key of Object.keys(byPerson)) {
      byPerson[key].shifts.sort((a, b) => a.date.localeCompare(b.date));
      byPerson[key].totalHours = Math.round(byPerson[key].totalHours * 100) / 100;
      byPerson[key].payHours   = Math.round(byPerson[key].payHours   * 100) / 100;
      byPerson[key].sickHours  = Math.round(byPerson[key].sickHours  * 100) / 100;
    }

    // ─── Stat (statutory holiday) pay ───────────────────────────────────
    // For each stat holiday in the pay period, anyone with 15+ shifts in
    // the 30 calendar days BEFORE that holiday qualifies. Their stat-pay
    // hours for that day = avg hours per qualifying shift (BC ESA's
    // "average day"), rounded to the nearest 0.01h. Multiple stat days
    // in the same pay period add up.
    //
    // Note: people who qualify (15+ prior-30-day shifts) but have NO
    // shifts in the pay period itself won't appear here, since this loop
    // only walks byPerson — which is built from shifts inside the period.
    // Rare (typically a vacationer); admin can add a manual entry.
    const allShiftsByName = {};
    for (const s of shifts) {
      if (!s.userName || !s.date) continue;
      if (!allShiftsByName[s.userName]) allShiftsByName[s.userName] = [];
      allShiftsByName[s.userName].push(s);
    }
    const statHolidays = (Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [])
      .filter(h => h?.date && h.date >= payStart && h.date <= payEnd);
    const minusDays = (dateStr, n) => {
      const d = new Date(dateStr + 'T00:00:00');
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };
    for (const key of Object.keys(byPerson)) {
      const person = byPerson[key];
      const personShifts = allShiftsByName[person.name] || [];
      person.statHours = 0;
      person.statDays = 0;
      person.statEntries = []; // [{ date, name, hours, basisShifts }]
      for (const h of statHolidays) {
        const windowStart = minusDays(h.date, 30);
        const relevant = personShifts.filter(s => s.date >= windowStart && s.date < h.date);
        if (relevant.length < 15) continue;
        const totalHrs = relevant.reduce((sum, s) => sum + shiftHours(s), 0);
        const avg = Math.round((totalHrs / relevant.length) * 100) / 100;
        person.statHours += avg;
        person.statDays  += 1;
        person.statEntries.push({
          date: h.date,
          name: h.name || 'Statutory Holiday',
          hours: avg,
          basisShifts: relevant.length,
        });
      }
      person.statHours = Math.round(person.statHours * 100) / 100;
    }

    // Sort people alphabetically by last name
    return Object.values(byPerson).sort((a, b) => {
      const lastA = a.name.split(' ').pop() || a.name;
      const lastB = b.name.split(' ').pop() || b.name;
      return lastA.localeCompare(lastB);
    });
  }, [shifts, usersForCentre, payStart, payEnd, salaryStaff, volunteerNames, hiddenFromOps, centerConfig]);

  // Sick days tracker — per-user counts for the current calendar year.
  //
  // Policy: every employee who has completed 3-month probation is eligible
  // for 5 sick days per calendar year (BC ESA minimum). We count any
  // shifts with sickPay === true in the current year, regardless of pay
  // period. Probation start date is taken from the user's hireDate field
  // if set; otherwise falls back to the Firestore createdAt timestamp.
  const SICK_DAYS_PER_YEAR = 5;
  const PROBATION_DAYS = 90;
  const sickDaysSummary = useMemo(() => {
    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;
    const yearEnd   = `${now.getFullYear()}-12-31`;
    const today     = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

    // Used = count of distinct dates with sick shifts in the current year.
    // (If they took half a day sick, we count it as 1 — same as employers
    // typically do.)
    const sickDatesByName = new Map();
    for (const s of shifts) {
      if (!s.sickPay || !s.userName || !s.date) continue;
      if (s.date < yearStart || s.date > yearEnd) continue;
      if (!sickDatesByName.has(s.userName)) sickDatesByName.set(s.userName, new Set());
      sickDatesByName.get(s.userName).add(s.date);
    }

    const out = [];
    for (const u of approvedUsers) {
      if (!u.displayName) continue;
      // Skip people we already exclude from payroll (volunteers, hidden).
      if (volunteerNames.has(u.displayName) || hiddenFromOps.has(u.displayName)) continue;

      // Probation calculation
      const hire = u.hireDate
        || (u.approvedAt?.toDate ? u.approvedAt.toDate().toISOString().slice(0,10) : null)
        || (u.createdAt?.toDate  ? u.createdAt.toDate().toISOString().slice(0,10)  : null);
      let onProbation = true, daysIn = 0;
      if (hire) {
        const d1 = new Date(hire + 'T00:00:00');
        const d2 = new Date(today + 'T00:00:00');
        daysIn = Math.floor((d2 - d1) / (24 * 3600 * 1000));
        onProbation = daysIn < PROBATION_DAYS;
      }

      const used = (sickDatesByName.get(u.displayName) || new Set()).size;
      const remaining = onProbation ? 0 : Math.max(0, SICK_DAYS_PER_YEAR - used);

      out.push({
        uid: u.uid,
        name: u.displayName,
        role: u.instructorType || 'Instructor',
        hireDate: hire,
        daysIn,
        onProbation,
        used,
        remaining,
        eligible: !onProbation,
        // Per-date list for the expandable tooltip
        sickDates: [...(sickDatesByName.get(u.displayName) || new Set())].sort(),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [shifts, approvedUsers, volunteerNames, hiddenFromOps]);

  // Sub-tab inside Manage Payroll: "This period" or "Sick days".
  const [payrollSubtab, setPayrollSubtab] = useState('period');

  // Diagnostic for stat pay — flags WHY a person did or didn't qualify
  // for stat pay on each holiday in the pay period. Used by the small
  // info panel on the payroll tab when stat pay isn't showing up.
  const statDiagnostic = useMemo(() => {
    if (!payStart || !payEnd) return null;
    const holidaysList = Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [];
    const inPeriod = holidaysList.filter(h => h?.date && h.date >= payStart && h.date <= payEnd);

    const minusDays = (dateStr, n) => {
      const d = new Date(dateStr + 'T00:00:00');
      d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };
    const byName = {};
    for (const s of shifts) {
      if (!s.userName || !s.date) continue;
      if (!byName[s.userName]) byName[s.userName] = [];
      byName[s.userName].push(s);
    }
    const detail = inPeriod.map(h => {
      const windowStart = minusDays(h.date, 30);
      const perPerson = Object.entries(byName).map(([name, ss]) => {
        const relevant = ss.filter(s => s.date >= windowStart && s.date < h.date);
        return { name, count: relevant.length, qualifies: relevant.length >= 15 };
      }).sort((a, b) => b.count - a.count);
      return { holiday: h, windowStart, perPerson };
    });
    return {
      holidaysConfigured: holidaysList.length,
      inPeriod,
      detail,
    };
  }, [shifts, centerConfig?.holidays, payStart, payEnd]);

  // Update a user's hire date (used by the Sick days tab so the owner
  // can correct probation dates without going to Manage Staff).
  const handleSetHireDate = async (userId, dateStr) => {
    if (!userId) return;
    await updateDoc(doc(db, 'users', userId), { hireDate: dateStr || null });
    try { toast.success('Hire date saved'); } catch { /* ignore */ }
  };

  // Pay period helpers
  const payPeriodLabel = payStart && payEnd
    ? `${new Date(payStart + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(payEnd + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';

  // Payout date label — for centres on the 11th–25th / 26th–10th schedule
  // the pattern is: period ending on the 25th → paid on the 30th; period
  // ending on the 10th → paid on the 15th. Both fall 5 days after the
  // period close. If the centre's period ends on a different day, we
  // still show end+5 (e.g. ending 31st → paid 5 days later) which matches
  // the same "5-day arrears" cadence.
  const payoutLabel = payEnd ? (() => {
    const end = new Date(payEnd + 'T00:00:00');
    end.setDate(end.getDate() + 5);
    return end.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  })() : '';

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

  // Map an instructorType / role string to the short code used in the
  // owner's existing QuickBooks worksheet. Best-effort — anything we
  // don't recognise defaults to 'I' (Instructor). Update the mapping
  // here if the centre adds a new role abbreviation.
  const roleAbbrev = (role) => {
    const r = String(role || '').toLowerCase();
    if (r.includes('director'))  return 'CD';
    if (r.includes('manager'))   return 'CD';
    if (r.includes('assistant')) return 'ACD';
    if (r.includes('admin'))     return 'ACD';
    if (r.includes('lead'))      return 'LI';
    if (r.includes('volunteer')) return 'V';
    if (r.includes('host'))      return 'I';
    return 'I';
  };

  // Export to XLSX — two sheets:
  //   1. "Detail"     — every shift, per person + totals (existing format)
  //   2. "Attendance" — one row per person for QuickBooks (Total Hours =
  //      Payroll Hours, the owner's bookkeeping value). Volunteers count
  //      0 in the Employees column; everyone else is 1. Sick pay sums the
  //      per-person sickHours. Special Cases stays empty for manual fill.
  const handleExportPayroll = async () => {
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

    // Dynamically load SheetJS (same pattern as the Radius importer).
    if (!window.XLSX) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    const XLSX = window.XLSX;

    // ── Sheet 1: Detail (per shift, per person + per-person totals) ──
    const detailRows = [
      ['Name', 'Role', 'Date', 'Start', 'End', 'Scheduled h', 'Payroll h', 'Resolved'],
    ];
    for (const person of payrollSummary) {
      for (const s of person.shifts) {
        const dateLabel = new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        detailRows.push([
          person.name,
          person.role,
          dateLabel,
          fmtTime(s.startTime),
          fmtTime(s.endTime),
          s.hours.toFixed(2),
          (s.payHours ?? s.hours).toFixed(2),
          s.payrollResolved ? '✓' : '',
        ]);
      }
      detailRows.push([
        person.name, '', 'TOTAL', '', '',
        person.totalHours.toFixed(2),
        (person.payHours ?? person.totalHours).toFixed(2),
        '',
      ]);
      detailRows.push([]);
    }
    const grandPay = payrollSummary.reduce(
      (s, p) => s + (p.payHours ?? p.totalHours ?? 0), 0,
    );
    detailRows.push([
      '', '', 'GRAND TOTAL', '', '',
      Math.round(totalPayrollHours * 100) / 100,
      Math.round(grandPay * 100) / 100,
      '',
    ]);

    // ── Sheet 2: Attendance (QuickBooks-shaped) ──
    const attendanceRows = [
      ['Employee Attendance', 'Total Hours', 'Employees', 'Sick Pay', 'Special Cases'],
    ];
    let totalHoursSum = 0;
    let employeesCount = 0;
    let sickSum = 0;
    // Sort alphabetically by last name where possible — matches the
    // owner's existing template format.
    const lastNameKey = (n) => {
      const parts = String(n || '').trim().split(/\s+/);
      return (parts[parts.length - 1] || '').toLowerCase();
    };
    const sorted = [...payrollSummary].sort((a, b) =>
      lastNameKey(a.name).localeCompare(lastNameKey(b.name)),
    );
    for (const person of sorted) {
      const abbrev = roleAbbrev(person.role);
      const isVolunteer = abbrev === 'V';
      const totalH = Math.round((person.payHours ?? person.totalHours ?? 0) * 100) / 100;
      const sickH = Math.round((person.sickHours || 0) * 100) / 100;
      attendanceRows.push([
        `${person.name} (${abbrev})`,
        totalH || '',
        isVolunteer ? '' : 1,
        sickH || '',
        '', // Special Cases — left blank for manual fill
      ]);
      totalHoursSum += totalH;
      if (!isVolunteer) employeesCount += 1;
      sickSum += sickH;
    }
    attendanceRows.push([]);
    attendanceRows.push([
      'Totals',
      Math.round(totalHoursSum * 100) / 100,
      employeesCount,
      Math.round(sickSum * 100) / 100 || '',
      '',
    ]);

    // ── Workbook assembly ──
    const wb = XLSX.utils.book_new();
    const wsAttendance = XLSX.utils.aoa_to_sheet(attendanceRows);
    const wsDetail     = XLSX.utils.aoa_to_sheet(detailRows);
    // Reasonable default column widths so the file opens looking right.
    wsAttendance['!cols'] = [
      { wch: 28 }, { wch: 12 }, { wch: 11 }, { wch: 10 }, { wch: 18 },
    ];
    wsDetail['!cols'] = [
      { wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 10 },
      { wch: 12 }, { wch: 12 }, { wch: 10 },
    ];
    // Attendance first so it's the default tab when opened (it's the
    // sheet the owner actually files in QuickBooks).
    XLSX.utils.book_append_sheet(wb, wsAttendance, 'Attendance');
    XLSX.utils.book_append_sheet(wb, wsDetail,     'Detail');
    XLSX.writeFile(wb, `payroll_${payStart}_to_${payEnd}.xlsx`);
  };

  // Parse Radius XLSX export — loads xlsx via script tag (no npm needed).
  //
  // We do NOT hard-code column indices (`row[2]`, `row[4]`, ...). Radius
  // changed their column order in the past and silently broke this import.
  // Instead we locate the header row by looking for a known cell value
  // ("Employee Name") and build a name→index map. If Radius adds or moves
  // a column, the import still works as long as the header text is intact.
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

      // Locate the header row + build a column map. Radius sometimes puts a
      // title / company-name row above the actual headers, so we scan the
      // first ~10 rows for one that looks like a header row.
      const norm = (s) => String(s ?? '').trim().toLowerCase();
      let headerIndex = -1;
      let colMap = null;
      const HEADER_SCAN_LIMIT = Math.min(rows.length, 10);
      for (let i = 0; i < HEADER_SCAN_LIMIT; i++) {
        const r = rows[i].map(norm);
        // Find each column we need by keyword presence so cosmetic header
        // tweaks ("Employee Name" → "Employee name", "Date" → "Shift Date")
        // don't break us.
        const find = (predicate) => r.findIndex(predicate);
        const candidate = {
          name:         find(c => c.includes('employee') && c.includes('name')),
          attendanceId: find(c => c.includes('attendance') && c.includes('id')),
          date:         find(c => c === 'date' || c.includes('shift date') || c.includes('work date')),
          timeIn:       find(c => c.replace(/[^a-z]/g, '') === 'timein' || (c.includes('time') && c.includes('in') && !c.includes('out'))),
          timeOut:      find(c => c.replace(/[^a-z]/g, '') === 'timeout' || (c.includes('time') && c.includes('out'))),
          duration:     find(c => c.includes('duration') || c.includes('hours')),
        };
        // Accept this row as the header iff we located everything we need.
        if (
          candidate.name >= 0 && candidate.date >= 0 &&
          candidate.timeIn >= 0 && candidate.timeOut >= 0 &&
          candidate.duration >= 0
        ) {
          headerIndex = i;
          colMap = candidate;
          break;
        }
      }
      if (!colMap) {
        setRadiusError(
          'Could not find the expected columns in this file. Make sure it is the Radius Employee Timesheet export with columns: Employee Name, Date, Time In, Time Out, Duration.'
        );
        return;
      }

      // Normalise Radius's Duration column to actual decimal hours.
      // Radius exports duration in MINUTES (a 4-hour shift comes through
      // as 242 — i.e. 4h 2min = 242 minutes — not 242 hours). Treating
      // it as hours was producing nonsense totals like "2,095h" instead
      // of "35h" for a pay period. Handles three observed formats:
      //   - minutes as a plain number (242)        → divide by 60
      //   - decimal hours (4.03)                   → leave alone
      //   - "HH:MM" string ("04:02")              → parse to hours
      // Heuristic for the numeric case: anything > 24 is minutes (nobody
      // works > 24 hours in a single shift; the largest legitimate
      // hour value we'd ever see is ~16).
      const normaliseDuration = (raw) => {
        if (raw == null || raw === '') return NaN;
        const s = String(raw).trim();
        if (s.includes(':')) {
          const [h, m] = s.split(':').map(Number);
          if (Number.isFinite(h) && Number.isFinite(m)) return h + (m / 60);
        }
        const n = parseFloat(s);
        if (!Number.isFinite(n)) return NaN;
        return n > 24 ? n / 60 : n;
      };
      // Belt-and-suspenders: when timeIn + timeOut are both present, compute
      // duration from those instead — Radius's Duration column has been
      // unreliable across export versions.
      const minutesFromHHMM = (str) => {
        if (!str) return null;
        const m = String(str).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        const ampm = (m[3] || '').toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return h * 60 + min;
      };
      const hoursFromTimes = (inStr, outStr) => {
        const a = minutesFromHHMM(inStr);
        const b = minutesFromHHMM(outStr);
        if (a == null || b == null) return null;
        let diff = b - a;
        if (diff < 0) diff += 24 * 60; // shift crossed midnight
        return diff / 60;
      };

      const parsed = [];
      for (let i = headerIndex + 1; i < rows.length; i++) {
        const row = rows[i];
        const name    = String(row[colMap.name] || '').trim();
        const dateRaw = String(row[colMap.date] || '').trim();
        const timeIn  = String(row[colMap.timeIn] || '').trim();
        const timeOut = String(row[colMap.timeOut] || '').trim();
        const fromTimes = hoursFromTimes(timeIn, timeOut);
        const fromCol   = normaliseDuration(row[colMap.duration]);
        // Prefer the time-in / time-out computation when we have both
        // (most accurate). Fall back to the (normalised) Duration column
        // when times are missing or unparseable.
        const actualHours = Number.isFinite(fromTimes) ? fromTimes
                          : Number.isFinite(fromCol)   ? fromCol
                          : NaN;
        // attendanceId is optional — we keep the existing "must be numeric"
        // filter when the column is present, since it's how Radius marks
        // real rows vs total/summary rows. If the column isn't there we
        // fall back to "has a parseable duration", which is just as good.
        const attendanceId = colMap.attendanceId >= 0 ? row[colMap.attendanceId] : null;
        if (colMap.attendanceId >= 0) {
          if (typeof attendanceId !== 'number' || isNaN(attendanceId)) continue;
        }

        if (!name) continue;
        if (!dateRaw || !Number.isFinite(actualHours)) continue;

        // Parse DD/MM/YYYY → YYYY-MM-DD
        if (!dateRaw.includes('/')) continue;
        const parts = dateRaw.split('/');
        if (parts.length !== 3) continue;
        const [d, m, y] = parts;
        const dateStr = `${y.trim()}-${String(m.trim()).padStart(2,'0')}-${String(d.trim()).padStart(2,'0')}`;

        parsed.push({ name, date: dateStr, timeIn, timeOut, actualHours });
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

  // ── Pay h override (per-shift) ──────────────────────────────────────
  // The Pay h column on the payroll table defaults to the scheduled
  // hours. Owners can double-click any cell to override (e.g. when an
  // instructor stays an extra half hour or leaves early). Persisting
  // null/empty REMOVES the override so the column reverts to scheduled.
  //
  // Writes go straight to the shift doc — payrollSummary re-derives
  // from `shifts` on the next snapshot, so the column + per-person Pay
  // total update without any local state plumbing.
  const [payEditing, setPayEditing] = useState({ shiftId: null, draft: '' });
  const beginPayEdit = (shift) => {
    setPayEditing({
      shiftId: shift.shiftId,
      draft: (shift.payHoursOverride ?? shift.hours).toString(),
    });
  };
  const commitPayEdit = async () => {
    const { shiftId, draft } = payEditing;
    if (!shiftId) return;
    setPayEditing({ shiftId: null, draft: '' });
    const trimmed = (draft || '').trim();
    try {
      if (trimmed === '') {
        // Empty input = reset to scheduled. Persist deleteField() so the
        // shift doc actually loses the override rather than carrying a 0.
        await updateDoc(doc(db, 'shifts', shiftId), { payHoursOverride: deleteField() });
        toast.success('Pay hours reset to scheduled.');
        return;
      }
      const n = Number(trimmed);
      if (!isFinite(n) || n < 0) { toast.error('Pay hours must be a number ≥ 0.'); return; }
      await updateDoc(doc(db, 'shifts', shiftId), { payHoursOverride: Math.round(n * 100) / 100 });
    } catch (e) { toast.error(e?.message || 'Failed to save pay hours.'); }
  };
  const cancelPayEdit = () => setPayEditing({ shiftId: null, draft: '' });

  // ── Resolve flagged payroll row ─────────────────────────────────────
  // Pressing the ✓ button on a red (discrepant / missing-from-Radius)
  // shift marks it acknowledged by the admin. The Pay h value stays
  // editable — resolve is "I've reviewed this and the Pay h I set is
  // what we're paying," not a freeze. Stored per-shift so it survives
  // page reloads and is visible to anyone who opens the period later.
  const handleResolveShift = async (shiftId, next = true) => {
    if (!shiftId) return;
    try {
      await updateDoc(doc(db, 'shifts', shiftId), { payrollResolved: !!next });
    } catch (e) { toast.error(e?.message || 'Failed to update.'); }
  };

  // Export gated by unresolved count. When everything's resolved, just
  // export. When some are still flagged, confirm before letting them
  // proceed — admin should know what they're shipping.
  const handleExportFinalPayroll = async (unresolvedCount) => {
    if (unresolvedCount > 0) {
      const ok = await confirmDialog({
        title: `${unresolvedCount} discrepancy ${unresolvedCount === 1 ? 'is' : 'are'} still unresolved`,
        message: `Some payroll rows are flagged as needing review and haven't been marked Resolved. Export anyway?`,
        confirmText: 'Export anyway',
        cancelText: 'Cancel — let me resolve first',
        danger: true,
      });
      if (!ok) return;
    }
    handleExportPayroll();
  };

  const addRadiusEntry = (name) => {
    setRadiusData(prev => [...prev, { name, date: payStart, timeIn: '', timeOut: '', actualHours: 0 }]);
  };

  // Build comparison: for each person in payroll, match Radius rows.
  //
  // Real fuzzy name matcher. Radius sometimes uses "Brianna E. Smith" or
  // "Sarah-Jane Doe" while the portal has "Brianna Smith" / "Sarah Jane
  // Doe", and the old "strict equals after trim" missed both. We tokenise
  // on whitespace AND hyphens, drop dots and apostrophes, and consider
  // two names a match if their first token matches AND their last token
  // matches. Single-word names fall back to exact-token equality.
  //
  // For staff whose Radius name doesn't share a first OR last token with
  // their Ratio displayName (legal first names, married names, etc., e.g.
  // "Jieun (Joanne) Lee"), the owner saves a `radiusName` alias on the
  // user profile and the matcher tries it as a second name too.
  const comparisonSummary = useMemo(() => {
    if (radiusData.length === 0) return null;
    const nameTokens = (raw) => String(raw || '')
      .toLowerCase()
      .replace(/[.'`]/g, '')      // drop punctuation that doesn't affect identity
      .split(/[\s-]+/)            // split on whitespace + hyphens
      .filter(Boolean);
    const namesMatch = (a, b) => {
      const ta = nameTokens(a);
      const tb = nameTokens(b);
      if (ta.length === 0 || tb.length === 0) return false;
      if (ta.length === 1 || tb.length === 1) return ta[0] === tb[0];
      return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
    };
    // Pull the user's radiusName from the canonical user list so the
    // matcher can recognise both "Joanne Lee" and "Jieun Lee".
    const userByPersonName = new Map(
      usersForCentre.map(u => [(u.displayName || '').toLowerCase(), u])
    );
    const personMatchesRadius = (personName, radiusName) => {
      if (namesMatch(personName, radiusName)) return true;
      const u = userByPersonName.get((personName || '').toLowerCase());
      if (u?.radiusName && namesMatch(u.radiusName, radiusName)) return true;
      return false;
    };
    // Track which Radius rows got attributed to ANY person so we can
    // surface the leftovers (rows whose name doesn't match any user) and
    // let the owner map them by clicking — saving the alias on the user.
    const attributedIdxs = new Set();
    const perPerson = payrollSummary.map(person => {
      const radiusRows = radiusData
        .map((r, idx) => ({ ...r, _idx: idx }))
        .filter(r => personMatchesRadius(person.name, r.name));
      for (const r of radiusRows) attributedIdxs.add(r._idx);
      const actualHours = radiusRows.reduce((s, r) => s + r.actualHours, 0);
      const scheduledHours = person.totalHours;
      const diff = Math.round((actualHours - scheduledHours) * 100) / 100;
      const hasDiscrepancy = Math.abs(diff) > 0.25; // >15 min difference flags it

      // Per-shift comparison.
      //
      // CRITICAL: when an instructor has multiple shifts on the same date
      // (e.g. Homer's in-centre 3-5pm + online 6-8pm), each scheduled
      // shift needs its OWN Radius row, not the first one on that date.
      // Previously a .find() by date returned the same Radius row for
      // every shift that day, so editing one row edited both — bug.
      //
      // Fix: per date, sort both shifts and Radius entries by start time
      // and greedily match nearest pairs. Each Radius _idx is consumed
      // once so it can't double-attribute.
      const toMinutes = (t) => {
        const v = String(t || '').trim();
        // Accept "HH:MM" or "h:mm AM/PM"
        let m = v.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const mins = parseInt(m[2], 10);
        const ampm = (m[3] || '').toUpperCase();
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        return h * 60 + mins;
      };

      const usedRadiusIdx = new Set();
      const shiftComparisons = person.shifts.map((s, sIdx) => {
        // Candidate Radius rows: same date, not already consumed.
        const candidates = radiusRows.filter(r => r.date === s.date && !usedRadiusIdx.has(r._idx));
        let match = null;
        if (candidates.length === 1) {
          match = candidates[0];
        } else if (candidates.length > 1) {
          // Pick the candidate whose timeIn is nearest the shift's startTime.
          const targetMin = toMinutes(s.startTime);
          if (targetMin == null) {
            match = candidates[0];
          } else {
            let best = null, bestDelta = Infinity;
            for (const c of candidates) {
              const cm = toMinutes(c.timeIn);
              if (cm == null) continue;
              const d = Math.abs(cm - targetMin);
              if (d < bestDelta) { bestDelta = d; best = c; }
            }
            match = best || candidates[0];
          }
        }
        if (match) usedRadiusIdx.add(match._idx);
        const shiftDiff = match ? Math.round((match.actualHours - s.hours) * 100) / 100 : null;
        return {
          ...s,
          actual: match || null,
          shiftDiff,
          shiftDiscrepancy: match ? Math.abs(shiftDiff) > 0.25 : false,
          missingFromRadius: !match,
          _shiftIdx: sIdx,
        };
      });

      // Any Radius row not consumed by a shift above is genuinely unmatched
      // — these can be either an extra clock-in on a day that had a shift
      // already (e.g. came back after dinner) or a shift that never made
      // it into Ratio at all. Either way, surface them with the "Schedule
      // shift" button so the owner can fix them.
      const unmatchedRadius = radiusRows.filter(r => !usedRadiusIdx.has(r._idx));

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
    // Unattributed Radius rows so far. Some of these are actually approved
    // users who didn't have a single Ratio shift in the pay period (so
    // they never appeared in payrollSummary). We promote them to synthetic
    // payroll rows here — same matcher (displayName + radiusName fuzzy) —
    // so Stella / Amarnoor / Rishi / etc. show on payroll WITH a
    // "Schedule shift" button instead of being orphaned.
    const leftover = radiusData
      .map((r, idx) => ({ ...r, _idx: idx }))
      .filter(r => !attributedIdxs.has(r._idx));

    const synthByUserId = new Map();
    for (const r of leftover) {
      const user = approvedUsers.find(u =>
        namesMatch(u.displayName, r.name) ||
        (u.radiusName && namesMatch(u.radiusName, r.name))
      );
      if (!user) continue;
      attributedIdxs.add(r._idx);
      let synth = synthByUserId.get(user.uid);
      if (!synth) {
        synth = {
          name: user.displayName,
          role: user.instructorType || 'Instructor',
          shifts: [],
          totalHours: 0,
          sickHours: 0,
          sickCount: 0,
          actualHours: 0,
          scheduledHours: 0,
          diff: 0,
          hasDiscrepancy: true,        // by definition — they have hours but no schedule
          shiftComparisons: [],
          unmatchedRadius: [],
        };
        synthByUserId.set(user.uid, synth);
      }
      synth.unmatchedRadius.push(r);
      synth.actualHours = Math.round((synth.actualHours + r.actualHours) * 100) / 100;
      synth.diff        = Math.round((synth.actualHours - synth.scheduledHours) * 100) / 100;
    }
    for (const synth of synthByUserId.values()) perPerson.push(synth);

    // True orphans: still no user matched after both passes. These need a
    // manual alias — e.g. "Jieun Lee" → save radiusName on "Joanne Lee".
    const orphans = radiusData
      .map((r, idx) => ({ ...r, _idx: idx }))
      .filter(r => !attributedIdxs.has(r._idx));
    return { perPerson, orphans };
  }, [payrollSummary, radiusData, usersForCentre, approvedUsers]);

  // Save a Radius-name alias on a staff user. Used by the orphan-mapping
  // dropdown — after this, the matcher attributes that Radius row (and
  // any future ones with the same name) to the chosen user.
  const setUserRadiusName = async (userId, radiusName) => {
    if (!userId) return;
    await updateDoc(doc(db, 'users', userId), { radiusName: radiusName || null });
    try {
      const { toast } = await import('../lib/notify');
      toast.success('Radius name saved');
    } catch { /* notify optional */ }
  };

  // Admin Panel is open to admins, owners, and super-admins. Plain
  // instructors get bounced (the route guard also enforces this).
  if (!canSeeAdminPanel) {
    return <div className="text-center text-gray-500 py-16">Access denied. Admin / owner only.</div>;
  }

  const pendingRequestsCount = timeOffRequests.filter(r => r.status === 'pending').length;

  // Each top-level sidebar entry now scopes the page to a small group
  // of related sub-tabs. "Manage Schedule" shows weekly grid +
  // auto-scheduler + time-off requests; "Manage Staff" and "Manage
  // Payroll" are single-view pages (no sub-tab bar). Tabs that aren't
  // in the current group stay reachable by direct URL (so deep links
  // don't break) but don't appear in the tab strip.
  const TAB_GROUPS = {
    spreadsheet: ['spreadsheet', 'scheduler', 'requests'],
    scheduler:   ['spreadsheet', 'scheduler', 'requests'],
    requests:    ['spreadsheet', 'scheduler', 'requests'],
    users:       ['users'],
    payroll:     ['payroll'],
    holidays:    ['holidays'],
  };
  const TAB_DEFS = {
    spreadsheet: { label: 'Weekly Grid',    icon: Table },
    scheduler:   { label: 'Auto-Scheduler', icon: Wand2, badge: 'AI', badgeStyle: 'purple' },
    requests:    { label: 'Time Off',       icon: CalendarRange },
    users:       { label: 'Manage Users',   icon: UserCheck },
    payroll:     { label: 'Payroll',        icon: DollarSign },
    holidays:    { label: 'Holidays',       icon: CalendarX },
  };
  const visibleTabKeys = TAB_GROUPS[tab] || Object.keys(TAB_DEFS);
  const tabs = visibleTabKeys.map(k => ({ key: k, ...TAB_DEFS[k] }));

  // Friendly per-tab page header. Mirrors the sidebar labels so the
  // owner sees "Manage Schedule" / "Manage Staff" / "Manage Payroll"
  // as the page title when they navigate via the redesigned sidebar.
  const pageTitleByTab = {
    spreadsheet: { title: 'Manage Schedule', subtitle: 'Weekly grid + auto-scheduler + time-off requests', icon: CalendarRange,    bg: 'bg-blue-100 text-blue-600' },
    users:       { title: 'Manage Staff',    subtitle: 'Approve, roles, sub-roles, priority',           icon: Users,            bg: 'bg-emerald-100 text-emerald-600' },
    scheduler:   { title: 'Auto-Scheduler',  subtitle: 'Generate a draft schedule from availability',   icon: Wand2,            bg: 'bg-purple-100 text-purple-600' },
    payroll:     { title: 'Manage Payroll',  subtitle: 'Hourly summary + Radius timesheet compare',     icon: DollarSign,       bg: 'bg-amber-100 text-amber-600' },
    requests:    { title: 'Time Off Requests', subtitle: 'Approve or deny time off',                    icon: CalendarRange,    bg: 'bg-orange-100 text-orange-600' },
    holidays:    { title: 'Holidays',        subtitle: 'Stat holidays + centre closures',               icon: CalendarX,        bg: 'bg-purple-100 text-purple-600' },
  };
  const pageHeader = pageTitleByTab[tab] || { title: 'Admin Panel', subtitle: 'Manage instructors and shifts', icon: Settings, bg: 'bg-purple-100 text-purple-600' };
  const PageIcon = pageHeader.icon;

  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className={`rounded-lg p-2 ${pageHeader.bg}`}><PageIcon size={22} /></div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{pageHeader.title}</h1>
          <p className="text-sm text-gray-500">{pageHeader.subtitle}</p>
        </div>
      </div>

      {/* Sub-tabs — only shown when the current section has more than one
          view. "Manage Staff" / "Manage Payroll" / "Holidays" are
          single-view pages so the bar is suppressed. */}
      {tabs.length > 1 && (
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
      )}

      {/* ── SPREADSHEET (Weekly Calendar Grid) ──────────────────────────────── */}
      {tab === 'spreadsheet' && (
        <div className="space-y-2 schedule-print-zone">
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
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-0 h-0 border-r-[8px] border-r-transparent border-t-[8px] border-t-amber-400" />
              TO Pending
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-0 h-0 border-r-[8px] border-r-transparent border-t-[8px] border-t-red-500" />
              TO Approved
            </span>
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
              {/* Export Schedule — opens the browser's print dialog with
                  print CSS that hides chrome + sidebar. Owner picks
                  "Save as PDF" from the destination dropdown to get a
                  one-page snapshot of the current week. Matches the
                  "screenshot" workflow without a heavy html2canvas dep. */}
              <button
                onClick={() => window.print()}
                title="Print or save the current week as PDF"
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 print:hidden"
              >
                <Download size={12} /> Export Schedule
              </button>
            </div>

            {/* Publish bar — surfaces draft counts and one-click bulk actions.
                Hidden when nothing is in draft so it doesn't add noise to a
                cleanly-published view. */}
            {(() => {
              const ws = format(weekStart, 'yyyy-MM-dd');
              const we = format(addDays(weekStart, 6), 'yyyy-MM-dd');
              const draftsThisWeek = shifts.filter(s => s.status === 'draft' && s.date >= ws && s.date <= we).length;
              const draftsAll      = shifts.filter(s => s.status === 'draft').length;
              if (draftsAll === 0) return null;
              return (
                <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b bg-amber-50/60 text-xs">
                  <span className="font-semibold text-amber-800">
                    {draftsAll} draft shift{draftsAll === 1 ? '' : 's'} pending
                    {draftsThisWeek !== draftsAll && ` (${draftsThisWeek} this week)`}
                  </span>
                  <span className="text-amber-700/80">— instructors don&apos;t see drafts until you publish.</span>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {draftsThisWeek > 0 && (
                      <button
                        onClick={() => handlePublishWeek(ws, we)}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-700 transition-colors"
                      >
                        Publish this week ({draftsThisWeek})
                      </button>
                    )}
                    <button
                      onClick={handlePublishAllDrafts}
                      className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 font-semibold text-emerald-700 hover:bg-emerald-50 transition-colors"
                    >
                      Publish all drafts ({draftsAll})
                    </button>
                  </div>
                </div>
              );
            })()}

            {/* Grid — table-fixed so columns share the width evenly and long
                shift labels can't stretch the table sideways. The wrapper is a
                scroll pane (max-height) so the day-header row can stay pinned
                via position:sticky while you scroll through instructors. */}
            <div className="overflow-auto max-h-[70vh]">
              {/* `[&_td]:border [&_th]:border [&_td]:border-gray-300 [&_th]:border-gray-300`
                  draws a clean 1px box around EVERY cell in the table so
                  the day-by-instructor grid reads as a real spreadsheet
                  rather than relying on stripes for separation. */}
              <table className="w-full text-xs border-collapse table-fixed min-w-[680px] [&_td]:border [&_th]:border [&_td]:border-gray-300 [&_th]:border-gray-300">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="sticky top-0 z-30 bg-gray-50 text-left px-4 py-2 font-semibold text-gray-600 w-32 border-r shadow-[inset_0_-1px_0_#e5e7eb]">INSTRUCTOR</th>
                    {weekDays.map(d => {
                      const isToday = isSameDay(d, new Date());
                      const ds = format(d, 'yyyy-MM-dd');
                      const holiday = holidayFor(d, centerConfig);
                      const portalNames = new Set(users.map(u => u.displayName));
                      // Include drafts in the planned-hours header so admin sees
                      // the full scheduled picture; visual stripes on the cells
                      // already mark which ones are draft vs published.
                      const dayTotalHrs = shifts
                        .filter(s => s.date === ds && portalNames.has(s.userName))
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
                    // Per-instructor weekly hours include drafts — admin needs
                    // the full planned total when deciding fairness. Stripes on
                    // the cells already mark drafts vs published.
                    const totalHrs = weekDays.reduce((sum, d) => {
                      const ds = format(d, 'yyyy-MM-dd');
                      return sum + shifts.filter(s => s.userId === u.uid && s.date === ds)
                        .reduce((s2, sh) => s2 + shiftHours(sh), 0);
                    }, 0);
                    const displayHrs = isNaN(totalHrs) ? 0 : Math.round(totalHrs * 10) / 10;
                    const initials = u.displayName?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
                    return (
                      <tr key={u.uid} className="border-b hover:bg-gray-50 transition-colors group">
                        <td className="px-4 py-2 border-r">
                          <button
                            type="button"
                            onClick={() => setAvailabilityModalUser(u)}
                            title={`View ${u.displayName}'s availability for this week`}
                            className="flex items-center gap-2 w-full text-left rounded-md px-1 py-0.5 -mx-1 hover:bg-blue-50 hover:ring-1 hover:ring-blue-200 transition-colors"
                          >
                            <Avatar user={u} size={28} />
                            <div>
                              <div className="font-semibold text-gray-800 text-xs">{u.displayName}</div>
                              <div className="text-gray-400" style={{fontSize:'10px'}}>{displayHrs}h · {u.instructorType || 'Instructor'}</div>
                            </div>
                          </button>
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
                          // Time-off overlay — pending shows yellow, approved
                          // red. Triangle anchors top-LEFT so it doesn't
                          // collide with the green availability triangle
                          // (top-right). Approved wins if both pending and
                          // approved cover the same date (unlikely but safe).
                          const cellTimeOff = timeOffRequests.find(t =>
                            t.userId === u.uid &&
                            t.startDate && t.endDate &&
                            ds >= t.startDate && ds <= t.endDate &&
                            (t.status === 'pending' || t.status === 'approved'),
                          );
                          const timeOffColor = cellTimeOff?.status === 'approved'
                            ? 'border-t-red-500'
                            : cellTimeOff?.status === 'pending'
                              ? 'border-t-amber-400'
                              : '';
                          const timeOffBg = cellTimeOff?.status === 'approved'
                            ? 'bg-red-50/40'
                            : cellTimeOff?.status === 'pending'
                              ? 'bg-amber-50/40'
                              : '';
                          return (
                            <td
                              key={ds}
                              className={`px-1 py-1 align-top relative ${
                                cellTimeOff && dayShifts.length === 0 ? timeOffBg
                                : hasAvail && dayShifts.length === 0 ? 'bg-green-50/40'
                                : ''
                              }`}
                            >
                              {/* Time-off triangle (top-left) — visible when
                                  the user has a request covering this date. */}
                              {cellTimeOff && (
                                <div className="group/to absolute top-0 left-0 z-10">
                                  <div className={`w-0 h-0 border-r-[14px] border-r-transparent border-t-[14px] cursor-pointer ${timeOffColor}`} />
                                  <div className="hidden group-hover/to:block absolute left-0 top-4 z-20 w-56 rounded-lg border border-gray-200 bg-white shadow-lg p-2">
                                    <p className={`text-xs font-semibold mb-1 ${cellTimeOff.status === 'approved' ? 'text-red-700' : 'text-amber-700'}`}>
                                      Time off · {cellTimeOff.status === 'approved' ? 'Approved' : 'Pending'}
                                    </p>
                                    <p className="text-xs text-gray-600">
                                      {cellTimeOff.startDate}{cellTimeOff.endDate !== cellTimeOff.startDate ? ` – ${cellTimeOff.endDate}` : ''}
                                    </p>
                                    {cellTimeOff.reason && (
                                      <p className="text-xs text-gray-500 italic mt-1">&quot;{cellTimeOff.reason}&quot;</p>
                                    )}
                                    {dayShifts.length > 0 && cellTimeOff.status === 'approved' && (
                                      <p className="text-[10px] text-red-600 font-semibold mt-1">⚠ Shift conflict — approve removes the shift.</p>
                                    )}
                                  </div>
                                </div>
                              )}
                              {/* Green triangle availability indicator */}
                              {hasAvail && (
                                <div className="group/avail absolute top-0 right-0 z-10">
                                  <div className="w-0 h-0 border-l-[14px] border-l-transparent border-t-[14px] border-t-green-400 cursor-pointer" />
                                  {/* Hover tooltip showing availability times */}
                                  <div className="hidden group-hover/avail:block absolute right-0 top-4 z-20 w-52 rounded-lg border border-green-200 bg-white shadow-lg p-2">
                                    <p className="text-xs font-semibold text-green-700 mb-1">Available</p>
                                    {dayAvail.map((a, i) => {
                                      const isFull = a.startTime === '00:00' && (a.endTime === '23:59' || a.endTime === '24:00');
                                      return (
                                        <div key={i}>
                                          <p className="text-xs text-gray-600">
                                            {isFull ? 'Full day' : `${fmtHHMM(a.startTime)} – ${fmtHHMM(a.endTime)}`}
                                          </p>
                                          {a.comment && <p className="text-xs text-blue-600 italic mt-0.5">&quot;{a.comment}&quot;</p>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                              {/* Existing shifts — the whole block is filled
                                  with the shift's assignment color (editable
                                  in Super Admin → Appearance). Drafts (not
                                  yet published) get a diagonal stripe overlay
                                  + dashed border + "DRAFT" tag so admins can
                                  see what's planned vs committed. */}
                              {dayShifts.map(s => {
                                const assignment = assignmentFor(s);
                                // Sick Pay overrides the assignment palette
                                // with deep burgundy so admins can scan the
                                // grid and immediately see who called in sick.
                                const isSick = !!s.sickPay;
                                const isDraft = s.status === 'draft';
                                const bg   = isSick ? '#7f1d1d' : assignmentColorHex(assignment, centerConfig);
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
                                const compactLabel = isSick ? 'SICK' : assignmentShort(assignment);
                                // Diagonal stripes via repeating-linear-gradient.
                                // Layered on top of the base color so the assignment
                                // colour is still legible underneath.
                                const draftStripes = `repeating-linear-gradient(135deg, rgba(255,255,255,0.35) 0 6px, rgba(255,255,255,0) 6px 12px)`;
                                const styleBlock = isDraft
                                  ? { backgroundImage: `${draftStripes}, linear-gradient(${bg}, ${bg})`, color: text }
                                  : { backgroundColor: bg, color: text };
                                return (
                                  <div key={s.id}
                                    onClick={() => setEditShiftModal(s)}
                                    title={`${isDraft ? 'Draft (not published) · ' : ''}${isSick ? `Sick Pay · ${assignment}` : `${assignment} · ${where}`}`}
                                    className={`rounded px-1.5 py-1 mb-0.5 cursor-pointer hover:opacity-80 transition-opacity overflow-hidden ${isDraft ? 'border border-dashed border-white/70 ring-1 ring-gray-300' : ''}`}
                                    style={styleBlock}>
                                    <div className="font-semibold leading-tight flex items-center gap-1" style={{fontSize:'11px'}}>
                                      <span>{fmtHHMM(s.startTime)}–{fmtHHMM(s.endTime)}{hrsDisplay ? ` · ${hrsDisplay}` : ''}</span>
                                      {isDraft && (
                                        <span className="ml-auto rounded bg-white/85 text-gray-700 px-1 py-px font-bold tracking-wider" style={{fontSize:'8px'}}>DRAFT</span>
                                      )}
                                    </div>
                                    <div className="uppercase tracking-wide opacity-90 leading-tight" style={{fontSize:'10px'}}>{compactLabel}{!isSick && showWhere ? ` · ${where}` : ''}</div>
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
                      // Totals include drafts (admin needs to see total planned
                      // headcount + hours) but flag how many are still in draft
                      // so they know there's work to publish.
                      const dayShiftsAll = shifts.filter(s => s.date === ds);
                      const dayShiftsPortal = dayShiftsAll.filter(s => portalNames2.has(s.userName));
                      const dayShiftsNoAccount = dayShiftsAll.filter(s => !portalNames2.has(s.userName));
                      const draftCount = dayShiftsAll.filter(s => s.status === 'draft').length;
                      const count = dayShiftsAll.length;
                      const hrs = dayShiftsPortal.reduce((sum, s) => sum + shiftHours(s), 0);
                      const hrsDisplay = isNaN(hrs) ? 0 : Math.round(hrs * 10) / 10;
                      return (
                        <td key={ds} className="text-center py-2 text-xs text-gray-500">
                          {count > 0 ? (
                            <div className="space-y-0.5">
                              <span className="font-semibold text-gray-700">{count} staff</span>
                              <div className="text-purple-600 font-semibold">{hrsDisplay}h total</div>
                              {draftCount > 0 && (
                                <>
                                  <div className="text-amber-600 text-[10px] font-semibold uppercase tracking-wide">
                                    {draftCount} draft
                                  </div>
                                  <button
                                    onClick={() => handlePublishDay(ds)}
                                    className="mt-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-700 transition-colors"
                                    title={`Publish all ${draftCount} draft shift${draftCount === 1 ? '' : 's'} on this day`}
                                  >
                                    Publish day
                                  </button>
                                </>
                              )}
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
        <div className="space-y-4">
          {/* Search + Add Staff row — mirrors Manage Roles' clean header.
              Add Staff opens the create-account modal; search filters both
              the pending and approved lists below. */}
          <div className="rounded-2xl border bg-white p-4 shadow-sm flex flex-wrap items-center gap-3">
            <Users size={18} className="text-gray-500" />
            <input
              type="text"
              value={userSearch}
              onChange={e => setUserSearch(e.target.value)}
              placeholder="Search by name or email…"
              className="flex-1 min-w-[180px] rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-red-500 focus:outline-none"
            />
            <button
              onClick={() => setAddStaffOpen(true)}
              className="ml-auto flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
              title="Manually add a new staff member without making them sign up"
            >
              <UserPlus size={15} /> Add Staff
            </button>
          </div>

          {/* Pending Approval — compact list. Anyone with admin-panel
              access can approve / reject pending users (Firestore rules
              prevent admins from touching elevated accounts). */}
          {(() => {
            const filtered = pendingUsers.filter(u => {
              if (!userSearch.trim()) return true;
              const q = userSearch.toLowerCase();
              return (u.displayName || '').toLowerCase().includes(q)
                  || (u.email || '').toLowerCase().includes(q);
            });
            if (filtered.length === 0) return null;
            return (
              <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b bg-yellow-50/60 flex items-center gap-2">
                  <Clock size={14} className="text-yellow-700" />
                  <h3 className="text-sm font-semibold text-yellow-800">
                    Pending Approval ({filtered.length})
                  </h3>
                </div>
                <ul className="divide-y divide-gray-100">
                  {filtered.map(u => (
                    <li key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-gray-50">
                      <Avatar user={u} size={32} roleColored={false} className="ring-2 ring-yellow-100" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-gray-900 truncate">{u.displayName || u.email}</p>
                        <p className="text-xs text-gray-500 truncate">{u.email}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleApprove(u.uid)}
                          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                          <UserCheck size={13} /> Approve
                        </button>
                        <button onClick={() => handleReject(u.id)}
                          className="flex items-center gap-1 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50">
                          <UserX size={13} /> Reject
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          {/* Approved staff — compact list mirroring Manage Roles' layout.
              Click anywhere on the row to open the Edit modal for that
              person; all the per-user toggles (role, priority, sub-roles,
              guaranteed, volunteer) live in there. Keeps this list
              scannable when the centre has 30+ staff. */}
          {(() => {
            const filtered = approvedUsers.filter(u => {
              if (!userSearch.trim()) return true;
              const q = userSearch.toLowerCase();
              return (u.displayName || '').toLowerCase().includes(q)
                  || (u.email || '').toLowerCase().includes(q);
            });
            return (
              <div className="rounded-2xl border bg-white shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-2">
                  <UserCheck size={14} className="text-gray-600" />
                  <h3 className="text-sm font-semibold text-gray-800">
                    Approved Staff ({filtered.length}{filtered.length !== approvedUsers.length ? ` of ${approvedUsers.length}` : ''})
                  </h3>
                </div>
                {filtered.length === 0 ? (
                  <div className="py-12 text-center">
                    <Users size={28} className="mx-auto text-gray-300 mb-2" />
                    <p className="text-sm text-gray-400 italic">
                      {approvedUsers.length === 0
                        ? 'No approved staff yet. Click Add Staff to create the first account.'
                        : 'No staff match your search.'}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {filtered.map(u => {
                      const subs = u.subRoles || [];
                      const typeColours = {
                        Instructor:           'bg-blue-100 text-blue-700 border-blue-200',
                        Lead:                 'bg-purple-100 text-purple-700 border-purple-200',
                        Host:                 'bg-amber-100 text-amber-700 border-amber-200',
                        Admin:                'bg-emerald-100 text-emerald-700 border-emerald-200',
                        Manager:              'bg-orange-100 text-orange-700 border-orange-200',
                        'Center Director':    'bg-pink-100 text-pink-700 border-pink-200',
                        'Dir. of Education':  'bg-pink-100 text-pink-700 border-pink-200',
                        Volunteer:            'bg-teal-100 text-teal-700 border-teal-200',
                      };
                      const typeCls = typeColours[u.instructorType || 'Instructor'] || typeColours.Instructor;
                      return (
                        <li
                          key={u.id}
                          onClick={() => setEditStaffUser(u)}
                          className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                        >
                          <Avatar user={u} size={36} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-gray-900 truncate">{u.displayName || u.email}</p>
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${typeCls}`}>
                                {u.instructorType || 'Instructor'}
                              </span>
                              {u.isVolunteer && (
                                <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                                  Volunteer
                                </span>
                              )}
                              {u.guaranteed && (
                                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                  Guaranteed
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                              <span className="truncate">{u.email}</span>
                              {subs.length > 0 && (
                                <span className="flex items-center gap-1">
                                  {subs.map(sr => {
                                    const st = SUB_ROLE_STYLES[sr];
                                    return (
                                      <span key={sr} className={`inline-flex items-center gap-1 rounded-full ${st?.pillBg || 'bg-gray-100'} ${st?.pillText || 'text-gray-600'} px-1.5 py-px text-[10px] font-semibold`}>
                                        {sr.charAt(0)}
                                      </span>
                                    );
                                  })}
                                </span>
                              )}
                              <span className="text-gray-400">· P{u.priority || 2}</span>
                            </div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditStaffUser(u); }}
                            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                          >
                            Edit
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })()}

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
            {/* Range type toggle — Day / Week / Month. Picker below
                switches based on selection. */}
            <div className="mb-3">
              <label className="mb-1 block text-sm font-medium text-gray-700">Schedule for</label>
              <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                {[
                  { key: 'day',   label: 'Day'   },
                  { key: 'week',  label: 'Week'  },
                  { key: 'month', label: 'Month' },
                ].map(opt => {
                  const active = schedRangeType === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setSchedRangeType(opt.key)}
                      className={`px-3 py-1.5 transition-colors ${active
                        ? 'bg-purple-600 text-white font-semibold'
                        : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
              {schedRangeType === 'month' && (
                <>
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
                </>
              )}
              {schedRangeType === 'week' && (
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Week starting (Mon)
                  </label>
                  <input
                    type="date"
                    value={schedWeekDate}
                    onChange={e => {
                      // Snap to the Monday of the picked date so the user
                      // can't accidentally start a "week" on a Wednesday.
                      const picked = new Date(e.target.value + 'T00:00:00');
                      const mon    = startOfWeek(picked, { weekStartsOn: 1 });
                      setSchedWeekDate(format(mon, 'yyyy-MM-dd'));
                    }}
                    className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Generates {format(new Date(schedWeekDate + 'T00:00:00'), 'MMM d')} – {format(addDays(new Date(schedWeekDate + 'T00:00:00'), 6), 'MMM d, yyyy')}
                  </p>
                </div>
              )}
              {schedRangeType === 'day' && (
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-sm font-medium text-gray-700">Date</label>
                  <input
                    type="date"
                    value={schedDayDate}
                    onChange={e => setSchedDayDate(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Default min/day
                </label>
                <input type="number" value={schedConfig.minPerDay} min={1} max={20}
                  onChange={e => setSchedConfig(c => ({ ...c, minPerDay: Number(e.target.value) }))}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
                <p className="mt-1 text-[10px] text-gray-500">Used for any day without its own override below.</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Default max/day
                </label>
                <input type="number" value={schedConfig.maxPerDay} min={1} max={30}
                  onChange={e => setSchedConfig(c => ({ ...c, maxPerDay: Number(e.target.value) }))}
                  className="w-full rounded-lg border px-3 py-2.5 text-sm focus:border-red-500 focus:outline-none" />
                <p className="mt-1 text-[10px] text-gray-500">Used for any day without its own override below.</p>
              </div>
            </div>

            {/* ── Per-day operating + staffing matrix ──────────────────────
                Lets the owner say "Mondays we want 10 in-centre + 2 online,
                Saturdays we want 6 in-centre + 1 online", AND mark whole
                days closed (writes operatingDays back to centerConfig).
                Empty cells fall back to the global defaults above so the
                owner only has to fill the days that differ from the norm. */}
            <PerDayStaffingMatrix
              activeCenterId={activeCenterId}
              centerConfig={centerConfig}
              schedConfig={schedConfig}
              setSchedConfig={setSchedConfig}
            />
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
                    <p className="text-sm text-gray-500">Review and edit, then save. Shifts land as drafts in the weekly grid — instructors won&apos;t see them until you click Publish.</p>
                  </div>
                  <button onClick={handlePostSchedule} disabled={posting}
                    className="flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2.5 text-sm font-bold text-white shadow-md hover:bg-green-700 disabled:opacity-50 transition-colors">
                    <Send size={16} />
                    {posting ? 'Saving…' : 'Save as drafts'}
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

              {/* Weekly grid view of the entire draft — same look as Manage
                  Staff Schedule. Lets the owner SEE the whole month at a
                  glance. The detailed day-by-day card list below is still
                  available for inline edits (Expand all / Collapse all). */}
              <DraftWeeklyGrid
                draftSchedule={draftSchedule}
                centerConfig={centerConfig}
                schedConfig={schedConfig}
              />

              <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
                <div className="border-b bg-gray-50 px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h4 className="font-semibold text-gray-900">Day-by-Day Editor</h4>
                    <p className="text-xs text-gray-500">Expand a day to edit its roster, times, or sub-roles — changes save to the draft, not posted yet.</p>
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
                                const userForAvatar = usersForCentre.find(uu => uu.displayName === name)
                                  || { displayName: name };
                                return (
                                  <div key={name} className="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 shadow-sm">
                                    <div className={`shrink-0 rounded-full ${sub?.blockBg || ''} ring-2 ring-white`} style={{ padding: '2px' }}>
                                      <Avatar user={userForAvatar} size={28} roleColored={false} />
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

                            <p className="mb-2 text-xs font-semibold text-gray-600">
                              Add from approved staff:
                              <span className="ml-2 text-[10px] font-normal text-gray-400 italic">
                                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 align-middle mr-1" />available ·
                                <span className="inline-block w-2 h-2 rounded-full bg-red-400 align-middle mx-1" />time off ·
                                <span className="inline-block w-2 h-2 rounded-full bg-white border border-gray-300 align-middle mx-1" />no availability set
                              </span>
                            </p>
                            <div className="flex flex-wrap gap-1.5 mb-4">
                              {approvedUsers.filter(u => !editingDay.assignedEmployees.includes(u.displayName)).map(u => {
                                const subs = u.subRoles || [];
                                // Online is its own platform — check it first.
                                const primarySub = subs.includes('Online')
                                  ? 'Online'
                                  : subs.includes('Highschool') ? 'Highschool' : subs.length > 0 ? 'Elementary' : null;
                                const sub = subRoleStyleFor(primarySub);

                                // Availability + time-off status for THIS
                                // day's date. Green = submitted an
                                // available window, red = pending or
                                // approved time-off covers the date,
                                // white = no signal either way (the
                                // existing default look).
                                const dateStr = editingDay.date;
                                const userAvail = availability.find(a => a.userId === u.uid && a.date === dateStr);
                                const userTO = timeOffRequests.find(t =>
                                  t.userId === u.uid &&
                                  t.startDate && t.endDate &&
                                  dateStr >= t.startDate && dateStr <= t.endDate &&
                                  (t.status === 'pending' || t.status === 'approved'),
                                );
                                let pillCls = 'border-gray-300 bg-white text-gray-600 hover:border-gray-500 hover:bg-gray-50 hover:text-gray-900';
                                let title = 'No availability submitted';
                                if (userTO) {
                                  pillCls = 'border-red-300 bg-red-50 text-red-700 hover:border-red-500 hover:bg-red-100';
                                  title = `Time off — ${userTO.status === 'approved' ? 'approved' : 'pending'}${userTO.reason ? ` · ${userTO.reason}` : ''}`;
                                } else if (userAvail) {
                                  pillCls = 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-emerald-500 hover:bg-emerald-100';
                                  const isFull = userAvail.startTime === '00:00' && (userAvail.endTime === '23:59' || userAvail.endTime === '24:00');
                                  title = isFull ? 'Available — full day' : `Available ${fmtHHMM(userAvail.startTime)}–${fmtHHMM(userAvail.endTime)}`;
                                }
                                return (
                                  <button key={u.uid} onClick={() => handleAddToDay(u.displayName)}
                                    title={title}
                                    className={`flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs transition-colors ${pillCls}`}
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
                                  const userForAvatar = usersForCentre.find(uu => uu.displayName === name)
                                    || { displayName: name };
                                  const isHostRow   = role === 'Host';
                                  const isOnlineRow = role === 'Online Instructor';
                                  return (
                                    <div
                                      key={name}
                                      className="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 hover:border-gray-300 hover:shadow-sm transition-all"
                                    >
                                      <div
                                        className={`shrink-0 rounded-full ${sub?.blockBg || ''}`}
                                        title={subRole || 'No sub-role'}
                                        style={{ padding: '2px' }}
                                      >
                                        <Avatar user={userForAvatar} size={28} roleColored={false} />
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
                                <CoverageGrid day={isEditing ? editingDay : day} centerConfig={centerConfig} />
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
                  {posting ? 'Saving…' : `Save ${draftSchedule.month} ${draftSchedule.year} as drafts`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── PAYROLL ─────────────────────────────────────────────────────── */}
      {tab === 'payroll' && (
        <div className="space-y-6">
          {/* Floating scroll-to-top — the payroll table is long; the chip
              hides itself until the user scrolls past ~400px. */}
          <ScrollTopButton />

          {/* (Removed) "Payroll tools" toolbar — the WIW import + bulk-
              delete buttons it housed are migration-era tooling we no
              longer need surfaced at the top of every payroll view. The
              ImportFromWiwButton + BulkDeleteShiftsByDate components are
              still defined in this file and can be re-mounted somewhere
              (e.g. a Settings page) if those workflows come back. */}

          {/* Sub-tabs inside Payroll. Default lands on the pay-period view
              (the existing screen). Sick Days flips to a roster view of
              year-to-date sick usage per employee, with probation status. */}
          <div className="flex gap-1 border-b border-gray-200">
            <button onClick={() => setPayrollSubtab('period')}
              className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                payrollSubtab === 'period'
                  ? 'border-b-2 border-green-600 text-green-700 bg-white'
                  : 'text-gray-500 hover:text-gray-800'
              }`}>
              <CalendarRange size={16} /> This Period
            </button>
            <button onClick={() => setPayrollSubtab('sick')}
              className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                payrollSubtab === 'sick'
                  ? 'border-b-2 border-amber-600 text-amber-700 bg-white'
                  : 'text-gray-500 hover:text-gray-800'
              }`}>
              <Activity size={16} /> Sick Days
              <span className="rounded-full bg-amber-100 text-amber-700 text-[10px] px-1.5 py-0.5 font-bold">
                {sickDaysSummary.reduce((s, p) => s + p.used, 0)}/{sickDaysSummary.length * SICK_DAYS_PER_YEAR}
              </span>
            </button>
          </div>

          {/* ── Sick Days sub-tab ─────────────────────────────────────── */}
          {payrollSubtab === 'sick' && (
            <SickDaysTab
              rows={sickDaysSummary}
              year={new Date().getFullYear()}
              maxPerYear={SICK_DAYS_PER_YEAR}
              probationDays={PROBATION_DAYS}
              onSetHireDate={handleSetHireDate}
            />
          )}

          {/* ── "This Period" sub-tab — wraps the original payroll UI ── */}
          {payrollSubtab === 'period' && (<>

          {/* Stat-pay diagnostic — only renders if there's a holiday in
              this pay period. Shows per-person shift count in the pre-30
              window so we can see exactly why someone qualifies or not. */}
          {statDiagnostic && statDiagnostic.inPeriod.length > 0 && (
            <div className="rounded-xl border border-purple-200 bg-purple-50/40 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Activity size={16} className="text-purple-700" />
                <h4 className="font-bold text-purple-900 text-sm">
                  Stat-pay diagnostic ({statDiagnostic.inPeriod.length} holiday{statDiagnostic.inPeriod.length === 1 ? '' : 's'} in this period)
                </h4>
              </div>
              {statDiagnostic.detail.map(d => {
                const qualifiers = d.perPerson.filter(p => p.qualifies);
                return (
                  <div key={d.holiday.date} className="mt-2 rounded-lg bg-white border border-purple-100 p-3">
                    <div className="text-sm font-semibold text-purple-900">
                      {d.holiday.name || 'Holiday'} · {d.holiday.date}
                      <span className="ml-2 text-xs font-normal text-gray-500">
                        Pre-30-day window: {d.windowStart} → {d.holiday.date}
                      </span>
                    </div>
                    {qualifiers.length === 0 ? (
                      <p className="mt-2 text-xs text-red-700">
                        Nobody qualifies. <b>No person has 15+ shifts in the window above.</b>
                        Most likely cause: April shifts aren't loaded yet (or weren't tagged with the right userName so they don't aggregate).
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-emerald-700">
                        <b>{qualifiers.length} qualifier{qualifiers.length === 1 ? '' : 's'}.</b> They should be getting stat pay — if not, hover the purple Stat badge on their row to see the breakdown.
                      </p>
                    )}
                    <details className="mt-2">
                      <summary className="text-xs text-purple-700 cursor-pointer">
                        Show per-person shift counts ({d.perPerson.length} people)
                      </summary>
                      <table className="w-full text-xs mt-2">
                        <thead>
                          <tr className="text-gray-500">
                            <th className="text-left px-2 py-1">Name</th>
                            <th className="text-right px-2 py-1">Shifts in window</th>
                            <th className="text-center px-2 py-1">15+ ?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.perPerson.map(p => (
                            <tr key={p.name} className={p.qualifies ? 'text-emerald-700' : 'text-gray-500'}>
                              <td className="px-2 py-0.5">{p.name}</td>
                              <td className="px-2 py-0.5 text-right font-mono">{p.count}</td>
                              <td className="px-2 py-0.5 text-center">{p.qualifies ? '✓' : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  </div>
                );
              })}
            </div>
          )}

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
                    {payoutLabel && (
                      <span className="ml-2 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[11px] font-semibold">
                        Paid {payoutLabel}
                      </span>
                    )}
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
                {/* Unresolved counter — aggregates red rows across all
                    visible persons. Pulls from comparisonSummary (which
                    overlays Radius matches onto payrollSummary). When
                    there's no Radius import yet, comparisonSummary is
                    null and we fall back to payrollSummary, where no
                    discrepancies are computed → zero unresolved. */}
                {(() => {
                  const rows = (comparisonSummary?.perPerson) || [];
                  let unresolved = 0;
                  for (const p of rows) {
                    for (const s of (p.shiftComparisons || [])) {
                      if ((s.shiftDiscrepancy || s.missingFromRadius) && !s.payrollResolved) {
                        unresolved++;
                      }
                    }
                  }
                  return (
                    <div className="flex items-center gap-3">
                      {unresolved > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-700"
                          title="Click Resolve on each red row after reviewing.">
                          ⚠ {unresolved} unresolved
                        </span>
                      ) : (
                        rows.length > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-700">
                            ✓ all resolved
                          </span>
                        )
                      )}
                      <button onClick={() => handleExportFinalPayroll(unresolved)}
                        className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 transition-colors">
                        <Download size={15} /> Export Final Payroll
                      </button>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Radius Import — auto-collapses to a one-line chip once
              entries are loaded, so it doesn't waste vertical space on
              the working flow (reconcile rows → resolve → export).
              Click the chip to expand and re-import a different file. */}
          {payrollSummary.length > 0 && radiusData.length > 0 && !radiusExpanded && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-2.5 shadow-sm flex items-center gap-3">
              <CheckCircle size={16} className="text-blue-600 shrink-0" />
              <div className="flex-1 text-sm">
                <span className="font-semibold text-blue-900">Radius timesheet loaded:</span>{' '}
                <span className="text-blue-800">{radiusData.length} entries</span>
                {radiusFileName && <span className="text-blue-600 ml-1">· {radiusFileName}</span>}
              </div>
              <button
                onClick={() => setRadiusExpanded(true)}
                className="rounded-md border border-blue-300 bg-white px-3 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100">
                Re-import
              </button>
            </div>
          )}
          {payrollSummary.length > 0 && (radiusData.length === 0 || radiusExpanded) && (
            <div className="rounded-xl border bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <h3 className="font-semibold text-gray-900">Radius Timesheet Import</h3>
                {radiusData.length > 0 && (
                  <>
                    <span className="ml-2 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                      {radiusData.length} entries loaded
                    </span>
                    <button onClick={() => setRadiusExpanded(false)}
                      className="ml-auto text-xs font-semibold text-gray-500 hover:text-gray-800">
                      Collapse
                    </button>
                  </>
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
              back to payroll for this period. Owner / super-admin only:
              writing to centerConfig.salaryStaff requires isOwnerAtCenter
              in the Firestore rules, so plain admins would just see the
              chips fail silently. Hide them entirely instead. */}
          {canSeeCenterSettings && Array.isArray(centerConfig?.salaryStaff) && centerConfig.salaryStaff.length > 0 && (
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
              {((comparisonSummary?.perPerson) || payrollSummary).map(person => {
                const bg = assignmentColorHex(assignmentFor(person), centerConfig);
                const hasRadius = !!comparisonSummary;
                const isDiscrepant = hasRadius && person.hasDiscrepancy;
                const shiftRows = hasRadius ? person.shiftComparisons : person.shifts;
                return (
                  <div key={person.name} className={`rounded-xl border shadow-sm overflow-hidden bg-white ${isDiscrepant ? 'border-red-300' : ''}`}>
                    {/* Person header */}
                    <div className={`flex items-center justify-between px-5 py-3 border-b ${isDiscrepant ? 'bg-red-50' : 'bg-gray-50'}`}>
                      <div className="flex items-center gap-3">
                        <Avatar
                          user={usersForCentre.find(uu => uu.displayName === person.name) || { displayName: person.name }}
                          size={32}
                        />
                        <div>
                          <span className="font-semibold text-gray-900">{person.name}</span>
                          <span className="ml-2 text-xs text-gray-500">{person.role}</span>
                          {isDiscrepant && (
                            <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">⚠ Discrepancy</span>
                          )}
                          {/* Quick toggle: mark this person as salaried so they
                              drop off the hourly payroll on the next render.
                              Owner / super-admin only — writing salaryStaff
                              is gated by Firestore rules so admins would
                              just bounce here. */}
                          {canSeeCenterSettings && (
                            <button
                              type="button"
                              onClick={() => handleExcludeFromPayroll(person.name)}
                              title="Mark as salary staff and exclude from this payroll"
                              className="ml-2 inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700"
                            >
                              <UserX size={10} /> Exclude
                            </button>
                          )}
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
                            <div className="text-sm font-bold text-green-700">{person.totalHours.toFixed(2)}h worked</div>
                            <div className="text-xs text-gray-400">
                              {person.shifts.length - (person.sickCount || 0)} worked shift{person.shifts.length - (person.sickCount || 0) !== 1 ? 's' : ''}
                            </div>
                            {(person.sickCount || 0) > 0 && (
                              <div className="mt-1 text-xs font-semibold text-amber-700">
                                <span className="rounded bg-amber-100 px-1.5 py-0.5">
                                  Sick: {person.sickHours.toFixed(2)}h · {person.sickCount} shift{person.sickCount !== 1 ? 's' : ''}
                                </span>
                              </div>
                            )}
                            {(person.statDays || 0) > 0 && (
                              <div
                                className="mt-1 text-xs font-semibold text-purple-700"
                                title={(person.statEntries || []).map(e => `${e.name} (${e.date}): ${e.hours.toFixed(2)}h · ${e.basisShifts} shifts in prior 30d`).join('\n')}
                              >
                                <span className="rounded bg-purple-100 px-1.5 py-0.5">
                                  Stat: {person.statHours.toFixed(2)}h · {person.statDays} day{person.statDays !== 1 ? 's' : ''}
                                </span>
                              </div>
                            )}
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
                          {hasRadius && <th className="text-right px-5 py-2 text-xs font-medium text-blue-500">Check In/Out Actuals</th>}
                          {hasRadius && (
                            <th className="text-right px-5 py-2 text-xs font-medium text-purple-600" title="Hours actually paid. Defaults to scheduled; click any cell to override. This is the value Export Final Payroll uses for QuickBooks.">
                              <div className="flex flex-col items-end leading-tight">
                                <span>Payroll Hours</span>
                                <span className="text-[9px] font-normal text-purple-400 italic">click to edit</span>
                              </div>
                            </th>
                          )}
                          {hasRadius && <th className="text-right px-5 py-2 text-xs font-medium text-gray-500">Diff</th>}
                          {hasRadius && <th className="text-right px-5 py-2 text-xs font-medium text-gray-500 w-16">Resolved</th>}
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
                          // Resolved overrides the red flag — once admin
                          // ✓'s a row, it goes green even if the underlying
                          // Sched/Actual diff is still mathematically wide.
                          // The Diff number still shows red text so the
                          // delta isn't hidden; the row background is the
                          // "I've acknowledged this" signal.
                          const rowResolved = rowFlag && s.payrollResolved;
                          const showRedFlag = rowFlag && !rowResolved;
                          return (
                            <tr key={i} className={`transition-colors ${
                              showRedFlag ? 'bg-red-50 hover:bg-red-100'
                              : rowResolved ? 'bg-emerald-50/70 hover:bg-emerald-100/70'
                              : s.sick ? 'bg-amber-50/60 hover:bg-amber-100/60'
                              : 'hover:bg-gray-50'
                            }`}>
                              <td className="px-5 py-2.5 text-gray-800 font-medium">
                                {dateLabel}
                                {s.sick && (
                                  <span className="ml-2 rounded bg-amber-200 text-amber-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">Sick</span>
                                )}
                              </td>
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
                              {/* Payroll Hours — single click to override.
                                  Rendered as an obvious editable cell:
                                  bordered "input-style" box with a tiny
                                  pencil mark so admins at other centres
                                  can tell it's interactive without being
                                  told. Purple ring when an override is
                                  active so manual edits stand out. */}
                              {hasRadius && (
                                <td className="px-5 py-2.5 text-right font-semibold">
                                  {payEditing.shiftId === s.shiftId ? (
                                    <input
                                      autoFocus
                                      type="number" step="0.25" min="0"
                                      value={payEditing.draft}
                                      onChange={e => setPayEditing(p => ({ ...p, draft: e.target.value }))}
                                      onBlur={commitPayEdit}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') commitPayEdit();
                                        if (e.key === 'Escape') cancelPayEdit();
                                      }}
                                      className="w-20 rounded-md border border-purple-500 bg-white px-2 py-1 text-right text-sm text-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-300"
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => beginPayEdit(s)}
                                      title={s.payHoursOverride != null
                                        ? `Overridden — click to edit (scheduled: ${s.hours.toFixed(2)}h)`
                                        : 'Click to override payroll hours'}
                                      className={`group inline-flex items-center justify-end gap-1 w-20 rounded-md border bg-white px-2 py-1 text-right transition-colors cursor-pointer hover:border-purple-400 hover:bg-purple-50 focus:outline-none focus:ring-2 focus:ring-purple-300 ${
                                        s.payHoursOverride != null
                                          ? 'border-purple-400 text-purple-700 ring-1 ring-purple-200'
                                          : 'border-gray-300 text-gray-700'
                                      }`}
                                    >
                                      <Edit3
                                        size={10}
                                        className={`shrink-0 transition-opacity ${
                                          s.payHoursOverride != null
                                            ? 'opacity-70 text-purple-500'
                                            : 'opacity-30 text-gray-400 group-hover:opacity-80 group-hover:text-purple-500'
                                        }`}
                                      />
                                      <span>{s.payHours.toFixed(2)}h</span>
                                    </button>
                                  )}
                                </td>
                              )}
                              {hasRadius && (
                                <td className={`px-5 py-2.5 text-right font-bold text-xs ${s.missingFromRadius ? 'text-red-500' : s.shiftDiscrepancy ? 'text-red-600' : 'text-green-600'}`}>
                                  {s.missingFromRadius ? '⚠ missing' : s.shiftDiff > 0 ? `+${s.shiftDiff.toFixed(2)}h` : `${s.shiftDiff.toFixed(2)}h`}
                                </td>
                              )}
                              {/* Resolve column — only meaningful on red
                                  rows. Unflagged rows render an empty cell
                                  so the table grid stays aligned. */}
                              {hasRadius && (
                                <td className="px-5 py-2.5 text-right">
                                  {rowFlag && !rowResolved && (
                                    <button
                                      onClick={() => handleResolveShift(s.shiftId, true)}
                                      title="Mark this discrepancy as reviewed. Pay h stays editable."
                                      className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2 py-0.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">
                                      ✓ Resolve
                                    </button>
                                  )}
                                  {rowResolved && (
                                    <button
                                      onClick={() => handleResolveShift(s.shiftId, false)}
                                      title="Un-resolve — re-flags this row as needing review."
                                      className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                                      ✓ Resolved
                                    </button>
                                  )}
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
                            {/* Pay h column placeholder — unscheduled rows
                                aren't payable (no scheduled basis), so we
                                render a dash to keep the grid aligned. */}
                            <td className="px-5 py-2.5 text-right text-gray-300">–</td>
                            <td className="px-5 py-2.5 text-right">
                              {/* "Schedule shift" button removed per owner
                                  request — payroll is not the right surface
                                  to be creating shifts. Owner will fix
                                  scheduling gaps from Manage Schedule
                                  before running payroll. */}
                              <span className="text-xs font-bold text-amber-600 whitespace-nowrap">⚠ unscheduled</span>
                            </td>
                            {/* Resolve column placeholder — keeps grid aligned with the new column header. */}
                            <td className="px-5 py-2.5"></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className={`border-t ${isDiscrepant ? 'bg-red-50' : 'bg-green-50'}`}>
                          <td colSpan={3} className={`px-5 py-2 text-sm font-semibold ${isDiscrepant ? 'text-red-800' : 'text-green-800'}`}>Total</td>
                          <td className={`px-5 py-2 text-right text-sm font-bold ${isDiscrepant ? 'text-red-800' : 'text-green-800'}`}>{person.totalHours.toFixed(2)}h</td>
                          {hasRadius && <td className="px-5 py-2 text-right text-sm font-bold text-blue-700">{person.actualHours.toFixed(2)}h</td>}
                          {hasRadius && (
                            <td className="px-5 py-2 text-right text-sm font-bold text-purple-700"
                              title="Sum of Pay h — what we actually pay this person.">
                              {(person.payHours ?? person.totalHours).toFixed(2)}h
                            </td>
                          )}
                          {hasRadius && (
                            <td className={`px-5 py-2 text-right text-sm font-bold ${isDiscrepant ? 'text-red-600' : 'text-green-600'}`}>
                              {person.diff > 0 ? '+' : ''}{person.diff.toFixed(2)}h
                            </td>
                          )}
                          {hasRadius && <td />}
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

          {/* ── ORPHAN RADIUS ROWS ─────────────────────────────────────────
              Radius entries whose name didn't match ANY user (e.g. "Jieun
              Lee" in Radius vs "Joanne Lee" in Ratio). Owner picks the
              real staff person from a dropdown; we save the Radius name
              as that user's `radiusName` alias, so this row — AND every
              future row with that name — auto-attribute correctly. */}
          {comparisonSummary?.orphans?.length > 0 && (
            <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/40 p-4">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle size={16} className="text-amber-700" />
                <h3 className="font-bold text-amber-900">
                  Unmatched Radius entries
                  <span className="ml-2 text-xs font-normal text-amber-700">
                    ({comparisonSummary.orphans.length} {comparisonSummary.orphans.length === 1 ? 'entry' : 'entries'} couldn't be linked to a staff member)
                  </span>
                </h3>
              </div>
              <p className="text-xs text-amber-800 mb-3">
                Pick the right staff person and we'll remember the Radius name on their profile permanently.
                Used when Radius shows a legal name like "Jieun Lee" but Ratio has "Joanne Lee".
              </p>
              <div className="space-y-2">
                {comparisonSummary.orphans.map(r => (
                  <div key={r._idx} className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2">
                    <span className="font-semibold text-gray-900">{r.name}</span>
                    <span className="text-xs text-gray-500">{r.date} · {normalizeTimeToHHMM(r.timeIn)}–{normalizeTimeToHHMM(r.timeOut)} ({r.actualHours.toFixed(2)}h)</span>
                    <span className="ml-auto inline-flex items-center gap-2">
                      <span className="text-xs text-gray-600">This is →</span>
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          const uid = e.target.value;
                          if (!uid) return;
                          setUserRadiusName(uid, r.name);
                          e.target.value = '';
                        }}
                        className="rounded border border-amber-300 bg-white px-2 py-1 text-xs">
                        <option value="">Pick staff…</option>
                        {approvedUsers.map(u => (
                          <option key={u.uid} value={u.uid}>{u.displayName}</option>
                        ))}
                      </select>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          </>)}{/* ─── end of "This Period" sub-tab ─── */}
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
              <span className="rounded-full bg-teal-100 px-2.5 py-1 font-medium text-teal-700">
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
                  approved: 'bg-teal-100 text-teal-700',
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
                            onClick={() => handleApproveTimeOff(req)}
                            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700 transition-colors">
                            <Check size={14} /> Approve
                          </button>
                          <button
                            onClick={async () => {
                              await updateDoc(doc(db, 'timeOffRequests', req.id), { status: 'denied' });
                              const recipient = approvedUsers.find(u => u.id === req.userId);
                              if (recipient?.email) {
                                notifyTimeOffDecision(req, recipient, 'denied');
                              }
                            }}
                            className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors">
                            <X size={14} /> Deny
                          </button>
                        </div>
                      )}

                      {req.status !== 'pending' && (
                        <button
                          onClick={async () => {
                            const ok = await confirmDialog({
                              title: 'Delete this time-off request?',
                              confirmText: 'Delete',
                              danger: true,
                            });
                            if (ok) await deleteDoc(doc(db, 'timeOffRequests', req.id));
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

      {/* Analytics + Center Settings are standalone pages now —
          /center-analytics and /center-settings respectively. */}

      {/* ── MODALS ──────────────────────────────────────────────────────────── */}
      {addStaffOpen && (
        <AddStaffModal
          onClose={() => setAddStaffOpen(false)}
          onSubmit={handleCreateStaff}
        />
      )}

      {editStaffUser && (
        <EditStaffModal
          user={usersForCentre.find(u => u.uid === editStaffUser.uid) || editStaffUser}
          onClose={() => setEditStaffUser(null)}
          onUpdateField={handleUpdateUserField}
          onDelete={async (target) => {
            await handleReject(target.id);
            setEditStaffUser(null);
          }}
          onSendReset={handleSendStaffReset}
        />
      )}

      {availabilityModalUser && (
        <UserAvailabilityModal
          user={availabilityModalUser}
          weekDays={weekDays}
          availability={availability}
          shifts={shifts}
          onClose={() => setAvailabilityModalUser(null)}
        />
      )}

      {addShiftModal && (
        <AddShiftModal
          date={addShiftModal.date}
          user={addShiftModal.user}
          users={approvedUsers}
          availability={availability}
          centerConfig={centerConfig}
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
          onPublish={async () => {
            await handlePublishSingleShift(editShiftModal);
            setEditShiftModal(null);
          }}
        />
      )}

      {addOpenShiftModal && (
        <AddOpenShiftModal
          date={addOpenShiftModal.date}
          centerConfig={centerConfig}
          onClose={() => setAddOpenShiftModal(null)}
          onSave={handleAddOpenShift}
        />
      )}

      {/* Print CSS — Export Schedule button calls window.print(). We hide
          everything that ISN'T the spreadsheet print zone (sidebar, top
          nav, publish bar, modals, the tab strip itself) and let the
          grid take the whole page. The owner picks "Save as PDF" in
          the destination dropdown to get a screenshot-style export. */}
      <style>{`
        @media print {
          @page { size: landscape; margin: 0.3in; }
          html, body { background: white !important; }
          /* Hide chrome that's not the schedule zone. */
          aside, header, nav,
          [data-tab-strip],
          .print\\:hidden { display: none !important; }
          /* Reset scroll containers so the grid prints in full. */
          .schedule-print-zone .overflow-auto,
          .schedule-print-zone [class*="max-h-"] {
            max-height: none !important;
            overflow: visible !important;
          }
          /* When printing, only the schedule zone matters — collapse the
             parent flex/grid layouts so nothing else takes space. */
          body * { visibility: hidden !important; }
          .schedule-print-zone, .schedule-print-zone * { visibility: visible !important; }
          .schedule-print-zone {
            position: absolute !important;
            left: 0; top: 0; right: 0;
            width: 100% !important;
          }
          /* Compact grid typography for print. */
          .schedule-print-zone table { font-size: 9px !important; line-height: 1.15 !important; }
          .schedule-print-zone th, .schedule-print-zone td { padding: 2px 3px !important; }
          /* Hide interactive bits the printout doesn't need. */
          .schedule-print-zone button,
          .schedule-print-zone input { display: none !important; }
        }
      `}</style>
    </div>
  );
}

// ─── Per-Day Staffing Matrix ────────────────────────────────────────────
// Operating days + per-day Min/Max for in-centre and online staff. Empty
// cells inherit from schedConfig.minPerDay/maxPerDay. Toggling a day
// closed writes operatingDays back to centerConfig (centre-wide
// persistent), while the staffing numbers live on schedConfig (per-run).
// Owners can edit either without touching the other.
const MATRIX_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function PerDayStaffingMatrix({ activeCenterId, centerConfig, schedConfig, setSchedConfig }) {
  const operatingDays = useMemo(() => {
    return Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0
      ? centerConfig.operatingDays
      : MATRIX_DAYS;
  }, [centerConfig?.operatingDays]);
  const [savingDays, setSavingDays] = useState(false);

  const perDay = schedConfig.perDay || {};

  // Toggle a weekday open/closed in centerConfig.operatingDays.
  // Persists immediately — there's no separate Save button — because
  // it's a small list and instant feedback is more useful than batching.
  const toggleOperating = async (day) => {
    if (!activeCenterId) return;
    const next = operatingDays.includes(day)
      ? operatingDays.filter(d => d !== day)
      : [...operatingDays, day];
    // Preserve canonical order so the array doesn't shuffle every save.
    const ordered = MATRIX_DAYS.filter(d => next.includes(d));
    try {
      setSavingDays(true);
      await setDoc(
        doc(db, 'centers', activeCenterId, 'config', 'main'),
        { operatingDays: ordered, updatedAt: serverTimestamp() },
        { merge: true },
      );
    } catch (err) {
      console.error('Failed to save operatingDays:', err);
      toast.error('Could not save operating days');
    } finally {
      setSavingDays(false);
    }
  };

  const setCell = (day, field, raw) => {
    setSchedConfig(c => {
      const cur = { ...(c.perDay || {}) };
      const dayRow = { ...(cur[day] || {}) };
      // Empty string means "fall back to default" — store as undefined so
      // the scheduler reads it as "not set" rather than as 0.
      if (raw === '' || raw == null) {
        delete dayRow[field];
      } else {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) dayRow[field] = n;
      }
      if (Object.keys(dayRow).length === 0) delete cur[day];
      else cur[day] = dayRow;
      return { ...c, perDay: cur };
    });
  };

  return (
    <div className="mb-5 rounded-xl border border-purple-200 bg-purple-50/30 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-purple-200 bg-white/60 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h4 className="text-sm font-bold text-purple-900">Per-day operating + staffing rules</h4>
          <p className="text-xs text-purple-700/80">
            Blank cells use the defaults above. Uncheck a day to mark the centre closed.
          </p>
        </div>
        {savingDays && <span className="text-xs text-purple-600 italic">Saving…</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-white/60 text-purple-900">
            <tr>
              <th className="text-left px-3 py-2 font-semibold">Day</th>
              <th className="text-center px-2 py-2 font-semibold">Open</th>
              <th className="text-center px-2 py-2 font-semibold" colSpan={2}>In-centre</th>
              <th className="text-center px-2 py-2 font-semibold" colSpan={2}>Online</th>
            </tr>
            <tr className="text-[10px] uppercase tracking-wide text-purple-700/70">
              <th></th>
              <th></th>
              <th className="text-center px-2 py-1 font-medium">Min</th>
              <th className="text-center px-2 py-1 font-medium">Max</th>
              <th className="text-center px-2 py-1 font-medium">Min</th>
              <th className="text-center px-2 py-1 font-medium">Max</th>
            </tr>
          </thead>
          <tbody>
            {MATRIX_DAYS.map(day => {
              const open = operatingDays.includes(day);
              const row = perDay[day] || {};
              return (
                <tr key={day} className={`border-t border-purple-100 ${open ? 'bg-white' : 'bg-gray-50 text-gray-400'}`}>
                  <td className="px-3 py-1.5 font-medium">{day}</td>
                  <td className="text-center px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={open}
                      onChange={() => toggleOperating(day)}
                      className="accent-purple-600 h-4 w-4 cursor-pointer"
                    />
                  </td>
                  {['min', 'max', 'onlineMin', 'onlineMax'].map(field => (
                    <td key={field} className="text-center px-1 py-1.5">
                      <input
                        type="number"
                        min={0}
                        max={30}
                        disabled={!open}
                        value={row[field] ?? ''}
                        placeholder={
                          field === 'min'      ? String(schedConfig.minPerDay) :
                          field === 'max'      ? String(schedConfig.maxPerDay) :
                          field === 'onlineMin'? '0' :
                                                  '—'
                        }
                        onChange={e => setCell(day, field, e.target.value)}
                        className="w-14 rounded border border-purple-200 px-1.5 py-1 text-center focus:border-purple-500 focus:outline-none disabled:bg-gray-100 disabled:cursor-not-allowed text-xs"
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-purple-200 bg-white/40 flex items-center justify-between gap-2">
        <span className="text-[10px] text-purple-700/70 italic">
          Online Min is informational (warns if under-staffed). Online Max caps how many online instructors auto-schedule.
        </span>
        <button
          onClick={() => setSchedConfig(c => ({ ...c, perDay: {} }))}
          className="text-[10px] font-semibold text-purple-700 hover:text-purple-900 underline"
        >
          Clear per-day overrides
        </button>
      </div>
    </div>
  );
}

// ─── Draft Weekly Grid ─────────────────────────────────────────────────
// Renders the auto-scheduler's monthly draft as a person×day grid,
// chunked into weeks. Same visual grammar as the Manage Staff Schedule
// table — sticky instructor column on the left, one column per date,
// shift blocks coloured by assignment, and clear cell borders. Read-only
// here (changes are still made through the day-by-day editor below) but
// gives the owner a one-glance look at the whole month.
function DraftWeeklyGrid({ draftSchedule, centerConfig, schedConfig }) {
  if (!draftSchedule?.days?.length) return null;

  // Union of every employee scheduled at any point in the month, sorted
  // for stable row ordering. We keep them in tier order so the grid
  // matches Today's Snapshot conventions (Hosts/Mgmt → Online → In-Centre).
  const rolePri = (role, subRole) => {
    if (role === 'Online Instructor' || subRole === 'Online') return 1;
    if (role === 'Instructor' || role === 'Lead')             return 2;
    return 0;
  };
  const everyone = new Map();   // name → { role, subRole } first sighting
  for (const day of draftSchedule.days) {
    for (const name of day.assignedEmployees || []) {
      if (!everyone.has(name)) {
        everyone.set(name, { role: day.roles?.[name], subRole: day.subRoles?.[name] });
      }
    }
  }
  const names = [...everyone.entries()].sort(([na, ia], [nb, ib]) => {
    const dp = rolePri(ia.role, ia.subRole) - rolePri(ib.role, ib.subRole);
    if (dp !== 0) return dp;
    return na.localeCompare(nb);
  }).map(([n]) => n);

  // Chunk days into Monday-anchored weeks for the table rows. Each chunk
  // becomes its own small table beneath a header showing the week range
  // plus low-staff indicators per day.
  const weeks = [];
  let current = [];
  for (const day of draftSchedule.days) {
    const d = new Date(day.date + 'T00:00:00');
    const dow = d.getDay();   // 0 = Sun
    // Start a new week on Monday (or the very first day if we haven't started one yet).
    if (current.length === 0 || dow === 1) {
      if (current.length > 0) weeks.push(current);
      current = [day];
    } else {
      current.push(day);
    }
  }
  if (current.length > 0) weeks.push(current);

  const fmtDate = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return { dow: d.toLocaleDateString(undefined, { weekday: 'short' }),
             dn:  d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="border-b bg-gray-50 px-5 py-3">
        <h4 className="font-semibold text-gray-900">Weekly Grid View</h4>
        <p className="text-xs text-gray-500">
          Whole-month look — same layout as Manage Staff Schedule. Use the day-by-day editor below to change anything.
        </p>
      </div>

      <div className="space-y-4 p-4">
        {weeks.map((week, wi) => (
          <div key={wi} className="overflow-x-auto">
            <table className="w-full text-xs border-collapse table-fixed min-w-[680px] [&_td]:border [&_th]:border [&_td]:border-gray-300 [&_th]:border-gray-300">
              <thead>
                <tr className="bg-gray-50">
                  <th className="text-left px-3 py-2 font-semibold text-gray-600 w-32">INSTRUCTOR</th>
                  {week.map(day => {
                    const isLow = day.countingStaffCount < schedConfig.minPerDay;
                    const dl = fmtDate(day.date);
                    return (
                      <th key={day.date}
                        className={`text-center px-2 py-2 font-semibold ${isLow ? 'bg-red-50' : ''}`}>
                        <div className={`text-[10px] uppercase tracking-wide ${isLow ? 'text-red-700' : 'text-gray-500'}`}>{dl.dow}</div>
                        <div className={`${isLow ? 'text-red-800' : 'text-gray-800'} text-xs`}>{dl.dn}</div>
                        <div className={`text-[10px] ${isLow ? 'text-red-700 font-bold' : 'text-gray-500'} mt-0.5`}>
                          {day.countingStaffCount}/{schedConfig.minPerDay}{isLow ? ' ⚠' : ''}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {names.map(name => (
                  <tr key={name}>
                    <td className="px-3 py-1.5 font-medium text-gray-800 bg-white">
                      {name}
                    </td>
                    {week.map(day => {
                      const isScheduled = day.assignedEmployees?.includes(name);
                      if (!isScheduled) {
                        return <td key={day.date} className="bg-gray-50/40 px-1 py-1" />;
                      }
                      const isSick = !!day.sickPay?.[name];
                      const assignment = assignmentFor({
                        role: day.roles?.[name],
                        subRole: day.subRoles?.[name],
                      });
                      const bg = isSick ? '#7f1d1d' : assignmentColorHex(assignment, centerConfig);
                      const text = contrastText(bg);
                      return (
                        <td key={day.date} className="p-0 align-top">
                          <div
                            className="rounded m-0.5 px-1.5 py-1 text-[10px] leading-tight"
                            style={{ backgroundColor: bg, color: text }}
                            title={`${name} · ${day.shiftTimes?.[name] || ''} · ${assignment}`}
                          >
                            <div className="font-bold truncate">{day.shiftTimes?.[name] || ''}</div>
                            <div className="opacity-90 truncate">{assignmentShort(assignment)}</div>
                            {isSick && <div className="font-bold opacity-90">SICK</div>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Small inline delta badge for week/month-over-week comparison ──────
function DeltaBadge({ delta, pct, isUp }) {
  if (delta === 0) {
    return (
      <span className="rounded-full bg-gray-100 text-gray-600 px-2 py-0.5 text-[10px] font-semibold">
        flat
      </span>
    );
  }
  const positive = isUp;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
      positive ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
    }`}>
      {positive ? '▲' : '▼'} {Math.abs(Math.round(delta * 10) / 10)}h
      {Math.abs(pct) < 999 && ` · ${Math.abs(Math.round(pct))}%`}
    </span>
  );
}

// Single row inside the Operations Snapshot — label on the left, the
// number on the right with an optional tone colour (good / warn / bad)
// and a hint underneath for context.
function SnapshotRow({ label, value, hint, tone }) {
  const toneCls =
    tone === 'good' ? 'text-emerald-700'
    : tone === 'warn' ? 'text-amber-700'
    : tone === 'bad'  ? 'text-rose-700'
    : 'text-gray-900';
  return (
    <div className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <p className={`text-base font-bold tabular-nums ${toneCls}`}>{value}</p>
    </div>
  );
}

// ─── Sub-component: Analytics tab ────────────────────────────────────────
// Owner-only dashboard. Pulls from the existing shifts + users + center
// config — no new data plumbing for Phase 1. Active student count is a
// manual entry on this page (Phase 2 will add automated enrollment import).

export function AnalyticsTab({ shifts, users, centerConfig, activeCenterId, view = 'hub' }) {
  const navigate = useNavigate();
  // Live counts that power the extra metric cards (open shifts, pending
  // time-off, etc). Pulled here rather than threaded through props
  // because the rest of Admin.jsx already subscribes to these elsewhere
  // — small duplication, but keeps the Analytics tab self-contained.
  const [openShiftsList, setOpenShiftsList] = useState([]);
  const [timeOffPending, setTimeOffPending] = useState(0);
  const [pendingSwapsCount, setPendingSwapsCount] = useState(0);
  useEffect(() => {
    if (!activeCenterId) return;
    const u1 = onSnapshot(
      query(
        collection(db, 'openShifts'),
        where('centerId', '==', activeCenterId),
      ),
      snap => setOpenShiftsList(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {},
    );
    const u2 = onSnapshot(
      query(
        collection(db, 'timeOffRequests'),
        where('centerId', '==', activeCenterId),
        where('status', '==', 'pending'),
      ),
      snap => setTimeOffPending(snap.size),
      () => {},
    );
    // Pending shift-swap requests — they live in the `chat` collection
    // as documents tagged type: 'shift_swap' with swapStatus: 'open'.
    // We count them so the owner sees pending swaps next to open
    // shifts (both represent "schedule needs human attention").
    //
    // We additionally drop swaps whose shiftDate is in the past — a swap
    // request for a shift that already happened is dead even if nobody
    // closed the chat doc, and shouldn't inflate the badge. Matches the
    // ShiftBoard + sidebar logic (`!m.shiftDate || m.shiftDate >= today`).
    const u3 = onSnapshot(
      query(
        collection(db, 'chat'),
        where('centerId', '==', activeCenterId),
        where('type', '==', 'shift_swap'),
        where('swapStatus', '==', 'open'),
      ),
      snap => {
        const today = format(new Date(), 'yyyy-MM-dd');
        const stillPending = snap.docs.filter(d => {
          const date = d.data()?.shiftDate;
          return !date || date >= today;
        });
        setPendingSwapsCount(stillPending.length);
      },
      () => {},
    );
    return () => { u1(); u2(); u3(); };
  }, [activeCenterId]);
  const now = new Date();
  const todayStr      = format(now, 'yyyy-MM-dd');
  const weekStartStr  = format(startOfWeek(now), 'yyyy-MM-dd');
  const weekEndStr    = format(addDays(startOfWeek(now), 6), 'yyyy-MM-dd');
  // viewMonth drives the Snapshot + Leaderboard + Hours-by-Assignment +
  // Payroll Projection cards. The other cards (Today / This Week /
  // This Year / Coverage rolling-8 / Hiring forecast) intentionally
  // stay anchored to "now" — they're not monthly.
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(new Date()));
  const monthStartStr = format(startOfMonth(viewMonth), 'yyyy-MM-dd');
  const monthEndStr   = format(endOfMonth(viewMonth), 'yyyy-MM-dd');
  const isViewingCurrentMonth = format(startOfMonth(now), 'yyyy-MM') === format(viewMonth, 'yyyy-MM');
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

  // Prior-period totals for the comparison badges.
  // "Last week" is the 7-day Sun–Sat window before this one. "Last month"
  // is the prior calendar month. Used to show + / − deltas on the Hours
  // This Week / Hours This Month cards so the owner can see momentum.
  const lastWeekStartStr = format(addDays(startOfWeek(now), -7), 'yyyy-MM-dd');
  const lastWeekEndStr   = format(addDays(startOfWeek(now), -1), 'yyyy-MM-dd');
  const hoursLastWeek    = sumHrs(posted.filter(s => s.date >= lastWeekStartStr && s.date <= lastWeekEndStr));

  // "Last month" delta is relative to whatever month is being viewed.
  const lastMonthDate     = subMonths(viewMonth, 1);
  const lastMonthStartStr = format(startOfMonth(lastMonthDate), 'yyyy-MM-dd');
  const lastMonthEndStr   = format(endOfMonth(lastMonthDate),   'yyyy-MM-dd');
  const hoursLastMonth    = sumHrs(posted.filter(s => s.date >= lastMonthStartStr && s.date <= lastMonthEndStr));

  // Return { delta, pct, isUp } for a current/previous pair. Returns null
  // when there's no previous data so the UI can hide the badge.
  const deltaFor = (current, prev) => {
    if (!prev) return null;
    const delta = current - prev;
    const pct = Math.abs(prev) > 0 ? (delta / prev) * 100 : 0;
    return { delta, pct, isUp: delta >= 0 };
  };
  const weekDelta  = deltaFor(hoursWeek,  hoursLastWeek);
  const monthDelta = deltaFor(hoursMonth, hoursLastMonth);

  // ── Open shifts (future-dated, still unfilled) ──
  const openShiftsCount = openShiftsList.filter(s => s.status === 'open' && s.date >= todayStr).length;

  // ── Sick days used this month — count distinct dates with sickPay ──
  const sickDatesByName = new Map();
  for (const s of monthShifts) {
    if (!s.sickPay || !s.userName || !s.date) continue;
    if (!sickDatesByName.has(s.userName)) sickDatesByName.set(s.userName, new Set());
    sickDatesByName.get(s.userName).add(s.date);
  }
  const sickDaysThisMonth = [...sickDatesByName.values()].reduce((sum, set) => sum + set.size, 0);

  // ── Days till next stat holiday ──
  const holidaysList = Array.isArray(centerConfig?.holidays) ? centerConfig.holidays : [];
  const upcomingHolidays = holidaysList
    .filter(h => h?.date && h.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));
  const nextHoliday = upcomingHolidays[0] || null;
  const daysTillNext = nextHoliday
    ? Math.round((new Date(nextHoliday.date + 'T00:00:00') - new Date(todayStr + 'T00:00:00')) / (24 * 3600 * 1000))
    : null;

  // ── Stat pay hours YTD (BC ESA "average day" rule) ──
  // For each holiday in the calendar year so far that's already passed,
  // sum the average-day hours for each person who had 15+ shifts in the
  // 30 days before that holiday. Gives the owner a single rolled-up
  // figure of stat-pay liability for the year.
  const allShiftsByName = {};
  for (const s of posted) {
    if (!s.userName || !s.date) continue;
    if (!allShiftsByName[s.userName]) allShiftsByName[s.userName] = [];
    allShiftsByName[s.userName].push(s);
  }
  const minusDaysStr = (dateStr, n) => {
    const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const ytdHolidays = holidaysList.filter(h => h?.date && h.date >= yearStartStr && h.date <= todayStr);
  let statHoursYTD = 0;
  for (const h of ytdHolidays) {
    const windowStart = minusDaysStr(h.date, 30);
    for (const name of Object.keys(allShiftsByName)) {
      const relevant = allShiftsByName[name].filter(s => s.date >= windowStart && s.date < h.date);
      if (relevant.length < 15) continue;
      const total = relevant.reduce((sum, s) => sum + shiftHours(s), 0);
      statHoursYTD += total / relevant.length;
    }
  }
  statHoursYTD = Math.round(statHoursYTD * 10) / 10;

  // Active employees: approved staff at this centre, excluding super-admins.
  // Active staff split: employees = paid roster (excludes volunteers),
  // volunteers = separate tile so the owner can see unpaid headcount.
  // Combined headcount is still derivable for any future card that
  // needs it: activeEmployees + activeVolunteers.
  const activeEmployees  = users.filter(u => u.approved && u.role !== 'super_admin' && u.isVolunteer !== true).length;
  const activeVolunteers = users.filter(u => u.approved && u.role !== 'super_admin' && u.isVolunteer === true).length;

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
  //
  // We use INSTRUCTIONAL hours (teaching window, e.g. 3pm-7pm), not
  // OPERATING hours (full open window, e.g. 10am-8pm). Owners only care
  // about coverage during teaching hours — showing 10am as "red" is
  // misleading because the centre isn't even running classes then.
  // Each centre's instructional hours are configured in Centre Settings,
  // so this auto-tailors per centre (Mathnasium Langley's 3-7p, a centre
  // with longer hours, etc.).
  const opHoursMap = centerConfig?.instructionalHours || DEFAULT_CENTER_CONFIG.instructionalHours;
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

  // (Removed) Manual "emails needing response" state — the Emails-to-Reply
  // tile was retired when Active Volunteers took its slot. Re-introduce if
  // we ever build an inbox-sync connector that's worth surfacing here.

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

  // ─── Operations Snapshot stats (replaces the old Hours-per-Day bar
  // chart with denser, more decision-useful numbers) ──────────────────
  // Avg hours per day this month — only count days that actually had
  // shifts so a fresh month doesn't drag the average to zero.
  const monthDatesWithShifts = new Set(monthShifts.map(s => s.date).filter(Boolean));
  const avgHoursPerDay = monthDatesWithShifts.size > 0
    ? hoursMonth / monthDatesWithShifts.size : 0;
  const avgHoursPerShift = monthShifts.length > 0
    ? hoursMonth / monthShifts.length : 0;

  // Busiest / quietest weekday by avg hours (this month).
  const dowHours = {}; // dayName -> { hours, dates: Set }
  for (const s of monthShifts) {
    if (!s.date) continue;
    const d = new Date(s.date + 'T12:00:00');
    const dayName = ALL_WEEKDAYS[d.getDay()];
    if (!dowHours[dayName]) dowHours[dayName] = { hours: 0, dates: new Set() };
    dowHours[dayName].hours += shiftHours(s);
    dowHours[dayName].dates.add(s.date);
  }
  const dowRows = Object.entries(dowHours).map(([day, v]) => ({
    day, avg: v.dates.size > 0 ? v.hours / v.dates.size : 0,
  })).sort((a, b) => b.avg - a.avg);
  const busiestDay = dowRows[0] || null;
  const quietestDay = dowRows.length > 0 ? dowRows[dowRows.length - 1] : null;

  // Open shift fill rate (this month) — filled vs total slots posted.
  const monthShiftCount = monthShifts.length;
  const openShiftsMonth = openShiftsList.filter(s =>
    s.date >= monthStartStr && s.date <= monthEndStr).length;
  const fillRate = (monthShiftCount + openShiftsMonth) > 0
    ? (monthShiftCount / (monthShiftCount + openShiftsMonth)) * 100 : 0;

  // Sick day rate this month — sick days as % of all scheduled person-days.
  const personDaysThisMonth = new Set(
    monthShifts.map(s => `${s.userName}|${s.date}`),
  ).size;
  const sickRate = personDaysThisMonth > 0
    ? (sickDaysThisMonth / personDaysThisMonth) * 100 : 0;

  // Average distinct-instructor coverage across operating days (last 8 weeks).
  const coverageAvgAll = coverageRows.filter(r => r.samples > 0);
  const coverageAvg = coverageAvgAll.length > 0
    ? coverageAvgAll.reduce((sum, r) => sum + r.avg, 0) / coverageAvgAll.length : 0;
  const coverageVsTarget = coverageTarget > 0
    ? (coverageAvg / coverageTarget) * 100 : 0;

  // ─── Payroll Projection (semi-monthly) ───────────────────────────────
  // Mathnasium pays semi-monthly with a lagged window:
  //   • 15th payroll covers the 26th of the PRIOR month → 10th of this month
  //   • 30th payroll covers the 11th → 25th of this month
  // Hours worked from the 26th onward roll into NEXT month's 15th run.
  //
  // This card MUST match the Manage Payroll export's "Total Hours" column
  // so owners can reconcile the two. That means the same filters as
  // payrollSummary in Admin.jsx:
  //   – posted only (drafts excluded)
  //   – Volunteer-role shifts excluded
  //   – salaried staff, flagged volunteers, and hidden ops accounts
  //     (owner / super-admin / Admin Team / internal) excluded
  //   – sick shifts NOT added to the headline (they live in a separate
  //     Sick Pay column in the export)
  //   – Payroll Hours = payHoursOverride if set, else scheduled.
  const payHrsOf = (s) =>
    (typeof s.payHoursOverride === 'number' && isFinite(s.payHoursOverride))
      ? s.payHoursOverride
      : shiftHours(s);

  // Rebuild the same exclusion sets the payroll tab uses. AnalyticsTab
  // only receives `users` + `activeCenterId`, so we resolve per-centre
  // here (cheap; users list is small).
  const _payUsersForCentre = users.map(u => resolveUserForCenter(u, activeCenterId));
  const _paySalaryStaff = new Set(Array.isArray(centerConfig?.salaryStaff) ? centerConfig.salaryStaff : []);
  const _payVolunteerNames = new Set();
  for (const u of _payUsersForCentre) {
    if (u.isVolunteer === true && u.displayName) _payVolunteerNames.add(u.displayName);
  }
  const _payHiddenFromOps = new Set();
  for (const u of users) {
    const hidden = u.role === 'owner' || u.role === 'super_admin'
      || u.internal === true
      || u.displayName === 'Admin Team';
    if (hidden && u.displayName) _payHiddenFromOps.add(u.displayName);
  }
  const _payEligible = (s) =>
    s.status !== 'draft'
    && s.role !== 'Volunteer'
    && !s.sickPay
    && !_paySalaryStaff.has(s.userName)
    && !_payVolunteerNames.has(s.userName)
    && !_payHiddenFromOps.has(s.userName);

  const _vmY = viewMonth.getFullYear();
  const _vmM = viewMonth.getMonth();
  const period1StartDate = new Date(_vmY, _vmM - 1, 26);
  const period1EndDate   = new Date(_vmY, _vmM,     10);
  const period2StartDate = new Date(_vmY, _vmM,     11);
  const period2EndDate   = new Date(_vmY, _vmM,     25);
  const period1StartStr = format(period1StartDate, 'yyyy-MM-dd');
  const period1EndStr   = format(period1EndDate,   'yyyy-MM-dd');
  const period2StartStr = format(period2StartDate, 'yyyy-MM-dd');
  const period2EndStr   = format(period2EndDate,   'yyyy-MM-dd');

  const period1Shifts = shifts.filter(s =>
    s.date >= period1StartStr && s.date <= period1EndStr && _payEligible(s));
  const period2Shifts = shifts.filter(s =>
    s.date >= period2StartStr && s.date <= period2EndStr && _payEligible(s));
  const period1Hours  = period1Shifts.reduce((sum, s) => sum + payHrsOf(s), 0);
  const period2Hours  = period2Shifts.reduce((sum, s) => sum + payHrsOf(s), 0);
  const period1Names  = new Set(period1Shifts.map(s => s.userName).filter(Boolean));
  const period2Names  = new Set(period2Shifts.map(s => s.userName).filter(Boolean));

  // Which pay run is "upcoming" given today's date:
  //   day 1–10  → 15th of this month is next up (period 1)
  //   day 11–25 → 30th of this month is next up (period 2)
  //   day 26+   → already accruing toward NEXT month's 15th, so neither
  //               card in the viewed month is upcoming.
  const todayDay = isViewingCurrentMonth ? now.getDate() : null;
  const currentPeriod = todayDay == null
    ? null
    : (todayDay <= 10 ? 1 : todayDay <= 25 ? 2 : null);

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

  // Metadata for each deep-dive module — used by the hub tiles and the
  // detail-view headers. Keeping this in one place means renaming a
  // module (or adding a 6th) only requires editing this array.
  const MODULES = [
    {
      key: 'snapshot',
      label: `${format(viewMonth, 'MMMM')} Operations Snapshot`,
      desc: 'Daily averages, busiest day, fill rate, sick rate, and projected 15th/30th payroll for the viewed month.',
      icon: Activity, accent: 'bg-purple-100 text-purple-700',
    },
    {
      key: 'intakes',
      label: 'Booking Intakes',
      desc: 'Where new students are coming from — public intake form submissions plus your Apptoto appointment feed.',
      icon: Megaphone, accent: 'bg-sky-100 text-sky-700',
    },
    {
      key: 'coverage',
      label: 'Avg Coverage by Day',
      desc: 'Rolling 8-week average of how many instructors actually show up per weekday vs. your staffing target.',
      icon: Calendar, accent: 'bg-amber-100 text-amber-700',
    },
    {
      key: 'assignments',
      label: 'Hours by Assignment',
      desc: 'Where this month\'s hours are going — by sub-role and per-instructor leaderboard.',
      icon: TrendingUp, accent: 'bg-emerald-100 text-emerald-700',
    },
    {
      key: 'hiring',
      label: 'Hiring Forecast',
      desc: 'Projected headcount over the next 4 months based on staff career-plan answers, plus draft-a-posting tool.',
      icon: Users, accent: 'bg-rose-100 text-rose-700',
    },
  ];
  const currentModule = MODULES.find(m => m.key === view);

  return (
    <div className="space-y-6">
      {/* Header — view-aware. Detail pages get a back link + module
          title; the hub stays as the generic Centre Analytics intro. */}
      {view === 'hub' ? (
        <div>
          <h2 className="text-lg font-bold text-gray-900">Centre Analytics</h2>
          <p className="text-sm text-gray-500">Headcount, hours, and what your team&apos;s been working on at a glance.</p>
        </div>
      ) : (
        <div>
          <button
            onClick={() => navigate('/center-analytics')}
            className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft size={12} /> Back to overview
          </button>
          <div className="flex items-center gap-2">
            {currentModule?.icon && (
              <span className={`rounded-lg p-1.5 ${currentModule.accent}`}>
                <currentModule.icon size={16} />
              </span>
            )}
            <h2 className="text-lg font-bold text-gray-900">{currentModule?.label || 'Analytics'}</h2>
          </div>
          <p className="text-sm text-gray-500 mt-0.5">{currentModule?.desc}</p>
        </div>
      )}

      {/* ── Hub: 5 module tiles ─────────────────────────────────────────
          Only renders on the overview. Each tile is a button that
          navigates to that module's dedicated detail page. Description
          text is right on the tile so a new owner doesn't have to
          click to learn what each module shows. */}
      {view === 'hub' && (
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <LayoutGrid size={14} className="text-gray-500" />
            <h3 className="text-sm font-semibold text-gray-900">Analytics modules</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {MODULES.map(m => {
              const Icon = m.icon;
              return (
                <button
                  key={m.key}
                  onClick={() => navigate(`/center-analytics/${m.key}`)}
                  className="group rounded-xl border border-gray-200 bg-white p-3 text-left transition-all hover:border-purple-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-purple-300"
                >
                  <div className={`mb-2 inline-flex rounded-lg p-1.5 ${m.accent}`}>
                    <Icon size={15} />
                  </div>
                  <p className="text-sm font-semibold text-gray-900 leading-tight group-hover:text-purple-700">{m.label}</p>
                  <p className="mt-1.5 text-xs leading-snug text-gray-500">{m.desc}</p>
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-purple-600 opacity-0 group-hover:opacity-100 transition-opacity">
                    Open →
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 1 — People & inbox.
          Only on hub view. Detail pages don't need the KPI grid. */}
      {view === 'hub' && (<>
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
            {updatedAtLabel ? `Updated ${updatedAtLabel}` : 'Radius sync coming soon'}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-sky-100 text-sky-700"><HandHeart size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Active Volunteers</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{activeVolunteers}</p>
          <p className="mt-1 text-xs text-gray-400">
            {activeVolunteers === 0 ? 'no volunteers approved' : 'unpaid contributors'}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-yellow-100 text-yellow-700"><CalendarX size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Pending Time-Off</p>
          <p className={`mt-0.5 text-2xl font-bold ${timeOffPending > 0 ? 'text-yellow-700' : 'text-gray-900'}`}>
            {timeOffPending}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {timeOffPending === 0 ? 'inbox clear' : `request${timeOffPending === 1 ? '' : 's'} waiting on you`}
          </p>
        </div>
      </div>

      {/* Row 2 — Hours */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-blue-100 text-blue-700"><Clock size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours Today</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursToday)}h</p>
          <p className="mt-1 text-xs text-gray-400">{format(now, 'EEE MMM d')}</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="w-fit rounded-lg p-1.5 bg-indigo-100 text-indigo-700"><CalendarRange size={16}/></div>
            {weekDelta && <DeltaBadge {...weekDelta} />}
          </div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Week</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursWeek)}h</p>
          <p className="mt-1 text-xs text-gray-400">Sun–Sat · last week {round1(hoursLastWeek)}h</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="w-fit rounded-lg p-1.5 bg-amber-100 text-amber-700"><CalendarRange size={16}/></div>
            {monthDelta && <DeltaBadge {...monthDelta} />}
          </div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Month</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursMonth)}h</p>
          <p className="mt-1 text-xs text-gray-400">
            {format(now, 'MMMM yyyy')} · {format(lastMonthDate, 'MMM')} {round1(hoursLastMonth)}h
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-rose-100 text-rose-700"><BarChart3 size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Hours This Year</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{round1(hoursYear)}h</p>
          <p className="mt-1 text-xs text-gray-400">{now.getFullYear()} so far</p>
        </div>
      </div>

      {/* Row 3 — Operations */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-orange-100 text-orange-700"><Briefcase size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Open / Swap Shifts</p>
          <p className={`mt-0.5 text-2xl font-bold ${
            openShiftsCount + pendingSwapsCount > 0 ? 'text-orange-700' : 'text-gray-900'
          }`}>
            {openShiftsCount} <span className="text-gray-300">/</span> {pendingSwapsCount}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            {openShiftsCount === 0 && pendingSwapsCount === 0
              ? 'queue is clear'
              : `${openShiftsCount} open · ${pendingSwapsCount} pending swap${pendingSwapsCount === 1 ? '' : 's'}`}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-amber-100 text-amber-700"><Activity size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Sick Days This Month</p>
          <p className={`mt-0.5 text-2xl font-bold ${sickDaysThisMonth >= 5 ? 'text-amber-700' : 'text-gray-900'}`}>
            {sickDaysThisMonth}
          </p>
          <p className="mt-1 text-xs text-gray-400">{sickDatesByName.size} staff affected</p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-pink-100 text-pink-700"><CalendarX size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Next Stat Holiday</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">
            {daysTillNext == null ? '—' : daysTillNext === 0 ? 'Today' : `${daysTillNext}d`}
          </p>
          <p className="mt-1 text-xs text-gray-400 truncate">
            {nextHoliday
              ? `${nextHoliday.name || 'Holiday'} · ${format(new Date(nextHoliday.date + 'T00:00:00'), 'MMM d')}`
              : 'none in your holidays list'}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="w-fit rounded-lg p-1.5 bg-purple-100 text-purple-700"><DollarSign size={16}/></div>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-gray-400">Stat Pay YTD</p>
          <p className="mt-0.5 text-2xl font-bold text-gray-900">{statHoursYTD}h</p>
          <p className="mt-1 text-xs text-gray-400">{ytdHolidays.length} stat holiday{ytdHolidays.length === 1 ? '' : 's'} paid out</p>
        </div>
      </div>
      </>)}

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

      {/* Emails-to-reply modal removed alongside the Emails-to-Reply
          tile (Active Volunteers now sits in that slot). The
          emailsCount / saveEmailsCount state vars remain in scope but
          unused — safe to delete in a follow-up cleanup pass. */}

      {/* ── Assignments module: Hours by Assignment + Top Instructors ──
          Originally lived in a 2-col grid alongside Operations Snapshot.
          Split into stand-alone cards so each can be view-gated to its
          own module. */}
      {view === 'assignments' && (
      <div className="grid gap-4">
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

      </div>
      )}

      {/* ── Snapshot module: Operations Snapshot + Payroll Projection ──
          Operations Snapshot — dense, decision-useful numbers replacing
          the old 30-day bar chart. Each row is a single KPI that maps to
          a real operating question (Are shifts getting filled? Are we
          short-staffed? Which day is our peak?). Month nav arrows let
          the owner page through prior months for comparison without
          losing the live deltas. */}
      {view === 'snapshot' && (
        <div className="rounded-2xl border bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-gray-900">Operations Snapshot</h3>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setViewMonth(m => subMonths(m, 1))}
                title="Previous month"
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              >
                <ChevronLeft size={14} />
              </button>
              {!isViewingCurrentMonth && (
                <button
                  onClick={() => setViewMonth(startOfMonth(new Date()))}
                  title="Jump to current month"
                  className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] font-medium text-gray-600 hover:bg-gray-50"
                >
                  Today
                </button>
              )}
              <button
                onClick={() => setViewMonth(m => addMonths(m, 1))}
                title="Next month"
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            {format(viewMonth, 'MMMM yyyy')}{isViewingCurrentMonth ? ' · live numbers' : ''}
          </p>
          <div className="divide-y divide-gray-100">
            <SnapshotRow label="Avg hours / day"        value={`${round1(avgHoursPerDay)}h`}  hint={`${monthDatesWithShifts.size} day${monthDatesWithShifts.size === 1 ? '' : 's'} scheduled`} />
            <SnapshotRow label="Avg hours / instructor" value={`${round1(avgPerInstructor)}h`} hint={`${monthInstructors.size} working this month`} />
            <SnapshotRow label="Avg hours / shift"      value={`${round1(avgHoursPerShift)}h`} hint={`${monthShiftCount} shift${monthShiftCount === 1 ? '' : 's'} posted`} />
            <SnapshotRow label="Open-shift fill rate"   value={`${Math.round(fillRate)}%`}     hint={`${openShiftsMonth} still open`} tone={fillRate >= 90 ? 'good' : fillRate >= 75 ? 'warn' : 'bad'} />
            <SnapshotRow label="Students per employee"  value={studentsPerEmployee || '—'}     hint="workload ratio" />
            <SnapshotRow label="Busiest day"  value={busiestDay ? busiestDay.day : '—'}  hint={busiestDay ? `${round1(busiestDay.avg)}h avg` : ''} />
            <SnapshotRow label="Quietest day" value={quietestDay ? quietestDay.day : '—'} hint={quietestDay ? `${round1(quietestDay.avg)}h avg` : ''} />
            <SnapshotRow label="Sick day rate"         value={`${Math.round(sickRate * 10) / 10}%`} hint={`${sickDaysThisMonth} of ${personDaysThisMonth} scheduled days`} tone={sickRate >= 8 ? 'bad' : sickRate >= 4 ? 'warn' : 'good'} />
            <SnapshotRow label="Coverage vs target"    value={`${Math.round(coverageVsTarget)}%`}   hint={`${round1(coverageAvg)} of ${coverageTarget} target instructors / day`} tone={coverageVsTarget >= 95 ? 'good' : coverageVsTarget >= 80 ? 'warn' : 'bad'} />
          </div>
        </div>
      )}

      {/* Payroll Projection — semi-monthly view. 15th pay run covers
          prior-month 26th → this-month 10th; 30th pay run covers
          this-month 11th → 25th. Uses the same Payroll Hours value as
          Manage Payroll — Override wins, scheduled falls back. Owners
          can spot a bloated upcoming run before payroll day instead
          of after. */}
      {view === 'snapshot' && (
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold text-gray-900">Payroll Projection</h3>
          <span className="text-xs text-gray-500">{format(viewMonth, 'MMMM yyyy')}</span>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Semi-monthly pay runs · Payroll Hours = override (if set) or scheduled hours
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            {
              label: '15th payroll',
              window: `${format(period1StartDate, 'MMM d')} – ${format(period1EndDate, 'MMM d')}`,
              hours: period1Hours,
              shifts: period1Shifts.length,
              instructors: period1Names.size,
              upcoming: currentPeriod === 1,
            },
            {
              label: '30th payroll',
              window: `${format(period2StartDate, 'MMM d')} – ${format(period2EndDate, 'MMM d')}`,
              hours: period2Hours,
              shifts: period2Shifts.length,
              instructors: period2Names.size,
              upcoming: currentPeriod === 2,
            },
          ].map(p => (
            <div
              key={p.label}
              className={`rounded-xl border p-4 ${
                p.upcoming
                  ? 'border-purple-300 bg-purple-50/40'
                  : 'border-gray-200 bg-gray-50/40'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{p.label}</span>
                {p.upcoming && (
                  <span className="rounded-full bg-purple-200 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-800">
                    Upcoming
                  </span>
                )}
              </div>
              <p className="text-[10px] text-gray-500 mb-2">{p.window}</p>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold text-purple-700">{round1(p.hours)}</span>
                <span className="text-sm text-gray-500">hrs</span>
              </div>
              <p className="mt-1 text-[10px] text-gray-500">
                {p.shifts} shift{p.shifts === 1 ? '' : 's'} · {p.instructors} instructor{p.instructors === 1 ? '' : 's'}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
          <span className="text-xs font-medium text-gray-600">Total month projection</span>
          <span className="text-sm font-bold text-gray-900">
            {round1(period1Hours + period2Hours)} hrs
          </span>
        </div>
        {isViewingCurrentMonth && (
          <p className="mt-2 text-[10px] text-gray-400 italic">
            Matches the Manage Payroll export (Total Hours): posted shifts only, sick / volunteers / salaried / hidden accounts excluded.
          </p>
        )}
      </div>
      )}

      {/* ── Intakes module: Public Intake form + Apptoto appointments ── */}
      {view === 'intakes' && <IntakeAnalyticsCard />}
      {view === 'intakes' && <ApptotoAppointmentsCard />}

      {/* ── Assignments module: Top Instructors leaderboard ── */}
      {view === 'assignments' && (
      <div className="rounded-2xl border bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Top Instructors</h3>
        <p className="text-xs text-gray-500 mb-4">By hours scheduled · {format(viewMonth, 'MMMM yyyy')}</p>
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
      )}

      {/* ── Coverage module: Day-of-Week + Hourly heatmap ───────────── */}
      {view === 'coverage' && (<>
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
            <h3 className="text-sm font-semibold text-gray-900">Average Instructional Hour Coverage</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Hour-by-hour coverage over the last {COVERAGE_WEEKS} weeks vs your daily target of {coverageTarget} instructors.
              Only your centre's <b>instructional hours</b> are shown — set them under <b>Centre Settings → Hours</b>.
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
      </>)}

      {/* ── Hiring module: 4-month forecast + job posting tools ─────── */}
      {view === 'hiring' && (
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
      )}

      {/* Job posting template modal — only relevant to the hiring view,
          but we leave it mounted at any view since opening state lives
          higher up. Safe: it just renders nothing while jobModalOpen is
          false. */}
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

// ─── Scroll-to-top button ───────────────────────────────────────────────
// Floating ↑ button anchored bottom-right. Appears only after the user
// has scrolled past ~400px so it doesn't clutter the top of the page.
// Click → smooth-scrolls back to the top of the scrollable container
// (the <main> in Layout.jsx — fall back to document scrolling if that
// element isn't found, e.g. when the page is opened standalone).
function ScrollTopButton() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    // The page lives inside Layout's <main className="overflow-y-auto">,
    // so window.scrollY won't catch its scroll. Walk up from any element
    // we can find to locate the actual scrolling container.
    const scrollEl = document.querySelector('main') || document.scrollingElement || document.documentElement;
    const onScroll = () => setShow((scrollEl.scrollTop || window.scrollY) > 400);
    scrollEl.addEventListener('scroll', onScroll);
    window.addEventListener('scroll', onScroll);
    onScroll();
    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  const handleClick = () => {
    const scrollEl = document.querySelector('main') || document.scrollingElement || document.documentElement;
    try { scrollEl.scrollTo({ top: 0, behavior: 'smooth' }); }
    catch { scrollEl.scrollTop = 0; }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  if (!show) return null;
  return (
    <button
      onClick={handleClick}
      aria-label="Scroll to top"
      title="Back to top"
      className="fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-gray-900 text-white shadow-lg hover:bg-gray-700 transition-colors print:hidden"
    >
      <ArrowUp size={18} />
    </button>
  );
}
