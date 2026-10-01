import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pill } from '../newlook/ui';
import {
  FIELD, PHYSICS, TABLES, RANKED_TABLE, courseFor, questionsFor, explain, tableLabel,
} from '../../lib/games/coleHop';

/**
 * Cole Hop — Andy's game, wired into the board.
 *
 * Answer a times-table question and Cole hops straight up. He does not
 * steer; the platform above is sliding, so WHEN you answer is the other
 * half of the game. Miss it and he falls, and the run is over.
 *
 * THE PLATFORMS ARE POSITIONED FROM THE CLOCK, NOT INTEGRATED FRAME BY
 * FRAME. The original advanced `p.x += p.vx * dt` every frame and bounced
 * off the walls, which accumulates differently on a 60Hz laptop and a
 * 120Hz phone — so two people playing the same seeded ladder would have
 * been aiming at platforms in different places, which is most of the
 * point of seeding it. A reflected triangle wave off `t` gives the same
 * position on any machine at any frame rate.
 *
 * Cole's own motion is still integrated, because it depends on when a
 * person answered, which no seed can predict.
 *
 * Calls onFinish exactly once, with { climbed, right, wrong, bestStreak }.
 */

const { W, H } = FIELD;
const { GRAVITY, JUMP, SPRING, CROUCH, PLAYER_R, START_Y } = PHYSICS;

/** Where a platform is at time t: a triangle wave, reflected off both walls. */
function platformX(p, t) {
  const range = W - p.w;
  if (range <= 0) return 0;
  const span = range * 2;
  let u = (p.x + p.vx * t) % span;
  if (u < 0) u += span;
  return u <= range ? u : span - u;
}

const TRICKS = ['superman', 'flip', 'splits'];

export default function ColeHopGame({ seed, ranked = false, onFinish }) {
  // A ranked run is always all tables — see lib/games/coleHop.js. The
  // picker is practice, and it is also what makes this useful at the
  // centre: an instructor who wants to drill their sevens can.
  const [table, setTable] = useState(ranked ? RANKED_TABLE : null);
  const [phase, setPhase] = useState(ranked ? 'play' : 'pick');
  const [climbed, setClimbed] = useState(0);
  const [tally, setTally] = useState({ right: 0, wrong: 0, streak: 0, best: 0 });
  const [qAt, setQAt] = useState(0);
  const [verdict, setVerdict] = useState(null);   // { i, right, q } after an answer
  const [standing, setStanding] = useState(true);

  const canvasRef = useRef(null);
  const world = useRef(null);
  const finished = useRef(false);
  const timers = useRef([]);
  // The loop runs for the life of the run and captures whatever it was
  // handed when it started. Anything it has to READ at the end lives in a
  // ref: a `finish` closed over render-time state reported the first
  // render's zeroes — nought right, nought wrong, on every run.
  const tallyRef = useRef({ right: 0, wrong: 0, streak: 0, best: 0 });
  const stepRef = useRef(() => {});
  const renderRef = useRef(() => {});

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const course = useMemo(() => (table === null ? null : courseFor(seed)), [seed, table]);
  const questions = useMemo(
    () => (table === null ? null : questionsFor(seed, table)),
    [seed, table],
  );
  const question = questions ? questions[qAt % questions.length] : null;

  const finish = useCallback((reached) => {
    if (finished.current) return;
    finished.current = true;
    setPhase('over');
    const t = tallyRef.current;
    onFinish({ climbed: reached, right: t.right, wrong: t.wrong, bestStreak: t.best });
  }, [onFinish]);

  // Everything the loop mutates lives here rather than in state: it
  // changes sixty times a second and none of it belongs in a render.
  useEffect(() => {
    if (phase !== 'play' || !course) return undefined;
    const platforms = course.map(p => ({ ...p, dipY: 0, dipV: 0, springT: 0 }));
    world.current = {
      t: 0,
      platforms,
      player: {
        x: W / 2, y: START_Y - PLAYER_R, vy: 0, r: PLAYER_R,
        squash: 0, stretch: 0, face: 1, ground: platforms[0],
        crouchT: 0, anim: null, animT: 0, special: false, nextTrick: null,
      },
      particles: [],
      camY: 0,
      highest: 0,
    };
    return () => { world.current = null; };
  }, [phase, course]);

  // The loop. One effect, one rAF, torn down on unmount — a canvas game
  // left running behind a closed card is a battery bug nobody attributes
  // to the game.
  useEffect(() => {
    if (phase !== 'play') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    // No 2D context means no drawing, and that is survivable: the quiz is
    // ordinary HTML and the physics is arithmetic, so the run still plays
    // and still scores. It is also what jsdom hands back, which is how
    // this component gets tested at all.
    const ctx = canvas.getContext('2d');
    let raf = 0;
    // Seeded from the FIRST FRAME's own timestamp, not from
    // performance.now(). The two are the same clock in a browser, but
    // starting from performance.now() makes the first dt "however long
    // React took to mount", and it is a different clock entirely under a
    // fake timer — which is how this ran for a whole test file with dt
    // pinned at zero and Cole standing perfectly still.
    let last = null;

    const resize = () => {
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const frame = (now) => {
      // Clamped at both ends: the cap is the usual "don't simulate half a
      // second because the tab was hidden", and the floor is because a
      // clock that goes backwards — a tab restore — would give negative
      // gravity and throw Cole off the bottom of the screen.
      const dt = last === null ? 0 : Math.min(0.033, Math.max(0, (now - last) / 1000));
      last = now;
      stepRef.current(dt);
      if (ctx) renderRef.current(ctx);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [phase]);

  // Kept current every render, so the loop above never has to be torn
  // down and rebuilt to see a new closure.
  stepRef.current = step;
  renderRef.current = render;

  function step(dt) {
    const w = world.current;
    if (!w) return;
    w.t += dt;
    const p = w.player;

    // Platforms first, so Cole rides the one he is on.
    for (const plat of w.platforms) {
      const was = plat.liveX ?? platformX(plat, w.t);
      plat.liveX = platformX(plat, w.t);
      plat.dx = plat.liveX - was;
      plat.springT = Math.max(0, plat.springT - dt * 5);
      if (plat.dipY || plat.dipV) {
        plat.dipV += (-320 * plat.dipY - 14 * plat.dipV) * dt;
        plat.dipY += plat.dipV * dt;
        if (Math.abs(plat.dipY) < 0.05 && Math.abs(plat.dipV) < 0.5) { plat.dipY = 0; plat.dipV = 0; }
      }
    }

    p.stretch = Math.max(0, p.stretch - dt * 3.5);
    p.squash = Math.max(0, p.squash - dt * 4);
    if (p.anim) p.animT += dt;
    if (p.crouchT > 0) {
      p.crouchT -= dt;
      if (p.crouchT <= 0) { p.crouchT = 0; if (p.ground) hop(); }
    }

    const prevBottom = p.y + p.r;
    if (p.ground) {
      const g = p.ground;
      p.x += g.dx;
      p.face = Math.sign(g.vx) || 1;
      const onIt = p.x + p.r * 0.7 > g.liveX && p.x - p.r * 0.7 < g.liveX + g.w;
      if (!onIt) { p.ground = null; p.vy = 0; }
      else { p.y = g.y + g.dipY - p.r; p.vy = 0; }
    }

    if (!p.ground) {
      p.vy += GRAVITY * dt;
      p.y += p.vy * dt;
      if (p.vy > 0) {
        for (const plat of w.platforms) {
          if (Math.abs(plat.y - p.y) > 200) continue;
          const withinX = p.x + p.r * 0.7 > plat.liveX && p.x - p.r * 0.7 < plat.liveX + plat.w;
          if (withinX && prevBottom <= plat.y + 2 && p.y + p.r >= plat.y) {
            p.y = plat.y - p.r;
            const onSpring = plat.spring && Math.abs(p.x - (plat.liveX + plat.w / 2)) < 20;
            if (onSpring) {
              p.vy = SPRING; plat.springT = 1; pickTrick(); burst(p.x, plat.y, '#ff4f7a', 14);
            } else {
              const impact = Math.min(1.5, p.vy / 700);
              p.vy = 0; p.ground = plat; p.anim = null; p.special = false;
              p.squash = 0.9 + impact * 0.4;
              plat.dipV += (5 + impact * 4) * 30;
              dust(p.x, plat.y, 8 + Math.round(impact * 4));
              if (plat.n > w.highest) { w.highest = plat.n; setClimbed(plat.n); }
            }
            break;
          }
        }
      }
    }

    // Standing is what the answer buttons wait for; it changes rarely, so
    // it is the one bit of loop state that reaches React.
    setStanding(prev => (prev === Boolean(p.ground) ? prev : Boolean(p.ground)));

    if (p.x < -p.r) p.x = W + p.r;
    if (p.x > W + p.r) p.x = -p.r;

    const targetCam = p.y - H * 0.42;
    if (targetCam < w.camY) w.camY = targetCam;

    for (const q of w.particles) {
      q.vy += (q.g ?? 600) * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt;
      if (q.grow) { q.r += q.grow * dt; q.vx *= 1 - 3 * dt; }
    }
    w.particles = w.particles.filter(q => q.life > 0);

    if (p.y - p.r > w.camY + H) finish(w.highest);
  }

  function hop() {
    const w = world.current;
    const p = w.player;
    if (p.ground) p.ground.dipV += 4 * 30;
    p.vy = JUMP;
    p.ground = null;
    p.squash = 0;
    p.stretch = 1;
    pickTrick();
    burst(p.x, p.y + p.r, '#c9ced9', 5);
  }

  function pickTrick() {
    const p = world.current.player;
    if (p.nextTrick) { p.anim = p.nextTrick; p.special = true; p.nextTrick = null; }
    else { p.anim = TRICKS[Math.floor(Math.random() * TRICKS.length)]; p.special = false; }
    p.animT = 0;
  }

  function burst(x, y, color, n = 8) {
    const w = world.current;
    for (let i = 0; i < n; i += 1) {
      w.particles.push({
        x, y, vx: (Math.random() - 0.5) * 220, vy: -Math.random() * 160 - 40,
        life: 0.5 + Math.random() * 0.3, max: 0.8, color, r: 2 + Math.random() * 3,
      });
    }
  }

  function dust(x, y, n) {
    const w = world.current;
    for (let i = 0; i < n; i += 1) {
      const side = i % 2 ? 1 : -1;
      w.particles.push({
        x: x + side * (4 + Math.random() * 8), y: y - 2 - Math.random() * 4,
        vx: side * (70 + Math.random() * 110), vy: -15 - Math.random() * 35,
        life: 0.45 + Math.random() * 0.2, max: 0.65, color: '#cfd3dc',
        r: 3 + Math.random() * 3, grow: 14, g: 40,
      });
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────
  function render(ctx) {
    const w = world.current;
    if (!w) return;
    const { camY, platforms, particles, player: p } = w;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Every tenth platform gets a line, because platforms are the score.
    ctx.save();
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillStyle = '#9aa1b5';
    ctx.strokeStyle = '#e3e6ee';
    ctx.setLineDash([6, 8]);
    for (const plat of platforms) {
      if (plat.n === 0 || plat.n % 10) continue;
      const y = plat.y - camY;
      if (y < -10 || y > H + 10) continue;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillText(String(plat.n), 8, y - 5);
    }
    ctx.restore();

    const gy = START_Y + 40 - camY;
    if (gy < H + 40) {
      ctx.fillStyle = '#3dbb6a'; ctx.fillRect(0, gy, W, H);
      ctx.fillStyle = '#2f9956'; ctx.fillRect(0, gy, W, 6);
    }

    for (const plat of platforms) {
      const y = plat.y + plat.dipY - camY;
      if (y < -40 || y > H + 40) continue;
      ctx.fillStyle = '#3a3a3a';
      roundRect(ctx, plat.liveX, y, plat.w, plat.h, 4); ctx.fill();
      if (plat.spring) {
        const cx = plat.liveX + plat.w / 2;
        const ext = 6 + plat.springT * 10;
        ctx.strokeStyle = '#1d2a4a'; ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i <= 4; i += 1) ctx.lineTo(cx + (i % 2 ? 6 : -6), y - (i / 4) * ext);
        ctx.stroke();
        ctx.fillStyle = '#ff4f7a';
        roundRect(ctx, cx - 11, y - ext - 5, 22, 6, 3); ctx.fill();
      }
    }

    for (const q of particles) {
      ctx.globalAlpha = Math.max(0, q.life / q.max);
      ctx.fillStyle = q.color;
      ctx.beginPath(); ctx.arc(q.x, q.y - camY, q.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    drawCole(ctx, p, camY, w.t);
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {phase === 'pick' ? (
        <div className="w-full max-w-sm text-center">
          <p className="text-[13.5px]" style={{ color: 'var(--nl-ink2)' }}>
            Answer a times table and Cole hops. The platform above is sliding —
            answer when it lines up.
          </p>
          <p className="mt-3 text-[11px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--nl-muted)' }}>Which times table?</p>
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {TABLES.map(n => (
              <button key={String(n)} type="button"
                onClick={() => { setTable(n); setPhase('play'); }}
                className={`rounded-lg border px-2 py-2 text-[13px] font-semibold tabular-nums ${
                  n === 'all' ? 'col-span-4 text-white' : 'bg-white'
                }`}
                style={n === 'all'
                  ? { background: 'var(--nl-brand)', borderColor: 'var(--nl-brand)' }
                  : { borderColor: 'var(--nl-rule)', color: 'var(--nl-ink)' }}>
                {n === 'all' ? 'All tables' : `${n}×`}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="flex w-full max-w-sm items-center justify-between text-[12px]">
            <Pill tone="flat">{tableLabel(table)}</Pill>
            <span style={{ color: 'var(--nl-muted)' }}>
              <b className="text-[15px] tabular-nums" style={{ color: 'var(--nl-ink)' }}>{climbed}</b>
              {' '}platform{climbed === 1 ? '' : 's'}
            </span>
          </div>

          <div className="w-full max-w-[320px] overflow-hidden rounded-2xl"
            style={{ aspectRatio: `${W} / ${H}`, boxShadow: '0 0 0 2px var(--nl-rule)' }}>
            <canvas ref={canvasRef} width={W} height={H}
              aria-label="Cole Hop playfield"
              className="block h-full w-full" style={{ touchAction: 'none' }} />
          </div>

          {phase === 'play' ? (
            <div className="w-full max-w-sm text-center">
              <p className="text-[12px] font-bold uppercase tracking-wider"
                style={{ color: verdict && !verdict.right ? 'var(--nl-brand)' : 'var(--nl-muted)' }}>
                {verdict
                  ? (verdict.right
                    ? (tally.streak >= 2 ? `Correct — ${tally.streak} in a row` : 'Correct')
                    : explain(verdict.q))
                  : (standing ? 'Pick the answer to hop' : 'Hopping…')}
              </p>
              <p className="nl-display mt-1 text-[26px] font-semibold tabular-nums">
                {question.a} × {question.b}
              </p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {question.options.map((opt, i) => {
                  const picked = verdict?.i === i;
                  const isAnswer = opt === question.answer;
                  const tone = verdict && isAnswer ? 'ok' : (picked ? 'bad' : null);
                  return (
                    <button key={i} type="button"
                      disabled={!standing || Boolean(verdict)}
                      onClick={() => answer(i)}
                      className="rounded-xl border-2 py-2.5 text-[20px] font-bold tabular-nums transition-colors disabled:opacity-45"
                      style={{
                        borderColor: tone === 'ok' ? 'var(--nl-ok)' : tone === 'bad' ? 'var(--nl-brand)' : 'var(--nl-rule)',
                        background: tone === 'ok' ? 'var(--nl-ok)' : tone === 'bad' ? 'var(--nl-brand)' : 'var(--nl-card)',
                        color: tone ? '#fff' : 'var(--nl-ink)',
                      }}>
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-[13.5px]" style={{ color: 'var(--nl-ink2)' }}>
              <b>Cole fell.</b> {climbed} platform{climbed === 1 ? '' : 's'} —
              {' '}{tally.right} right, {tally.wrong} wrong on the tables.
            </p>
          )}
        </>
      )}
    </div>
  );

  function answer(i) {
    if (phase !== 'play' || verdict || !standing) return;
    const q = question;
    const right = q.options[i] === q.answer;
    setVerdict({ i, right, q });
    if (right) {
      setTally(t => {
        const streak = t.streak + 1;
        const next = { ...t, right: t.right + 1, streak, best: Math.max(t.best, streak) };
        tallyRef.current = next;
        return next;
      });
      // A streak buys a showier hop. It is decoration, and decoration is
      // the reward for a run of right answers.
      const p = world.current?.player;
      if (p) {
        const next = tally.streak + 1;
        if (next === 3 || next === 5 || (next >= 10 && next % 5 === 0)) {
          p.nextTrick = (next === 5 || next % 10 === 5) ? 'spin' : 'doubleflip';
        }
        p.crouchT = CROUCH;
      }
      after(450);
    } else {
      setTally(t => {
        const next = { ...t, wrong: t.wrong + 1, streak: 0 };
        tallyRef.current = next;
        return next;
      });
      if (world.current) world.current.player.squash = 0.8;
      // A wrong answer does not drop him. It costs the seconds the
      // platform above keeps sliding for, which is punishment enough and
      // leaves the fact on screen long enough to read.
      after(1100);
    }
  }

  function after(ms) {
    const id = setTimeout(() => {
      setVerdict(null);
      setQAt(n => n + 1);
    }, ms);
    timers.current.push(id);
  }
}

// ── Cole himself, drawn as the red colon he is everywhere else ─────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function smooth(k) { const v = Math.max(0, Math.min(1, k)); return v * v * (3 - 2 * v); }
function lp(a, b, k) { return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }; }

function drawDot(ctx, cx, cy, rad, hi) {
  const g = ctx.createRadialGradient(cx - rad * 0.35, cy - rad * 0.4, rad * 0.15, cx, cy, rad + 2);
  g.addColorStop(0, hi); g.addColorStop(1, '#d0142c');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#1d2a4a'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath(); ctx.ellipse(cx - rad * 0.4, cy - rad * 0.45, rad * 0.25, rad * 0.15, -0.6, 0, Math.PI * 2); ctx.fill();
}

function drawCole(ctx, player, camY, t) {
  const x = player.x, y = player.y - camY, r = player.r;
  const crouch = player.crouchT > 0 ? smooth(1 - player.crouchT / CROUCH) : 0;
  const sq = Math.max(player.squash, crouch * 1.35);
  const st = player.stretch || 0;
  const anim = player.anim, at = player.animT || 0;
  const w = anim ? smooth(at / 0.12) * (1 - smooth((at - 0.62) / 0.22)) : 0;
  const lag = Math.max(-8, Math.min(8, player.vy / 110)) * (1 - w);
  const gap = 6 - sq * 5 + Math.max(0, -player.vy / 300) * (1 - w) + st * 9;

  const botR = 12, topR = 10.5;
  const botY = r - botR;
  const topY = botY - botR - gap - topR + lag * 0.6;
  const midY = (botY + topY) / 2;

  ctx.save();
  ctx.translate(x, y);
  if (anim === 'flip' || anim === 'doubleflip') {
    const turns = anim === 'doubleflip' ? 2 : 1;
    ctx.translate(0, midY);
    ctx.rotate(player.face * Math.PI * 2 * turns * smooth(at / (0.62 + 0.1 * (turns - 1))));
    ctx.translate(0, -midY);
  }
  if (anim === 'spin') ctx.scale(Math.cos(Math.PI * 4 * smooth(at / 0.75)), 1);
  if (anim === 'superman') {
    ctx.translate(0, midY);
    ctx.rotate(player.face * 0.25 * w);
    ctx.translate(0, -midY);
  }

  const kick = Math.sin(t * 18) * (player.vy < 0 ? 2.5 : 0.8);
  const handUp = player.vy < 0 ? -9 : 2;
  const wave = Math.sin(t * 14) * 2;
  let feet = [{ x: -7, y: r + 1 + kick }, { x: 7, y: r + 1 - kick }];
  let hands = [{ x: -18, y: botY + handUp - wave }, { x: 18, y: botY + handUp + wave }];
  let footTilt = [-0.1, 0.1];

  if (anim === 'superman') {
    const f = player.face;
    hands = [lp(hands[0], { x: f * 5, y: topY - topR - 13 }, w),
      lp(hands[1], { x: -f * 17, y: botY + 5 }, w)];
    if (f < 0) hands.reverse();
    feet = [lp(feet[0], { x: -3, y: r + 8 }, w), lp(feet[1], { x: 3, y: r + 8 }, w)];
    footTilt = [-0.1 + 1.2 * w, 0.1 - 1.2 * w];
  } else if (anim === 'spin') {
    hands = [lp(hands[0], { x: -20, y: topY - 12 }, w), lp(hands[1], { x: 20, y: topY - 12 }, w)];
    feet = [lp(feet[0], { x: -3, y: r + 6 }, w), lp(feet[1], { x: 3, y: r + 6 }, w)];
  } else if (anim === 'flip' || anim === 'doubleflip') {
    hands = [lp(hands[0], { x: -9, y: botY - 2 }, w), lp(hands[1], { x: 9, y: botY - 2 }, w)];
    feet = [lp(feet[0], { x: -6, y: r - 3 }, w), lp(feet[1], { x: 6, y: r - 3 }, w)];
  } else if (anim === 'splits') {
    hands = [lp(hands[0], { x: -22, y: topY - 10 }, w), lp(hands[1], { x: 22, y: topY - 10 }, w)];
    feet = [lp(feet[0], { x: -28, y: r - 3 }, w), lp(feet[1], { x: 28, y: r - 3 }, w)];
    footTilt = [-0.1 - 0.5 * w, 0.1 + 0.5 * w];
  }

  if (anim === 'superman' && w > 0.01) {
    ctx.save();
    ctx.globalAlpha = w;
    const flap = Math.sin(t * 22) * 4;
    ctx.fillStyle = '#2f6fe0'; ctx.strokeStyle = '#1d2a4a'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-9, botY - 9);
    ctx.quadraticCurveTo(-16 + flap, botY + 18, -12 + flap, r + 18);
    ctx.lineTo(12 - flap, r + 20);
    ctx.quadraticCurveTo(16 - flap, botY + 18, 9, botY - 9);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  ctx.strokeStyle = '#1d2a4a'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  for (let i = 0; i < 2; i += 1) {
    const side = i ? 1 : -1;
    ctx.beginPath(); ctx.moveTo(side * 5, botY + 6); ctx.lineTo(feet[i].x, feet[i].y); ctx.stroke();
  }
  for (let i = 0; i < 2; i += 1) {
    const side = hands[i].x < 0 ? -1 : 1;
    ctx.beginPath(); ctx.moveTo(side * 10, botY - 2); ctx.lineTo(hands[i].x, hands[i].y); ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 2; i += 1) {
    ctx.beginPath(); ctx.ellipse(feet[i].x, feet[i].y, 6, 3.6, footTilt[i], 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  ctx.save();
  ctx.translate(0, botY);
  ctx.scale((1 + sq * 0.25) * (1 - st * 0.12), (1 - sq * 0.2) * (1 + st * 0.15));
  drawDot(ctx, 0, 0, botR, '#ff6a78');
  ctx.strokeStyle = '#1d2a4a'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  if (player.vy < 0) {
    ctx.beginPath(); ctx.arc(0, -1, 5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  } else {
    ctx.fillStyle = '#1d2a4a';
    ctx.beginPath(); ctx.ellipse(0, 2, 2.3, 3, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(255, 210, 220, 0.6)';
  ctx.beginPath(); ctx.ellipse(-7.5, 1, 2.8, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(7.5, 1, 2.8, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  drawDot(ctx, 0, topY, topR, '#ff7d8a');
  const look = player.face * 2, lookY = player.vy < 0 ? -1.5 : 1;
  for (const ex of [-4.5, 4.5]) {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(ex, topY + 1, 3.6, 4.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1d2a4a';
    ctx.beginPath(); ctx.arc(ex + look * 0.8, topY + 1 + lookY, 2, 0, Math.PI * 2); ctx.fill();
  }

  ctx.strokeStyle = '#1d2a4a'; ctx.lineWidth = 2; ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 2; i += 1) {
    const h = hands[i], side = h.x < 0 ? -1 : 1;
    ctx.beginPath(); ctx.arc(h.x, h.y, 4.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(h.x + side * 1, h.y - 4.5, 2.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}
