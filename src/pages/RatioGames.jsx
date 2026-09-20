import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, doc, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import { Trophy, Flame, Info, Loader2, CalendarDays, Sparkles, Check } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { toast } from '../lib/notify';
import { Card, Pill, Btn, Lbl, Stat } from '../components/newlook/ui';
import {
  GAMES, GAME_LIST, DAYS_PER_MONTH, GAMES_PER_DAY,
  dayKey, monthKey, scoreDocId, buildScoreRow, standings, rankOf, featuredGameId,
} from '../lib/ratioGames';
import SprintGame from '../components/games/SprintGame';
import MathleGame from '../components/games/MathleGame';
import ConnectionsGame from '../components/games/ConnectionsGame';
import RatioRushGame from '../components/games/RatioRushGame';

/**
 * Ratio Games — a short maths game a day, a board, and a monthly winner.
 *
 * EVERY ACCOUNT PLAYS. The route carries no permission and this page makes
 * no check: volunteers and trainees, turned away from Team Chat and the
 * Job Board, are in. Who is eligible for the PRIZE is a decision the
 * centre makes when handing the card over, deliberately not encoded here.
 *
 * ONE RANKED RUN PER GAME PER DAY, and practice as much as you like. The
 * ranked run writes {uid}_{game}_{date}, which the rules allow to be
 * created once and never updated — so a second one is refused by Firestore
 * rather than by this page being polite about it.
 *
 * THE PAGE OWNS SAVING; each game just plays and reports an outcome. That
 * keeps the write in one place, so a new game cannot invent its own way of
 * scoring itself onto the board.
 */

const COMPONENTS = {
  sprint60: SprintGame,
  mathle: MathleGame,
  connections: ConnectionsGame,
  ratioRush: RatioRushGame,
};

function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export default function RatioGames() {
  const { profile, activeCenterId, centerConfig } = useAuth();
  const uid = profile?.uid;
  const today = dayKey(new Date());
  const month = monthKey(today);

  const [scores, setScores] = useState(null);       // null = still loading
  const [saving, setSaving] = useState(false);
  // { gameId, ranked, seed } while a game is being played, else null.
  const [playing, setPlaying] = useState(null);
  const [lastRun, setLastRun] = useState(null);

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

  const playedToday = useMemo(() => {
    const out = {};
    for (const s of scores || []) {
      if (s.uid === uid && s.date === today) out[s.gameId] = s;
    }
    return out;
  }, [scores, uid, today]);

  const featured = featuredGameId(today);

  const start = (gameId, ranked) => {
    setLastRun(null);
    setPlaying({
      gameId,
      ranked,
      // A daily game's seed is the centre and the date, so everyone here
      // gets the same puzzle. Practice gets its own seed, or it would be
      // the same board twice.
      seed: ranked
        ? `${activeCenterId}|${today}|${gameId}`
        : `${activeCenterId}|${today}|${gameId}|practice-${Date.now()}`,
    });
  };

  const finish = useCallback(async (outcome) => {
    const run = playing;
    if (!run) return;
    const game = GAMES[run.gameId];
    setPlaying(null);
    setLastRun({ gameId: run.gameId, ranked: run.ranked, outcome });

    if (!run.ranked || !uid || !activeCenterId) return;
    setSaving(true);
    try {
      const row = buildScoreRow({
        uid,
        userName: profile?.displayName || '',
        centerId: activeCenterId,
        gameId: run.gameId,
        date: today,
        outcome,
        durationMs: (game?.seconds || 0) * 1000,
        seed: run.seed,
      });
      await setDoc(doc(db, 'centers', activeCenterId, 'gameScores', scoreDocId(uid, run.gameId, today)), row);
      toast.success(`${row.points} points on the board.`);
    } catch (err) {
      // The usual cause is a second ranked run — which the rules exist to
      // refuse. Say which it was.
      toast.error(
        err?.code === 'permission-denied'
          ? `Today’s ranked ${game?.name || 'run'} is already in. Practice runs are unlimited.`
          : (err?.message || 'Could not save that run.'),
      );
    } finally {
      setSaving(false);
    }
  }, [playing, uid, activeCenterId, profile?.displayName, today]);

  // Switched off for this centre. The sidebar link and the home card are
  // already gone; this is what a typed URL or an old bookmark meets. Every
  // hook above has run, so the early return can't change hook order.
  if (!centerConfig?.gamesEnabled) {
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

  const Active = playing ? COMPONENTS[playing.gameId] : null;
  const activeGame = playing ? GAMES[playing.gameId] : null;
  const lastGame = lastRun ? GAMES[lastRun.gameId] : null;

  return (
    <div className="nl mx-auto w-full max-w-3xl space-y-3.5 pb-28 lg:pb-6">

      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="nl-display text-[21px] font-semibold">Ratio Games</h1>
          <p className="text-[13px]" style={{ color: 'var(--nl-muted)' }}>
            A few minutes of maths, a board, and a gift card at the end of the month.
          </p>
        </div>
        <Pill tone="brand"><Trophy size={12} /> {monthName(month)}</Pill>
      </div>

      {/* ── Playing ───────────────────────────────────────────── */}
      {playing && Active && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <Lbl>{activeGame.name}</Lbl>
              <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--nl-muted)' }}>{activeGame.blurb}</p>
            </div>
            <Pill tone={playing.ranked ? 'brand' : 'flat'}>{playing.ranked ? 'Ranked' : 'Practice'}</Pill>
          </div>
          <Active seed={playing.seed} onFinish={finish} />
          <div className="mt-3 text-center">
            <Btn size="sm" variant="quiet" onClick={() => { setPlaying(null); setLastRun(null); }}>
              Leave it
            </Btn>
          </div>
        </Card>
      )}

      {/* ── How that run went ─────────────────────────────────── */}
      {!playing && lastRun && lastGame && (
        <Card tone="ok">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <b className="text-[14.5px]">{lastGame.name} — {lastGame.summary(lastRun.outcome)}</b>
              <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--nl-ink2)' }}>
                {lastRun.ranked
                  ? <>{saving ? 'Saving…' : `${lastGame.score(lastRun.outcome)} points on the board.`}</>
                  : `${lastGame.score(lastRun.outcome)} points — practice, not counted.`}
              </p>
            </div>
            <Btn size="sm" variant="ghost" onClick={() => start(lastRun.gameId, false)}>Play again</Btn>
          </div>
        </Card>
      )}

      {/* ── The roster ────────────────────────────────────────── */}
      {!playing && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {GAME_LIST.map(game => {
            const done = playedToday[game.id];
            const isFeatured = game.id === featured;
            return (
              <Card key={game.id} tone={isFeatured ? 'note' : 'plain'}>
                <div className="flex h-full flex-col gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <b className="text-[14.5px]">{game.name}</b>
                    {isFeatured
                      ? <Pill tone="note"><Sparkles size={11} /> Today’s pick</Pill>
                      : <span className="text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>{game.minutes} min</span>}
                  </div>
                  <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--nl-muted)' }}>
                    {game.blurb}
                  </p>
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                    {done ? (
                      <>
                        <Pill tone="ok"><Check size={11} /> {done.points} today</Pill>
                        <Btn size="sm" variant="quiet" onClick={() => start(game.id, false)}>Practice</Btn>
                      </>
                    ) : (
                      <>
                        <Btn size="sm" onClick={() => start(game.id, true)}>Play for points</Btn>
                        <Btn size="sm" variant="quiet" onClick={() => start(game.id, false)}>Practice</Btn>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

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
                {entry.streak >= 3 && <Pill tone="warn"><Flame size={11} /> {entry.streak}</Pill>}
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
            <b>How the month adds up.</b> Every game scores out of about 100 for a good run, so none of
            them is worth more than the others. Your best {GAMES_PER_DAY} games in a day count, and your
            best {DAYS_PER_MONTH} days in the month — so somebody working two shifts a week can still win it.
            Three days in a row earns a bonus.
            <span className="mt-1.5 block" style={{ color: 'var(--nl-muted)' }}>
              Playing is entirely optional, on your own time, and scores are never part of how anyone&rsquo;s work is judged.
            </span>
          </div>
        </div>
      </Card>

      <p className="flex items-center justify-center gap-1.5 pt-1 text-[11.5px]" style={{ color: 'var(--nl-muted)' }}>
        <CalendarDays size={12} /> The board resets on the 1st. One ranked run per game, per day.
      </p>
    </div>
  );
}
