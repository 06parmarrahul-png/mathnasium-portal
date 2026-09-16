/**
 * CoverageModelCard — staff supply by day of week, against the target the
 * centre sets for that day.
 *
 * THE SHAPE OF THE QUESTION
 *   Monday to Saturday, how many instructors do we want, and have we got
 *   them? That is a day-sized question, so the top level is one bar per
 *   day. Click a day and it opens into that day's instructional half hours,
 *   which is where "fine at 3:00, two short at half four" lives.
 *
 *   Targets are typed straight under the bars. A half hour inherits its
 *   day's number unless the expanded view gives it its own, so the flat
 *   case — "twelve, all Monday" — is one input and not eight.
 *
 * IT FOLLOWS INSTRUCTIONAL HOURS, PER WEEKDAY. They are not the same for
 * every day (Langley: Mon–Thu 3–7, Fri 3–6, Sat mornings), and a summer
 * override moves them, so the expansion reads
 * resolveInstructionalHours(config, thatDate) rather than a fixed window.
 *
 * WHAT IT REPLACED
 *   "Average Coverage by Day": an 8-week average of distinct instructors
 *   per weekday against one number for the whole centre, counting every
 *   name on a posted shift — hosts, trainees and the admin desk included —
 *   so it never answered "can we staff Friday" and never went through
 *   countsInRatio() the way every other screen does.
 *
 * NOBODY SUBMITTING IS NOT NOBODY FREE. Most days at this centre have no
 * availability on file. Those days render blank rather than as a bar of
 * zero, and sit out of the totals — see classifySlot in coverageModel.js.
 */

import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where, orderBy, doc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import { isCentreManager } from '../lib/managementTier';
import { resolveUserForCenter } from '../lib/centerMembership';
import { buildTimeOffIndex } from '../lib/timeOff';
import {
  resolveInstructionalHours, ALL_WEEKDAYS, DEFAULT_CENTER_CONFIG, holidayFor,
} from '../lib/centerConfig';
import {
  normalizeModel, slotKeysFor, targetFor, dayTargetFor, slotOverridesDay, hasTargets,
  daySupply, classifySlot, upcomingDatesFor, setDayTarget, setSlotTarget,
  clearSlotTargets, setAllDayTargets,
} from '../lib/coverageModel';
import {
  Users, ChevronDown, ChevronRight, Save, Loader2, Lock, AlertTriangle, RotateCcw,
} from 'lucide-react';

const fmtDate = (ymd) => {
  const d = new Date(`${ymd}T12:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const slotLabel = (slot) => {
  const [h, m] = slot.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}` : `${h12}:${String(m).padStart(2, '0')}`;
};
const meridiem = (slot) => (Number(slot.split(':')[0]) >= 12 ? 'p' : 'a');
const fmtWindow = (hours) => {
  if (!hours?.start || !hours?.end) return '';
  const to12 = (t) => {
    const [h, m] = t.split(':').map(Number);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
  };
  return `${to12(hours.start)}–${to12(hours.end)}`;
};

const STATUS_STYLE = {
  met:         'bg-emerald-50 text-emerald-700',
  fillable:    'bg-amber-50 text-amber-800',
  unstaffable: 'bg-rose-50 text-rose-700',
  none:        'text-gray-300',
};

export default function CoverageModelCard() {
  const { activeCenterId, centerConfig, centreRoles, can, isAdmin, profile } = useAuth();
  const [users, setUsers] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [timeOff, setTimeOff] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openDay, setOpenDay] = useState(null);
  const [draft, setDraft] = useState(null);       // a pending write, unsaved
  const [saving, setSaving] = useState(false);
  const [bulk, setBulk] = useState('');

  // Mirrors the centre-config write rule: owner tier, Enterprise, the legacy
  // Admin role, a Manager of THIS centre, or a role granted centre.settings.
  // Hosts run the board but the rules don't let them write config, so they
  // read rather than get a save button that fails.
  const canEdit = can('centre.settings') || isAdmin || isCentreManager(profile, activeCenterId);

  // Self-contained on purpose: this card sits on two pages that hold
  // different slices of data, and a prop-fed version would read one window
  // on Centre Analytics and another on the Staffing Board.
  useEffect(() => {
    if (!activeCenterId) return;
    const d = new Date();
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const subs = [
      onSnapshot(
        query(collection(db, 'users'), where('centerIds', 'array-contains', activeCenterId)),
        snap => setUsers(snap.docs.map(x => ({ id: x.id, ...x.data() }))),
        () => setUsers([]),
      ),
      onSnapshot(
        query(collection(db, 'availability'), where('centerId', '==', activeCenterId), where('date', '>=', start), orderBy('date')),
        snap => { setAvailability(snap.docs.map(x => ({ id: x.id, ...x.data() }))); setLoading(false); },
        () => { setAvailability([]); setLoading(false); },
      ),
      onSnapshot(
        query(collection(db, 'shifts'), where('centerId', '==', activeCenterId), where('date', '>=', start), orderBy('date')),
        snap => setShifts(snap.docs.map(x => ({ id: x.id, ...x.data() }))),
        () => setShifts([]),
      ),
      // No single `date` field to range-filter on (it lives in startDate /
      // endDate), so this one is unbounded — same as the Staffing Board.
      onSnapshot(
        query(collection(db, 'timeOffRequests'), where('centerId', '==', activeCenterId)),
        snap => setTimeOff(snap.docs.map(x => ({ id: x.id, ...x.data() }))),
        () => setTimeOff([]),
      ),
    ];
    return () => subs.forEach(u => u());
  }, [activeCenterId]);

  const stored = useMemo(
    () => draft ?? (centerConfig?.coverageModel || {}),
    [draft, centerConfig?.coverageModel],
  );
  const model = useMemo(() => normalizeModel(stored), [stored]);
  const dirty = draft !== null
    && JSON.stringify(normalizeModel(draft)) !== JSON.stringify(normalizeModel(centerConfig?.coverageModel));

  const usersForCentre = useMemo(
    () => users.map(u => resolveUserForCenter(u, activeCenterId)),
    [users, activeCenterId],
  );
  const timeOffIndex = useMemo(() => buildTimeOffIndex(timeOff), [timeOff]);

  const operatingDays = (Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0)
    ? centerConfig.operatingDays
    : DEFAULT_CENTER_CONFIG.operatingDays;

  // One bar per operating day, read off the NEXT occurrence of it that the
  // centre is actually open. Availability is stored per date, so a weekday
  // view has to stand on a real one.
  const days = useMemo(() => {
    const live = shifts.filter(s => s?.status !== 'cancelled');
    return operatingDays.map(weekday => {
      const dates = upcomingDatesFor(weekday, 8, new Date(), ALL_WEEKDAYS);
      const date = dates.find(d => !holidayFor(new Date(`${d}T12:00:00`), centerConfig)) || dates[0];
      const hours = resolveInstructionalHours(centerConfig, new Date(`${date}T12:00:00`))?.[weekday];
      const slotKeys = slotKeysFor(hours);
      const supply = daySupply({
        date, slotKeys, users: usersForCentre, availability, shifts: live, timeOffIndex, roles: centreRoles,
      });
      const target = dayTargetFor(model, weekday);
      const known = supply.hasAvailability;
      return {
        weekday, date, hours, slotKeys, ...supply, target,
        known,
        short: known && Number.isFinite(target) ? Math.max(0, target - supply.available) : 0,
        spare: known && Number.isFinite(target) ? Math.max(0, supply.available - target) : 0,
      };
    });
  }, [operatingDays, centerConfig, usersForCentre, availability, shifts, timeOffIndex, centreRoles, model]);

  const measured   = days.filter(d => d.known && Number.isFinite(d.target));
  const atTarget   = measured.filter(d => d.short === 0).length;
  const toFill     = measured.reduce((sum, d) => sum + d.short, 0);
  const thinnest   = [...measured].sort((a, b) => b.short - a.short)[0];
  const rosterSize = new Set(availability.map(a => a.userId)).size;
  const anyTargets = operatingDays.some(d => hasTargets(model, d));
  const scale = Math.max(4, ...days.map(d => Math.max(d.available, Number.isFinite(d.target) ? d.target : 0))) * 1.15;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round((scale * f) / 5) * 5).filter((v, i, a) => a.indexOf(v) === i);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const ref = doc(db, 'centers', activeCenterId, 'config', 'main');
      // updateDoc, NOT setDoc(merge): a merge write deep-merges maps, so a
      // target you CLEARED would quietly survive in the stored model.
      try {
        await updateDoc(ref, { coverageModel: draft });
      } catch (err) {
        if (err?.code !== 'not-found') throw err;
        await setDoc(ref, { coverageModel: draft }, { merge: true });
      }
      setDraft(null);
      toast.success('Targets saved.');
    } catch (err) {
      toast.error(err?.message || 'Could not save the targets.');
    } finally {
      setSaving(false);
    }
  };

  const expanded = days.find(d => d.weekday === openDay) || null;

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            <Users size={15} className="text-purple-600" />
            Staff supply by day of week
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            How many instructors are available each day, against the target you set for that day.
            Click a day to open its instructional half hours. Only staff who count toward the ratio.
          </p>
        </div>
        {dirty && canEdit && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDraft(null)}
              className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              Discard
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-40"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save targets
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-gray-400">
          <Loader2 size={15} className="animate-spin" /> Reading availability…
        </p>
      ) : (
        <>
          {/* Stat strip */}
          <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-gray-200 sm:grid-cols-4">
            <Stat
              label="Days at target"
              value={measured.length > 0 ? `${atTarget}` : '—'}
              suffix={measured.length > 0 ? `of ${measured.length}` : ''}
              hint={measured.length > 0 ? 'With availability on file' : 'Set a target to measure'}
            />
            <Stat
              label="Instructors short"
              value={measured.length > 0 ? `${toFill}` : '—'}
              tone={toFill > 0 ? 'bad' : 'good'}
              hint="Added up across the week"
            />
            <Stat
              label="Thinnest day"
              value={thinnest && thinnest.short > 0 ? thinnest.weekday.slice(0, 3) : '—'}
              tone={thinnest && thinnest.short > 0 ? 'bad' : 'good'}
              hint={thinnest && thinnest.short > 0
                ? `${thinnest.short} short of ${thinnest.target}`
                : 'Nothing below target'}
            />
            <Stat
              label="Roster"
              value={`${rosterSize}`}
              hint="Have availability on file"
            />
          </div>

          {/* Bars */}
          <div className="relative">
            <div className="absolute inset-x-0 top-0 h-[190px]">
              {ticks.map(t => (
                <div
                  key={t}
                  className="absolute inset-x-0 border-t border-gray-100"
                  style={{ bottom: `${(t / scale) * 100}%` }}
                >
                  <span className="absolute -top-2 left-0 bg-white pr-1 text-[10px] tabular-nums text-gray-300">{t}</span>
                </div>
              ))}
            </div>

            <div className="relative flex items-end gap-2 pl-6" style={{ height: 190 }}>
              {days.map(d => {
                const barPct    = d.known ? (d.available / scale) * 100 : 0;
                const targetPct = Number.isFinite(d.target) ? (d.target / scale) * 100 : null;
                const isOpen    = openDay === d.weekday;
                return (
                  <button
                    key={d.weekday}
                    onClick={() => setOpenDay(isOpen ? null : d.weekday)}
                    className="group relative flex h-full flex-1 flex-col justify-end rounded-t-lg outline-none focus-visible:ring-2 focus-visible:ring-purple-300"
                    aria-expanded={isOpen}
                    title={d.known
                      ? `${d.available} available on ${d.weekday} ${fmtDate(d.date)} — click for half hours`
                      : `No availability on file for ${d.weekday} ${fmtDate(d.date)}`}
                  >
                    {/* Shortfall band: bar top up to the target line. */}
                    {d.known && targetPct !== null && d.short > 0 && (
                      <div
                        className="absolute inset-x-2 rounded-t border border-dashed border-rose-300 bg-rose-100/50"
                        style={{ bottom: `${barPct}%`, height: `${targetPct - barPct}%` }}
                      />
                    )}
                    {d.known ? (
                      <>
                        <span className="relative z-10 mx-auto mb-1 rounded bg-white/90 px-1 text-center text-sm font-bold tabular-nums text-gray-900">
                          {d.available}
                        </span>
                        <div
                          className={`mx-2 rounded-t-md transition-all ${
                            d.short > 0 ? 'bg-emerald-600/80' : 'bg-emerald-500'
                          } ${isOpen ? 'ring-2 ring-purple-400' : 'group-hover:opacity-90'}`}
                          style={{ height: `${barPct}%` }}
                        />
                      </>
                    ) : (
                      <div className="mx-2 rounded-t-md border border-dashed border-gray-200 bg-gray-50" style={{ height: '12%' }}>
                        <span className="sr-only">No availability on file</span>
                      </div>
                    )}
                    {/* The day's target line. */}
                    {targetPct !== null && (
                      <div
                        className="pointer-events-none absolute inset-x-1 border-t-2 border-dashed border-rose-400"
                        style={{ bottom: `${targetPct}%` }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Day labels, verdicts and the target inputs. */}
            <div className="flex gap-2 pl-6">
              {days.map(d => {
                const isOpen = openDay === d.weekday;
                return (
                  <div key={d.weekday} className="flex-1 text-center">
                    <button
                      onClick={() => setOpenDay(isOpen ? null : d.weekday)}
                      className="mt-1.5 inline-flex items-center gap-0.5 text-xs font-bold text-gray-800 hover:text-purple-700"
                    >
                      {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      {d.weekday.slice(0, 3)}
                    </button>
                    <p className="text-[10px] text-gray-400">{fmtDate(d.date)}</p>
                    <p className={`text-[11px] ${
                      !d.known ? 'text-gray-300'
                        : !Number.isFinite(d.target) ? 'text-gray-400'
                          : d.short > 0 ? 'font-semibold text-rose-600' : 'text-emerald-700'
                    }`}>
                      {!d.known ? 'none on file'
                        : !Number.isFinite(d.target) ? 'no target'
                          : d.short > 0 ? `${d.short} short` : `+${d.spare} spare`}
                    </p>
                    <input
                      type="number" min="0" max="40"
                      value={dayTargetFor(model, d.weekday) ?? ''}
                      placeholder="—"
                      disabled={!canEdit}
                      aria-label={`Instructors wanted on ${d.weekday}`}
                      onChange={e => setDraft(setDayTarget(stored, d.weekday, e.target.value))}
                      className="mt-1 w-14 rounded-lg border border-gray-300 px-1 py-1 text-center text-xs font-semibold tabular-nums text-gray-900 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-200 disabled:bg-gray-50 disabled:text-gray-400"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bulk set + legend */}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
            {canEdit && (
              <>
                <input
                  type="number" min="0" max="40" value={bulk}
                  onChange={e => setBulk(e.target.value)}
                  placeholder="12"
                  aria-label="Target for every operating day"
                  className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-xs tabular-nums focus:border-purple-500 focus:outline-none"
                />
                <button
                  onClick={() => { setDraft(setAllDayTargets(stored, operatingDays, bulk)); setBulk(''); }}
                  disabled={bulk === ''}
                  className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  Set every day to this
                </button>
              </>
            )}
            <span className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
              <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" /> instructors available
              <span className="mx-1 text-gray-300">·</span>
              <span className="inline-block h-0 w-3 border-t-2 border-dashed border-rose-400" /> that day&rsquo;s target
              <span className="mx-1 text-gray-300">·</span>
              <span className="inline-block h-2 w-3 rounded-sm border border-dashed border-rose-300 bg-rose-100/60" /> shortfall
            </span>
          </div>

          {!anyTargets && canEdit && (
            <p className="mt-3 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-center text-xs text-gray-500">
              No targets set yet — type a number under any day, or set them all at once above.
              At a 4:1 ratio, 12 instructors cover up to 48 students at a time.
            </p>
          )}
          {!canEdit && (
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-400">
              <Lock size={11} /> Read-only — a Manager, the Admin Assistant or the owner sets these.
            </p>
          )}

          {expanded && <DayDetail
            day={expanded}
            model={model}
            stored={stored}
            canEdit={canEdit}
            onSlot={(slot, value) => setDraft(setSlotTarget(stored, expanded.weekday, slot, value))}
            onClearOverrides={() => setDraft(clearSlotTargets(stored, expanded.weekday))}
          />}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, suffix, hint, tone }) {
  const toneClass = tone === 'bad' ? 'text-rose-600' : tone === 'good' ? 'text-emerald-700' : 'text-gray-900';
  return (
    <div className="bg-white px-3 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{label}</p>
      <p className={`mt-0.5 text-xl font-bold tabular-nums ${toneClass}`}>
        {value}
        {suffix && <span className="ml-1 text-xs font-medium text-gray-400">{suffix}</span>}
      </p>
      {hint && <p className="text-[10px] text-gray-400">{hint}</p>}
    </div>
  );
}

/**
 * One day, opened up into its instructional half hours. Same three lines as
 * the day bar, per slot, plus the status the slot earns — and the inputs
 * that let one half hour differ from the rest of the day.
 */
function DayDetail({ day, model, stored, canEdit, onSlot, onClearOverrides }) {
  const rows = day.rows.map(r => {
    const target = targetFor(model, day.weekday, r.slot);
    const available = day.known ? r.available : null;
    return {
      ...r, target, available,
      overridden: slotOverridesDay(model, day.weekday, r.slot),
      ...classifySlot({ target, available, scheduled: r.scheduled }),
    };
  });
  const worst = rows.filter(r => r.status === 'unstaffable').sort((a, b) => b.shortAvailable - a.shortAvailable)[0];
  const anyOverride = rows.some(r => r.overridden);

  return (
    <div className="mt-5 rounded-xl border border-purple-200 bg-purple-50/30 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-bold text-gray-900">
          {day.weekday} {fmtDate(day.date)}
          <span className="ml-2 text-xs font-normal text-gray-500">
            instructional hours {fmtWindow(day.hours) || 'not set'}
          </span>
          <span className="mt-0.5 block text-[11px] font-normal text-gray-500">
            {day.known
              ? <>{day.available} {day.available === 1 ? 'person is' : 'people are'} free somewhere in the day —
                  the row below is how many cover each half hour.</>
              : <>Nobody has submitted availability for this date yet.</>}
          </span>
        </h4>
        {canEdit && anyOverride && (
          <button
            onClick={onClearOverrides}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2 py-1 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
          >
            <RotateCcw size={11} /> Clear half-hour overrides
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-400">
          No instructional hours set for {day.weekday} — add them in Centre Settings → Hours.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-purple-200">
                  <th className="sticky left-0 z-10 bg-purple-50/0 pb-1.5 pr-3 text-left font-bold uppercase tracking-wide text-gray-500">
                    Slot
                  </th>
                  {rows.map(r => (
                    <th key={r.slot} className="px-1 pb-1.5 text-center font-semibold tabular-nums text-gray-600">
                      {slotLabel(r.slot)}<span className="text-[9px] text-gray-400">{meridiem(r.slot)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-purple-100">
                <tr>
                  <td className="py-2 pr-3 font-semibold text-gray-700">
                    Wanted
                    <span className="block text-[10px] font-normal text-gray-400">blank follows the day</span>
                  </td>
                  {rows.map(r => (
                    <td key={r.slot} className="px-0.5 py-1.5 text-center">
                      <input
                        type="number" min="0" max="40"
                        value={stored?.[day.weekday]?.[r.slot] ?? ''}
                        placeholder={Number.isFinite(r.target) ? String(r.target) : '—'}
                        disabled={!canEdit}
                        aria-label={`Wanted at ${r.slot} on ${day.weekday}`}
                        onChange={e => onSlot(r.slot, e.target.value)}
                        className={`w-11 rounded border px-1 py-1 text-center text-xs tabular-nums focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-200 disabled:bg-gray-50 disabled:text-gray-400 ${
                          r.overridden ? 'border-purple-400 bg-white font-semibold text-purple-900' : 'border-gray-300 bg-white text-gray-500'
                        }`}
                      />
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-gray-600">
                    Available
                    <span className="block text-[10px] text-gray-400">
                      {day.known ? 'told us they can work' : 'none submitted yet'}
                    </span>
                  </td>
                  {rows.map(r => (
                    <td key={r.slot} className="px-1 py-2 text-center tabular-nums text-gray-700">
                      {r.available == null ? <span className="text-gray-300">—</span> : r.available}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-gray-600">
                    Scheduled
                    <span className="block text-[10px] text-gray-400">on the rota, drafts included</span>
                  </td>
                  {rows.map(r => (
                    <td key={r.slot} className="px-1 py-2 text-center tabular-nums text-gray-700">{r.scheduled}</td>
                  ))}
                </tr>
                <tr>
                  <td className="py-2 pr-3 font-bold uppercase tracking-wide text-gray-500">Status</td>
                  {rows.map(r => (
                    <td key={r.slot} className="px-0.5 py-1.5 text-center">
                      <span
                        className={`block rounded px-1 py-1.5 text-[11px] font-semibold ${STATUS_STYLE[r.status]}`}
                        title={r.status === 'none'
                          ? 'No target set for this half hour'
                          : r.status === 'unstaffable'
                            ? `Want ${r.target}, ${r.available} free, ${r.scheduled} rostered`
                            : `Want ${r.target}, ${r.scheduled} rostered${r.available == null ? '' : `, ${r.available} free`}`}
                      >
                        {r.status === 'none' && '—'}
                        {r.status === 'met' && 'OK'}
                        {r.status === 'fillable' && `-${r.short}`}
                        {r.status === 'unstaffable' && `-${r.shortAvailable}`}
                      </span>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          {worst && (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-rose-700">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                <b>{slotLabel(worst.slot)}{meridiem(worst.slot) === 'p' ? 'pm' : 'am'}</b> can&rsquo;t be staffed:
                you want {worst.target} and {worst.available} {worst.available === 1 ? 'person has' : 'people have'} said
                they can work it. Hiring or availability, not the rota.
              </span>
            </p>
          )}
          {!day.known && (
            <p className="mt-3 text-xs text-gray-500">
              Nobody has submitted availability for {day.weekday} {fmtDate(day.date)} yet, so the Available row is
              blank — that isn&rsquo;t the same as nobody being free.
            </p>
          )}
        </>
      )}
    </div>
  );
}
