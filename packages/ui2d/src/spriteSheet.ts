/** A sheet: the rectangles of one texture that each hold a picture, addressed by index or name. */

import type { UvRect } from './spriteBatch.ts';

/** A `UvRect` a caller owns and refills, so reading a frame allocates nothing. */
export interface SpriteFrame {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export function createSpriteFrame(): SpriteFrame {
  return { u0: 0, v0: 0, u1: 1, v1: 1 };
}

/** One entry of an atlas, in texels, as a packer emits it. */
export interface SheetEntry {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The frames of one texture.
 *
 * Two flat arrays and a name index rather than an array of objects: reading a frame in a draw loop
 * is four `Float32Array` reads and no property lookups, and a tilemap does that per tile.
 */
export interface SpriteSheet {
  /** The slot on the pass this sheet's texture was set into. */
  readonly texture: number;
  /** The texture's own size, in texels. */
  readonly width: number;
  readonly height: number;
  readonly count: number;
  /** Four per frame: u0, v0, u1, v1. */
  readonly uvs: Float32Array;
  /** Two per frame: width and height in texels, for drawing a frame at its own scale. */
  readonly sizes: Float32Array;
  readonly names: ReadonlyMap<string, number>;
}

function build(
  texture: number,
  width: number,
  height: number,
  entries: readonly SheetEntry[],
): SpriteSheet {
  const uvs = new Float32Array(entries.length * 4);
  const sizes = new Float32Array(entries.length * 2);
  const names = new Map<string, number>();
  entries.forEach((entry, index) => {
    uvs[index * 4] = entry.x / width;
    uvs[index * 4 + 1] = entry.y / height;
    uvs[index * 4 + 2] = (entry.x + entry.w) / width;
    uvs[index * 4 + 3] = (entry.y + entry.h) / height;
    sizes[index * 2] = entry.w;
    sizes[index * 2 + 1] = entry.h;
    names.set(entry.name, index);
  });
  return { texture, width, height, count: entries.length, uvs, sizes, names };
}

/**
 * A sheet cut into equal cells, row-major: left to right, then down.
 *
 * **A cell that would run off the edge is not emitted.** A sheet 70 texels wide cut into sixteens
 * has four whole cells and six texels of margin, and a fifth cell reading into that margin is a
 * frame with a stripe of nothing down one side — which reads as a rendering bug rather than as a
 * badly measured atlas.
 *
 * Frames are named `"0"`, `"1"` and so on, so `frameOf` works on a grid too.
 */
export function gridSheet(
  texture: number,
  width: number,
  height: number,
  cellWidth: number,
  cellHeight: number,
): SpriteSheet {
  const columns = Math.floor(width / cellWidth);
  const rows = Math.floor(height / cellHeight);
  const entries: SheetEntry[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      entries.push({
        name: String(entries.length),
        x: column * cellWidth,
        y: row * cellHeight,
        w: cellWidth,
        h: cellHeight,
      });
    }
  }
  return build(texture, width, height, entries);
}

/** A sheet from an atlas description: whatever rectangles a packer put where. */
export function namedSheet(
  texture: number,
  width: number,
  height: number,
  entries: readonly SheetEntry[],
): SpriteSheet {
  return build(texture, width, height, entries);
}

/** The index a name has, or `-1`. */
export function frameOf(sheet: SpriteSheet, name: string): number {
  return sheet.names.get(name) ?? -1;
}

/**
 * Read a frame into a rectangle the caller owns. Allocates nothing.
 *
 * **An index this sheet does not have reads as the whole texture rather than throwing**, because
 * this is called per sprite per frame and the rule is that nothing throws in the frame loop. What
 * a caller then sees is the entire atlas drawn where one picture should be, which is unmistakable.
 */
export function sheetFrame(sheet: SpriteSheet, index: number, out: SpriteFrame): UvRect {
  if (index < 0 || index >= sheet.count) {
    out.u0 = 0;
    out.v0 = 0;
    out.u1 = 1;
    out.v1 = 1;
    return out;
  }
  const at = index * 4;
  out.u0 = sheet.uvs[at] as number;
  out.v0 = sheet.uvs[at + 1] as number;
  out.u1 = sheet.uvs[at + 2] as number;
  out.v1 = sheet.uvs[at + 3] as number;
  return out;
}

/** A frame's width in texels, or 0 for an index the sheet does not have. */
export function sheetFrameWidth(sheet: SpriteSheet, index: number): number {
  return index < 0 || index >= sheet.count ? 0 : (sheet.sizes[index * 2] as number);
}

/** A frame's height in texels, or 0 for an index the sheet does not have. */
export function sheetFrameHeight(sheet: SpriteSheet, index: number): number {
  return index < 0 || index >= sheet.count ? 0 : (sheet.sizes[index * 2 + 1] as number);
}
