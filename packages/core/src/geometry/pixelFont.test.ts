import { expect, test } from 'vitest';
import {
  GLYPH_HEIGHT,
  GLYPH_SPACING,
  GLYPH_WIDTH,
  countCells,
  forEachCell,
  glyphRows,
  hasGlyph,
  measureText,
} from './pixelFont.ts';

test('every glyph fits the grid it claims to be on', () => {
  /*
   * A bitmask is easy to typo one bit too wide, and the failure is silent: the
   * extra column lands on the next character and the whole line looks subtly
   * smeared without any one letter looking wrong.
   */
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:!?-+/()%';
  for (const character of characters) {
    const rows = glyphRows(character);
    expect(rows.length, `${character} row count`).toBe(GLYPH_HEIGHT);
    for (const row of rows) {
      expect(row, `${character} row width`).toBeLessThan(1 << GLYPH_WIDTH);
      expect(row).toBeGreaterThanOrEqual(0);
    }
  }
});

test('every letter and digit is actually drawn', () => {
  // An all-zero glyph renders as a space, so a forgotten one is invisible
  // rather than obviously missing — the worst way for a font to be incomplete.
  for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
    expect(countCells(character), `${character} has ink`).toBeGreaterThan(3);
  }
});

test('an unknown character shows a box rather than vanishing', () => {
  // Copy will drift ahead of the font. A visible box in a notification is a bug
  // report; a silent gap is a mystery nobody files.
  expect(hasGlyph('€')).toBe(false);
  expect(countCells('€')).toBeGreaterThan(0);
});

test('lower case is folded, not dropped', () => {
  expect(countCells('best')).toBe(countCells('BEST'));
});

test('width matches what is actually laid out', () => {
  /*
   * Centring reads this number and the renderer reads the cells. If they
   * disagree every message is off-centre by a few pixels, which looks like
   * carelessness rather than a bug and so never gets fixed.
   */
  for (const text of ['A', 'HI', 'RUIN FOUND', '12.34S']) {
    let rightmost = -1;
    forEachCell(text, (x) => {
      rightmost = Math.max(rightmost, x);
    });
    expect(measureText(text), text).toBeGreaterThanOrEqual(rightmost + 1);
    expect(measureText(text), text).toBe(
      text.length * (GLYPH_WIDTH + GLYPH_SPACING) - GLYPH_SPACING,
    );
  }
});

test('cells sit inside the glyph box, with y up', () => {
  // The rest of the engine has y up; a font authored top-down and not flipped
  // renders every message upside down, which is obvious — but the off-by-one
  // that leaves it one row low is not.
  let lowest = Infinity;
  let highest = -Infinity;
  forEachCell('E', (x, y) => {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(GLYPH_WIDTH);
    lowest = Math.min(lowest, y);
    highest = Math.max(highest, y);
  });
  expect(lowest).toBe(0);
  expect(highest).toBe(GLYPH_HEIGHT - 1);
});

test('characters are reported in reading order', () => {
  // Per-character animation staggers on this index. Out of order, a message
  // would assemble itself from the middle outwards.
  const seen: number[] = [];
  forEachCell('ABC', (_x, _y, charIndex) => {
    if (seen[seen.length - 1] !== charIndex) seen.push(charIndex);
  });
  expect(seen).toEqual([0, 1, 2]);
});

test('an empty string measures and draws nothing', () => {
  expect(measureText('')).toBe(0);
  expect(countCells('')).toBe(0);
});
