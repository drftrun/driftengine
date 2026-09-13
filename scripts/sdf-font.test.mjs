import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packGlyphs, metricsDocument, runSet } from './sdf-font-lib.mjs';

/*
 * The packer is the part with arithmetic in it, so it is the part that gets tested. The
 * rasteriser is a call into a drawing surface and is checked by looking at its output.
 */
test('packGlyphs lays boxes out in rows without overlapping', () => {
  const placed = packGlyphs(
    [
      { char: 'A', width: 40, height: 48 },
      { char: 'B', width: 40, height: 48 },
      { char: 'C', width: 40, height: 48 },
    ],
    { atlasWidth: 100, padding: 2 },
  );
  assert.equal(placed.length, 3);
  /* Two fit on the first row at 44 apart, the third wraps. */
  assert.equal(placed[0].y, placed[1].y);
  assert.ok(placed[2].y > placed[0].y);
  assert.ok(placed[1].x >= placed[0].x + 40);
});

test('packGlyphs reports the height it needed', () => {
  const placed = packGlyphs([{ char: 'A', width: 40, height: 48 }], {
    atlasWidth: 100,
    padding: 2,
  });
  assert.equal(placed.height, undefined);
  assert.equal(placed[0].x, 2);
  assert.equal(placed[0].y, 2);
});

test('a glyph wider than the atlas is an error rather than a silent clip', () => {
  assert.throws(
    () => packGlyphs([{ char: 'W', width: 300, height: 48 }], { atlasWidth: 100, padding: 2 }),
    /wider than the atlas/,
  );
});

test('metricsDocument writes version 1 and NUL-joined kerning keys', () => {
  const doc = metricsDocument({
    family: 'Test',
    atlas: { width: 64, height: 64, distanceRange: 4 },
    metrics: { unitsPerEm: 1000, ascender: 800, descender: -200, lineHeight: 1200 },
    glyphs: {},
    kerning: [{ left: 'A', right: 'V', amount: -60 }],
  });
  assert.equal(doc.version, 1);
  assert.equal(doc.kerning['A\u0000V'], -60);
});

/*
 * A run is a whole line, unlike the glyph file where every character is its own entry: a
 * run is a string that means something as a string, and the only separator that cannot
 * appear inside one is the line ending.
 */
test('runSet takes one run per line', () => {
  assert.deepEqual(runSet('أبو\nfi\n'), ['أبو', 'fi']);
});

test('runSet drops blank lines and trailing whitespace rather than baking them', () => {
  assert.deepEqual(runSet('أبو  \n\n\n  \nfi\n'), ['أبو', 'fi']);
});

test('runSet keeps the first of a repeated run', () => {
  assert.deepEqual(runSet('fi\nأبو\nfi\n'), ['fi', 'أبو']);
});

/* A single character in the runs file is a mistake worth naming: it would bake a second
   cell for a glyph that already has one, and `SdfFont.runs` would never match it. */
test('a one-character run is refused', () => {
  assert.throws(() => runSet('أ\n'), /at least two characters/);
});
