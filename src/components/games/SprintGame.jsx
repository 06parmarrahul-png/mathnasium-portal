import { useCallback, useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import { Btn, Pill } from '../newlook/ui';
import { GAMES, makeRng, seedFrom, sprintQuestion, sprintLevel } from '../../lib/ratioGames';

/**
 * Sprint 60 — sixty seconds of mental arithmetic.
 *
 * Answers submit themselves the moment they're right: on a phone, between
 * students, a Send button after every sum is the difference between a game
 * and a form. It steps up a difficulty ladder as the streak grows, which is
 * what stops a good player just farming easy sums.
 *
 * Calls onFinish exactly once, with { correct }.
 */
const GAME = GAMES.sprint60;

export default function SprintGame({ seed, onFinish }) {
  const [state, setState] = useState(() => {
    const rng = makeRng(seedFrom(seed));
    return { rng, question: sprintQuestion(rng, 0), typed: '', correct: 0, streak: 0, left: GAME.seconds };
  });
  const startedAt = useRef(null);
  const done = useRef(false);
  const tick = useRef(null);

  const finish = useCallback((correct) => {
    if (done.current) return;
    done.current = true;
    if (tick.current) clearInterval(tick.current);
    onFinish({ correct });
  }, [onFinish]);

  useEffect(() => {
    // The clock starts when the component mounts, not while it renders —
    // Date.now() during render is a reading that can change between two
    // renders of the same state.
    startedAt.current = Date.now();
    tick.current = setInterval(() => {
      setState(prev => {
        const left = GAME.seconds - Math.round((Date.now() - startedAt.current) / 1000);
        if (left <= 0) { finish(prev.correct); return { ...prev, left: 0 }; }
        return { ...prev, left };
      });
    }, 250);
    return () => { if (tick.current) clearInterval(tick.current); };
  }, [finish]);

  const onType = (value) => {
    setState(prev => {
      const typed = value.replace(/[^0-9-]/g, '').slice(0, 6);
      if (typed !== '' && typed !== '-' && Number(typed) === prev.question.answer) {
        const streak = prev.streak + 1;
        return { ...prev, correct: prev.correct + 1, streak, question: sprintQuestion(prev.rng, streak), typed: '' };
      }
      return { ...prev, typed };
    });
  };

  const skip = () => setState(prev => ({
    ...prev, streak: 0, question: sprintQuestion(prev.rng, 0), typed: '',
  }));

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full" style={{ background: 'var(--nl-raised)' }}>
        <div className="h-full rounded-full transition-[width] duration-200"
          style={{ width: `${(100 * state.left) / GAME.seconds}%`, background: 'var(--nl-brand)' }} />
      </div>
      <div className="nl-display text-[26px] font-bold tabular-nums"
        style={{ color: state.left <= 10 ? 'var(--nl-brand)' : 'var(--nl-ink)' }}>
        0:{String(Math.max(0, state.left)).padStart(2, '0')}
      </div>

      <div className="nl-display text-[38px] font-bold leading-none tabular-nums">{state.question.text} =</div>
      <input
        autoFocus
        inputMode="numeric"
        value={state.typed}
        onChange={e => onType(e.target.value)}
        aria-label="Your answer"
        className="w-32 rounded-xl border-2 px-3 py-2 text-center text-2xl font-bold tabular-nums outline-none"
        style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)', color: 'var(--nl-ink)' }}
      />

      <div className="flex items-center gap-4">
        <span className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
          <b className="nl-display text-[17px]" style={{ color: 'var(--nl-ink)' }}>{state.correct}</b> correct
        </span>
        <span className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
          <b className="nl-display text-[17px]" style={{ color: 'var(--nl-ink)' }}>{state.streak}</b> streak
        </span>
        <Pill tone="flat">Level {sprintLevel(state.streak)} of 3</Pill>
      </div>

      <div className="flex items-center gap-2">
        <Btn size="sm" variant="quiet" onClick={skip}>Skip</Btn>
        <Btn size="sm" variant="quiet" onClick={() => finish(state.correct)}>
          <Timer size={13} /> Stop
        </Btn>
      </div>
    </div>
  );
}
