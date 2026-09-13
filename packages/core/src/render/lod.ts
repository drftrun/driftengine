import type { ReadonlyMat4 } from 'gl-matrix';

import type { Bounds } from '../math/bounds.ts';

/**
 * Which level of detail a piece of geometry has earned, from how big it looks.
 *
 * **Apparent size and not distance, and the difference is the whole of it.** Thresholds in metres
 * make a cathedral and a doorknob swap detail at the same range, so either the cathedral drops to
 * its coarsest form while it still fills the screen or the doorknob keeps its finest while it is
 * two pixels across. Every world with objects of more than one size hits this, and the usual
 * repair is a per-object distance scale — which is apparent size, arrived at by hand, one object
 * at a time.
 */

/**
 * The angular radius of a bounded object, in radians, as seen from a point.
 *
 * `radius / distance` rather than `atan(radius / distance)`: the two agree to within a percent
 * out to about a quarter of a radian, which is far larger than anything a level threshold cares
 * about, and this is a per-object per-frame path.
 *
 * Returns `Infinity` for a viewpoint inside the object's own sphere. That is the honest answer —
 * it fills the view — and it makes the comparison below pick the finest level without a special
 * case.
 */
export function apparentSize(
  bounds: Bounds,
  model: ReadonlyMat4,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
): number {
  const cx = bounds.centre[0] ?? 0;
  const cy = bounds.centre[1] ?? 0;
  const cz = bounds.centre[2] ?? 0;

  const m0 = model[0] ?? 0;
  const m1 = model[1] ?? 0;
  const m2 = model[2] ?? 0;
  const m4 = model[4] ?? 0;
  const m5 = model[5] ?? 0;
  const m6 = model[6] ?? 0;
  const m8 = model[8] ?? 0;
  const m9 = model[9] ?? 0;
  const m10 = model[10] ?? 0;

  const x = m0 * cx + m4 * cy + m8 * cz + (model[12] ?? 0) - eyeX;
  const y = m1 * cx + m5 * cy + m9 * cz + (model[13] ?? 0) - eyeY;
  const z = m2 * cx + m6 * cy + m10 * cz + (model[14] ?? 0) - eyeZ;

  /* The same largest-axis rule `boundsVisible` uses, and for the same reason. */
  const sx = Math.sqrt(m0 * m0 + m1 * m1 + m2 * m2);
  const sy = Math.sqrt(m4 * m4 + m5 * m5 + m6 * m6);
  const sz = Math.sqrt(m8 * m8 + m9 * m9 + m10 * m10);
  const radius = bounds.radius * Math.max(sx, sy, sz);

  const distance = Math.sqrt(x * x + y * y + z * z);
  if (distance <= radius) return Infinity;
  return radius / distance;
}

/**
 * The index of the level this object has earned.
 *
 * `thresholds` are apparent sizes in descending order — the size at which each level *stops*
 * being good enough. An object larger than the first threshold gets level 0; one smaller than the
 * last gets the last level, rather than an index off the end of whatever array the caller is
 * about to look this up in.
 *
 * An empty `thresholds` gives 0, which is the only level a caller with no thresholds has.
 */
export function lodForBounds(
  bounds: Bounds,
  model: ReadonlyMat4,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  thresholds: readonly number[],
): number {
  const size = apparentSize(bounds, model, eyeX, eyeY, eyeZ);
  for (let level = 0; level < thresholds.length; level += 1) {
    if (size >= (thresholds[level] ?? 0)) return level;
  }
  return Math.max(0, thresholds.length - 1);
}
