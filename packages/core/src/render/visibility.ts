import type { ReadonlyMat4 } from 'gl-matrix';

import type { Bounds } from '../math/bounds.ts';
import { sphereInFrustum } from '../math/frustum.ts';
import type { Frustum } from '../math/frustum.ts';

/**
 * Whether a mesh placed by a model matrix is anywhere inside a frustum.
 *
 * Shared by both backends rather than written twice, for the reason the resource table is: two
 * copies of a decision are two chances to answer it differently, and a culling disagreement
 * between backends is an object that is present on one and missing on the other.
 *
 * **Scale is the trap, and it is why this is not two lines at each call site.** A bounding sphere
 * put through a scaling matrix is a sphere of a different size, so the world radius is the local
 * radius times the *largest* of the three axis scales. Taking the average, or the x scale, or
 * forgetting entirely, culls an enlarged object while it is plainly on screen — and the failure
 * looks like a threshold to tune rather than a factor that is missing.
 *
 * Non-uniform scale makes the transformed shape an ellipsoid, and the largest axis is the sphere
 * that contains it. Conservative, which is the only direction a cull may err in.
 *
 * Allocates nothing.
 */
export function boundsVisible(frustum: Frustum, bounds: Bounds, model: ReadonlyMat4): boolean {
  const cx = bounds.centre[0] ?? 0;
  const cy = bounds.centre[1] ?? 0;
  const cz = bounds.centre[2] ?? 0;

  /* The centre through the model matrix. Column-major, so a column is four consecutive entries. */
  const m0 = model[0] ?? 0;
  const m1 = model[1] ?? 0;
  const m2 = model[2] ?? 0;
  const m4 = model[4] ?? 0;
  const m5 = model[5] ?? 0;
  const m6 = model[6] ?? 0;
  const m8 = model[8] ?? 0;
  const m9 = model[9] ?? 0;
  const m10 = model[10] ?? 0;

  const x = m0 * cx + m4 * cy + m8 * cz + (model[12] ?? 0);
  const y = m1 * cx + m5 * cy + m9 * cz + (model[13] ?? 0);
  const z = m2 * cx + m6 * cy + m10 * cz + (model[14] ?? 0);

  /*
   * The length of each basis vector is that axis' scale, rotation included: a rotation preserves
   * length, so this reads the scale out of a matrix that also rotates without having to
   * decompose it.
   */
  const sx = Math.sqrt(m0 * m0 + m1 * m1 + m2 * m2);
  const sy = Math.sqrt(m4 * m4 + m5 * m5 + m6 * m6);
  const sz = Math.sqrt(m8 * m8 + m9 * m9 + m10 * m10);
  const radius = bounds.radius * Math.max(sx, sy, sz);

  return sphereInFrustum(frustum, x, y, z, radius);
}
