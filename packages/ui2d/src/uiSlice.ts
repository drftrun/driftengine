/**
 * A panel background that stretches without stretching its corners.
 *
 * Nine cells: the four corners keep their source size, the four edges stretch along one axis, and
 * the middle stretches along both. Written into a caller's array as
 * `x, y, w, h, u0, v0, u1, v1` per cell, in row-major order — top-left, top, top-right, left,
 * middle, right, bottom-left, bottom, bottom-right — so the middle is always index 4.
 *
 * **A box narrower than its own insets scales them down rather than letting them overlap.**
 * Overlapping corners draw the same alpha twice, which on a translucent panel is a visible seam
 * exactly where the design was trying to be careful.
 *
 * **The source size is a parameter because `SpriteFrame` carries only texture coordinates.** The
 * insets are in texels, so splitting the frame needs to know what the frame's texels span.
 */
import type { SpriteFrame } from './spriteSheet.ts';

/** Floats per placement: x, y, w, h, u0, v0, u1, v1. */
export const SLICE_STRIDE = 8;

export interface SliceInset {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function sliceInto(
  out: Float32Array,
  frame: SpriteFrame,
  sourceWidth: number,
  sourceHeight: number,
  inset: SliceInset,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  /*
   * Scaled down together when the box cannot hold both, so the two corners meet exactly at the
   * midpoint instead of overlapping. The texture coordinates are deliberately *not* scaled with
   * them: the corner draws a smaller piece of the box out of the same piece of the source, which
   * is squashing rather than seaming and is the better of the two wrong pictures available.
   */
  const sideX = inset.left + inset.right;
  const kx = sideX > w && sideX > 0 ? w / sideX : 1;
  const left = inset.left * kx;
  const right = inset.right * kx;

  const sideY = inset.top + inset.bottom;
  const ky = sideY > h && sideY > 0 ? h / sideY : 1;
  const top = inset.top * ky;
  const bottom = inset.bottom * ky;

  const colX = [x, x + left, x + w - right];
  const colW = [left, Math.max(0, w - left - right), right];
  const rowY = [y, y + top, y + h - bottom];
  const rowH = [top, Math.max(0, h - top - bottom), bottom];

  const du = frame.u1 - frame.u0;
  const dv = frame.v1 - frame.v0;
  const uAt = [
    frame.u0,
    frame.u0 + (inset.left / sourceWidth) * du,
    frame.u1 - (inset.right / sourceWidth) * du,
    frame.u1,
  ];
  const vAt = [
    frame.v0,
    frame.v0 + (inset.top / sourceHeight) * dv,
    frame.v1 - (inset.bottom / sourceHeight) * dv,
    frame.v1,
  ];

  let at = 0;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[at] = colX[c] as number;
      out[at + 1] = rowY[r] as number;
      out[at + 2] = colW[c] as number;
      out[at + 3] = rowH[r] as number;
      out[at + 4] = uAt[c] as number;
      out[at + 5] = vAt[r] as number;
      out[at + 6] = uAt[c + 1] as number;
      out[at + 7] = vAt[r + 1] as number;
      at += SLICE_STRIDE;
    }
  }
  return 9;
}
