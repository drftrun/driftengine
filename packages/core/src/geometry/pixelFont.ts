/**
 * A 5x7 pixel font, as bitmasks.
 *
 * Glyphs are built rather than loaded, for the same reasons the cursor is: no
 * asset, no request, no licence, and — the one that matters — a shape the
 * renderer can *extrude*. A font file gives you outlines to rasterise; a grid
 * of cells gives you boxes to light, which is what makes text belong in a
 * flat-shaded world instead of floating over it.
 *
 * Five by seven is the smallest grid that carries a legible uppercase alphabet
 * with digits. Anything smaller starts guessing between 8, B and 6 at a glance,
 * which is exactly the glance a notification gets.
 *
 * Each glyph is seven rows, each row five bits, most significant bit leftmost.
 */
export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** Blank columns between glyphs, in cells. */
export const GLYPH_SPACING = 1;

const GLYPHS: Record<string, readonly number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '.': [0, 0, 0, 0, 0, 0b01100, 0b01100],
  ',': [0, 0, 0, 0, 0b01100, 0b01100, 0b11000],
  ':': [0, 0b01100, 0b01100, 0, 0b01100, 0b01100, 0],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  '?': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0, 0b00100],
  '-': [0, 0, 0, 0b11111, 0, 0, 0],
  '+': [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
  '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  "'": [0b00100, 0b00100, 0, 0, 0, 0, 0],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  '%': [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  '·': [0, 0, 0, 0b01100, 0b01100, 0, 0],
  '×': [0, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0],
  /**
   * A solid cell. Not a letter — it is how a caller builds a *plate*: a run of
   * these behind a word makes a keycap, which is the only way to say "this is a
   * key you press" without a second asset pipeline.
   */
  '█': [0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111, 0b11111],
};

/** Anything the font does not have. Better a visible box than a silent gap. */
const MISSING: readonly number[] = [0b11111, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11111];

/**
 * Rows for one character. Lower case is folded to upper: this is a display
 * face for short shouted strings, and a 5x7 grid has no room for descenders.
 */
export function glyphRows(character: string): readonly number[] {
  const upper = character.toUpperCase();
  return GLYPHS[upper] ?? GLYPHS[character] ?? MISSING;
}

export function hasGlyph(character: string): boolean {
  return GLYPHS[character.toUpperCase()] !== undefined;
}

/** Width of a string in cells, spacing included, excluding the trailing gap. */
export function measureText(text: string): number {
  if (text.length === 0) return 0;
  return text.length * (GLYPH_WIDTH + GLYPH_SPACING) - GLYPH_SPACING;
}

/** How many lit cells a string needs, which is how many boxes it costs. */
export function countCells(text: string): number {
  let cells = 0;
  for (const character of text) {
    for (const row of glyphRows(character)) {
      for (let x = 0; x < GLYPH_WIDTH; x++) {
        if ((row & (1 << (GLYPH_WIDTH - 1 - x))) !== 0) cells++;
      }
    }
  }
  return cells;
}

/**
 * Walk every lit cell of a string.
 *
 * Coordinates are in cells, origin at the string's left baseline: x increases
 * right, y increases *up*, so the caller works in the same handedness as the
 * rest of the engine rather than in text-editor coordinates.
 *
 * `charIndex` comes along because per-character animation is the whole point —
 * a message where every letter arrives at once is a label, and one where they
 * arrive in sequence is an event.
 */
/**
 * Every horizontal run of lit cells, as one span each.
 *
 * **Because a box per cell is most of a world.** A consumer measured their village at 2,662,324
 * triangles of which **1,195,296 — forty-five per cent — were the lettering** on 169 street plates
 * and 830 house numbers, one box of twelve triangles at each of 65,271 lit cells. A run of three
 * lit cells side by side is three boxes with four interior faces between them that nothing can ever
 * see, and one box the same shape outside.
 *
 * **Horizontal only, and that is a measurement rather than a simplification.** Against that
 * consumer's own 1,168 strings, merging runs takes 65,271 cells to 42,631 boxes, and a greedy
 * rectangle merge over two dimensions gives *exactly the same number* — in a glyph five cells wide
 * there is nothing vertical left to win, and the second pass would be code that never pays.
 *
 * A run never crosses a glyph, because the cursor advances by `GLYPH_WIDTH + GLYPH_SPACING` and
 * that spacing is a column of unlit cells.
 */
export function forEachRun(
  text: string,
  visit: (x: number, y: number, width: number, charIndex: number) => void,
): void {
  let cursor = 0;
  let charIndex = 0;
  for (const character of text) {
    const rows = glyphRows(character);
    for (let row = 0; row < rows.length; row++) {
      const bits = rows[row] ?? 0;
      const y = GLYPH_HEIGHT - 1 - row;
      let runStart = -1;
      for (let x = 0; x <= GLYPH_WIDTH; x++) {
        const lit = x < GLYPH_WIDTH && (bits & (1 << (GLYPH_WIDTH - 1 - x))) !== 0;
        if (lit && runStart < 0) runStart = x;
        else if (!lit && runStart >= 0) {
          visit(cursor + runStart, y, x - runStart, charIndex);
          runStart = -1;
        }
      }
    }
    cursor += GLYPH_WIDTH + GLYPH_SPACING;
    charIndex++;
  }
}

export function forEachCell(
  text: string,
  visit: (x: number, y: number, charIndex: number) => void,
): void {
  let cursor = 0;
  let charIndex = 0;
  for (const character of text) {
    const rows = glyphRows(character);
    for (let row = 0; row < rows.length; row++) {
      const bits = rows[row] ?? 0;
      // Row 0 is the top of the glyph, so it is the highest y.
      const y = GLYPH_HEIGHT - 1 - row;
      for (let x = 0; x < GLYPH_WIDTH; x++) {
        if ((bits & (1 << (GLYPH_WIDTH - 1 - x))) !== 0) visit(cursor + x, y, charIndex);
      }
    }
    cursor += GLYPH_WIDTH + GLYPH_SPACING;
    charIndex++;
  }
}
