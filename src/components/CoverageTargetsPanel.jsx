/**
 * CoverageTargetsPanel — "how many floor staff do we want at half four?"
 *
 * The centre's staffing targets were a single number for a whole day
 * (minPerDay). This is the per-half-hour version: pick a weekday, type a
 * count into each slot, save. It writes `coverageModel` on the centre
 * config, which Centre Analytics → Coverage then measures availability and
 * the posted rota against (src/lib/coverageModel.js).
 *
 * WHY IT LIVES ON THE STAFFING BOARD
 *   The people who know the answer are the ones staffing the floor —
 *   Managers and Hosts — and Centre Analytics is owner-tier only. The
 *   Firestore rules already let a Manager write the centre config
 *   (isAdminOrManagerAt), so this needed no new permission.
 *
 *   Hosts are the exception: they run the board but the rules do NOT let
 *   them write the config. They get the panel read-only rather than a save
 *   button that fails — see canEdit below.
 *
 * IT IS A WANT, NOT A ROTA. Nothing schedules from these numbers; the
 * board still builds shifts from real bookings.
 */

import { useMemo, useState } from 'react';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import { isCentreManager } from '../lib/managementTier';
import { resolveInstructionalHours, ALL_WEEKDAYS, DEFAULT_CENTER_CONFIG } from '../lib/centerConfig';
import {
  resolveCoverageModel, slotKeysFor, targetFor, setSlotTarget, fillWeekday, upcomingDatesFor,
} from '../lib/coverageModel';
import { Target, ChevronDown, ChevronRight, Save, Loader2, Lock } from 'lucide-react';

/** 'HH:MM' → '4:30' — the column heading, kept short so slots fit across. */
function slotLabel(slot) {
  const [h, m] = slot.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}` : `${h12}:${String(m).padStart(2, '0')}`;
}

function meridiem(slot) {
  return Number(slot.split(':')[0]) >= 12 ? 'p' : 'a';
}

export default function CoverageTargetsPanel() {
  const { activeCenterId, centerConfig, can, isAdmin, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(() => ALL_WEEKDAYS[new Date().getDay()]);
  // Edits live here until saved, so a half-typed column never reaches the
  // config that other screens read.
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [bulk, setBulk] = useState('');

  // Mirrors the config write rule: owner tier, Enterprise, the legacy Admin
  // role, a Manager of THIS centre, or a custom role granted centre.settings.
  const canEdit = can('centre.settings') || isAdmin || isCentreManager(profile, activeCenterId);

  const saved = useMemo(() => resolveCoverageModel(centerConfig), [centerConfig]);
  const model = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  const operatingDays = (Array.isArray(centerConfig?.operatingDays) && centerConfig.operatingDays.length > 0)
    ? centerConfig.operatingDays
    : DEFAULT_CENTER_CONFIG.operatingDays;

  // The teaching window for this weekday, taken from the next date that
  // falls on it so a live summer-hours override is honoured.
  const slots = useMemo(() => {
    const [next] = upcomingDatesFor(day, 1, new Date(), ALL_WEEKDAYS);
    const hours = resolveInstructionalHours(centerConfig, next ? new Date(`${next}T12:00:00`) : new Date());
    return slotKeysFor(hours?.[day]);
  }, [centerConfig, day]);

  const dayTotal = slots.reduce((sum, s) => {
    const t = targetFor(model, day, s);
    return sum + (Number.isFinite(t) ? t : 0);
  }, 0);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const ref = doc(db, 'centers', activeCenterId, 'config', 'main');
      // updateDoc, NOT setDoc(merge): a merge write deep-merges maps, so a
      // target you CLEARED would quietly survive in the stored model.
      // Replacing the whole field is the only way a deletion sticks.
      try {
        await updateDoc(ref, { coverageModel: draft });
      } catch (err) {
        if (err?.code !== 'not-found') throw err;
        await setDoc(ref, { coverageModel: draft }, { merge: true });
      }
      setDraft(null);
      toast.success('Coverage targets saved.');
    } catch (err) {
      toast.error(err?.message || 'Could not save the targets.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-5 rounded-2xl border border-gray-200 bg-white shadow-sm">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
        <Target size={15} className="text-purple-600" />
        <span className="text-sm font-bold text-gray-900">Coverage targets</span>
        <span className="text-xs text-gray-500">
          How many floor staff you want in each half hour
        </span>
        {dirty && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
            Unsaved
          </span>
        )}
        <span className="ml-auto text-xs text-gray-400">
          {Object.keys(saved).length > 0
            ? `${Object.keys(saved).length} ${Object.keys(saved).length === 1 ? 'day' : 'days'} set`
            : 'Not set yet'}
        </span>
      </button>

      {open && (
        <div className="border-t px-4 py-4">
          <p className="mb-3 text-xs text-gray-500">
            This is what you <b>want</b>, not a rota — nothing is scheduled from it. Centre Analytics
            measures submitted availability and the posted schedule against these numbers, so you can
            see which half hours you can&rsquo;t staff before the week starts.
          </p>

          {/* Weekday picker */}
          <div className="mb-3 inline-flex flex-wrap gap-0.5 rounded-lg bg-gray-100 p-0.5">
            {operatingDays.map(d => (
              <button
                key={d}
                onClick={() => setDay(d)}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-all ${
                  day === d ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {d.slice(0, 3)}
              </button>
            ))}
          </div>

          {slots.length === 0 ? (
            <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-gray-400">
              No instructional hours set for {day} — add them in Centre Settings → Hours first.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="text-xs">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-white pb-1 pr-3 text-left font-bold uppercase tracking-wide text-gray-500">
                        {day}
                      </th>
                      {slots.map(s => (
                        <th key={s} className="px-0.5 pb-1 text-center font-semibold tabular-nums text-gray-600">
                          {slotLabel(s)}<span className="text-[9px] text-gray-400">{meridiem(s)}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="sticky left-0 z-10 bg-white pr-3 text-gray-500">Staff wanted</td>
                      {slots.map(s => {
                        const value = targetFor(model, day, s);
                        return (
                          <td key={s} className="px-0.5 py-1">
                            <input
                              type="number" min="0" max="30"
                              value={value ?? ''}
                              placeholder="—"
                              disabled={!canEdit}
                              onChange={e => setDraft(setSlotTarget(model, day, s, e.target.value))}
                              aria-label={`Staff wanted at ${s} on ${day}`}
                              className="w-11 rounded border border-gray-300 px-1 py-1 text-center text-xs tabular-nums focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-200 disabled:bg-gray-50 disabled:text-gray-400"
                            />
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">
                  {dayTotal > 0
                    ? <>That&rsquo;s <b className="tabular-nums">{(dayTotal / 2).toFixed(1)}h</b> of floor time across {day}.</>
                    : <>Nothing set for {day} yet.</>}
                </span>

                {canEdit && (
                  <>
                    <span className="ml-auto flex items-center gap-1.5">
                      <input
                        type="number" min="0" max="30" value={bulk}
                        onChange={e => setBulk(e.target.value)}
                        placeholder="4"
                        aria-label={`Apply a count to every ${day} slot`}
                        className="w-14 rounded-lg border border-gray-300 px-2 py-1.5 text-xs tabular-nums focus:border-purple-500 focus:outline-none"
                      />
                      <button
                        onClick={() => { setDraft(fillWeekday(model, day, slots, bulk)); setBulk(''); }}
                        disabled={bulk === ''}
                        className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                      >
                        Apply to all {day.slice(0, 3)} slots
                      </button>
                    </span>
                    {dirty && (
                      <button
                        onClick={() => setDraft(null)}
                        className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                      >
                        Discard
                      </button>
                    )}
                    <button
                      onClick={save}
                      disabled={!dirty || saving}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-40"
                    >
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                      Save targets
                    </button>
                  </>
                )}
              </div>

              {!canEdit && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-gray-400">
                  <Lock size={12} />
                  Read-only — a Manager, the Admin Assistant or the owner sets these.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
