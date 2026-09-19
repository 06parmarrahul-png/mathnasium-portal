/**
 * A deliberately unhurried scroll, for moving a reader to a part of the
 * page they did not ask to go to.
 *
 * The public booking page needs this: picking a time slot reveals the
 * intake form below the fold, and parents were left looking at the same
 * grid with no sign anything had happened. Jumping them down solves that
 * and creates a worse problem — arriving somewhere instantly reads as a
 * new page, and people stop believing they can go back.
 *
 * So three rules, all of them about keeping the reader oriented:
 *
 *   1. It TAKES ITS TIME. Long enough to watch the page travel, which is
 *      what tells someone the destination was below and is still above.
 *   2. It LEAVES A SLIVER of what came before on screen. Landing with the
 *      form flush to the top hides the fact that the grid is still there.
 *   3. It GETS OUT OF THE WAY. Touch the wheel, the screen or a key and
 *      the animation stops dead, wherever it is. An animation that fights
 *      the reader for the scroll position is worse than no animation.
 *
 * Anyone who has asked their system not to animate things gets the plain
 * jump instead; for them the movement is the problem, not the fix.
 */

/** ~1s. Fast enough not to feel broken, slow enough to read as travel. */
export const SCROLL_MS = 900;

/** How much of the previous section stays on screen at the destination. */
export const HEADROOM = 72;

/**
 * Where to scroll so `elementTop` sits `headroom` px below the top of the
 * viewport. Pure, and the only part of this worth pinning down: it is the
 * rule that keeps the previous section peeking.
 *
 * @param {number} elementTop  the target's top, in document coordinates
 * @param {number} headroom    px of the previous section to leave showing
 * @param {number} maxY        furthest the document can actually scroll
 */
export function scrollTargetY({ elementTop, headroom = HEADROOM, maxY = Infinity }) {
  if (!Number.isFinite(elementTop)) return 0;
  const wanted = elementTop - headroom;
  // Clamped at both ends: a target near the top of a short page would
  // otherwise ask for a negative scroll, and one near the bottom would
  // ask for more page than there is.
  const ceiling = Number.isFinite(maxY) ? Math.max(0, maxY) : Infinity;
  return Math.max(0, Math.min(wanted, ceiling));
}

const prefersReducedMotion = () => {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  } catch {
    return false;
  }
};

/** Slow, fast, slow — the shape that reads as travel rather than a cut. */
const easeInOutCubic = (t) => (
  t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2
);

/**
 * Scroll the window to `y`. Returns a function that stops it early; it is
 * safe to call more than once, and it is called for you when the reader
 * takes over or the animation finishes.
 */
export function smoothScrollTo(y, { duration = SCROLL_MS } = {}) {
  const noop = () => {};
  if (typeof window === 'undefined') return noop;

  if (prefersReducedMotion()) {
    window.scrollTo(0, y);
    return noop;
  }

  const startY = window.scrollY;
  const distance = y - startY;
  // Already there. Animating a two-pixel trip just looks like a glitch.
  if (Math.abs(distance) < 2) return noop;

  let frame = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('wheel', stop);
    window.removeEventListener('touchstart', stop);
    window.removeEventListener('keydown', stop);
  };

  // Rule 3. Passive, so none of these can delay the reader's own scroll.
  window.addEventListener('wheel', stop, { passive: true });
  window.addEventListener('touchstart', stop, { passive: true });
  window.addEventListener('keydown', stop);

  const started = performance.now();
  const step = (now) => {
    if (stopped) return;
    const t = Math.min(1, (now - started) / duration);
    window.scrollTo(0, startY + distance * easeInOutCubic(t));
    if (t < 1) frame = requestAnimationFrame(step);
    else stop();
  };
  frame = requestAnimationFrame(step);
  return stop;
}

/** The same, aimed at an element. No element, no scroll — never an error. */
export function scrollToElement(el, { headroom = HEADROOM, duration = SCROLL_MS } = {}) {
  if (!el || typeof window === 'undefined') return () => {};
  const elementTop = el.getBoundingClientRect().top + window.scrollY;
  const maxY = Math.max(
    0,
    (document.documentElement?.scrollHeight || 0) - window.innerHeight,
  );
  return smoothScrollTo(scrollTargetY({ elementTop, headroom, maxY }), { duration });
}
