/**
 * CoverageModelCard — staff supply against the target the centre sets.
 *
 * THE SHAPE OF THE QUESTION
 *   Monday to Saturday, how many instructors do we want, and have we got
 *   them? That is a day-sized question, so the top level is one bar per
 *   day. Click a day and the same chart redraws for that day's
 *   instructional half hours, which is where "fine at 3:00, two short at
 *   half four" lives.
 *
 *   Targets are typed straight under the bars. A half hour inherits its
 *   day's number unless the expanded view gives it its own, so the flat
 *   case — "twelve, all Monday" — is one input and not eight.
 *
 * IT IS THE SUPPLY & DEMAND CHART, deliberately: same component
 * (SlotBarChart), same palette, same status pills underneath. That page
 * asks "are there enough instructors for the students booked"; this one
 * asks "are there enough for what we asked for". Reading one teaches you
 * to read the other, and sharing the component means they can't drift.
 *
 * IT FOLLOWS INSTRUCTIONAL HOURS, PER WEEKDAY. They are not the same every
 * day (Fri and Sat differ from Mon–Thu here), and a summer override moves
 * them, so the expansion reads resolveInstructionalHours(config, thatDate)
 * rather than a fixed window.
 *
 * NOBODY SUBMITTING IS NOT NOBODY FREE. Most days at this centre have no
 * availability on file. Those days render empty rather than as a bar of
 * zero, and sit out of the week's totals — see classifySlot in
 * coverageModel.js.
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
import SlotBarChart from './SlotBarChart';
import { CHART_INSET } from '../lib/slotChart';
import { Users, ChevronDown, ChevronRight, Save, Loader2, Lock, RotateCcw } from 'lucide-react';

const fmtDate = (ymd) => new Date(`${ymd}T12:00:00`)
  .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const slotLabel = (slot) => {
  const [h, m] = slot.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${h >= 12 ? 'PM' : 'AM'}`;
};

const fmtWindow = (hours) => {
  if (!hours?.start || !hours?.end) return '';
  const to12 = (t) => {
    const [h, m] = t.split(':').map(Number);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h >= 12 ? 'pm' : 'am'}`;
  };
  return `${to12(hours.start)}–${to12(hours.end)}`;
};

/**
 * The status language of Supply & Demand, in instructors: "2 Short" is
 * that many bodies missing, "1 Spare" is one more than asked for. Under
 * and over map onto the same two marker colours that page already uses.
 */
function verdict({ status, shortAvailable, target, available }) {
  // Order matters: no target is "nobody asked", no availability is "nobody
  // answered". They are different states and the second must not read as
  // the first, or a day with a target and no submissions looks settled.
  if (!Number.isFinite(target)) return { chart: 'none', label: '—', tone: 'none' };
  if (available == null) return { chart: 'none', label: 'No data', tone: 'none' };
  const spare = Math.round(available) - target;
  if (status === 'unstaffable' || spare < 0) {
    const n = status === 'unstaffable' ? shortAvailable : Math.abs(spare);
    return { chart: 'understaffed', label: `${n} Short`, tone: 'bad', short: n };
  }
  if (spare > 0) return { chart: 'overstaffed', label: `${spare} Spare`, tone: 'over', short: 0 };
  // Matched means availability covers the target, so there is nobody left
  // to FIND. The rota may still be short of them — that is a different row
  // (On the rota) and a different job, and putting it here made a column
  // read "Matched" with an impact of seven.
  return { chart: 'matched', label: 'Matched', tone: 'good', short: 0 };
}

// The same three colours the chart's marker lines use, so a pill and its
// bar always agree: orange short, red spare, green matched.
const PILL_TONE = {
  bad:  'bg-orange-50 text-orange-700',
  over: 'bg-red-50 text-red-600',
  good: 'bg-emerald-50 text-emerald-700',
  none: 'text-gray-300',
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

  // One column per operating day, read off the NEXT occurrence of it that
  // the centre is actually open. Availability is stored per date, so a
  // weekday view has to stand on a real one.
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
      const status = !known || !Number.isFinite(target)
        ? 'none'
        : classifySlot({ target, available: supply.available, scheduled: supply.scheduled }).status;
      const v = verdict({
        status, target, available: known ? supply.available : null,
        shortAvailable: Math.max(0, (target ?? 0) - supply.available),
      });
      return { weekday, date, hours, slotKeys, ...supply, target, known, verdict: v };
    });
  }, [operatingDays, centerConfig, usersForCentre, availability, shifts, timeOffIndex, centreRoles, model]);

  const measured   = days.filter(d => d.known && Number.isFinite(d.target));
  const atTarget   = measured.filter(d => (d.verdict.short || 0) === 0).length;
  const toFind     = measured.reduce((sum, d) => sum + (d.verdict.short || 0), 0);
  const thinnest   = [...measured].sort((a, b) => (b.verdict.short || 0) - (a.verdict.short || 0))[0];
  const rosterSize = new Set(availability.map(a => a.userId)).size;
  const anyTargets = operatingDays.some(d => hasTargets(model, d));

  const expanded = days.find(d => d.weekday === openDay) || null;
  const slotRows = useMemo(() => {
    if (!expanded) return [];
    return expanded.rows.map(r => {
      const target = targetFor(model, expanded.weekday, r.slot);
      const available = expanded.known ? r.available : null;
      const c = classifySlot({ target, available, scheduled: r.scheduled });
      return {
        ...r, target, available,
        overridden: slotOverridesDay(model, expanded.weekday, r.slot),
        ...c,
        verdict: verdict({ ...c, target, available }),
      };
    });
  }, [expanded, model]);

  // One chart, whichever level is showing.
  const chart = expanded
    ? {
        items: slotRows.map(r => ({
          label: slotLabel(r.slot),
          value: r.available ?? 0,
          marker: Number.isFinite(r.target) ? r.target : undefined,
          status: r.verdict.chart,
        })),
        axisTitle: 'Instructors',
      }
    : {
        items: days.map(d => ({
          label: d.weekday.slice(0, 3),
          value: d.known ? d.available : 0,
          marker: Number.isFinite(d.target) ? d.target : undefined,
          status: d.verdict.chart,
        })),
        axisTitle: 'Instructors',
      };
  const maxY = Math.max(4, ...chart.items.map(i => Math.max(i.value, i.marker || 0))) * 1.15;
  const tickStep = Math.max(1, Math.round(maxY / 6));
  const columns = expanded ? slotRows : days;

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

  return (
    <div className="rounded-2xl border bg-white p-5 shadow-sm">
      {/* Header — same furniture as Supply & Demand: what the chart means on
          the left, the control that changes it on the right. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-base font-bold text-gray-900">
            <Users size={16} className="text-purple-600" />
            {expanded ? `${expanded.weekday} — Supply vs. Target` : 'Centre — Supply vs. Target'}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            {expanded
              ? <>Target: instructors wanted · Supply: instructors available ·
                  instructional hours {fmtWindow(expanded.hours) || 'not set'}, {fmtDate(expanded.date)}</>
              : <>Target: instructors wanted · Supply: instructors available that day ·
                  only staff who count toward the ratio</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && !expanded && (
            <>
              <label className="text-xs font-medium text-gray-600" htmlFor="coverage-all-days">
                Every day
              </label>
              <input
                id="coverage-all-days"
                type="number" min="0" max="40" value={bulk}
                onChange={e => setBulk(e.target.value)}
                placeholder="12"
                aria-label="Target for every operating day"
                className="w-16 rounded-lg border border-gray-300 px-2 py-1.5 text-sm tabular-nums focus:border-purple-500 focus:outline-none"
              />
              <button
                onClick={() => { setDraft(setAllDayTargets(stored, operatingDays, bulk)); setBulk(''); }}
                disabled={bulk === ''}
                className="rounded-lg border border-emerald-300 px-2.5 py-1.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-40"
              >
                Apply to all
              </button>
            </>
          )}
          {expanded && (
            <button
              onClick={() => setOpenDay(null)}
              className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              Back to the week
            </button>
          )}
          {dirty && canEdit && (
            <>
              <button
                onClick={() => setDraft(null)}
                className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
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
            </>
          )}
        </div>
      </div>

      {loading ? (
        <p className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
          <Loader2 size={15} className="animate-spin" /> Reading availability…
        </p>
      ) : (
        <>
          <SlotBarChart
            items={chart.items}
            maxY={maxY}
            tickStep={tickStep}
            axisTitle={chart.axisTitle}
            legend={{
              fill: 'Instructors available',
              matched: 'Target — matched',
              under: 'Target — short',
              over: 'Target — spare',
            }}
          />

          {/* The rows under the chart, in Supply & Demand's shape: the slot,
              the verdict, and what it costs you. */}
          <div className="mt-2 overflow-x-auto">
            <div style={{ paddingLeft: CHART_INSET.left, paddingRight: CHART_INSET.right }}>
              <table className="w-full table-fixed text-xs">
                <tbody>
                  <tr>
                    <th className="w-24 py-1 pr-2 text-left text-[10px] font-bold uppercase tracking-wide text-gray-500">
                      {expanded ? 'Slot' : 'Day'}
                    </th>
                    {columns.map((c, i) => (
                      <td key={i} className="px-0.5 py-1 text-center text-[10px] text-gray-500">
                        {expanded ? slotLabel(c.slot) : (
                          <button
                            onClick={() => setOpenDay(days[i].weekday)}
                            className="inline-flex items-center gap-0.5 font-semibold text-gray-700 hover:text-purple-700"
                          >
                            <ChevronRight size={10} />
                            {days[i].weekday.slice(0, 3)}
                          </button>
                        )}
                        {!expanded && <span className="block text-[9px] text-gray-400">{fmtDate(days[i].date)}</span>}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th className="py-1 pr-2 text-left text-[10px] font-bold uppercase tracking-wide text-gray-500">
                      Ratio status
                    </th>
                    {columns.map((c, i) => (
                      <td key={i} className="px-0.5 py-1">
                        <span className={`block rounded-md px-1 py-1.5 text-center text-[11px] font-bold ${PILL_TONE[c.verdict.tone]}`}>
                          {c.verdict.label}
                        </span>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th className="py-1 pr-2 text-left align-top text-[10px] font-bold uppercase tracking-wide text-gray-500">
                      Target
                      <span className="block text-[9px] font-normal normal-case tracking-normal text-gray-400">
                        {expanded ? 'blank follows the day' : 'instructors wanted'}
                      </span>
                    </th>
                    {columns.map((c, i) => (
                      <td key={i} className="px-0.5 py-1 text-center">
                        {expanded ? (
                          <input
                            type="number" min="0" max="40"
                            value={stored?.[expanded.weekday]?.[c.slot] ?? ''}
                            placeholder={Number.isFinite(c.target) ? String(c.target) : '—'}
                            disabled={!canEdit}
                            aria-label={`Wanted at ${c.slot} on ${expanded.weekday}`}
                            onChange={e => setDraft(setSlotTarget(stored, expanded.weekday, c.slot, e.target.value))}
                            className={`w-12 rounded border px-1 py-1 text-center text-xs tabular-nums focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-200 disabled:bg-gray-50 disabled:text-gray-400 ${
                              c.overridden ? 'border-purple-400 font-semibold text-purple-900' : 'border-gray-300 text-gray-500'
                            }`}
                          />
                        ) : (
                          <input
                            type="number" min="0" max="40"
                            value={dayTargetFor(model, days[i].weekday) ?? ''}
                            placeholder="—"
                            disabled={!canEdit}
                            aria-label={`Instructors wanted on ${days[i].weekday}`}
                            onChange={e => setDraft(setDayTarget(stored, days[i].weekday, e.target.value))}
                            className="w-12 rounded border border-gray-300 px-1 py-1 text-center text-xs font-semibold tabular-nums text-gray-900 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-200 disabled:bg-gray-50 disabled:text-gray-400"
                          />
                        )}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th className="py-1 pr-2 text-left align-top text-[10px] font-bold uppercase tracking-wide text-gray-500">
                      Impact
                      <span className="block text-[9px] font-normal normal-case leading-tight tracking-normal text-gray-400">
                        instructors<br />to find
                      </span>
                    </th>
                    {columns.map((c, i) => (
                      <td key={i} className="px-0.5 py-1 text-center">
                        {c.verdict.short > 0
                          ? <span className="text-base font-bold text-orange-600">{c.verdict.short}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                    ))}
                  </tr>
                  {expanded && (
                    <tr>
                      <th className="py-1 pr-2 text-left text-[10px] font-bold uppercase tracking-wide text-gray-500">
                        On the rota
                        <span className="block text-[9px] font-normal normal-case tracking-normal text-gray-400">
                          drafts included
                        </span>
                      </th>
                      {slotRows.map((r, i) => (
                        <td key={i} className="px-0.5 py-1 text-center tabular-nums text-gray-600">{r.scheduled}</td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Week summary, and the honest-empty caveats. */}
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-gray-200 sm:grid-cols-4">
            <Stat label="Days at target" value={measured.length > 0 ? `${atTarget}` : '—'}
              suffix={measured.length > 0 ? `of ${measured.length}` : ''}
              hint={measured.length > 0 ? 'With availability on file' : 'Set a target to measure'} />
            <Stat label="Instructors short" value={measured.length > 0 ? `${toFind}` : '—'}
              tone={toFind > 0 ? 'bad' : 'good'} hint="Added up across the week" />
            <Stat label="Thinnest day"
              value={thinnest && thinnest.verdict.short > 0 ? thinnest.weekday.slice(0, 3) : '—'}
              tone={thinnest && thinnest.verdict.short > 0 ? 'bad' : 'good'}
              hint={thinnest && thinnest.verdict.short > 0
                ? `${thinnest.verdict.short} short of ${thinnest.target}` : 'Nothing below target'} />
            <Stat label="Roster" value={`${rosterSize}`} hint="Have availability on file" />
          </div>

          {expanded && (
            <p className="mt-3 text-xs text-gray-500">
              {expanded.known
                ? <>{expanded.available} {expanded.available === 1 ? 'person is' : 'people are'} free somewhere
                    in {expanded.weekday}; the bars are how many cover each half hour.</>
                : <>Nobody has submitted availability for {expanded.weekday} {fmtDate(expanded.date)} yet, so
                    there is nothing to measure — that isn&rsquo;t the same as nobody being free.</>}
              {canEdit && slotRows.some(r => r.overridden) && (
                <button
                  onClick={() => setDraft(clearSlotTargets(stored, expanded.weekday))}
                  className="ml-2 inline-flex items-center gap-1 rounded border border-gray-300 px-1.5 py-0.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
                >
                  <RotateCcw size={10} /> Clear half-hour overrides
                </button>
              )}
            </p>
          )}

          {!expanded && days.some(d => !d.known) && (
            <p className="mt-3 text-xs text-gray-500">
              {days.filter(d => !d.known).map(d => d.weekday.slice(0, 3)).join(', ')} —
              nobody has submitted availability yet, so those days aren&rsquo;t measured.
            </p>
          )}

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

          {!expanded && (
            <p className="mt-3 flex items-center gap-1 text-[11px] text-gray-400">
              <ChevronDown size={11} /> Click any day to open its instructional half hours.
            </p>
          )}
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
