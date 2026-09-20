import { describe, expect, it, test } from 'vitest';

import { GLYPH_HEIGHT } from '../geometry/pixelFont.ts';
import {
  TEXT_CUBE,
  TextLayout,
  deviceSnappedCellSize,
  textHeightPx,
  textWidthPx,
} from './textLayout.ts';

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

test('EVERY FACE OF THE TEXT CUBE IS WOUND SO ITS GEOMETRIC NORMAL IS THE ONE IT DECLARES', () => {
  /*
   * **The cube was wound backwards on purpose until 2026-09-16, and nothing checked it.** The
   * comment said the vertex shader's Y flip mirrors the winding so faces authored the usual way
   * are all culled; measured on both backends, the opposite holds — the usual winding draws solid
   * glyphs on each, and the reversed one drew a **one-pixel sliver of every cell on WebGL2** while
   * WebGPU drew them solid. The text on the default backend was a dotted outline of itself, and it
   * survived because it is still legible.
   *
   * Each triangle carries the normal of the face it belongs to, so the invariant needs nothing
   * external: the cross product of a triangle's own edges must point the way its own normal does.
   * A cube wound the other way fails every one of its twelve triangles.
   */
  const { positions, normals, vertexCount } = TEXT_CUBE;
  expect(vertexCount).toBe(36);
  for (let triangle = 0; triangle < vertexCount / 3; triangle += 1) {
    const at = triangle * 9;
    const ux = (positions[at + 3] as number) - (positions[at] as number);
    const uy = (positions[at + 4] as number) - (positions[at + 1] as number);
    const uz = (positions[at + 5] as number) - (positions[at + 2] as number);
    const vx = (positions[at + 6] as number) - (positions[at] as number);
    const vy = (positions[at + 7] as number) - (positions[at + 1] as number);
    const vz = (positions[at + 8] as number) - (positions[at + 2] as number);
    const geometric = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const declared = [normals[at] as number, normals[at + 1] as number, normals[at + 2] as number];
    const agreement =
      (geometric[0] as number) * (declared[0] as number) +
      (geometric[1] as number) * (declared[1] as number) +
      (geometric[2] as number) * (declared[2] as number);
    expect(agreement, `triangle ${triangle} faces away from the normal it carries`).toBeGreaterThan(
      0,
    );
  }
});

/**
 * A BITMAP GLYPH'S CELLS LAND ON WHOLE DEVICE PIXELS.
 *
 * **Reported from two consumers and this repository's own voxel sandbox**, as glyphs "eaten
 * away" in a regular checkerboard while larger text in the same frame stayed solid. Nothing was
 * being dropped: a 5x7 face draws every stroke one cell wide, so when a cell is a fractional
 * number of device pixels the rasteriser gives some strokes four pixels and the next three, and
 * a face whose whole legibility is uniform strokes comes apart. Measured on
 * `demo/dev/overlay.html`: at a cell of 4.00 every stroke is four pixels, and at 3.75 the same
 * string draws strokes of three and four with 18% more lit pixels than the larger cell.
 *
 * Two doors reach the same state, which is why it was reported as two unrelated faults. A
 * caller may ask for a fractional cell outright — a consumer sizing a second line at 0.52 of
 * its headline asks for 4.68 — or ask for a whole one that a device ratio makes fractional, a
 * 3-pixel cell at a 1.25 ratio being 3.75 device pixels.
 */
test('A CELL IS A WHOLE NUMBER OF DEVICE PIXELS WHATEVER THE CALLER ASKS FOR', () => {
  /* The size a consumer asks for when it sizes one line off another, at a ratio of 1. */
  expect(deviceSnappedCellSize(4.68, 1280, 1280)).toBe(4);
  /* Three CSS pixels on a 1.25 device ratio: whole to the caller, 3.75 on the grid. */
  expect(deviceSnappedCellSize(3, 1280, 1600) * (1600 / 1280)).toBe(3);

  /* The property itself, rather than the two cases above: whatever is asked, the cell the
     shader is handed covers a whole number of device pixels. */
  for (const ratio of [1, 1.25, 1.5, 2, 2.5, 3]) {
    for (const asked of [3, 3.5, 4.68, 5, 6.25, 9, 11.4]) {
      const snapped = deviceSnappedCellSize(asked, 1280, 1280 * ratio);
      const device = snapped * ratio;
      expect(
        Math.abs(device - Math.round(device)),
        `asked ${asked} at ratio ${ratio} draws a cell of ${device} device pixels`,
      ).toBeLessThan(1e-6);
      /* Never larger than asked, so a line a caller fitted to a box cannot overflow it. */
      expect(snapped).toBeLessThanOrEqual(asked);
    }
  }
});

/**
 * **A cell below one device pixel has no whole size to snap to**, and flooring it would be a
 * line of text that vanishes rather than one that is slightly ragged. It passes through.
 * A degenerate viewport or buffer does the same: this runs in the frame loop, where the honest
 * answer to a number that makes no sense is the caller's own.
 */
test('A SUB-PIXEL CELL AND A DEGENERATE RATIO PASS THROUGH UNCHANGED', () => {
  expect(deviceSnappedCellSize(0.6, 1280, 1280)).toBe(0.6);
  expect(deviceSnappedCellSize(4, 0, 1280)).toBe(4);
  expect(deviceSnappedCellSize(4, 1280, 0)).toBe(4);
  expect(deviceSnappedCellSize(4, 1280, Number.NaN)).toBe(4);
});
