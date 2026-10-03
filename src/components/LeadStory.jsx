/**
 * The lead's story, drawn.
 *
 * Filled dot — it happened. Hollow dot — it hasn't. Ringed dot with a
 * centre — it is on the books but not confirmed. Red — it broke. Green —
 * they enrolled. A halo marks where the family is standing right now.
 *
 * COLOUR ENCODES STATE, NOT STAGE. Position already says which event a
 * dot is; painting each event its own colour spends the one channel that
 * could have told you whether it is done. So the line is dark where the
 * story happened and pale where it hasn't got to yet, and the eye can
 * find the live lead in a column of forty without reading a word.
 *
 * THE NUMBERS ARE MEASURED, NEVER ESTIMATED. A connector is only
 * labelled when both of its ends are real; the four-day wait sits on the
 * assessment, because that is the event it belongs to. All of it comes
 * from lib/leadStory.js, which is where the rules and the tests live.
 *
 * Three shapes, one model:
 *   LeadStoryRail — inline, for a row in a list.
 *   LeadStoryGrid — stages in fixed columns, so a column of leads lines
 *                   up and you can scan DOWN to see where people stall.
 *   LeadStorySpine — vertical, with what was said hanging off each dot.
 */

import { storyOf, storyGaps, formatDay } from '../lib/leadStory';
import { LEAD_SOURCE_LABELS } from '../lib/leads';
import { LEAD_REASON_LABELS } from '../lib/leadFollowUp';

/** Urgency → the ring colour on the dot they're standing on. */
const RING = { rose: '#e11d48', amber: '#d97706', sky: '#0284c7', slate: '#64748b' };

const INK = {
  done: '#1e293b',   // happened
  won:  '#059669',   // enrolled
  miss: '#e11d48',   // no-show or cancelled
  pale: '#cbd5e1',   // hasn't happened
  line: '#94a3b8',   // a connector between two real things
};

function Dot({ step, size = 12, tone = 'slate' }) {
  const ring = RING[tone] || RING.slate;
  const base = {
    width: size, height: size, borderRadius: 999, flex: `0 0 ${size}px`,
    display: 'grid', placeItems: 'center', boxSizing: 'border-box',
    position: 'relative', zIndex: 1,
  };
  const halo = step.now ? `0 0 0 ${Math.round(size / 3)}px ${ring}1f` : 'none';

  if (step.state === 'done') return <span style={{ ...base, background: INK.done }} />;
  if (step.state === 'won') return <span style={{ ...base, background: INK.won }} />;
  if (step.state === 'miss') {
    return <span style={{ ...base, background: INK.miss, boxShadow: halo }} />;
  }
  if (step.state === 'lost') {
    return <span style={{ ...base, background: '#fff', border: `2px dashed ${INK.line}` }} />;
  }
  if (step.state === 'planned') {
    // On the books, not confirmed. A ring with a centre: more than
    // nothing, less than done.
    return (
      <span style={{ ...base, background: '#fff',
        border: `${Math.max(2, size / 6)}px solid ${ring}`, boxShadow: halo }}>
        <span style={{ width: size / 3.2, height: size / 3.2, borderRadius: 999, background: ring }} />
      </span>
    );
  }
  // todo
  return (
    <span style={{ ...base, background: '#fff',
      border: step.now ? `${Math.max(2, size / 5)}px solid ${ring}` : `2px solid ${INK.pale}`,
      boxShadow: halo }} />
  );
}

/** A connector. Solid once both ends are real, dotted while one is open. */
function Seg({ from, to, gap, hideLabel, minWidth = 20 }) {
  const solid = from.state !== 'todo' && to.state !== 'todo';
  return (
    <span style={{ flex: '1 1 0', position: 'relative', minWidth, height: 2 }}>
      <span style={{ position: 'absolute', inset: 0,
        borderTop: solid ? `2px solid ${INK.line}` : `2px dotted ${INK.pale}` }} />
      {gap && !hideLabel ? (
        <span style={{
          position: 'absolute', left: '50%', top: -9, transform: 'translateX(-50%)',
          background: '#fff', padding: '0 4px', fontSize: 10, lineHeight: '16px',
          fontWeight: 600, color: '#64748b', whiteSpace: 'nowrap',
        }}>{gap.label}</span>
      ) : null}
    </span>
  );
}

// ───── Inline, for a list row ─────────────────────────────────────────

export function LeadStoryRail({ lead, tone = 'slate', size = 10, labels = false }) {
  const steps = storyOf(lead);
  const gaps = storyGaps(steps);
  return (
    <span style={{ display: 'flex', alignItems: 'center', width: '100%' }}
      title={steps.map(s => `${s.label}${s.on ? ` ${formatDay(s.on)}` : ''}`).join(' → ')}>
      {steps.map((s, i) => (
        <span key={s.key} style={{ display: 'contents' }}>
          <Dot step={s} size={size} tone={tone} />
          {i < steps.length - 1
            ? <Seg from={s} to={steps[i + 1]} gap={gaps[i]} hideLabel={!labels} minWidth={12} />
            : null}
        </span>
      ))}
    </span>
  );
}

// ───── Stages in columns, so a list of these lines up ─────────────────

export function LeadStoryGrid({ lead, tone = 'slate', size = 12 }) {
  const steps = storyOf(lead);
  const gaps = storyGaps(steps);
  return (
    <span style={{ display: 'grid', width: '100%',
      gridTemplateColumns: `repeat(${steps.length}, minmax(0,1fr))` }}>
      {steps.map((s, i) => (
        <span key={s.key} style={{ position: 'relative', display: 'grid', placeItems: 'center', height: 22 }}>
          {i < steps.length - 1 ? (
            // Spans centre-of-this-cell to centre-of-the-next, so the
            // line meets the dots however wide the table gets.
            <span style={{ position: 'absolute', left: '50%', width: '100%', top: 10,
              height: 2, display: 'flex' }}>
              <Seg from={s} to={steps[i + 1]} gap={gaps[i]} />
            </span>
          ) : null}
          <Dot step={s} size={size} tone={tone} />
        </span>
      ))}
    </span>
  );
}

// ───── Down the page, with what was said ──────────────────────────────

/**
 * What to say under each dot. Every line reads a field the lead carries;
 * a step with nothing behind it gets nothing, rather than a placeholder
 * sentence that looks like a record of something.
 */
function bodyFor(lead, step) {
  const l = lead || {};
  if (step.key === 'enquiry') {
    const bits = [LEAD_SOURCE_LABELS[l.source] || l.source, LEAD_REASON_LABELS[l.reason]]
      .filter(Boolean);
    return bits.join(' · ');
  }
  if (step.key === 'reached') {
    // The last thing anybody wrote down about talking to them.
    const last = (l.history || []).filter(h => h && h.text).slice(-1)[0];
    return last ? last.text : '';
  }
  if (step.key === 'assessment') {
    return [l.tourBy ? `${l.tourBy} touring` : '', l.assignedTo ? `${l.assignedTo}'s lead` : '']
      .filter(Boolean).join(' · ');
  }
  if (step.key === 'assessed') return l.assessedBy ? `Assessed by ${l.assessedBy}` : '';
  if (step.key === 'outcome') return l.outcomeReason || '';
  return '';
}

export function LeadStorySpine({ lead, tone = 'slate' }) {
  const steps = storyOf(lead);
  const gaps = storyGaps(steps);
  const writeUp = (lead?.assessmentNotes || []).filter(n => n && n.text);

  return (
    <ol className="m-0 list-none p-0">
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        const next = steps[i + 1];
        const solid = next && step.state !== 'todo' && next.state !== 'todo';
        const body = bodyFor(lead, step);
        // A step that hasn't happened says nothing about itself unless
        // it is the one they're standing on.
        const speaks = step.state !== 'todo' || step.now;
        const showWriteUp = step.key === 'assessed' && writeUp.length > 0;

        return (
          <li key={step.key} className="grid" style={{ gridTemplateColumns: '34px minmax(0,1fr)', columnGap: 10 }}>
            <div className="grid justify-items-center">
              <Dot step={step} size={14} tone={tone} />
              {!last ? (
                <div className="relative w-0.5 flex-1" style={{
                  minHeight: speaks && (body || showWriteUp) ? 32 : 20,
                  borderLeft: solid ? `2px solid ${INK.line}` : `2px dotted ${INK.pale}`,
                  margin: '3px 0',
                }}>
                  {gaps[i] ? (
                    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap bg-white px-0.5 text-[10px] font-semibold text-gray-400">
                      {gaps[i].label}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="min-w-0" style={{ paddingBottom: last ? 0 : 10 }}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className={`text-[13px] ${
                  step.state === 'miss' ? 'font-semibold text-rose-700'
                    : step.state === 'todo' && !step.now ? 'text-gray-400'
                      : step.now ? 'font-semibold text-gray-900' : 'font-medium text-gray-900'}`}>
                  {step.label}
                </span>
                {step.on ? (
                  <span className="text-[11px] tabular-nums text-gray-400">{formatDay(step.on)}</span>
                ) : null}
                {step.now && !step.on ? (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-700">next</span>
                ) : null}
                {step.key === 'assessment' && step.waitDays !== null ? (
                  <span className={`text-[10px] font-semibold ${step.late ? 'text-amber-700' : 'text-gray-400'}`}>
                    {step.waitDays}d from enquiry{step.late ? ' · over the 4-day goal' : ''}
                  </span>
                ) : null}
                {step.key === 'assessment' && step.unrecorded ? (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-amber-200">
                    outcome not recorded
                  </span>
                ) : null}
              </div>

              {speaks && body ? (
                <p className="mt-0.5 text-[12px] leading-relaxed text-gray-600">{body}</p>
              ) : null}

              {showWriteUp ? (
                <div className="mt-1.5 space-y-1.5">
                  {writeUp.map((n, k) => (
                    <div key={k} className="rounded-lg bg-gray-50 p-2 ring-1 ring-gray-200">
                      <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-gray-700">{n.text}</p>
                      <p className="mt-1 text-[10px] text-gray-400">
                        {String(n.at || '').slice(0, 10)}{n.by ? ` · ${n.by}` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}

              {step.key === 'assessed' && !showWriteUp && step.done ? (
                <p className="mt-0.5 text-[12px] italic text-gray-400">
                  No write-up yet — the thing everyone re-reads before ringing back.
                </p>
              ) : null}

              {step.key === 'enquiry' && lead?.notes ? (
                <p className="mt-1 border-l-2 border-gray-200 pl-2 text-[12px] leading-relaxed text-gray-600">
                  {lead.notes}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
