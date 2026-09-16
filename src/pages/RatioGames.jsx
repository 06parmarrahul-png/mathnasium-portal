import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import { Timer, Trophy, Flame, Info, Loader2, CalendarDays } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import { Card, Pill, Btn, Lbl, Stat } from '../components/newlook/ui';
import {
  GAMES, DAYS_PER_MONTH, GAMES_PER_DAY,
  dayKey, monthKey, scoreDocId, buildScoreRow, standings, rankOf,
  seedFrom, makeRng, sprintQuestion, sprintLevel, pointsFor, gamesEnabled,
} from '../lib/ratioGames';

/**
 * Ratio Games — a short maths game a day, a board, and a monthly winner.
 *
 * EVERY ACCOUNT PLAYS. The route carries no permission and this page makes
 * no check: volunteers and trainees, who are turned away from Team Chat
 * and the Job Board, are in. That is the point — it is the one thing in
 * the portal that is for everybody. Who is eligible for the PRIZE is a
 * decision the centre makes when handing the card over, deliberately not
 * encoded here.
 *
 * ONE RANKED RUN A DAY, and practice as much as you like. The ranked run
 * writes a document named {uid}_{game}_{date} that the rules allow to be
 * created once and never updated, so a second one is refused by Firestore
 * rather than by this page being polite about it.
 *
 * The questions come from a seed made of the centre and the date, so
 * everyone here gets the same ones and nobody can reroll until they like
 * their luck. See src/lib/ratioGames.js — all the scoring lives there.
 */

const SPRINT = GAMES.sprint60;

/** Big mm:ss for the clock. */
function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `0:${String(s).padStart(2, '0')}`;
}

export default function RatioGames() {
  const { profile, activeCenterId, centerConfig } = useAuth();
  const uid = profile?.uid;
  const today = dayKey(new Date());
  const month = monthKey(today);

  const [scores, setScores] = useState(null);       // null = still loading
  const [saving, setSaving] = useState(false);

  // ── The run ────────────────────────────────────────────────────────────
  // `ranked` is decided when the run STARTS and carried to the end, so a
  // practice run can never be filed as the day's ranked one, and the day's
  // ranked run can't be downgraded after a bad start.
  const [run, setRun] = useState(null);
  const tickRef = useRef(null);
  const rngRef = useRef(null);

  // Everybody's rows for this month — the board is public to the centre.
  useEffect(() => {
    if (!activeCenterId) return undefined;
    return onSnapshot(
      query(
        collection(db, 'centers', activeCenterId, 'gameScores'),
        where('date', '>=', `${month}-01`),
      ),
      snap => setScores(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setScores([]),
    );
  }, [activeCenterId, month]);

  const board = useMemo(() => standings(scores || []), [scores]);
  const myRank = uid ? rankOf(board, uid) : null;
  const me = board.find(r => r.uid === uid) || null;
  const playedToday = (scores || []).some(s => s.uid === uid && s.date === today && s.gameId === SPRINT.id);

  const stop = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  }, []);

  useEffect(() => stop, [stop]);

  const finish = useCallback(async (finished) => {
    stop();
    setRun(r => (r ? { ...r, over: true, left: 0 } : r));
    if (!finished.ranked || !uid || !activeCenterId) return;
    setSaving(true);
    try {
      const row = buildScoreRow({
        uid,
        userName: profile?.displayName || '',
        centerId: activeCenterId,
        gameId: SPRINT.id,
        date: today,
        result: finished.correct,
        durationMs: SPRINT.seconds * 1000,
        seed: finished.seed,
      });
      await setDoc(doc(db, 'centers', activeCenterId, 'gameScores', scoreDocId(uid, SPRINT.id, today)), row);
      toast.success(`${row.points} points on the board.`);
    } catch (err) {
      // The usual cause is a second ranked run — the rules refuse it, which
      // is exactly what they're for. Say which it was.
      toast.error(
        err?.code === 'permission-denied'
          ? 'Today’s ranked run is already in. Practice runs are unlimited.'
          : (err?.message || 'Could not save that run.'),
      );
    } finally {
      setSaving(false);
    }
  }, [stop, uid, activeCenterId, profile?.displayName, today]);

  const start = useCallback((ranked) => {
    const seed = `${activeCenterId}|${today}|${ranked ? 'ranked' : `practice-${Date.now()}`}`;
    rngRef.current = makeRng(seedFrom(seed));
    const first = sprintQuestion(rngRef.current, 0);
    const startedAt = Date.now();
    setRun({
      ranked, seed, question: first, typed: '', correct: 0, streak: 0,
      left: SPRINT.seconds, over: false, startedAt,
    });
    stop();
    tickRef.current = setInterval(() => {
      setRun(prev => {
        if (!prev || prev.over) return prev;
        const left = SPRINT.seconds - Math.round((Date.now() - prev.startedAt) / 1000);
        if (left <= 0) {
          // Read the final state out of the tick rather than closing over
          // a stale copy — the timer is the only thing that can end a run
          // without the player doing anything.
          finish({ ranked: prev.ranked, correct: prev.correct, seed: prev.seed });
          return { ...prev, left: 0, over: true };
        }
        return { ...prev, left };
      });
    }, 250);
  }, [activeCenterId, today, stop, finish]);

  /** Answers submit themselves the moment they're right. */
  const onType = (value) => {
    setRun(prev => {
      if (!prev || prev.over) return prev;
      const typed = value.replace(/[^0-9-]/g, '').slice(0, 6);
      if (typed !== '' && typed !== '-' && Number(typed) === prev.question.answer) {
        const streak = prev.streak + 1;
        return {
          ...prev,
          correct: prev.correct + 1,
          streak,
          question: sprintQuestion(rngRef.current, streak),
          typed: '',
        };
      }
      return { ...prev, typed };
    });
  };

  const skip = () => {
    setRun(prev => (prev && !prev.over
      ? { ...prev, streak: 0, question: sprintQuestion(rngRef.current, 0), typed: '' }
      : prev));
  };

  const live = run && !run.over;
  const livePoints = run ? pointsFor(run.correct, SPRINT.par) : 0;

  // Switched off for this centre. The sidebar link and the home card are
  // already gone; this is what a typed URL or an old bookmark meets. Every
  // hook above has run, so the early return can't change hook order.
  if (!gamesEnabled(centerConfig)) {
    return (
      <div className="nl mx-auto w-full max-w-lg pb-6">
        <Card>
          <b className="block text-[15px]">Ratio Games isn’t switched on yet</b>
          <p className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
            The centre owner turns it on in Centre Settings. Nothing is lost while it&rsquo;s off —
            any scores already played are still here, and the board picks up where it left off.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="nl mx-auto w-full max-w-3xl space-y-3.5 pb-28 lg:pb-6">

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="nl-display text-[21px] font-semibold">Ratio Games</h1>
          <p className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
            A minute of maths, a board, and a gift card at the end of the month.
          </p>
        </div>
        <Pill tone="brand"><Trophy size={12} /> {monthName(month)}</Pill>
      </div>

      {/* ── The game ──────────────────────────────────────────── */}
      <Card className="text-center">
        <div className="flex items-center justify-between gap-2 text-left">
          <div>
            <Lbl>{SPRINT.name}</Lbl>
            <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>{SPRINT.blurb}</p>
          </div>
          {live && (
            <div className="nl-display shrink-0 text-[28px] font-bold tabular-nums"
              style={{ color: run.left <= 10 ? 'var(--nl-brand)' : 'var(--nl-ink)' }}>
              {clock(run.left)}
            </div>
          )}
        </div>

        {!run && (
          <div className="mt-5 flex flex-col items-center gap-3">
            <div className="nl-display text-[34px] font-bold leading-none">{SPRINT.seconds} seconds</div>
            <p className="max-w-sm text-[13px]" style={{ color: 'var(--nl-muted)' }}>
              Mental arithmetic, no paper. Answers submit themselves the moment they&rsquo;re right,
              and it gets harder the longer your streak runs. Par is {SPRINT.par}.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Btn onClick={() => start(true)}>
                <Timer size={15} /> {playedToday ? 'Ranked run is in' : 'Start today’s run'}
              </Btn>
              <Btn variant="quiet" onClick={() => start(false)}>Practice</Btn>
            </div>
            <p className="text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
              {playedToday
                ? 'You’ve had your ranked run today — practice as much as you like.'
                : 'One ranked run a day. Practice never counts.'}
            </p>
          </div>
        )}

        {live && (
          <div className="mt-4 flex flex-col items-center gap-3">
            <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full" style={{ background: 'var(--nl-raised)' }}>
              <div className="h-full rounded-full transition-[width] duration-200"
                style={{ width: `${(100 * run.left) / SPRINT.seconds}%`, background: 'var(--nl-brand)' }} />
            </div>
            <div className="nl-display text-[38px] font-bold leading-none tabular-nums">{run.question.text} =</div>
            <input
              autoFocus
              inputMode="numeric"
              value={run.typed}
              onChange={e => onType(e.target.value)}
              aria-label="Your answer"
              className="w-32 rounded-xl border-2 px-3 py-2 text-center text-2xl font-bold tabular-nums outline-none"
              style={{ borderColor: 'var(--nl-rule)', background: 'var(--nl-card)', color: 'var(--nl-ink)' }}
            />
            <div className="flex items-center gap-4">
              <span className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
                <b className="nl-display text-[17px]" style={{ color: 'var(--nl-ink)' }}>{run.correct}</b> correct
              </span>
              <span className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
                <b className="nl-display text-[17px]" style={{ color: 'var(--nl-ink)' }}>{run.streak}</b> streak
              </span>
              <Pill tone={run.ranked ? 'brand' : 'flat'}>{run.ranked ? 'Ranked' : 'Practice'}</Pill>
            </div>
            <div className="flex items-center gap-2">
              <Btn size="sm" variant="quiet" onClick={skip}>Skip</Btn>
              <span className="text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>Level {sprintLevel(run.streak)} of 3</span>
            </div>
          </div>
        )}

        {run && run.over && (
          <div className="mt-5 flex flex-col items-center gap-3">
            <div className="nl-display text-[44px] font-bold leading-none tabular-nums">{run.correct}</div>
            <Lbl>correct · par {SPRINT.par}</Lbl>
            <Pill tone={livePoints >= 100 ? 'ok' : 'flat'}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Trophy size={12} />}
              {run.ranked ? `${livePoints} points` : `${livePoints} points — practice, not counted`}
            </Pill>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Btn variant="quiet" onClick={() => start(false)}>Practice again</Btn>
              {!playedToday && !run.ranked && (
                <Btn onClick={() => start(true)}><Timer size={15} /> Take today’s ranked run</Btn>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ── Where you stand ───────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2.5">
        <Stat n={me ? me.points : 0} k="Your points" sub={myRank ? `#${myRank} this month` : 'Not on the board yet'} />
        <Stat n={me ? me.daysPlayed : 0} k="Days played" sub={`Best ${DAYS_PER_MONTH} count`} />
        <Stat n={me ? me.streak : 0} k="Best streak" tone={me && me.streak >= 3 ? 'var(--nl-ok)' : undefined}
          sub={me && me.streak >= 3 ? 'Bonus earned' : '3 in a row for a bonus'} />
      </div>

      {/* ── The board ─────────────────────────────────────────── */}
      <Card>
        <div className="flex items-center justify-between gap-2">
          <Lbl>The board · {monthName(month)}</Lbl>
          <span className="text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>Everyone at the centre</span>
        </div>

        {scores === null ? (
          <p className="py-6 text-center text-[13px]" style={{ color: 'var(--nl-muted)' }}>
            <Loader2 size={14} className="mr-1 inline animate-spin" /> Loading the board…
          </p>
        ) : board.length === 0 ? (
          <p className="py-6 text-center text-[13px]" style={{ color: 'var(--nl-muted)' }}>
            Nobody has played yet this month. Be the first name on it.
          </p>
        ) : (
          <ul className="mt-2 divide-y" style={{ borderColor: 'var(--nl-rule)' }}>
            {board.slice(0, 10).map((entry, i) => (
              <li key={entry.uid} className="flex items-center gap-3 py-2">
                <span className="nl-display w-6 text-center text-[15px] font-bold tabular-nums"
                  style={{ color: i === 0 ? 'var(--nl-brand)' : 'var(--nl-muted)' }}>
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
                  {entry.uid === uid ? 'You' : entry.userName}
                </span>
                {entry.streak >= 3 && (
                  <Pill tone="warn"><Flame size={11} /> {entry.streak}</Pill>
                )}
                <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--nl-muted)' }}>
                  {entry.daysPlayed}d
                </span>
                <span className="nl-display w-14 text-right text-[16px] font-bold tabular-nums">
                  {entry.points}
                </span>
              </li>
            ))}
          </ul>
        )}

        {myRank > 10 && me && (
          <div className="mt-2 flex items-center gap-3 border-t pt-2" style={{ borderColor: 'var(--nl-rule)' }}>
            <span className="nl-display w-6 text-center text-[15px] font-bold tabular-nums" style={{ color: 'var(--nl-brand)' }}>
              {myRank}
            </span>
            <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">You</span>
            <span className="nl-display w-14 text-right text-[16px] font-bold tabular-nums">{me.points}</span>
          </div>
        )}
      </Card>

      {/* ── How it adds up ────────────────────────────────────── */}
      <Card tone="note">
        <div className="flex items-start gap-2">
          <Info size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--nl-note)' }} />
          <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--nl-ink2)' }}>
            <b>How the month adds up.</b> A run scores against par, so {SPRINT.par} correct is 100 points.
            Your best {GAMES_PER_DAY} games in a day count, and your best {DAYS_PER_MONTH} days in the month —
            so somebody working two shifts a week can still win it. Three days in a row earns a bonus.
            <span className="mt-1.5 block" style={{ color: 'var(--nl-muted)' }}>
              Playing is entirely optional, on your own time, and scores are never part of how anyone&rsquo;s work is judged.
            </span>
          </div>
        </div>
      </Card>

      <p className="flex items-center justify-center gap-1.5 pt-1 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
        <CalendarDays size={12} /> The board resets on the 1st. More games are on the way.
      </p>
    </div>
  );
}

function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
