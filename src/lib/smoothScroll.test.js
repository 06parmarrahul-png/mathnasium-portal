import { describe, it, expect } from 'vitest';
import { scrollTargetY, HEADROOM } from './smoothScroll';

describe('where an auto-scroll lands', () => {
  it('stops short of the target, so what came before still shows', () => {
    // The whole point: the reader has to be able to SEE that the slot
    // grid is still up there, or they will not believe they can go back.
    expect(scrollTargetY({ elementTop: 1000, headroom: 72 })).toBe(928);
  });

  it('leaves that gap by default, without being asked', () => {
    expect(scrollTargetY({ elementTop: 1000 })).toBe(1000 - HEADROOM);
    expect(HEADROOM).toBeGreaterThan(0);
  });

  it('never asks to scroll above the top of the page', () => {
    // A target already near the top would otherwise want a negative
    // scroll, which browsers clamp anyway — but then the animation
    // travels to a place it can't reach and appears to stall.
    expect(scrollTargetY({ elementTop: 40, headroom: 72 })).toBe(0);
    expect(scrollTargetY({ elementTop: 0 })).toBe(0);
  });

  it('never asks for more page than there is', () => {
    // The form is the last thing on the page, so its top is often within
    // a screen of the bottom.
    expect(scrollTargetY({ elementTop: 4000, headroom: 72, maxY: 1200 })).toBe(1200);
  });

  it('clamps to zero when the page cannot scroll at all', () => {
    expect(scrollTargetY({ elementTop: 900, maxY: 0 })).toBe(0);
    expect(scrollTargetY({ elementTop: 900, maxY: -50 })).toBe(0);
  });

  it('gives a usable number rather than NaN for a missing measurement', () => {
    expect(scrollTargetY({ elementTop: undefined })).toBe(0);
    expect(scrollTargetY({ elementTop: NaN })).toBe(0);
  });
});
