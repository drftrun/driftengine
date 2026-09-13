import { expect, test } from 'vitest';
import { parseSdfFont } from './sdfFont.ts';
import { DEFAULT_SDF_TEXT_STYLE, SdfTextLayout } from './sdfTextLayout.ts';

/** Two glyphs, both a clean 500x1000 units, so every expected number is arithmetic. */
function font() {
  const box = {
    advance: 500,
    planeLeft: 0,
    planeBottom: 0,
    planeRight: 500,
    planeTop: 1000,
    atlasLeft: 0,
    atlasBottom: 0,
    atlasRight: 50,
    atlasTop: 100,
  };
  /* Advance but no area -- a real glyph, unlike a character the atlas never heard of. */
  const space = {
    advance: 500,
    planeLeft: 0,
    planeBottom: 0,
    planeRight: 0,
    planeTop: 0,
    atlasLeft: 0,
    atlasBottom: 0,
    atlasRight: 0,
    atlasTop: 0,
  };
  return parseSdfFont({
    version: 1,
    family: 'Test',
    atlas: { width: 100, height: 100, distanceRange: 4 },
    metrics: { unitsPerEm: 1000, ascender: 1000, descender: 0, lineHeight: 1000 },
    glyphs: { A: box, B: { ...box }, ' ': space },
    kerning: { 'A\u0000B': -100 },
  });
}

test('each glyph becomes one quad', () => {
  const layout = new SdfTextLayout();
  layout.set(font(), 'AB', DEFAULT_SDF_TEXT_STYLE);
  expect(layout.quadCount).toBe(2);
  expect(layout.indices.length).toBeGreaterThanOrEqual(12);
});

/* A real space glyph -- advance but zero area -- must move the pen like any other character. */
test('a space advances without producing a quad', () => {
  const layout = new SdfTextLayout();
  layout.set(font(), 'A B', DEFAULT_SDF_TEXT_STYLE);
  expect(layout.quadCount).toBe(2);
  /*
   * A, space and B are each 500 units, and none of them borders the other closely enough to
   * hit the A-B kerning pair: (500 + 500 + 500) / 1000 unitsPerEm = 1.5. A space that were
   * skipped instead of advanced would leave B sitting right after A, at 1.0 -- so this is
   * the number that tells an advancing space from a skipped one.
   */
  expect(layout.width).toBeCloseTo(1.5, 6);
});

test('width is the advance sum with kerning applied', () => {
  const layout = new SdfTextLayout();
  /* size 1 => one em is one unit. A + B = 1.0, less 0.1 of kerning. */
  layout.set(font(), 'AB', { ...DEFAULT_SDF_TEXT_STYLE, size: 1 });
  expect(layout.width).toBeCloseTo(0.9, 6);
});

test('centre anchoring puts the string astride the origin', () => {
  const layout = new SdfTextLayout();
  layout.set(font(), 'AB', { ...DEFAULT_SDF_TEXT_STYLE, size: 1, anchorX: 'center' });
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < layout.quadCount * 4; i++) {
    const x = layout.positions[i * 3] as number;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  expect(min).toBeCloseTo(-max, 5);
});

test('left anchoring starts at the origin', () => {
  const layout = new SdfTextLayout();
  layout.set(font(), 'AB', { ...DEFAULT_SDF_TEXT_STYLE, size: 1, anchorX: 'left' });
  let min = Infinity;
  for (let i = 0; i < layout.quadCount * 4; i++) {
    const x = layout.positions[i * 3] as number;
    if (x < min) min = x;
  }
  expect(min).toBeCloseTo(0, 5);
});

/* A glyph the atlas lacks is skipped, not drawn as a wrong one and not thrown over. */
test('a missing glyph is skipped and still advances nothing', () => {
  const layout = new SdfTextLayout();
  layout.set(font(), 'AZB', DEFAULT_SDF_TEXT_STYLE);
  expect(layout.quadCount).toBe(2);
});

/* Re-laying the same string must not touch the buffers; upload is what it costs. */
test('setting the same string twice reports no change', () => {
  const layout = new SdfTextLayout();
  const f = font();
  expect(layout.set(f, 'AB', DEFAULT_SDF_TEXT_STYLE)).toBe(true);
  expect(layout.set(f, 'AB', DEFAULT_SDF_TEXT_STYLE)).toBe(false);
  expect(layout.set(f, 'BA', DEFAULT_SDF_TEXT_STYLE)).toBe(true);
});

/** The same two-glyph font, plus a run whose cell is twice as wide as one glyph. */
function fontWithRun() {
  const box = {
    advance: 500,
    planeLeft: 0,
    planeBottom: 0,
    planeRight: 500,
    planeTop: 1000,
    atlasLeft: 0,
    atlasBottom: 0,
    atlasRight: 50,
    atlasTop: 100,
  };
  const run = { ...box, advance: 1200, planeRight: 1200, atlasRight: 120 };
  return parseSdfFont({
    version: 1,
    family: 'Test',
    atlas: { width: 200, height: 100, distanceRange: 4 },
    metrics: { unitsPerEm: 1000, ascender: 1000, descender: 0, lineHeight: 1000 },
    glyphs: { A: box, B: { ...box }, AB: run },
    kerning: {},
  });
}

/*
 * The whole point: `AB` is in the table as one baked cell, so the string "AB" is one quad
 * rather than two. This is what makes an unshapeable script drawable — the shaping happened
 * once, at bake time, in a text stack that has one.
 */
test('a run at the pen draws as one quad, not one per character', () => {
  const layout = new SdfTextLayout();
  layout.set(fontWithRun(), 'AB', { ...DEFAULT_SDF_TEXT_STYLE, size: 1 });
  expect(layout.quadCount).toBe(1);
});

test("a run advances by the run's own advance", () => {
  const layout = new SdfTextLayout();
  layout.set(fontWithRun(), 'AB', { ...DEFAULT_SDF_TEXT_STYLE, size: 1 });
  expect(layout.width).toBeCloseTo(1.2, 6);
});

/* Longest first, or a shorter run that is a prefix of a longer one would win and the tail
   would be laid out again as single glyphs. */
test('the longest matching run wins over a shorter one', () => {
  const base = fontWithRun();
  const cell = base.glyph('AB');
  expect(cell).not.toBeNull();
  const font = parseSdfFont({
    version: 1,
    family: 'Test',
    atlas: { width: 200, height: 100, distanceRange: 4 },
    metrics: { unitsPerEm: 1000, ascender: 1000, descender: 0, lineHeight: 1000 },
    glyphs: {
      A: {
        advance: 500,
        planeLeft: 0,
        planeBottom: 0,
        planeRight: 500,
        planeTop: 1000,
        atlasLeft: 0,
        atlasBottom: 0,
        atlasRight: 50,
        atlasTop: 100,
      },
      B: {
        advance: 500,
        planeLeft: 0,
        planeBottom: 0,
        planeRight: 500,
        planeTop: 1000,
        atlasLeft: 0,
        atlasBottom: 0,
        atlasRight: 50,
        atlasTop: 100,
      },
      AB: cell as NonNullable<typeof cell>,
      ABB: { ...(cell as NonNullable<typeof cell>), advance: 1700 },
    },
    kerning: {},
  });
  const layout = new SdfTextLayout();
  layout.set(font, 'ABB', { ...DEFAULT_SDF_TEXT_STYLE, size: 1 });
  expect(layout.quadCount).toBe(1);
  expect(layout.width).toBeCloseTo(1.7, 6);
});

/* Everything outside a run is unchanged, which is the regression that matters most: every
   existing atlas has no runs at all and must lay out exactly as it did before. */
test('a run in the middle leaves the glyphs around it alone', () => {
  const layout = new SdfTextLayout();
  layout.set(fontWithRun(), 'BABA', { ...DEFAULT_SDF_TEXT_STYLE, size: 1 });
  /* B, then the AB run, then A: three quads, 0.5 + 1.2 + 0.5 wide. */
  expect(layout.quadCount).toBe(3);
  expect(layout.width).toBeCloseTo(2.2, 6);
});
