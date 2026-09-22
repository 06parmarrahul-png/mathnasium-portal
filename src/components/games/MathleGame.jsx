import { useCallback, useEffect, useMemo, useState } from 'react';
import { Delete, CornerDownLeft } from 'lucide-react';
import { Pill } from '../newlook/ui';
import {
  LENGTH, TRIES, KEYS, dailyEquation, checkGuess, markGuess, keyboardMarks,
} from '../../lib/games/mathle';

/**
 * Mathle — find the hidden equation in six tries.
 *
 * Every guess has to be an equation that is TRUE, which is what makes it a
 * maths game rather than a spelling one. The keyboard remembers what each
 * character has earned, because holding six guesses' worth of greys in
 * your head is memory work, not arithmetic.
 *
 * RUNNING OUT OF GUESSES SHOWS THE EQUATION. Six tries and no answer is
 * the ending that teaches nothing, so the answer is spelled out — in the
 * × and ÷ the tiles use, not the * and / that are only there because
 * that is what a keyboard has.
 *
 * Calls onFinish exactly once, with { solved, guesses }.
 */

/** The way the tiles write it: 1+2×3=7, not 1+2*3=7. */
const pretty = (equation) => String(equation).replace(/\*/g, '×').replace(/\//g, '÷');

const MARK_STYLE = {
  exact:   { background: 'var(--nl-ok)', color: '#fff', borderColor: 'var(--nl-ok)' },
  present: { background: 'var(--nl-warn)', color: '#fff', borderColor: 'var(--nl-warn)' },
  absent:  { background: 'var(--nl-raised)', color: 'var(--nl-muted)', borderColor: 'var(--nl-rule)' },
};

export default function MathleGame({ seed, onFinish }) {
  const answer = useMemo(() => dailyEquation(seed), [seed]);
  const [rows, setRows] = useState([]);          // submitted guesses
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState('');
  const [over, setOver] = useState(false);

  const marks = useMemo(
    () => keyboardMarks(rows.map(guess => ({ guess, answer }))),
    [rows, answer],
  );

  const submit = useCallback(() => {
    if (over) return;
    const problem = checkGuess(typed);
    if (problem) { setMessage(problem); return; }

    const next = [...rows, typed];
    setRows(next);
    setTyped('');

    if (typed === answer) {
      setOver(true);
      setMessage(`Got it in ${next.length}.`);
      onFinish({ solved: true, guesses: next.length });
      return;
    }
    if (next.length >= TRIES) {
      setOver(true);
      setMessage(`Out of guesses. The answer was ${pretty(answer)}.`);
      onFinish({ solved: false, guesses: TRIES });
      return;
    }
    setMessage(`${TRIES - next.length} ${TRIES - next.length === 1 ? 'guess' : 'guesses'} left.`);
  }, [over, typed, rows, answer, onFinish]);

  const type = useCallback((ch) => {
    if (over) return;
    setMessage('');
    setTyped(t => (t.length >= LENGTH ? t : t + ch));
  }, [over]);

  const back = useCallback(() => {
    if (over) return;
    setTyped(t => t.slice(0, -1));
  }, [over]);

  // A physical keyboard is the faster way in on a laptop, and the desk
  // this is played at usually has one.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
      else if (/^[0-9+\-*/=]$/.test(e.key)) { e.preventDefault(); type(e.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, back, type]);

  const grid = Array.from({ length: TRIES }, (_, r) => {
    if (r < rows.length) return { guess: rows[r], marks: markGuess(rows[r], answer) };
    if (r === rows.length) return { guess: typed.padEnd(LENGTH, ' '), marks: null, live: true };
    return { guess: ' '.repeat(LENGTH), marks: null };
  });

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="grid gap-1.5" aria-label="Guesses">
        {grid.map((row, r) => (
          <div key={r} className="grid grid-cols-8 gap-1.5">
            {Array.from({ length: LENGTH }, (_, c) => {
              const ch = row.guess[c] === ' ' ? '' : row.guess[c];
              const mark = row.marks ? row.marks[c] : null;
              return (
                <span key={c}
                  className="flex aspect-square w-[clamp(30px,9vw,42px)] items-center justify-center rounded-lg border-2 text-[clamp(1rem,3.4vw,1.25rem)] font-bold tabular-nums"
                  style={mark ? MARK_STYLE[mark] : {
                    borderColor: row.live && ch ? 'var(--nl-ink2)' : 'var(--nl-rule)',
                    background: 'var(--nl-card)', color: 'var(--nl-ink)',
                  }}>
                  {ch === '*' ? '×' : ch === '/' ? '÷' : ch}
                </span>
              );
            })}
          </div>
        ))}
      </div>

      <p className="min-h-[1.4em] text-center text-[13px]" role="status" aria-live="polite"
        style={{ color: over ? 'var(--nl-ink)' : 'var(--nl-muted)' }}>
        {message || 'Every guess has to be a true equation.'}
      </p>

      {!over && (
        <div className="flex flex-col items-center gap-1.5">
          {KEYS.map((row, i) => (
            <div key={i} className="flex gap-1.5">
              {row.map(ch => (
                <button key={ch} type="button" onClick={() => type(ch)}
                  aria-label={ch === '*' ? 'times' : ch === '/' ? 'divide' : ch}
                  className="min-w-[34px] rounded-lg border px-2 py-2.5 text-[15px] font-bold tabular-nums"
                  style={marks[ch] ? MARK_STYLE[marks[ch]] : {
                    background: 'var(--nl-raised)', color: 'var(--nl-ink)', borderColor: 'var(--nl-rule)',
                  }}>
                  {ch === '*' ? '×' : ch === '/' ? '÷' : ch}
                </button>
              ))}
            </div>
          ))}
          <div className="flex gap-1.5">
            <button type="button" onClick={submit}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-[13px] font-bold text-white"
              style={{ background: 'var(--nl-brand)' }}>
              <CornerDownLeft size={13} /> Enter
            </button>
            <button type="button" onClick={back} aria-label="Delete"
              className="flex items-center gap-1.5 rounded-lg border px-4 py-2.5 text-[13px] font-bold"
              style={{ background: 'var(--nl-raised)', color: 'var(--nl-ink)', borderColor: 'var(--nl-rule)' }}>
              <Delete size={13} />
            </button>
          </div>
        </div>
      )}

      {over && (
        <Pill tone={rows[rows.length - 1] === answer ? 'ok' : 'flat'}>
          {rows[rows.length - 1] === answer
            ? `Solved in ${rows.length}`
            : `Answer: ${pretty(answer)}`}
        </Pill>
      )}
    </div>
  );
}
