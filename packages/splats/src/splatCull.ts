/** Whether a capture's own bounding box reaches the frame at all, decided before anything sorts. */

import { multiplyMat4 } from './splatMatrix.ts';

/* Scratch at module scope, so a per-frame visibility test allocates nothing. Safe to share
   between two batches because this is synchronous: no second call runs inside one. */
const viewModel = new Float32Array(16);
const clip = new Float32Array(16);
/** Six planes, four numbers each: a, b, c, d with `a x + b y + c z + d >= 0` inside. */
const planes = new Float32Array(24);

/**
 * Is any part of the box `[boundsMin, boundsMax]` inside the frustum?
 *
 * The box is in the **capture's own space**, which is why this takes the model matrix rather than
 * a world-space box: `SplatData` computes its bounds while the packing loop is open, in whatever
 * frame the capture was authored in, and moving the box every frame would be work to reach the
 * same answer as moving the planes.
 *
 * **Answered before the sort, not after, and that is where the saving is.** Drawing a capture that
 * is out of frame costs one draw call the rasteriser throws away; *sorting* it costs a linear pass
 * over every splat it has, in a worker, for a picture nobody sees. Culling after the sort would
 * save the cheap half.
 *
 * **Conservative: a box that touches the frustum is visible.** The test is whether some plane has
 * the whole box behind it, which is exact for rejection and admits a few boxes near a corner that
 * are outside every plane pairwise but inside none singly. What that costs is a sort for a capture
 * just off the corner of the frame; what would make it wrong is the opposite error, which loses a
 * picture — so the asymmetry is deliberate.
 *
 * `projection` is the caller's own, **before** the backend's clip correction: the planes below are
 * the OpenGL convention that `mat4.perspective` produces, and a corrected matrix has moved z into
 * [0, 1] and flipped y, so the near plane extracted from one would be wrong.
 */
export function splatBoundsVisible(
  view: ArrayLike<number>,
  projection: ArrayLike<number>,
  model: ArrayLike<number>,
  boundsMin: ArrayLike<number>,
  boundsMax: ArrayLike<number>,
): boolean {
  multiplyMat4(viewModel, view, model);
  multiplyMat4(clip, projection, viewModel);

  /*
   * Gribb and Hartmann: the clip-space inequalities `-w <= x <= w` and so on are linear in the
   * object-space point, so each is a plane whose coefficients are a sum or difference of two rows
   * of the matrix. A row of a column-major matrix is every fourth entry, which is why the strides
   * below look transposed.
   */
  for (let axis = 0; axis < 3; axis++) {
    for (let component = 0; component < 4; component++) {
      const w = clip[component * 4 + 3] ?? 0;
      const a = clip[component * 4 + axis] ?? 0;
      /* Two planes per axis: w + a is the low side, w - a the high one. */
      planes[axis * 8 + component] = w + a;
      planes[axis * 8 + 4 + component] = w - a;
    }
  }

  const minX = boundsMin[0] ?? 0;
  const minY = boundsMin[1] ?? 0;
  const minZ = boundsMin[2] ?? 0;
  const maxX = boundsMax[0] ?? 0;
  const maxY = boundsMax[1] ?? 0;
  const maxZ = boundsMax[2] ?? 0;

  for (let plane = 0; plane < 6; plane++) {
    const at = plane * 4;
    const a = planes[at] ?? 0;
    const b = planes[at + 1] ?? 0;
    const c = planes[at + 2] ?? 0;
    const d = planes[at + 3] ?? 0;
    /*
     * The box's corner **furthest along this plane's normal**, picked component by component.
     * Testing that one decides the whole box: if even the corner most in front of the plane is
     * behind it, all eight are — six dot products rather than forty-eight.
     *
     * **The opposite corner is the trap, and it looks equally plausible.** Taking the corner
     * furthest *behind* the plane rejects every box that is partly behind one, which throws away
     * any capture straddling the near plane and any capture the camera is standing inside — the
     * two cases a room-scale capture is made of. Both are asserted in `splatCull.test.ts` for
     * that reason, and both failed on the first writing of this line.
     */
    const x = a >= 0 ? maxX : minX;
    const y = b >= 0 ? maxY : minY;
    const z = c >= 0 ? maxZ : minZ;
    if (a * x + b * y + c * z + d < 0) return false;
  }
  return true;
}
