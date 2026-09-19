// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  MASCOTS, DEFAULT_MASCOT, MASCOT_POSES, resolveMascotId, mascotFor, mascotSvg, mascotDataUrl,
} from './mascots';

const parse = (svg) => new DOMParser().parseFromString(svg, 'image/svg+xml');

describe('choosing a mascot', () => {
  it('has the eight Coles', () => {
    expect(MASCOTS.map(m => m.id))
      .toEqual(['classic', 'coach', 'cool', 'bot', 'gamer', 'coffee', 'dog', 'corgi']);
  });

  it('gives anyone who never picked the original', () => {
    expect(DEFAULT_MASCOT).toBe('classic');
    expect(resolveMascotId(undefined)).toBe('classic');
    expect(resolveMascotId(null)).toBe('classic');
    expect(resolveMascotId('')).toBe('classic');
  });

  it('treats a value it does not know as the default, not as a broken icon', () => {
    // A doc written by a future version, or edited by hand.
    expect(resolveMascotId('pirate')).toBe('classic');
    expect(resolveMascotId({ id: 'coach' })).toBe('classic');
    expect(mascotFor('pirate').name).toBe('Cole');
  });

  it('keeps a real pick', () => {
    for (const m of MASCOTS) expect(resolveMascotId(m.id)).toBe(m.id);
    expect(mascotFor('bot').name).toBe('Cole-bot');
  });
});

describe('the artwork', () => {
  // Every combination is drawn, because a typo in one pose's markup would
  // show up as a broken image for exactly the people who picked that Cole.
  const combos = MASCOTS.flatMap(m => MASCOT_POSES.flatMap(p => [
    [m.id, p, 'full'], [m.id, p, 'head'],
  ]));

  it.each(combos)('%s in %s (%s) is well-formed SVG', (id, pose, crop) => {
    const doc = parse(mascotSvg(id, pose, { crop }));
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.nodeName).toBe('svg');
  });

  it.each(combos)('%s in %s (%s) points every clip-path at a clip that exists', (id, pose, crop) => {
    const svg = mascotSvg(id, pose, { crop });
    const doc = parse(svg);
    const ids = [...doc.querySelectorAll('[id]')].map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map(m => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(ids).toContain(r);
  });

  it('draws the same markup every time, so the data URL can be cached', () => {
    expect(mascotSvg('coach', 'wave')).toBe(mascotSvg('coach', 'wave'));
    expect(mascotDataUrl('coach', 'wave')).toBe(mascotDataUrl('coach', 'wave'));
  });

  it('frames the head for the icon and the whole body otherwise', () => {
    expect(mascotSvg('classic', 'stand', { crop: 'head' })).toContain('viewBox="30 0 148 148"');
    expect(mascotSvg('classic', 'stand')).toContain('viewBox="0 0 200 264"');
  });

  it('gives each Cole its signature, so they are not eight copies', () => {
    expect(mascotSvg('coach', 'coach')).toContain('1:4');       // the clipboard
    expect(mascotSvg('bot')).toContain('#20232B');               // the visor
    expect(mascotSvg('cool')).toContain('M60 77 H140');           // the shades
    expect(mascotSvg('classic')).toContain('M92 38 Q84 14');     // the cowlick
    expect(mascotSvg('gamer')).toContain('M50 112 Q48 136');     // the boom mic
    expect(mascotSvg('coffee')).toContain('#8A5F4B');            // the eye bags
    expect(mascotSvg('dog')).toContain('M62 48 Q34 54');          // ears down
    expect(mascotSvg('corgi')).toContain('M52 46 Q44 6');          // ears up
  });

  it('tells the two dogs apart by which way the ears go', () => {
    // Cole-9 IS a dog and Cole-gi is Cole in a dog hood, so they share
    // a theme and have to differ where it is readable at 40px: one set
    // of ears hangs, the other stands up.
    const dog = mascotSvg('dog', 'stand', { crop: 'head' });
    const corgi = mascotSvg('corgi', 'stand', { crop: 'head' });
    expect(dog).toContain('M62 48 Q34 54');
    expect(corgi).not.toContain('M62 48 Q34 54');
    // ...and only the hood leaves Cole's own face and blush in place.
    expect(corgi).toContain('#FF7F8E');
    expect(dog).toContain('#F6E3CE');   // the muzzle Cole-9 wears instead
    expect(corgi).not.toContain('#F6E3CE');
  });

  it('hands a prop to the pose that holds it, and to no other', () => {
    expect(mascotSvg('gamer', 'game')).toContain('M64 172 Q52 176');
    expect(mascotSvg('gamer', 'stand')).not.toContain('M64 172 Q52 176');
    expect(mascotSvg('coffee', 'sip')).toContain('M150 106 H182');
    expect(mascotSvg('coffee', 'stand')).not.toContain('M150 106 H182');
    expect(mascotSvg('dog', 'fetch')).toContain('translate(172 146)');
    expect(mascotSvg('dog', 'stand')).not.toContain('translate(172 146)');
  });

  it('keeps the dog\'s tail below the head crop', () => {
    // The crop is the top 148 units of the drawing, and the tail lives
    // under it. Its STROKE is what has to clear that line, not its path:
    // at 19 wide the tail reached past it and drew a stray brown mark
    // beside the 40px icon. Cropping only swaps the viewBox, so this has
    // to be checked as geometry rather than as markup that went away.
    const tail = mascotSvg('dog', 'stand')
      .match(/<path d="(M130 [^"]+)" stroke="[^"]+" stroke-width="(\d+)"/);
    expect(tail).toBeTruthy();
    const ys = [...tail[1].matchAll(/-?[\d.]+\s+(-?[\d.]+)/g)].map(m => Number(m[1]));
    // A quadratic stays inside the hull of its three points, so the
    // smallest y written down bounds the curve itself.
    expect(Math.min(...ys) - Number(tail[2]) / 2).toBeGreaterThanOrEqual(148);
  });

  it('keeps every Cole apart in the 40px icon, which draws the head standing', () => {
    // Nothing held is in frame there, so a Cole whose only signature is a
    // prop would be an exact copy of the original in the sidebar. Compared
    // with the clip ids normalised, since those carry the name already.
    const icons = MASCOTS.map(m => mascotSvg(m.id, 'stand', { crop: 'head' })
      .replaceAll(`${m.id}-stand-`, 'x-'));
    expect(new Set(icons).size).toBe(MASCOTS.length);
  });

  it('falls back to standing for a pose it does not have', () => {
    expect(mascotSvg('coach', 'backflip')).toBe(mascotSvg('coach', 'stand'));
  });

  it('is an image data URL, with nothing left unescaped', () => {
    const url = mascotDataUrl('cool', 'peace', { crop: 'head' });
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(url).not.toMatch(/[<>"#]/);
  });
});
