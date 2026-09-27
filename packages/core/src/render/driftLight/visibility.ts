/**
 * How much of a light a point sees, through a signed distance field: DriftLight's occlusion.
 *
 * **Sphere-traced, with a penumbra from the light's own size.** A spherical light of radius R seen
 * from a distance L fills a cone that is R * t / L across at a distance t along the way, so a surface
 * a clearance h from the ray covers the fraction of it that h falls short of that radius. The least
 * such ratio along the ray is the visibility: 1 in open air, 0 behind a wall, and a soft ramp at an
 * edge that widens with the light, which is what `AGENTS.md` asks of a light with a physical size.
 *
 * The trace stops before the light by its own radius, or 5 cm where that is smaller, so a candle's
 * wax does not shadow the flame sitting on it. What it gives up is exactness at a grazing corner,
 * where one ratio stands for an area the cone only partly crosses; what would make it wrong is a
 * field coarser than the lights it shadows, which blurs every occluder smaller than a cell.
 */

/** A signed distance: metres to the nearest surface, negative inside. */
export type DistanceAt = (x: number, y: number, z: number) => number;

/** Steps before the trace gives up and answers what it has; a light a metre off needs a dozen. */
const MAX_STEPS = 64;
/** The least a step advances, so a ray grazing a surface still reaches the light. */
const MIN_STEP_M = 0.01;
/** Where the trace starts, clear of the surface the point may be lying on. */
const START_M = 0.02;

/** The visibility, 0 to 1, of a light of radius `sourceRadius` at `to` from the point `from`. */
export function softVisibility(
  distance: DistanceAt,
  fx: number,
  fy: number,
  fz: number,
  tx: number,
  ty: number,
  tz: number,
  sourceRadius: number,
): number {
  const dx = tx - fx;
  const dy = ty - fy;
  const dz = tz - fz;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return 1;
  const ux = dx / length;
  const uy = dy / length;
  const uz = dz / length;
  const radius = Math.max(sourceRadius, 1e-3);
  const end = length - Math.max(radius, 0.05);
  let seen = 1;
  let t = START_M;
  for (let step = 0; step < MAX_STEPS && t < end; step++) {
    const h = distance(fx + ux * t, fy + uy * t, fz + uz * t);
    if (h <= 0) return 0;
    const cone = (radius * t) / length;
    seen = Math.min(seen, h / cone);
    if (seen <= 0) return 0;
    t += Math.max(h, MIN_STEP_M);
  }
  return Math.min(1, seen);
}
