/**
 * The shape of Today's Snapshot: who is on, in what order, and how many
 * of them are teaching each half hour.
 *
 * The ordering rules here were CoverageGrid's private ones. They moved so
 * the condensed snapshot on the leadership home and the full grid on the
 * classic Home cannot drift apart — a person has to appear in the same
 * group, in the same place, on both. CoverageGrid imports them from here
 * now; nothing about them changed in the move.
 *
 * Everything in this file is a read of ONE collection: today's shifts.
 * Nothing is compared against student demand, a budget or Radius.
 */
import { countsInRatio } from './ratioCount';

/** "15:30" → 930. Anything unparseable → NaN, and callers drop it. */
export function mins(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

// Tier 5 — trainees. Paid and present, but shadowing rather than
// covering, so they must never sit in the in-centre instructor block
// where someone reading the grid would count them as staffing.
export const isTrainingRole = (role) => String(role || '').trim().toLowerCase() === 'training';

/**
 * Ordering for Today's Snapshot:
 *   0 = Important staff (Hosts + Management — Manager, Director, Admin)
 *   1 = Online instructors
 *   2 = In-centre instructors (Instructor + Lead) — the teaching workforce
 *   3 = Volunteers, tracked below the paid roster
 *   4 = LEGACY STEAM / Summer Camp
 *   5 = Trainees
 *
 * Checks BOTH role and subRole because most centres tag online staff as
 * role:'Instructor' + subRole:'Online' rather than role:'Online Instructor'.
 */
export const rolePriority = (role, subRole, isVolunteer, flexRole) => {
  // LEGACY tier. STEAM / Summer Camp were removed and nothing writes
  // flexRole any more, but the 58 summer-2026 shifts that carry it still
  // need their own row group on a historical day rather than being mixed
  // into the in-centre instructor block.
  if (flexRole) return 4;
  if (isTrainingRole(role)) return 5;
  if (isVolunteer) return 3;
  if (role === 'Online Instructor' || subRole === 'Online') return 1;
  if (role === 'Instructor' || role === 'Lead')             return 2;
  // Everything else (Host, Manager, Director, Admin, Director of Education,
  // Centre Director, …) is "important staff".
  return 0;
};

/**
 * Sub-ordering WITHIN each tier:
 *   Tier 0 (management): CD → Dir. Ed → Manager → Admin Assistant → Host
 *   Tier 2 (in-centre):  Lead → Highschool → Elementary
 * Anything unrecognised falls to the bottom of its tier so a new role
 * added later doesn't hide.
 */
export const subPriorityInTier = (tier, role, subRole) => {
  if (tier === 0) {
    if (role === 'Center Director' || role === 'Centre Director')          return 0;
    if (role === 'Dir. of Education' || role === 'Director of Education')  return 1;
    if (role === 'Manager')                                                return 2;
    if (role === 'Admin Assistant' || role === 'admin_assistant')          return 3;
    if (role === 'Host')                                                   return 4;
    return 5;
  }
  if (tier === 2) {
    if (role === 'Lead')                                                   return 0;
    if (subRole === 'Highschool' || subRole === 'High School')             return 1;
    if (subRole === 'Elementary')                                          return 2;
    return 3;
  }
  return 0; // other tiers fall through to alphabetical only
};

export const TIER_LABEL = {
  0: 'Hosts & Management',
  1: 'Online Instructors',
  2: 'In-Centre Instructors',
  3: 'Volunteers',
  4: 'STEAM / Summer Camp (retired)',
  5: 'Training',
};

/** A shift somebody actually works. Drafts and cancellations are neither. */
export const isLiveShift = (s) => !!s && s.status !== 'draft' && s.status !== 'cancelled';

/**
 * The half hours the day actually spans, from the shifts themselves —
 * never a hardcoded 3-to-7. Snapped outwards so a 2:45 start still has a
 * column to sit in.
 */
export function dayAxis(rows) {
  const starts = [];
  const ends = [];
  for (const r of rows || []) {
    const a = mins(r.startTime);
    const b = mins(r.endTime);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) { starts.push(a); ends.push(b); }
  }
  if (!starts.length) return { from: null, to: null, slots: [] };
  const from = Math.floor(Math.min(...starts) / 30) * 30;
  const to = Math.ceil(Math.max(...ends) / 30) * 30;
  const slots = [];
  for (let t = from; t < to; t += 30) slots.push(t);
  return { from, to, slots };
}

/** Live shifts, tagged with their tier and volunteer flag, in grid order. */
export function snapshotRows(shifts, { volunteerNames = new Set() } = {}) {
  return (shifts || [])
    .filter(s => isLiveShift(s) && s.userName && Number.isFinite(mins(s.startTime)) && Number.isFinite(mins(s.endTime)))
    .map((s) => {
      const isVolunteer = volunteerNames.has(s.userName);
      return { ...s, isVolunteer, tier: rolePriority(s.role, s.subRole, isVolunteer, s.flexRole) };
    })
    .sort((a, b) => (
      a.tier - b.tier
      || subPriorityInTier(a.tier, a.role, a.subRole) - subPriorityInTier(b.tier, b.role, b.subRole)
      || String(a.userName).localeCompare(String(b.userName))
    ));
}

/** Rows grouped into their tiers, in tier order, empty tiers dropped. */
export function groupRows(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.tier === r.tier) last.rows.push(r);
    else out.push({ tier: r.tier, label: TIER_LABEL[r.tier] || 'Other', rows: [r] });
  }
  return out;
}

/**
 * How many people are teaching in each half hour.
 *
 * Whether a shift counts is the shift's OWN stored answer, read through
 * countsInRatio — never guessed from the role. That rule has been broken
 * six times in this codebase and this is not the seventh.
 */
export function instructorsPerSlot(rows, slots) {
  return (slots || []).map(t => (rows || []).filter(r => (
    countsInRatio(r, { isVolunteer: r.isVolunteer })
    && mins(r.startTime) <= t && t < mins(r.endTime)
  )).length);
}

/**
 * The four headline figures.
 *
 * `online` counts a role of 'Online Instructor' OR a sub-role of 'Online'.
 * The classic tile checks only the role, so on a day when the centre's
 * online lead is stored as role:'Lead' + subRole:'Online' it reads 0 while
 * the grid directly beneath it files that person under Online Instructors.
 */
export function snapshotTotals(rows) {
  let hours = 0;
  for (const r of rows) hours += (mins(r.endTime) - mins(r.startTime)) / 60;
  return {
    people: rows.length,
    instructors: rows.filter(r => countsInRatio(r, { isVolunteer: r.isVolunteer })).length,
    host: rows.filter(r => !r.flexRole && r.role === 'Host').length,
    online: rows.filter(r => !r.flexRole && (r.role === 'Online Instructor' || r.subRole === 'Online')).length,
    hours: Math.round(hours * 10) / 10,
    sick: rows.filter(r => r.sickPay).length,
    noShow: rows.filter(r => r.noShow).length,
  };
}

/** Everyone with a Lead shift, and whoever is hosting. */
export function whoIsRunningIt(rows) {
  const leads = rows.filter(r => String(r.role || '').toLowerCase().includes('lead')).map(r => r.userName);
  const host = rows.find(r => r.role === 'Host')?.userName || null;
  return { leads, host };
}

/** The longest run of slots at the day's peak, as [startMin, endMin]. */
export function peakWindow(counts, slots) {
  const max = Math.max(0, ...counts);
  if (!max) return null;
  let best = null;
  let run = null;
  counts.forEach((c, i) => {
    if (c === max) run = run || i;
    else if (run !== null) { if (!best || i - run > best[1] - best[0]) best = [run, i]; run = null; }
  });
  if (run !== null && (!best || counts.length - run > best[1] - best[0])) best = [run, counts.length];
  return best ? { max, from: slots[best[0]], to: slots[best[1] - 1] + 30 } : null;
}
