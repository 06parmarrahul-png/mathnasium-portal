import { describe, it, expect } from 'vitest';
import {
  GAMES, MAX_POINTS, gameById, dayKey, monthKey, daysElapsed, nextDay, scoreDocId,
  pointsFor, dayTotal, playedRuns, streakBonus, longestStreak, standings, rankOf,
  seedFrom, makeRng, sprintLevel, sprintQuestion, buildScoreRow, gamesEnabled,
  GAME_LIST, ROTATION, featuredGameId,
} from './ratioGames';

const run = (uid, date, points, extra = {}) => ({
  uid, userName: uid, gameId: 'sprint60', date, points, ...extra,
});

describe('dates', () => {
  it('reads a date in local time, not UTC', () => {
    // new Date('2026-09-17') is the 16th in Pacific — the trap this avoids.
    expect(dayKey(new Date(2026, 8, 17, 23, 30))).toBe('2026-09-17');
    expect(dayKey(new Date(2026, 8, 1, 0, 5))).toBe('2026-09-01');
    expect(monthKey(new Date(2026, 8, 17, 23, 30))).toBe('2026-09');
    expect(monthKey('2026-09-17')).toBe('2026-09');
  });

  it('rolls over months and leap years', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });

  it('lists a month only as far as today', () => {
    const days = daysElapsed('2026-09', new Date(2026, 8, 3, 12));
    expect(days).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('lists a whole past month', () => {
    expect(daysElapsed('2026-02', new Date(2026, 8, 3, 12))).toHaveLength(28);
  });
});

describe('one run a day', () => {
  it('names the document after the person, the game and the day', () => {
    expect(scoreDocId('u1', 'sprint60', '2026-09-16')).toBe('u1_sprint60_2026-09-16');
    expect(scoreDocId('u1', 'sprint60', new Date(2026, 8, 16, 9))).toBe('u1_sprint60_2026-09-16');
  });
});

describe('what a run is worth', () => {
  it('scores against par, not raw output', () => {
    expect(pointsFor(18, 18)).toBe(100);
    expect(pointsFor(9, 18)).toBe(50);
    expect(pointsFor(0, 18)).toBe(0);
  });

  it('caps an exceptional run, so a forged row can’t carry a month', () => {
    expect(pointsFor(40, 18)).toBe(MAX_POINTS);
    expect(pointsFor(9999, 18)).toBe(MAX_POINTS);
  });

  it('refuses nonsense rather than returning NaN', () => {
    expect(pointsFor(undefined, 18)).toBe(0);
    expect(pointsFor('abc', 18)).toBe(0);
    expect(pointsFor(5, 0)).toBe(0);
    expect(pointsFor(-5, 18)).toBe(0);
  });
});

describe('the three caps', () => {
  it('counts only the best three runs in a day', () => {
    const rows = [50, 90, 70, 100, 20].map(p => run('u1', '2026-09-01', p));
    expect(dayTotal(rows)).toBe(260);   // 100 + 90 + 70
  });

  it('counts only the best twelve days in a month', () => {
    // Fifteen days at 100. Only twelve count, so the month is 1200 — plus
    // the streak bonus for a fortnight of turning up.
    const rows = Array.from({ length: 15 }, (_, i) =>
      run('u1', `2026-09-${String(i + 1).padStart(2, '0')}`, 100));
    const [me] = standings(rows);
    expect(me.base).toBe(1200);
    expect(me.daysPlayed).toBe(15);
    expect(me.daysCounted).toBe(12);
  });

  it('caps the streak bonus', () => {
    const everyDay = Array.from({ length: 30 }, (_, i) =>
      `2026-09-${String(i + 1).padStart(2, '0')}`);
    expect(streakBonus(everyDay)).toBe(60);
  });
});

describe('streaks', () => {
  it('counts consecutive calendar days', () => {
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-07'];
    expect(playedRuns(dates)).toEqual([3, 1]);
    expect(longestStreak(dates)).toBe(3);
    expect(streakBonus(dates)).toBe(10);
  });

  it('a gap breaks the run', () => {
    expect(streakBonus(['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05'])).toBe(0);
  });

  it('does not double-count a day played twice', () => {
    const dates = ['2026-09-01', '2026-09-01', '2026-09-02', '2026-09-03'];
    expect(longestStreak(dates)).toBe(3);
  });

  it('counts two separate runs', () => {
    const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-10', '2026-09-11', '2026-09-12'];
    expect(playedRuns(dates)).toEqual([3, 3]);
    expect(streakBonus(dates)).toBe(20);
  });
});

describe('the board', () => {
  const rows = [
    run('ann', '2026-09-01', 100), run('ann', '2026-09-02', 90), run('ann', '2026-09-03', 80),
    run('bea', '2026-09-01', 120), run('bea', '2026-09-02', 120),
    run('cal', '2026-09-05', 60),
  ];

  it('ranks by points, with the streak bonus included', () => {
    // Ann's three steady days (270 + a 10-point streak bonus) beat Bea's
    // two maximum ones (240). Turning up is the thing being rewarded.
    const board = standings(rows);
    expect(board.map(r => r.uid)).toEqual(['ann', 'bea', 'cal']);
    const ann = board.find(r => r.uid === 'ann');
    expect(ann.base).toBe(270);
    expect(ann.bonus).toBe(10);
    expect(ann.points).toBe(280);
    expect(ann.streak).toBe(3);
  });

  it('breaks a tie on fewer runs — sharper, not longer', () => {
    const tied = [
      run('quick', '2026-09-01', 100), run('quick', '2026-09-02', 100),
      run('slow', '2026-09-01', 50), run('slow', '2026-09-01', 50),
      run('slow', '2026-09-02', 50), run('slow', '2026-09-02', 50),
    ];
    const board = standings(tied);
    expect(board[0].uid).toBe('quick');
    expect(board[0].points).toBe(board[1].points);
  });

  it('knows where somebody sits, and when they haven’t played', () => {
    const board = standings(rows);
    expect(rankOf(board, 'ann')).toBe(1);
    expect(rankOf(board, 'nobody')).toBeNull();
  });

  it('uses the newest name for someone who was renamed', () => {
    const board = standings([
      { uid: 'u1', userName: 'Sam Old', gameId: 'sprint60', date: '2026-09-01', points: 50 },
      { uid: 'u1', userName: 'Sam New', gameId: 'sprint60', date: '2026-09-02', points: 50 },
    ]);
    expect(board[0].userName).toBe('Sam New');
  });

  it('survives junk rows without dropping the real ones', () => {
    const board = standings([null, { points: 10 }, run('ann', '2026-09-01', 40)]);
    expect(board).toHaveLength(1);
    expect(board[0].uid).toBe('ann');
  });

  it('is empty before anybody plays', () => {
    expect(standings([])).toEqual([]);
    expect(standings(undefined)).toEqual([]);
  });
});

describe('seeded puzzles', () => {
  it('gives the whole centre the same day’s questions', () => {
    const a = makeRng(seedFrom('langley|2026-09-16'));
    const b = makeRng(seedFrom('langley|2026-09-16'));
    const first = Array.from({ length: 10 }, () => sprintQuestion(a, 0).text);
    const second = Array.from({ length: 10 }, () => sprintQuestion(b, 0).text);
    expect(first).toEqual(second);
  });

  it('gives a different centre, and a different day, different questions', () => {
    const langley = sprintQuestion(makeRng(seedFrom('langley|2026-09-16')), 0);
    const burnaby = sprintQuestion(makeRng(seedFrom('burnaby|2026-09-16')), 0);
    const tomorrow = sprintQuestion(makeRng(seedFrom('langley|2026-09-17')), 0);
    expect(burnaby.text).not.toBe(langley.text);
    expect(tomorrow.text).not.toBe(langley.text);
  });
});

describe('Sprint 60 questions', () => {
  it('steps up with the streak', () => {
    expect(sprintLevel(0)).toBe(1);
    expect(sprintLevel(3)).toBe(1);
    expect(sprintLevel(4)).toBe(2);
    expect(sprintLevel(9)).toBe(3);
  });

  it('every answer is a whole number — this is played on a phone', () => {
    const rng = makeRng(seedFrom('langley|2026-09-16'));
    for (let streak = 0; streak < 40; streak += 1) {
      for (let i = 0; i < 40; i += 1) {
        const q = sprintQuestion(rng, streak);
        expect(Number.isInteger(q.answer)).toBe(true);
        expect(q.answer).toBeGreaterThanOrEqual(0);
        expect(typeof q.text).toBe('string');
        expect(q.text.length).toBeGreaterThanOrEqual(2);   // "2²" is a fair question
      }
    }
  });

  it('never asks a subtraction that goes negative', () => {
    const rng = makeRng(seedFrom('seed|negatives'));
    for (let i = 0; i < 200; i += 1) {
      const q = sprintQuestion(rng, 0);
      expect(q.answer).toBeGreaterThanOrEqual(0);
    }
  });

  it('only divides where it divides exactly', () => {
    const rng = makeRng(seedFrom('seed|division'));
    for (let i = 0; i < 200; i += 1) {
      const q = sprintQuestion(rng, 5);
      if (q.text.includes('÷')) {
        const [left, right] = q.text.split(' ÷ ').map(Number);
        expect(left % right).toBe(0);
        expect(q.answer).toBe(left / right);
      }
    }
  });
});

describe('the row a run writes', () => {
  it('asks the game to score its own outcome', () => {
    const row = buildScoreRow({
      uid: 'u1', userName: 'Ann', centerId: 'langley', gameId: 'sprint60',
      date: '2026-09-20', outcome: { correct: 9 }, durationMs: 60000, seed: 'langley|2026-09-20',
    });
    expect(row.points).toBe(50);          // 9 of par 18
    expect(row.result).toBe(9);
    expect(row.uid).toBe('u1');
    expect(row.date).toBe('2026-09-20');
  });

  it('scores each game by its own idea of better', () => {
    const at = (gameId, outcome) => buildScoreRow({
      uid: 'u1', centerId: 'langley', gameId, date: '2026-09-20', outcome,
    });
    // Mathle: fewer guesses is better, and failing still beats not playing.
    expect(at('mathle', { solved: true, guesses: 3 }).points).toBe(100);
    expect(at('mathle', { solved: true, guesses: 1 }).points).toBe(MAX_POINTS);
    expect(at('mathle', { solved: false, guesses: 6 }).points).toBe(20);
    // Connections: a clean sweep is worth more than a scrappy one.
    expect(at('connections', { groups: 4, mistakes: 0 }).points).toBe(120);
    expect(at('connections', { groups: 4, mistakes: 3 }).points).toBe(85);
    expect(at('connections', { groups: 2, mistakes: 4 }).points).toBe(30);
    // Ratio Rush: par is eight of ten.
    expect(at('ratioRush', { correct: 8 }).points).toBe(100);
  });

  it('stores one integer per run for the board', () => {
    const at = (gameId, outcome) => buildScoreRow({
      uid: 'u1', centerId: 'langley', gameId, date: '2026-09-20', outcome,
    }).result;
    expect(at('mathle', { solved: true, guesses: 4 })).toBe(4);
    expect(at('mathle', { solved: false })).toBe(0);
    expect(at('connections', { groups: 3 })).toBe(3);
    expect(Number.isInteger(at('sprint60', { correct: 12 }))).toBe(true);
  });

  it('never writes a score the Firestore rules would refuse', () => {
    // points: int, 0..120. result: int, >= 0.
    const outcomes = [
      ['sprint60', { correct: 999 }], ['sprint60', { correct: -4 }], ['sprint60', {}],
      ['mathle', { solved: true, guesses: 0 }], ['mathle', {}],
      ['connections', { groups: 9, mistakes: -5 }], ['connections', { groups: -1, mistakes: 99 }],
      ['ratioRush', { correct: 500 }],
    ];
    for (const [gameId, outcome] of outcomes) {
      const row = buildScoreRow({ uid: 'u1', centerId: 'langley', gameId, date: '2026-09-20', outcome });
      expect(Number.isInteger(row.points)).toBe(true);
      expect(row.points).toBeGreaterThanOrEqual(0);
      expect(row.points).toBeLessThanOrEqual(MAX_POINTS);
      expect(Number.isInteger(row.result)).toBe(true);
      expect(row.result).toBeGreaterThanOrEqual(0);
    }
  });

  it('turns junk into zero rather than NaN', () => {
    const row = buildScoreRow({
      uid: 'u1', centerId: 'langley', gameId: 'sprint60', date: '2026-09-20',
      outcome: { correct: 'lots' }, durationMs: null,
    });
    expect(row.points).toBe(0);
    expect(row.result).toBe(0);
    expect(row.durationMs).toBe(0);
  });

  it('scores nothing for a game it has never heard of', () => {
    const row = buildScoreRow({ uid: 'u1', centerId: 'langley', gameId: 'buzz', date: '2026-09-20', outcome: { correct: 10 } });
    expect(row.points).toBe(0);
    expect(row.result).toBe(0);
  });
});

describe('the roster', () => {
  it('every game can score itself and name a result', () => {
    for (const game of GAME_LIST) {
      expect(typeof game.score).toBe('function');
      expect(typeof game.resultOf).toBe('function');
      expect(game.name).toBeTruthy();
      expect(game.blurb).toBeTruthy();
      expect(game.par).toBeGreaterThan(0);
      expect(game.minutes).toBeGreaterThan(0);
    }
  });

  it('a par run is worth about a hundred in every game', () => {
    // The point of scoring against par: no game can carry a month.
    expect(GAMES.sprint60.score({ correct: 18 })).toBe(100);
    expect(GAMES.mathle.score({ solved: true, guesses: 3 })).toBe(100);
    expect(GAMES.connections.score({ groups: 4, mistakes: 0 })).toBe(120);
    expect(GAMES.ratioRush.score({ correct: 8 })).toBe(100);
  });

  it('today’s pick cycles through the roster', () => {
    const week = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
    const picks = week.map(featuredGameId);
    expect(new Set(picks).size).toBeGreaterThan(1);
    for (const id of picks) expect(GAMES[id]).toBeTruthy();
  });

  it('picks the same game all day, and a different one tomorrow', () => {
    expect(featuredGameId('2026-09-20')).toBe(featuredGameId('2026-09-20'));
    expect(featuredGameId('2026-09-20')).not.toBe(featuredGameId('2026-09-21'));
  });

  it('every game in the rotation is a real one', () => {
    for (const id of ROTATION) expect(GAMES[id]).toBeTruthy();
  });
});

describe('the registry', () => {
  it('knows Sprint 60 and nothing it hasn’t been told about', () => {
    expect(gameById('sprint60')).toBe(GAMES.sprint60);
    expect(gameById('nope')).toBeNull();
    expect(GAMES.sprint60.par).toBeGreaterThan(0);
  });
});

describe('the centre switch', () => {
  it('is off until somebody turns it on', () => {
    // A deploy must not put a competition in everyone's sidebar.
    expect(gamesEnabled(undefined)).toBe(false);
    expect(gamesEnabled(null)).toBe(false);
    expect(gamesEnabled({})).toBe(false);
    expect(gamesEnabled({ gamesEnabled: false })).toBe(false);
  });

  it('only a real boolean true counts', () => {
    // A half-written config value shouldn't quietly start it.
    expect(gamesEnabled({ gamesEnabled: true })).toBe(true);
    expect(gamesEnabled({ gamesEnabled: 'true' })).toBe(false);
    expect(gamesEnabled({ gamesEnabled: 1 })).toBe(false);
  });
});
