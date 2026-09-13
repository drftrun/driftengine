import { describe, expect, test } from 'vitest';
import { Spline, createSplineSample } from '../geometry/spline.ts';
import { RibbonSurface, createSurfaceHit } from './ribbonSurface.ts';
import type { SplinePoint } from '../geometry/spline.ts';

function pt(x: number, y: number, z: number, bankRad = 0, widthM = 16): SplinePoint {
  return { x, y, z, bankRad, widthM };
}

/**
 * A hairpin as tight as the generator can make one: a full reversal inside a
 * single bar at a fast tempo, so the two legs run within a dozen metres of each
 * other in *arc length* as well as in space.
 */
function tightHairpin(legGap: number): Spline {
  const points: SplinePoint[] = [pt(0, 20, 0), pt(10, 20, 0)];
  // 180° through a small radius.
  const radius = legGap * 0.5;
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI;
    points.push(pt(14 + Math.cos(a) * radius, 20, radius + Math.sin(a) * radius));
  }
  points.push(pt(10, 20, legGap), pt(0, 20, legGap));
  return new Spline(points);
}

describe('a hairpin that doubles back on itself', () => {
  test('the surface is solid across its whole width, on both legs', () => {
    /*
     * Reported twice against 180-degree ribbons: the player walks through the
     * surface and drops off the world.
     *
     * The centreline test in `generate.test.ts` passes, which is why this went
     * unnoticed — the failure is *off* the centreline. Where two legs of a
     * hairpin share a column, a query has to pick the right one, and picking
     * wrong reports a lateral offset outside the surface, which reports **no
     * ground**. The ribbon contributes no collision boxes, so one bad query is a
     * fall through the floor.
     *
     * Swept across the full width because that is where a character actually is: the
     * inside of a hairpin is exactly where the two legs come closest, and exactly
     * where somebody carrying speed ends up.
     */
    const hit = createSurfaceHit();
    const sample = createSplineSample();

    for (const legGap of [10, 14, 20, 30]) {
      const spline = tightHairpin(legGap);
      const surface = new RibbonSurface(spline);
      let misses = 0;
      let worst = '';

      for (let d = 1; d < spline.lengthM - 1; d += 0.75) {
        spline.sampleAt(d, sample);
        const half = sample.widthM * 0.5;
        for (const u of [-0.9, -0.5, 0, 0.5, 0.9]) {
          const x = sample.x + sample.rightX * half * u;
          const z = sample.z + sample.rightZ * half * u;
          if (!surface.sample(x, z, hit, sample.y)) {
            misses++;
            if (worst === '') worst = `d=${d.toFixed(1)} u=${u}`;
          }
        }
      }
      expect(misses, `legs ${legGap}m apart: ${misses} holes, first at ${worst}`).toBe(0);
    }
  });
});
