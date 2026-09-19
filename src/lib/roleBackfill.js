/**
 * A person's JOB TITLE is copied onto every shift when the shift is
 * created (`role: person.user?.instructorType`), the same way their name
 * is. The copy is what the grid reads — CoverageGrid asks
 * `assignmentFor({ role, subRole })`, and only a `role` containing "lead"
 * produces a LEAD badge — so promoting someone updates their account and
 * leaves every shift already on the calendar showing the old title.
 *
 * For shifts they have ALREADY WORKED that is correct and must stay: a
 * timesheet should record the job that was done, not the job they hold
 * now. For shifts still to come it is simply wrong, and it is what this
 * module fixes.
 *
 * THE RULE, and why it is this narrow:
 *
 *   A shift's role is not always the person's title. The grid is built
 *   around one person working two roles in a day — "LEAD 11–3 covering
 *   for the owner, HOST 3–7" — so a future shift deliberately scheduled
 *   as something else is real data, not staleness. The only shifts that
 *   can be relabelled without guessing are the ones still carrying the
 *   title the person is being promoted OUT of.
 *
 *   That rule is also what makes this safe to run twice: once a shift has
 *   moved to the new title it no longer matches, so nothing moves again.
 *
 * Shared, deliberately, between the live promotion path in Manage Staff
 * and scripts/backfill-shift-roles.js, so the one-off repair of everyone
 * promoted before this existed cannot drift from what happens from now on.
 */

/** No title stored at all reads as Instructor, which is what the grid draws. */
const DEFAULT_TITLE = 'Instructor';

const titleOf = (v) => String(v || DEFAULT_TITLE).trim();

/** Case-insensitive, because titles are free text a centre can invent. */
const sameTitle = (a, b) => titleOf(a).toLowerCase() === titleOf(b).toLowerCase();

/**
 * The shifts a title change should rewrite.
 *
 * @param {Array}  shifts     every shift for this person (`userId ==`)
 * @param {string} oldTitle   what they were, before the change
 * @param {string} newTitle   what they are now
 * @param {string} centerId   the centre the title changed at — a promotion
 *                            at one centre must not relabel their shifts
 *                            at another, since the title is per-centre
 * @param {string} from       ISO date; shifts before this are history
 * @returns {Array} the subset to update, each needing `role: newTitle`
 */
export function shiftsToRelabel(shifts, { oldTitle, newTitle, centerId, from }) {
  if (!Array.isArray(shifts) || !from || !centerId) return [];
  // A change that isn't one has nothing to propagate. Re-saving the same
  // title is NOT a repair here: the shifts left stale by an older
  // promotion carry a title nobody is moving out of any more, and there
  // is no way to tell those apart from a shift deliberately scheduled as
  // another role. The script asks a person to look at those instead.
  if (sameTitle(oldTitle, newTitle)) return [];
  return shifts.filter(s => (
    s
    && s.centerId === centerId
    && typeof s.date === 'string'
    && s.date >= from
    && sameTitle(s.role, oldTitle)
  ));
}

/**
 * Future shifts whose role disagrees with the title the person now holds,
 * grouped by the role they currently carry.
 *
 * This is the wider, LOSSY question — it cannot tell a shift left behind
 * by an old promotion from one deliberately scheduled as another role, so
 * nothing acts on it automatically. It exists so the one-off script can
 * print what it found and let a person decide.
 *
 * @returns {Map<string, Array>} current role → the shifts carrying it
 */
export function disagreeingShiftsByRole(shifts, { title, centerId, from }) {
  const out = new Map();
  if (!Array.isArray(shifts) || !from || !centerId) return out;
  for (const s of shifts) {
    if (!s || s.centerId !== centerId) continue;
    if (typeof s.date !== 'string' || s.date < from) continue;
    if (sameTitle(s.role, title)) continue;
    const key = titleOf(s.role);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(s);
  }
  return out;
}

/**
 * Split a list into writeBatch-sized chunks. Firestore caps a batch at
 * 500 operations, and a long-tenured person can hold more shifts than
 * that; 400 leaves room without needing to think about it.
 */
export function batches(list, size = 400) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
