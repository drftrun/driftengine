/**
 * Text as static world geometry: one box per lit glyph cell.
 *
 * The screen-space `TextRenderer` exists because a grid of cells gives you
 * *boxes to light* rather than outlines to rasterise. This is the same idea
 * standing in the world instead of over it — a string that a consumer can merge
 * into its static mesh, place on a surface's own basis, and light with
 * everything else. No draw call of its own, no atlas, no font file.
 *
 * Laid out in a local frame: x to the right, y up from the baseline, z the
 * depth the cells stand out through. The caller supplies the basis that turns
 * that into a place in the world (`MeshBuilder.addOrientedMesh`), which is what
 * lets a line of text bank with a road or face back along a curve.
 */

import { GLYPH_HEIGHT, forEachRun, measureText } from './pixelFont.ts';
import { MeshBuilder } from './meshBuilder.ts';
import type { MeshData } from '../render/mesh.ts';
import type { Vec3 } from '../math/color.ts';

export interface TextMeshStyle {
  /** World size of one glyph cell. A glyph is five of these across, seven tall. */
  cellSizeM: number;
  /**
   * Cell height, where it differs from the width. Defaults to square.
   *
   * For text read at a shallow angle: a word laid flat on the ground is
   * foreshortened along the direction it is read from, and stretching the cells
   * that way is what road markings have always done about it. It is a property
   * of the *viewing* rather than of the font, which is why it belongs to a style
   * and not to the glyph table.
   */
  cellHeightM?: number;
  color: Vec3;
  /**
   * Depth through the plane, world units. Defaults to the cell size, which
   * gives cubes — the shape the flat-shaded look is built out of, and the one
   * that catches a light from the side rather than going flat as the sun moves.
   */
  depthM?: number;
  emissive?: number;
  /**
   * Where the origin sits horizontally. Centred by default: a marker is aimed
   * at a place, and left-aligning it would move the thing being marked whenever
   * the string changed length.
   */
  align?: 'left' | 'center';
  /** Where the origin sits vertically: on the baseline, or at the middle. */
  baseline?: 'bottom' | 'center';
}

/** Width of a string in world units, before the basis is applied. */
export function textMeshWidthM(text: string, cellSizeM: number): number {
  return measureText(text) * cellSizeM;
}

/** Height of a line in world units. Every glyph is the same seven cells tall. */
export function textMeshHeightM(cellSizeM: number): number {
  return GLYPH_HEIGHT * cellSizeM;
}

export function buildTextMesh(text: string, style: TextMeshStyle): MeshData {
  if (style.cellSizeM <= 0) {
    throw new Error(`buildTextMesh needs a positive cell size, got ${style.cellSizeM}`);
  }

  const cell = style.cellSizeM;
  const cellHigh = style.cellHeightM ?? cell;
  const depth = style.depthM ?? cell;
  const emissive = style.emissive ?? 0;
  const half: Vec3 = [cell * 0.5, cellHigh * 0.5, depth * 0.5];
  const offsetX = style.align === 'left' ? 0 : -textMeshWidthM(text, cell) * 0.5;
  const offsetY = style.baseline === 'center' ? -textMeshHeightM(cellHigh) * 0.5 : 0;

  const builder = new MeshBuilder();
  const centre: Vec3 = [0, 0, 0];
  const extent: Vec3 = [0, half[1], half[2]];
  /*
   * **One box per horizontal run, not per lit cell.** The two produce the same outer surface — a
   * run of three cells and the box that spans them have identical outsides, and what goes is the
   * interior faces between them, which nothing can ever see. Measured against a consumer's own
   * 1,168 strings, it takes 65,271 boxes to 42,631: **1.53x**, for a change that is invisible.
   *
   * `half[0]` grows with the run and the other two do not, which is why the extent is rebuilt here
   * rather than reusing `half`.
   */
  forEachRun(text, (x, y, width) => {
    // Cell coordinates address a cell's corner; a box is placed by its centre.
    extent[0] = width * cell * 0.5;
    centre[0] = offsetX + (x + width * 0.5) * cell;
    centre[1] = offsetY + (y + 0.5) * cellHigh;
    centre[2] = 0;
    builder.addBox(centre, extent, style.color, emissive);
  });
  return builder.build();
}
