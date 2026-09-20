import { useMemo, useState } from 'react';
import { Heart } from 'lucide-react';
import { Btn } from '../newlook/ui';
import { dailyBoard, judgeGuess, GROUP_SIZE, LIVES } from '../../lib/games/connections';

/**
 * Connections — sixteen numbers, four sets of four.
 *
 * The overlaps are the puzzle: 64 is a perfect square and a power of two,
 * and only one split of the board works. "One away" says the idea was
 * right without saying which tile to move, which is the whole difficulty.
 *
 * Calls onFinish exactly once, with { groups, mistakes }.
 */
export default function ConnectionsGame({ seed, onFinish }) {
  const board = useMemo(() => dailyBoard(seed), [seed]);
  const [tiles, setTiles] = useState(board.tiles);
  const [picked, setPicked] = useState([]);
  const [solved, setSolved] = useState([]);
  const [mistakes, setMistakes] = useState(0);
  const [message, setMessage] = useState('Pick four, then submit.');
  const [over, setOver] = useState(false);

  const toggle = (value) => {
    if (over) return;
    setPicked(prev => (prev.includes(value)
      ? prev.filter(v => v !== value)
      : (prev.length < GROUP_SIZE ? [...prev, value] : prev)));
  };

  const submit = () => {
    if (over || picked.length !== GROUP_SIZE) return;
    const verdict = judgeGuess(board, picked);

    if (verdict.status === 'solved') {
      const found = [...solved, verdict.group];
      setSolved(found);
      setTiles(prev => prev.filter(v => !verdict.group.items.includes(v)));
      setPicked([]);
      if (found.length === board.groups.length) {
        setOver(true);
        setMessage(mistakes === 0 ? 'All four, without a single wrong one.' : 'All four.');
        onFinish({ groups: found.length, mistakes });
      } else {
        setMessage(`${verdict.group.name} — ${board.groups.length - found.length} to go.`);
      }
      return;
    }

    const used = mistakes + 1;
    setMistakes(used);
    setPicked([]);
    if (used >= LIVES) {
      setOver(true);
      setSolved(board.groups);
      setTiles([]);
      setMessage('Out of lives. The full board is above.');
      onFinish({ groups: solved.length, mistakes: used });
      return;
    }
    setMessage(verdict.status === 'one-away'
      ? `One away — ${LIVES - used} ${LIVES - used === 1 ? 'life' : 'lives'} left.`
      : `Not a set — ${LIVES - used} ${LIVES - used === 1 ? 'life' : 'lives'} left.`);
  };

  return (
    <div className="flex flex-col gap-3">
      {solved.map(group => (
        <div key={group.id} className="rounded-xl px-3 py-2"
          style={{ background: 'var(--nl-okw)', border: '1px solid var(--nl-ok)' }}>
          <b className="text-[13px]" style={{ color: 'var(--nl-ok)' }}>{group.name}</b>
          <span className="ml-2 text-[13px] tabular-nums" style={{ color: 'var(--nl-ink2)' }}>
            {group.items.join('  ·  ')}
          </span>
        </div>
      ))}

      {tiles.length > 0 && (
        <div className="mx-auto grid w-full max-w-md grid-cols-4 gap-2">
          {tiles.map(value => {
            const on = picked.includes(value);
            return (
              <button key={value} type="button" onClick={() => toggle(value)}
                aria-pressed={on}
                className="flex aspect-[5/3] items-center justify-center rounded-xl border-2 text-[17px] font-bold tabular-nums transition-colors"
                style={on
                  ? { background: 'var(--nl-note)', borderColor: 'var(--nl-note)', color: '#fff' }
                  : { background: 'var(--nl-raised)', borderColor: 'var(--nl-rule)', color: 'var(--nl-ink)' }}>
                {value}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-center gap-1.5">
        {Array.from({ length: LIVES }, (_, i) => (
          <Heart key={i} size={13}
            fill={i < LIVES - mistakes ? 'var(--nl-brand)' : 'transparent'}
            style={{ color: i < LIVES - mistakes ? 'var(--nl-brand)' : 'var(--nl-rule)' }} />
        ))}
      </div>

      <p className="min-h-[1.4em] text-center text-[13px]" role="status" aria-live="polite"
        style={{ color: 'var(--nl-muted)' }}>
        {message}
      </p>

      {!over && (
        <div className="flex flex-wrap justify-center gap-2">
          <Btn size="sm" onClick={submit} disabled={picked.length !== GROUP_SIZE}>Submit</Btn>
          <Btn size="sm" variant="quiet" onClick={() => setPicked([])}>Clear</Btn>
        </div>
      )}
    </div>
  );
}
