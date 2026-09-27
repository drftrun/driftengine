import { expect, test } from 'vitest';

import { pixelText, wrapParts } from './hudText.ts';

test('A READOUT IS SPELLED IN THE GLYPHS THE PIXEL FONT HAS, and nothing is drawn as its box', () => {
  /*
   * The browser's readout line, as a scene writes it. The dash becomes a hyphen, the degree sign
   * goes, the middle dot is kept because the font has one, and lower case becomes capitals, which
   * is all the font draws.
   */
  expect(pixelText('webgpu · Sponza atrium — 60 fps · sun 50.4°')).toBe(
    'WEBGPU · SPONZA ATRIUM - 60 FPS · SUN 50.4',
  );
  /* An ellipsis is three stops, and a character with no glyph and no spelling is dropped. */
  expect(pixelText('loading…')).toBe('LOADING...');
  expect(pixelText('a_b')).toBe('AB');
});

test('A readout too wide for the window breaks between its parts, never inside one', () => {
  /*
   * At a cell of one pixel a glyph advances six and the last one's gap is not counted, so "AB" is
   * 11 wide and "AB · CD" is 7 glyphs, 41. A window 41 wide takes the first two parts on one line,
   * and the third, "EF", goes to the next.
   */
  expect(wrapParts(['AB', 'CD', 'EF'], 41, 1)).toEqual(['AB · CD', 'EF']);
  /* One part wider than the window is its own line rather than being cut. */
  expect(wrapParts(['ABCDEFGH', 'IJ'], 20, 1)).toEqual(['ABCDEFGH', 'IJ']);
  expect(wrapParts([], 100, 1)).toEqual([]);
});

test('A LINE ALSO BREAKS BEFORE IT HOLDS MORE LIT CELLS THAN ONE TEXT OBJECT DRAWS, or its end is cut', () => {
  /*
   * A full block lights all 35 cells of its 5 by 7, so two of them are 70 and "██ · ██" is 140 plus
   * the dot's few. The engine cuts a text object at its cell cap, so a line that would pass one has
   * to break first, however much width is left: under a cap of 100 these are two lines, under 200 one.
   */
  expect(wrapParts(['██', '██'], 10_000, 1, ' · ', 100)).toEqual(['██', '██']);
  expect(wrapParts(['██', '██'], 10_000, 1, ' · ', 200)).toEqual(['██ · ██']);
});
