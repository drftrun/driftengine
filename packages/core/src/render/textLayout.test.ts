import { describe, expect, it } from 'vitest';

import { GLYPH_HEIGHT } from '../geometry/pixelFont.ts';
import { TextLayout, textHeightPx, textWidthPx } from './textLayout.ts';

describe('the text layout', () => {
  /* The cells are what a backend uploads; the count is what it instances over. */
  it('lays a string out as one instance per lit cell', () => {
    const layout = new TextLayout();

    layout.setText('A');

    expect(layout.instanceCount).toBeGreaterThan(0);
    expect(layout.widthPx(1)).toBe(textWidthPx('A', 1));
  });

  /**
   * **The upload is the expensive half, and most frames show the same string.**
   * `setText` returning whether anything moved is what lets both backends skip it,
   * and it is the only signal they have — the arrays are reused in place.
   */
  it('reports no change when the string is the one already laid out', () => {
    const layout = new TextLayout();

    expect(layout.setText('SAME')).toBe(true);
    expect(layout.setText('SAME')).toBe(false);
    expect(layout.setText('OTHER')).toBe(true);
  });

  /**
   * A plate is not a run of block glyphs: glyphs are spaced a cell apart, so a plate
   * built from them comes out striped and sized in whole glyph widths. This is the
   * bug that made the first keycap wider than the word behind it.
   */
  it('fills a plate solid, one cell at a time', () => {
    const layout = new TextLayout();

    layout.setPlate(3, 2, -1);

    expect(layout.instanceCount).toBe(6);
    /* Every cell of the rectangle, and the bottom row sits where it was asked to. */
    const ys = new Set<number>();
    for (let i = 0; i < layout.instanceCount; i++) ys.add(layout.cells[i * 2 + 1] as number);
    expect([...ys].sort()).toEqual([-1, 0]);
  });

  /* A plate arrives as one unit rather than assembling column by column. */
  it('gives a plate a single character, so it does not stagger across itself', () => {
    const layout = new TextLayout();

    layout.setPlate(4, 2, 0);

    expect(layout.charCount).toBe(1);
  });

  /* Same key, same rectangle: a plate redrawn every frame must not re-upload. */
  it('reports no change when the plate is the one already laid out', () => {
    const layout = new TextLayout();

    expect(layout.setPlate(3, 2, 0)).toBe(true);
    expect(layout.setPlate(3, 2, 0)).toBe(false);
    expect(layout.setPlate(3, 2, 1)).toBe(true);
  });

  /**
   * **Truncated rather than thrown.** A display face is handed runtime strings, and a
   * frame with a clipped message beats a frame that does not render.
   */
  it('truncates a string past its cell ceiling instead of throwing', () => {
    const layout = new TextLayout();

    expect(() => layout.setText('M'.repeat(4000))).not.toThrow();
    expect(layout.instanceCount).toBeLessThanOrEqual(layout.cells.length / 2);
  });

  it('measures the font without needing a layout at all', () => {
    expect(textHeightPx(3)).toBe(GLYPH_HEIGHT * 3);
    expect(textWidthPx('AB', 2)).toBeGreaterThan(textWidthPx('A', 2));
  });
});
