/**
 * A booked assessment, as the Calendar edits it.
 *
 * An assessment is a `centerIntakes` document, not a calendar entry —
 * that collection alone occupies a slot on the public booking page,
 * counts against the per-day cap and reaches the Intakes list and the
 * Leads funnel. The rules keep it at owner tier because it carries a
 * parent's name, email and phone.
 *
 * Pure so it can be tested without rendering, and so the editor file
 * exports a component and nothing else.
 */
import { minutesOf } from './ratioCalendar';

export const INTAKE_STATUSES = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'completed', label: 'Completed' },
  { key: 'no_show',   label: 'No-show' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** The slot string centerIntakes stores: centre-local wall clock, no zone. */
export const slotOf = (date, time) => `${date}T${time || '00:00'}:00`;

/** Everything wrong with this draft, or null. */
export function validateAssessment(d) {
  if (!d?.date) return 'Pick a date.';
  if (minutesOf(d?.startTime) == null) return 'Pick a start time.';
  if (!Number(d?.durationMin)) return 'How long is it?';
  if (!String(d?.childName || '').trim() && !String(d?.guardianName || '').trim()) {
    return 'Put at least one name on it — the child or the guardian.';
  }
  return null;
}

/**
 * Another booked assessment this one would run into.
 *
 * A warning, never a block. Staff double-book on purpose sometimes (two
 * instructors, one hour) and the person moving it can see the centre's
 * day; the public booking page is where a collision must actually be
 * refused, and it already is.
 */
export function clashWith(draft, intakes) {
  const s = minutesOf(draft?.startTime);
  if (s == null || !draft?.date) return null;
  const e = s + Number(draft.durationMin || 60);
  for (const t of intakes || []) {
    if (!t || t.id === draft.id) continue;
    if (t.status === 'cancelled') continue;
    if (String(t.slot || '').slice(0, 10) !== draft.date) continue;
    const ts = minutesOf(String(t.slot).slice(11, 16));
    if (ts == null) continue;
    const te = ts + Number(t.durationMin || 60);
    if (s < te && ts < e) return t;
  }
  return null;
}

