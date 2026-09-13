import { expect, test } from 'vitest';
import { parseSdfFont } from './sdfFont.ts';

function document() {
  return {
    version: 1,
    family: 'Test',
    atlas: { width: 128, height: 64, distanceRange: 4 },
    metrics: { unitsPerEm: 1000, ascender: 800, descender: -200, lineHeight: 1200 },
    glyphs: {
      A: {
        advance: 640,
        planeLeft: 20,
        planeBottom: 0,
        planeRight: 620,
        planeTop: 700,
        atlasLeft: 4,
        atlasBottom: 4,
        atlasRight: 44,
        atlasTop: 52,
      },
    },
    kerning: { 'A\u0000V': -60 },
  };
}

test('a parsed font answers for a glyph it has', () => {
  const font = parseSdfFont(document());
  expect(font.glyph('A')?.advance).toBe(640);
  expect(font.unitsPerEm).toBe(1000);
});

/* Null, not a throw: a missing glyph is a content problem and the frame still has to draw. */
test('a glyph the atlas lacks reports null rather than throwing', () => {
  const font = parseSdfFont(document());
  expect(font.glyph('Z')).toBeNull();
});

test('kerning is found for a pair and zero otherwise', () => {
  const font = parseSdfFont(document());
  expect(font.kerning('A', 'V')).toBe(-60);
  expect(font.kerning('A', 'A')).toBe(0);
});

/*
 * A future format change must fail at load rather than draw a wrong frame. This is the
 * fail-fast-at-init rule: the one moment throwing is correct.
 */
test('an unknown version is refused at load', () => {
  const future = { ...document(), version: 2 };
  expect(() => parseSdfFont(future)).toThrow(/version/);
});

test('a document that is not an object is refused', () => {
  expect(() => parseSdfFont(null)).toThrow();
});

test('a document missing unitsPerEm throws and names the field', () => {
  const doc = { ...document(), metrics: { ascender: 800, descender: -200, lineHeight: 1200 } };
  expect(() => parseSdfFont(doc)).toThrow(/unitsPerEm/);
});

test('a document whose metrics key is not an object throws descriptively', () => {
  const doc = { ...document(), metrics: null };
  expect(() => parseSdfFont(doc)).toThrow();
});

/*
 * A run is a key in the glyph table that is more than one code point: a string the
 * generator shaped once and baked as a single cell, because the runtime lays glyphs out
 * left to right and cannot join or reorder anything. `أبو` is the case that forced it.
 *
 * Derived from the table rather than declared in the document on purpose. A separate list
 * could disagree with the glyphs it names, and a run named but not baked is a label that
 * silently draws nothing.
 */
test('runs are the multi-character keys, longest first', () => {
  const doc = document();
  const cell = doc.glyphs.A;
  const font = parseSdfFont({
    ...doc,
    glyphs: { ...doc.glyphs, أبو: cell, أب: cell },
  });
  expect(font.runs).toEqual(['أبو', 'أب']);
});

test('a font with only single characters has no runs', () => {
  expect(parseSdfFont(document()).runs).toEqual([]);
});

/* A run is looked up like any other key, because that is all it is. */
test('a run is reachable through glyph()', () => {
  const doc = document();
  const font = parseSdfFont({ ...doc, glyphs: { ...doc.glyphs, أبو: doc.glyphs.A } });
  expect(font.glyph('أبو')?.advance).toBe(640);
});
