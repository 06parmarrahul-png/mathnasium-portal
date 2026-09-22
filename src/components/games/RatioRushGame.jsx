import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { Btn, Pill } from '../newlook/ui';
import { GAMES } from '../../lib/ratioGames';
import { roundsFor, explain, aimNote, ROUNDS } from '../../lib/games/ratioRush';

/**
 * Ratio Rush — how many instructors does this half hour need?
 *
 * The centre's own maths, against the clock: students in, instructors out,
 * at the FLOOR ratio of 1:4, always rounding up. Four is the number you
 * can divide by while standing on the floor; three and a half against a
 * sixty-second clock is a different skill. A miss shows the division
 * rather than just saying "wrong", and says what the 1:3.5 aim would have
 * wanted when that is a different number — the point is to leave people
 * better at reading a booking curve than they were a minute ago.
 *
 * Calls onFinish exactly once, with { correct, asked }.
 */
const GAME = GAMES.ratioRush;

export default function RatioRushGame({ seed, onFinish }) {
  const rounds = useMemo(() => roundsFor(seed, ROUNDS), [seed]);
  const [at, setAt] = useState(0);
  const [typed, setTyped] = useState('');
  const [correct, setCorrect] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [left, setLeft] = useState(GAME.seconds);
  const [over, setOver] = useState(false);
  const startedAt = useRef(null);
  const done = useRef(false);
  const tick = useRef(null);
  // The timer callback closes over state, so the running total lives in a
  // ref as well — otherwise a run that times out reports zero.
  const correctRef = useRef(0);

  const finish = useCallback((got, asked) => {
    if (done.current) return;
    done.current = true;
    if (tick.current) clearInterval(tick.current);
    // The run stays on screen once it's over, so it has to stop looking
    // like a slot waiting for an answer.
    setOver(true);
    onFinish({ correct: got, asked });
  }, [onFinish]);

  useEffect(() => {
    startedAt.current = Date.now();
    tick.current = setInterval(() => {
      const remaining = GAME.seconds - Math.round((Date.now() - startedAt.current) / 1000);
      setLeft(remaining);
      if (remaining <= 0) finish(correctRef.current, ROUNDS);
    }, 250);
    return () => { if (tick.current) clearInterval(tick.current); };
  }, [finish]);


  const round = rounds[at];

  const answer = () => {
    if (!round || feedback || over) return;
    const given = Number(typed);
    const right = Number.isFinite(given) && given === round.answer;
    if (right) { setCorrect(c => c + 1); correctRef.current += 1; }
    setFeedback({ right, round });
    setTyped('');
  };

  const next = () => {
    setFeedback(null);
    const upcoming = at + 1;
    if (upcoming >= rounds.length) { finish(correctRef.current, rounds.length); return; }
    setAt(upcoming);
  };

  if (!round) return null;

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="flex w-full max-w-sm items-center justify-between text-[12px]"
        style={{ color: 'var(--nl-muted)' }}>
        <span>Slot {at + 1} of {rounds.length}</span>
        <span className="tabular-nums">0:{String(Math.max(0, left)).padStart(2, '0')}</span>
      </div>
      <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full" style={{ background: 'var(--nl-raised)' }}>
        <div className="h-full rounded-full"
          style={{ width: `${(100 * Math.max(0, left)) / GAME.seconds}%`, background: 'var(--nl-brand)' }} />
      </div>

      {over ? (
        <div className="nl-display text-[26px] font-bold leading-none">
          {left <= 0 ? 'Time.' : 'That’s the ten.'}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Users size={18} style={{ color: 'var(--nl-muted)' }} />
            <span className="nl-display text-[40px] font-bold leading-none tabular-nums">{round.students}</span>
          </div>
          <p className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
            students booked · at <b>1:{round.ratio}</b> — how many instructors?
          </p>
        </>
      )}

      {over ? null : !feedback ? (
        <>
          <input
            autoFocus
            inputMode="numeric"
            value={typed}
            onChange={e => setTyped(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onKeyDown={e => { if (e.key === 'Enter') answer(); }}
            aria-label="Instructors needed"
            className="w-24 rounded-xl border-2 px-3 py-2 text-center text-2xl font-bold tabular-nums outline-none"
            style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)', color: 'var(--nl-ink)' }}
          />
          <Btn size="sm" onClick={answer} disabled={typed === ''}>Answer</Btn>
        </>
      ) : (
        <>
          <Pill tone={feedback.right ? 'ok' : 'warn'}>
            {feedback.right ? 'Right' : `It's ${feedback.round.answer}`}
          </Pill>
          <p className="text-[13px] tabular-nums" style={{ color: 'var(--nl-muted)' }}>
            {explain(feedback.round)}
          </p>
          {aimNote(feedback.round) && (
            <p className="text-[12px]" style={{ color: 'var(--nl-muted)' }}>
              {aimNote(feedback.round)}
            </p>
          )}
          <Btn size="sm" onClick={next}>
            {at + 1 >= rounds.length ? 'Finish' : 'Next slot'}
          </Btn>
        </>
      )}

      <span className="text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>
        <b style={{ color: 'var(--nl-ink)' }}>{correct}</b> right{over ? ` of ${rounds.length}` : ' so far'}
      </span>
    </div>
  );
}
