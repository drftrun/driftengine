import { countCells, forEachCell, measureText, GLYPH_HEIGHT } from '../geometry/pixelFont.ts';
import type { Vec3 } from '../math/color.ts';

/**
 * Where a string becomes cells, for both backends.
 *
 * **Nothing here names a device.** Laying a message out is arithmetic over the pixel font —
 * which cells are lit, how wide the result is, which character each cell belongs to for the
 * arrival stagger — and it produced the same two arrays whichever API was going to upload
 * them. Keeping it in the WebGL2 class meant a second backend would have had to reimplement
 * it, and the rule this repository learned the hard way is that anything both backends decide
 * lives in one module and is bound twice. `waterGrid.ts` and `plumeGeometry.ts` are the same
 * shape.
 *
 * A backend owns the buffers and the pipeline; this owns what goes in them.
 */

/**
 * How many cells one text object may hold.
 *
 * Sized for a long notification rather than a paragraph — this is a display face for short
 * shouted strings, and anything approaching a sentence should be DOM text, which is what a
 * screen reader can read and a translator can translate.
 */
export const MAX_CELLS = 900;

export interface TextStyle {
  /** Pixels per cell. A 5x7 glyph is 5x and 7x this. */
  readonly cellSize: number;
  readonly color: Vec3;
  /** Self-illumination, 0 for matte and ~1 for something that reads as lit. */
  readonly glow: number;
  readonly alpha: number;
  /** 0 to 1 through the arrival animation. */
  readonly reveal: number;
  /** Radians of entry spin. Zero for text that should not tumble in. */
  readonly spin: number;
  /** Extra scale at the moment of arrival. */
  readonly punch: number;
  /** Idle vertical bob, in pixels. */
  readonly bob: number;
  /**
   * Where this piece sits in a longer line, for the arrival stagger.
   *
   * Only needed when one line is drawn as several objects — words around a keycap. Left at
   * the defaults, a piece staggers across itself, which is right for a line drawn in one go.
   */
  readonly charOffset?: number;
  readonly charSpan?: number;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  cellSize: 6,
  charOffset: 0,
  color: [1, 1, 1],
  glow: 0.5,
  alpha: 1,
  reveal: 1,
  spin: 0,
  punch: 0,
  bob: 0,
};

/** Width of a string in pixels at a given cell size, without laying it out. */
export function textWidthPx(text: string, cellSize: number): number {
  return measureText(text) * cellSize;
}

export function textHeightPx(cellSize: number): number {
  return GLYPH_HEIGHT * cellSize;
}

/**
 * The cell size to draw at, so every cell of a bitmap glyph covers whole device pixels.
 *
 * **A 5x7 face draws every stroke exactly one cell wide, so a fractional cell is not a slightly
 * softer glyph — it is a glyph whose strokes are different widths.** The rasteriser gives one
 * column of cells four pixels and the next three, and a face carrying its legibility entirely in
 * uniform strokes comes apart. Reported three times as text "eaten away" in a checkerboard while
 * larger text in the same frame stayed solid, which is the size dependence this explains: a whole
 * cell is uniform and a fractional one is not, and nothing about it is a dropped pixel.
 *
 * Two doors reach a fractional cell, which is why it was reported as unrelated faults. A caller
 * asks for one outright, sizing a second line at a fraction of its headline; or asks for a whole
 * one that the device ratio makes fractional, a 3-pixel cell at a 1.25 ratio being 3.75 on the
 * grid. `viewportWidth` is whatever units the caller lays out in — CSS pixels for an overlay
 * sized from `cssWidth`, device pixels for one sized from the canvas — and `bufferWidth` is the
 * drawing buffer, so the ratio between them is exactly what turns one into the other.
 *
 * **What it gives up is the asked size.** The cell drawn is the largest whole number of device
 * pixels that is not larger than the one asked for, so a string is drawn up to one device pixel
 * per cell narrower than `textWidthPx` measures it. Down rather than to nearest, because a caller
 * that fitted a line to a box measured it first: rounding up would draw a line wider than the box
 * it was fitted to, and rounding down can only leave a gap.
 *
 * **`textWidthPx` and `RendererApi.textWidth` are deliberately left unsnapped**, and that is the
 * cost rather than an oversight. Neither is handed a viewport, so neither can know whether the
 * caller lays out in CSS pixels or device ones — and this ratio is exactly that question. A width
 * is therefore an upper bound on what is drawn: a centred line sits up to half the shortfall off
 * centre, at most half a device pixel per cell. Handing the measurement a viewport would fix it
 * and is a change to the public surface rather than to a patch.
 *
 * **What would make it wrong** is a face whose strokes are not cell-aligned — an SDF atlas, where
 * the glyph is a distance field and a fractional size is exactly what it is built to serve.
 * `sdfTextLayout.ts` is that path and does not come through here.
 */
export function deviceSnappedCellSize(
  cellSize: number,
  viewportWidth: number,
  bufferWidth: number,
): number {
  const ratio = bufferWidth / viewportWidth;
  if (!Number.isFinite(ratio) || ratio <= 0) return cellSize;
  const device = cellSize * ratio;
  if (!Number.isFinite(device)) return cellSize;
  /*
   * The tolerance is against float error rather than a fudge: a ratio of 1 turns an asked 4 into
   * 3.9999999999999996 often enough, and flooring that would shrink every whole cell on every
   * ordinary display by a pixel — the change doing most harm where there was nothing to fix.
   */
  const whole = Math.floor(device + 1e-6);
  /* Below one device pixel there is no whole size to snap to, and flooring would draw nothing. */
  if (whole < 1) return cellSize;
  return whole / ratio;
}

/**
 * The same grid's **phase**, which is the other half of the same defect.
 *
 * **A whole pitch on a fractional origin still draws strokes of two widths.** Snapping the cell to
 * four device pixels puts the boundaries four apart, and starting them at 10.4 puts every boundary
 * at `.4` — so each stroke covers three whole pixels and two halves, and the rasteriser resolves
 * that the same ragged way it resolved a fractional cell. The pitch decides how far apart the
 * boundaries are; this decides where the first one is, and a face of uniform strokes needs both.
 *
 * It was found the way the first half was: the cell snap shipped, and the reporter said the text was
 * still wrong.
 *
 * **To nearest rather than down**, which is the opposite of the cell above and for the opposite
 * reason: this is a position, not a size. Moving a label up to half a device pixel is the smallest
 * change that puts its grid on the display's, while flooring would shift every label the same way
 * and bias a centred one off centre.
 *
 * **What would make it wrong** is a caller animating an origin sub-pixel on purpose — a label that
 * slides smoothly now steps by a device pixel. For a face whose strokes are one pixel wide that is
 * the trade this whole function exists to make, and `sdfTextLayout.ts`, which does not come through
 * here, is the path for anything that wants the other answer.
 */
export function deviceSnappedOrigin(
  value: number,
  viewportWidth: number,
  bufferWidth: number,
): number {
  const ratio = bufferWidth / viewportWidth;
  if (!Number.isFinite(ratio) || ratio <= 0) return value;
  const device = value * ratio;
  if (!Number.isFinite(device)) return value;
  return Math.round(device) / ratio;
}

export class TextLayout {
  /** Reused every upload; text changes far too often to allocate per change. */
  readonly cells = new Float32Array(MAX_CELLS * 2);
  readonly chars = new Float32Array(MAX_CELLS);
  instanceCount = 0;
  /** Characters in the current content, for the per-character stagger. */
  charCount = 1;

  private lastKey = '';
  private widthCells = 0;

  /** Width of the last laid-out string, in pixels at a given cell size. */
  widthPx(cellSize: number): number {
    return this.widthCells * cellSize;
  }

  /**
   * Lay a string out, and say whether anything moved.
   *
   * **The return value is the whole point of the skip.** Most frames show the same message as
   * the frame before, and re-uploading a buffer to say so is the sort of cost that only shows
   * up on a phone. The arrays are reused in place, so a caller has no other way to tell.
   */
  setText(text: string): boolean {
    if (text === this.lastKey) return false;
    this.lastKey = text;
    this.widthCells = measureText(text);

    /*
     * Truncate rather than throw: a frame with a clipped message is better than a frame that
     * does not render, and this is a display face being handed runtime strings.
     */
    if (countCells(text) > MAX_CELLS) this.instanceCount = 0;

    let index = 0;
    forEachCell(text, (x, y, charIndex) => {
      if (index >= MAX_CELLS) return;
      this.cells[index * 2] = x;
      this.cells[index * 2 + 1] = y;
      this.chars[index] = charIndex;
      index++;
    });
    this.instanceCount = index;
    this.charCount = Math.max(1, text.length);
    return true;
  }

  /**
   * A solid rectangle of cells, for a keycap or a backing plate.
   *
   * Not text. A run of block glyphs looks like the same thing and is not: glyphs are spaced a
   * cell apart, so the "plate" comes out striped and sized in whole glyph widths rather than
   * in cells — which is exactly how the first keycap ended up wider than the word it was
   * behind.
   *
   * `bottomCell` is where the rectangle starts vertically, in the same baseline-relative cells
   * the glyphs use, so -1 gives a cell of padding below.
   */
  setPlate(widthCells: number, heightCells: number, bottomCell: number): boolean {
    const key = `plate:${widthCells}:${heightCells}:${bottomCell}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    this.widthCells = widthCells;

    let index = 0;
    for (let x = 0; x < widthCells && index < MAX_CELLS; x++) {
      for (let y = 0; y < heightCells && index < MAX_CELLS; y++) {
        this.cells[index * 2] = x;
        this.cells[index * 2 + 1] = bottomCell + y;
        /*
         * One "character", so a plate arrives as a single unit rather than assembling column
         * by column behind the word it belongs to.
         */
        this.chars[index] = 0;
        index++;
      }
    }
    this.instanceCount = index;
    this.charCount = 1;
    return true;
  }
}

/** A unit cube centred on the origin: six faces, two triangles each. */
function buildCube(): { positions: Float32Array; normals: Float32Array; vertexCount: number } {
  const faces: { normal: Vec3; corners: readonly Vec3[] }[] = [
    {
      normal: [0, 0, 1],
      corners: [
        [-1, -1, 1],
        [1, -1, 1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
    },
    {
      normal: [0, 0, -1],
      corners: [
        [1, -1, -1],
        [-1, -1, -1],
        [-1, 1, -1],
        [1, 1, -1],
      ],
    },
    {
      normal: [1, 0, 0],
      corners: [
        [1, -1, 1],
        [1, -1, -1],
        [1, 1, -1],
        [1, 1, 1],
      ],
    },
    {
      normal: [-1, 0, 0],
      corners: [
        [-1, -1, -1],
        [-1, -1, 1],
        [-1, 1, 1],
        [-1, 1, -1],
      ],
    },
    {
      normal: [0, 1, 0],
      corners: [
        [-1, 1, 1],
        [1, 1, 1],
        [1, 1, -1],
        [-1, 1, -1],
      ],
    },
    {
      normal: [0, -1, 0],
      corners: [
        [-1, -1, -1],
        [1, -1, -1],
        [1, -1, 1],
        [-1, -1, 1],
      ],
    },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  for (const face of faces) {
    const [a, b, c, d] = face.corners as [Vec3, Vec3, Vec3, Vec3];
    /*
     * **Wound the usual way, and it was wound backwards on purpose until 2026-09-16.**
     *
     * The comment that stood here said the vertex shader's Y flip mirrors the winding, so faces
     * authored the usual way "come out back-facing and every one of them is culled". Measured on
     * both backends, that is not what happens: with the usual winding both draw solid glyphs, and
     * with the reversed one **WebGL2 draws a one-pixel sliver of every cell** while WebGPU draws
     * them solid. The text on the default backend has been a dotted outline of itself.
     *
     * It survived because it is legible. A reader sees letters; only a capture beside the other
     * backend says the cells are hollow, and `demo/dev/overlay.html` is where that comparison is
     * cheap — 7,678 lit pixels against 14,982 for the same string.
     */
    for (const corner of [a, b, c, a, c, d]) {
      positions.push(corner[0], corner[1], corner[2]);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    vertexCount: positions.length / 3,
  };
}

/** Unit cube, as position/normal pairs. Two triangles per face. Built once, shared by both. */
export const TEXT_CUBE = buildCube();
