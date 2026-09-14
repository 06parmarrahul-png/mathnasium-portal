// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  MASCOTS, DEFAULT_MASCOT, MASCOT_POSES, resolveMascotId, mascotFor, mascotSvg, mascotDataUrl,
} from './mascots';

const parse = (svg) => new DOMParser().parseFromString(svg, 'image/svg+xml');

describe('choosing a mascot', () => {
  it('has the four Coles', () => {
    expect(MASCOTS.map(m => m.id)).toEqual(['classic', 'coach', 'cool', 'bot']);
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

  it('gives each Cole its signature, so they are not four copies', () => {
    expect(mascotSvg('coach', 'coach')).toContain('1:4');       // the clipboard
    expect(mascotSvg('bot')).toContain('#20232B');               // the visor
    expect(mascotSvg('cool')).toContain('M60 77 H140');           // the shades
    expect(mascotSvg('classic')).toContain('M92 38 Q84 14');     // the cowlick
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
