/**
 * A route: a spline sampled by arc length, a banked ribbon swept along it with gaps in it, and the
 * exact surface a character stands on.
 *
 * A snippet, typechecked with the examples and quoted by the manual's splines chapter.
 */
import { RibbonSurface, Spline, buildRibbon, createSurfaceHit } from '@driftengine/core';
import type { RendererApi, SplinePoint } from '@driftengine/core';

// #region spline
/** Control points carry a bank, in radians, and a width, in metres, as well as a position. */
const points: SplinePoint[] = [
  { x: 0, y: 0, z: 0, bankRad: 0, widthM: 8 },
  { x: 40, y: 4, z: -30, bankRad: 0.35, widthM: 7 },
  { x: 90, y: 2, z: -20, bankRad: -0.2, widthM: 7 },
  { x: 130, y: 10, z: 30, bankRad: 0, widthM: 9 },
];
const route = new Spline(points);
console.info(`${route.lengthM.toFixed(1)} m long`);
// #endregion

// #region ribbon
/** A slab swept along the route, with one gap a player has to jump. */
export function buildRoute(renderer: RendererApi) {
  const holes = [{ fromM: 70, toM: 78 }];
  const { mesh, colliders } = buildRibbon(route, {
    color: [0.36, 0.38, 0.44],
    stepM: 1,
    thicknessM: 0.6,
    holes,
  });
  const surface = new RibbonSurface(route, { holes });
  return { mesh: renderer.createMesh(mesh), colliders, surface };
}
// #endregion

// #region surface
const hit = createSurfaceHit();

/** Where the ground is in a column, and where along the route that is. */
export function groundUnder(
  surface: RibbonSurface,
  x: number,
  z: number,
  y: number,
): number | null {
  if (!surface.sample(x, z, hit, y)) return null; // over a gap, or off the route
  // hit.distanceM is how far along, hit.lateralM how far off the centre line, hit.normal* the face.
  return hit.y;
}
// #endregion
