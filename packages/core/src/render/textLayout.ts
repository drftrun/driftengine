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
     * Wound clockwise, which is backwards — deliberately. The vertex shader flips Y to put the
     * origin at the top left, and a mirror reverses winding, so faces authored the usual way
     * come out back-facing and every one of them is culled. The symptom is text that renders
     * with no GL error and no pixels, which is a genuinely difficult thing to look at and
     * diagnose.
     */
    for (const corner of [a, c, b, a, d, c]) {
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
