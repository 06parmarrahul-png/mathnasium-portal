/**
 * leadStory.js — a lead's five events, and which of them have happened.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE STORY, NOT THE STATUS.
 *
 * A lead's `status` is one word for a thing with a shape: they enquired,
 * somebody reached them, an assessment got booked, they sat it, they
 * enrolled. "Contacted" tells you none of that, and the gaps between the
 * events are where the centre loses people.
 *
 * So this module answers, for one lead: what has happened, what hasn't
 * yet, where are they standing, and how long did each step take. The UI
 * draws it as a line of dots — filled where it happened, hollow where it
 * hasn't — and the durations sit on the connectors.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * IT INVENTS NOTHING. Every step reads a field the lead actually carries.
 * A step with no evidence behind it is 'todo' — not "probably done
 * because they enrolled". An enrolled lead with no assessment recorded
 * draws a hollow Assessed dot, which is the truth: nobody wrote it down.
 *
 * BOOKED IS NOT DONE. An assessment on the books is 'planned', not
 * 'done', because a filled dot has to mean it happened or the whole line
 * stops being readable at a glance. That also catches the lead everyone
 * misses: the date went by and nobody recorded an outcome, which draws
 * as still-not-filled rather than quietly completing itself.
 *
 * PURE MODULE — no React, no Firebase, no clock of its own.
 */

import { whenOf } from './leadAnalytics';
import { daysUntil, dayMs, daysToAssessment, DAYS_TO_ASSESSMENT_GOAL } from './leadFollowUp';

/** Local 'YYYY-MM-DD' for a millis stamp.
 *
 *  Deliberately NOT toISOString().slice(0,10), which gives the UTC day —
 *  from 5pm in Vancouver that is already tomorrow, and this file would
 *  date half the centre's evening enquiries a day late.
 */
export function ymdOf(value) {
  const at = whenOf(value);
  if (at === null) return '';
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** '2026-10-03' → '3 Oct'. Date only, so there is no clock format to
 *  honour — the reader's 12h/24h preference does not apply to a day. */
export function formatDay(ymd) {
  const at = dayMs(ymd);
  if (at === null) return '';
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The five events, in the order they happen. */
export const STORY_KEYS = ['enquiry', 'reached', 'assessment', 'assessed', 'outcome'];

export const STORY_LABELS = {
  enquiry:    'Enquiry in',
  reached:    'Reached',
  assessment: 'Assessment',
  assessed:   'Assessed',
  outcome:    'Enrolled',
};

/**
 * `state` is one of:
 *   done    — it happened
 *   planned — on the books, not confirmed (a future date, or a past one
 *             nobody recorded an outcome for)
 *   todo    — hasn't happened
 *   miss    — it broke: no-show or cancelled
 *   won     — they enrolled
 *   lost    — they went elsewhere
 *
 * Exactly one step may carry `now: true` — where the family is standing.
 * A finished story (won or lost) has none, because there is nothing to
 * stand on.
 */
export function storyOf(lead, now = Date.now()) {
  const l = lead || {};
  const outcome = l.assessmentOutcome || '';
  const won = l.status === 'enrolled';
  const lost = l.status === 'lost';

  // Reached: when they were FIRST reached, not most recently.
  //
  // `lastContactOn` moves every time somebody logs a call, so a family
  // rung again a week after their assessment would draw a Reached dot
  // dated after the Assessment dot beside it — the story told out of
  // order. `contactedAt` is stamped once, when the lead first moved to
  // Contacted, so it is the one that belongs on a timeline. The latest
  // contact is still shown, as its own field, in the detail panel.
  const reachedOn = ymdOf(l.contactedAt) || l.lastContactOn || '';

  // Assessed: its own stamp, or — when the outcome says they attended —
  // the day of the assessment, which is when it happened.
  const assessedOn = ymdOf(l.assessedAt) || (outcome === 'attended' ? l.assessmentOn || '' : '');

  const until = l.assessmentOn ? daysUntil(l.assessmentOn, now) : null;
  const wait = daysToAssessment(l);

  const steps = [
    {
      key: 'enquiry',
      on: ymdOf(l.createdAt),
      state: 'done',
    },
    {
      key: 'reached',
      on: reachedOn,
      state: reachedOn ? 'done' : 'todo',
    },
    {
      key: 'assessment',
      on: l.assessmentOn || '',
      state: outcome === 'no-show' || outcome === 'cancelled' ? 'miss'
        : !l.assessmentOn ? 'todo'
          : outcome === 'attended' ? 'done'
            // Still on the books: either it hasn't come round yet, or it
            // has and nobody said what happened.
            : 'planned',
      note: outcome === 'no-show' ? 'No show' : outcome === 'cancelled' ? 'Cancelled' : '',
      // A booked date that has already gone by with nothing recorded.
      // The one lead a pipeline quietly loses.
      unrecorded: Boolean(l.assessmentOn) && until !== null && until < 0
        && outcome !== 'attended' && outcome !== 'no-show' && outcome !== 'cancelled',
      // THE CENTRE'S HEADLINE NUMBER, on the event it belongs to.
      // "Lead in, assessed within four days" is measured enquiry → the
      // assessment date, which is one hop when nobody logged a call and
      // two when somebody did — so it cannot live on a connector. It is
      // a property of the assessment, and it is shown on it.
      waitDays: wait,
      late: wait !== null && wait > DAYS_TO_ASSESSMENT_GOAL,
    },
    {
      key: 'assessed',
      on: assessedOn,
      state: assessedOn ? 'done' : 'todo',
    },
    {
      key: 'outcome',
      on: won ? ymdOf(l.enrolledAt) : lost ? ymdOf(l.lostAt) : '',
      state: won ? 'won' : lost ? 'lost' : 'todo',
      note: lost ? 'Lost' : '',
    },
  ];

  for (const s of steps) {
    s.label = s.note || STORY_LABELS[s.key];
    s.done = s.state === 'done' || s.state === 'won';
  }

  // Where they are standing: the first step still open. A finished story
  // has nobody standing anywhere.
  if (!won && !lost) {
    const at = steps.findIndex(s => s.state === 'todo' || s.state === 'planned' || s.state === 'miss');
    if (at >= 0) steps[at].now = true;
  }
  return steps;
}

/** A step that has landed — something real to measure from or to. */
const landed = (s) => s.state !== 'todo';

/**
 * Days spent between consecutive steps, one entry per gap (the last is
 * always null — there is no segment after the final dot).
 *
 * ONLY BETWEEN TWO THINGS THAT HAVE LANDED. A gap with an open end has
 * no length yet, and a "0d" on it would read as "instant" rather than
 * "hasn't happened". Same-day gaps are dropped too: "0d" on a connector
 * is noise, and the dots already sit next to each other.
 *
 * A label here is only ever how long THAT hop took. The four-day goal
 * spans enquiry → assessment, which is one hop or two depending on
 * whether anybody logged a call, so it lives on the assessment step
 * instead — see `waitDays` / `late` in storyOf().
 */
export function storyGaps(steps) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i];
    const b = steps[i + 1];
    if (!b || !landed(a) || !landed(b) || !a.on || !b.on) { out.push(null); continue; }
    const from = dayMs(a.on);
    const to = dayMs(b.on);
    if (from === null || to === null) { out.push(null); continue; }
    const days = Math.round((to - from) / 86400000);
    if (days < 1) { out.push(null); continue; }
    out.push({ days, label: `${days}d` });
  }
  return out;
}

/** How far along the story is, 0–4. Used to sort a pipeline by stage. */
export function stageIndex(lead, now = Date.now()) {
  const steps = storyOf(lead, now);
  const at = steps.findIndex(s => s.now);
  return at < 0 ? steps.length : at;
}
