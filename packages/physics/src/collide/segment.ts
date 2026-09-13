import { ColliderSet } from '../colliderSet.ts';
import type { Aabb } from './aabb.ts';
import { hits } from './scratch.ts';

/** What a ray hits: a segment tested against a collider set. */

/** Below this, a slab is treated as parallel to the segment. */
const PARALLEL_EPSILON = 1e-8;

/**
 * Nearest obstruction along the segment `origin → origin + delta`, returned as
 * a fraction of the segment in [0, 1] — 1 meaning unobstructed.
 *
 * Boxes are expanded by `radius`, which approximates sweeping a sphere: the
 * caller (the third-person camera boom) then stops clear of surfaces instead of
 * grazing them. Allocation-free; slab method, one pass over the boxes.
 *
 * Render-side only. Nothing here may be called from `simulate()`.
 */
export function segmentHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  boxes: ColliderSet,
  radius: number,
): number {
  let nearest = 1;

  const count = boxes.query(
    Math.min(ox, ox + dx) - radius,
    Math.min(oy, oy + dy) - radius,
    Math.min(oz, oz + dz) - radius,
    Math.max(ox, ox + dx) + radius,
    Math.max(oy, oy + dy) + radius,
    Math.max(oz, oz + dz) + radius,
    hits,
  );
  const data = boxes.data;
  // Support of the contact that finally clamps the move; true when unblocked.
  let clampSupport = true;

  for (let h = 0; h < count; h++) {
    const index = hits[h] ?? 0;
    const o = index * 6;
    let tmin = 0;
    let tmax = nearest;
    let hit = true;

    /*
     * A shaped collider is clipped against its own face planes instead of its
     * box's. The box is only the broad phase, and treating it as solid here is
     * what made the camera pull in over the empty corner of every banked
     * stretch, and a grapple anchor on drawn air. Each face direction bounds
     * the shape as a slab of its vertex projections; a hull with fewer than
     * three face lines cannot be bounded that way and keeps the box answer.
     */
    const shape = boxes.shapeAt(index);
    if (shape !== undefined && shape.faceNormals.length >= 9) {
      const fn = shape.faceNormals;
      const v = shape.vertices;
      for (let f = 0; f < fn.length && hit; f += 3) {
        const nx = fn[f] ?? 0;
        const ny = fn[f + 1] ?? 0;
        const nz = fn[f + 2] ?? 0;
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < v.length; i += 3) {
          const p = (v[i] ?? 0) * nx + (v[i + 1] ?? 0) * ny + (v[i + 2] ?? 0) * nz;
          if (p < lo) lo = p;
          if (p > hi) hi = p;
        }
        lo -= shape.radius + radius;
        hi += shape.radius + radius;
        const at = ox * nx + oy * ny + oz * nz;
        const rate = dx * nx + dy * ny + dz * nz;

        if (rate > -PARALLEL_EPSILON && rate < PARALLEL_EPSILON) {
          if (at < lo || at > hi) hit = false;
          continue;
        }
        let t1 = (lo - at) / rate;
        let t2 = (hi - at) / rate;
        if (t1 > t2) {
          const swap = t1;
          t1 = t2;
          t2 = swap;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) hit = false;
      }
      if (hit && tmin < nearest) nearest = tmin;
      continue;
    }

    for (let axis = 0; axis < 3 && hit; axis++) {
      const at = axis === 0 ? ox : axis === 1 ? oy : oz;
      const d = axis === 0 ? dx : axis === 1 ? dy : dz;
      const lo = (data[o + axis] ?? 0) - radius;
      const hi = (data[o + 3 + axis] ?? 0) + radius;

      if (d > -PARALLEL_EPSILON && d < PARALLEL_EPSILON) {
        // Parallel to this slab: a miss unless the origin already lies inside.
        if (at < lo || at > hi) hit = false;
        continue;
      }

      let t1 = (lo - at) / d;
      let t2 = (hi - at) / d;
      if (t1 > t2) {
        const swap = t1;
        t1 = t2;
        t2 = swap;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) hit = false;
    }

    if (hit && tmin < nearest) nearest = tmin;
  }

  return nearest;
}
