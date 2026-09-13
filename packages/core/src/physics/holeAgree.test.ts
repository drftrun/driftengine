import { describe, expect, test } from 'vitest';
import { Spline } from '../geometry/spline.ts';
import { buildRibbon, RIBBON_STEP_M } from '../geometry/ribbon.ts';
import type { RibbonHole } from '../geometry/ribbon.ts';
import type { SplinePoint } from '../geometry/spline.ts';
import { RibbonSurface, createSurfaceHit } from './ribbonSurface.ts';

/**
 * The surface and the mesh must cut a hole in the same place.
 *
 * Two failures, both bad and opposite: deck the surface answers for but the
 * mesh never drew is a character standing on nothing, and deck the mesh drew but
 * the surface denies is a character on visible ground the game thinks they are
 * off. This asks both questions of the same pair, exactly.
 */
describe('a hole is cut in the same place by the mesh and the surface', () => {
  const straight = (lengthM: number, widthM = 8): Spline => {
    const points: SplinePoint[] = [];
    for (let i = 0; i * 5 <= lengthM; i++) {
      points.push({ x: i * 5, y: 0, z: 0, bankRad: 0, widthM } as SplinePoint);
    }
    return new Spline(points);
  };

  test('at every boundary alignment, over many hole placements', () => {
    const hit = createSurfaceHit();
    let phantom = 0;
    let denied = 0;
    let checked = 0;
    // Boundaries deliberately landing on, near and far from the step grid.
    for (let offset = 0; offset < 2; offset += 0.13) {
      for (const span of [4, 6.5, 9, 13.7]) {
        const spline = straight(120);
        const holes: RibbonHole[] = [{ fromM: 30 + offset, toM: 30 + offset + span }];
        const { colliders } = buildRibbon(spline, {
          color: [1, 1, 1],
          stepM: RIBBON_STEP_M,
          holes,
        });
        const surface = new RibbonSurface(spline, { holes, holeEdgeM: RIBBON_STEP_M });
        for (let d = 20; d < 60; d += 0.1) {
          checked++;
          const answered = surface.sample(d, 0, hit, 0);
          // Drawn deck over this column: any collider whose x-range covers it.
          let drawn = false;
          for (const c of colliders) {
            if (d >= c.minX - 1e-6 && d <= c.maxX + 1e-6) {
              drawn = true;
              break;
            }
          }
          if (answered && !drawn) phantom++;
          if (!answered && drawn) denied++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    expect(phantom, 'columns the surface answers for with nothing drawn').toBe(0);
    expect(denied, 'columns of drawn deck the surface denies').toBe(0);
  });
});
