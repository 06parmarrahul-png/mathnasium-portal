import { describe, it, expect } from 'vitest';
import {
  HIGHLIGHTS, HIGHLIGHT_KEYS, highlightFor, highlightStyle,
  legendEntries, serializeLegend, highlightsInUse,
} from './scheduler-highlights';

describe('the palette', () => {
  it('is the four highlighter colours, in order', () => {
    expect(HIGHLIGHT_KEYS).toEqual(['yellow', 'pink', 'orange', 'blue']);
  });

  it('gives every colour a background, text colour and ring', () => {
    for (const h of HIGHLIGHTS) {
      expect(h.bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(h.text).toMatch(/^#[0-9a-f]{6}$/i);
      expect(h.ring).toMatch(/^#[0-9a-f]{6}$/i);
      expect(h.label).toBeTruthy();
    }
  });

  it('uses a distinct background per colour', () => {
    expect(new Set(HIGHLIGHTS.map(h => h.bg)).size).toBe(HIGHLIGHTS.length);
  });
});

describe('highlightFor', () => {
  it('finds a known colour', () => {
    expect(highlightFor('pink').bg).toBe('#fbcfe8');
  });

  it('is null for no highlight or an unknown one', () => {
    expect(highlightFor('')).toBe(null);
    expect(highlightFor(null)).toBe(null);
    expect(highlightFor(undefined)).toBe(null);
    expect(highlightFor('chartreuse')).toBe(null);
  });
});

describe('highlightStyle', () => {
  it('returns undefined when there is nothing to paint', () => {
    // Not {} — spreading an empty object is fine, but returning undefined
    // makes "no highlight" unambiguous at the call site.
    expect(highlightStyle('')).toBeUndefined();
    expect(highlightStyle('nope')).toBeUndefined();
  });

  it('paints the background and readable text', () => {
    const st = highlightStyle('yellow');
    expect(st.backgroundColor).toBe('#fef08a');
    expect(st.color).toBe('#713f12');
  });

  // Without these the highlight silently disappears on paper, which is the
  // one surface the whole feature exists for.
  it('forces the colour to survive printing, in both engines', () => {
    for (const k of HIGHLIGHT_KEYS) {
      const st = highlightStyle(k);
      expect(st.printColorAdjust).toBe('exact');
      expect(st.WebkitPrintColorAdjust).toBe('exact');
    }
  });
});

describe('legendEntries', () => {
  it('shows only the colours the centre has named', () => {
    const out = legendEntries({ yellow: 'Needs review', blue: 'Parent waiting' });
    expect(out.map(h => h.key)).toEqual(['yellow', 'blue']);
    expect(out[0].meaning).toBe('Needs review');
  });

  it('is empty when nothing is named and nothing is used', () => {
    expect(legendEntries({}, [])).toEqual([]);
    expect(legendEntries(null)).toEqual([]);
  });

  // A mark on the sheet with nothing explaining it is worse than no legend.
  it('still shows a colour that is in use but unnamed', () => {
    const out = legendEntries({ yellow: 'Needs review' }, ['orange']);
    expect(out.map(h => h.key)).toEqual(['yellow', 'orange']);
    expect(out.find(h => h.key === 'orange').meaning).toBe('');
  });

  it('does not list a used colour twice when it is also named', () => {
    const out = legendEntries({ yellow: 'Needs review' }, ['yellow']);
    expect(out.map(h => h.key)).toEqual(['yellow']);
  });

  it('accepts a Set or an array of used colours', () => {
    expect(legendEntries({}, new Set(['pink'])).map(h => h.key)).toEqual(['pink']);
    expect(legendEntries({}, ['pink']).map(h => h.key)).toEqual(['pink']);
  });

  it('ignores whitespace-only labels', () => {
    expect(legendEntries({ yellow: '   ' })).toEqual([]);
  });

  it('keeps palette order regardless of legend key order', () => {
    const out = legendEntries({ blue: 'b', yellow: 'y', orange: 'o', pink: 'p' });
    expect(out.map(h => h.key)).toEqual(['yellow', 'pink', 'orange', 'blue']);
  });
});

describe('serializeLegend', () => {
  it('writes every key, so clearing a label actually clears it', () => {
    const out = serializeLegend({ yellow: 'Review' });
    expect(Object.keys(out).sort()).toEqual([...HIGHLIGHT_KEYS].sort());
    expect(out.pink).toBe('');
  });

  it('trims and caps length', () => {
    expect(serializeLegend({ yellow: '  Review  ' }).yellow).toBe('Review');
    expect(serializeLegend({ yellow: 'x'.repeat(80) }).yellow.length).toBe(40);
  });

  it('drops keys that are not colours', () => {
    expect(serializeLegend({ yellow: 'a', bogus: 'b' }).bogus).toBeUndefined();
  });

  it('is safe on junk', () => {
    expect(serializeLegend(null).yellow).toBe('');
    expect(serializeLegend({ yellow: 42 }).yellow).toBe('42');
  });
});

describe('highlightsInUse', () => {
  it('collects the colours actually on the day', () => {
    const used = highlightsInUse({
      a: { highlight: 'yellow' },
      b: { highlight: 'blue' },
      c: { highlight: 'yellow' },
      d: { status: 'in' },
    });
    expect([...used].sort()).toEqual(['blue', 'yellow']);
  });

  it('ignores unknown or empty values', () => {
    const used = highlightsInUse({ a: { highlight: 'gold' }, b: { highlight: '' }, c: {} });
    expect(used.size).toBe(0);
  });

  it('is safe on junk', () => {
    expect(highlightsInUse(null).size).toBe(0);
    expect(highlightsInUse({}).size).toBe(0);
  });
});
