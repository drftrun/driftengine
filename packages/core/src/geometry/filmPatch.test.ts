import { describe, expect, test } from 'vitest';
import { Spline, createSplineSample } from './spline.ts';
import { buildFilmPatch } from './filmPatch.ts';
import type { SplinePoint } from './spline.ts';

/** A banked curve, because a flat straight hides every mistake this can make. */
function curve(): Spline {
  const points: SplinePoint[] = [];
  for (let i = 0; i < 8; i++) {
    const t = i * 0.4;
    points.push({
      x: Math.sin(t) * 20,
      y: 30 + i * 1.5,
      z: i * 8,
      bankRad: 0.4,
      widthM: 10,
    });
  }
  return new Spline(points);
}

const OPTIONS = {
  fromM: 12,
  toM: 22,
  centreM: 1.5,
  halfWidthM: 2.4,
  liftM: 0.02,
  color: [0.07, 0.06, 0.09] as [number, number, number],
  seed: 4242,
};

describe('a film patch', () => {
  test('dissolves at its rim and is solid through the middle', () => {
    /*
     * The property the whole file exists for. The flat squares this replaced read
     * badly for one reason: a film on a surface has no straight edges, and a
     * hard edge reads as a sticker on
     * the world no matter what material fills it, so the outermost ring of
     * vertices must carry zero coverage and the interior must reach full — a patch
     * that is uniformly half-covered is a translucent rectangle, which is the same
     * problem with extra steps.
     */
    const patch = buildFilmPatch(curve(), OPTIONS);
    const coverage = patch.emissive;

    let interiorMax = 0;
    for (const c of coverage) interiorMax = Math.max(interiorMax, c);
    expect(interiorMax).toBeGreaterThan(0.9);

    // The first and last station, and the first and last vertex of every station,
    // are the silhouette: all of them at zero.
    const across = 9;
    const stations = coverage.length / across;
    for (let s = 0; s < stations; s++) {
      expect(coverage[s * across], `station ${s} near edge`).toBeCloseTo(0, 6);
      expect(coverage[s * across + across - 1], `station ${s} far edge`).toBeCloseTo(0, 6);
    }
    for (let a = 0; a < across; a++) {
      expect(coverage[a], 'first station').toBeCloseTo(0, 6);
      expect(coverage[(stations - 1) * across + a], 'last station').toBeCloseTo(0, 6);
    }
  });

  test('lies on the banked surface rather than across it', () => {
    /*
     * The second thing wrong with the squares: an axis-aligned box around a tilted
     * cross-section sits at one height while the surface under it is at another, so
     * on any banked deck the slick floated. Every vertex here must sit at the lift
     * height above the surface, measured along the surface's own normal — which is
     * only true if the builder used the curve's frame.
     */
    const spline = curve();
    const patch = buildFilmPatch(spline, OPTIONS);
    const sample = createSplineSample();

    for (let v = 0; v < patch.positions.length / 3; v++) {
      const x = patch.positions[v * 3] as number;
      const y = patch.positions[v * 3 + 1] as number;
      const z = patch.positions[v * 3 + 2] as number;

      // The nearest point on the curve, found coarsely: enough to confirm the
      // vertex sits in the surface's plane there.
      let bestD = 0;
      let best = Infinity;
      for (let d = OPTIONS.fromM - 4; d <= OPTIONS.toM + 4; d += 0.1) {
        spline.sampleAt(d, sample);
        const distance = Math.hypot(sample.x - x, sample.y - y, sample.z - z);
        if (distance < best) {
          best = distance;
          bestD = d;
        }
      }
      spline.sampleAt(bestD, sample);
      // Height above the surface, along its normal.
      const height =
        (x - sample.x) * sample.normalX +
        (y - sample.y) * sample.normalY +
        (z - sample.z) * sample.normalZ;
      expect(Math.abs(height - OPTIONS.liftM), `vertex ${v} floats`).toBeLessThan(0.05);
    }
  });

  test('never reaches wider than the band it was given', () => {
    /*
     * The one failure that would matter to a player: grip disappearing where
     * nothing is drawn, or ground that looks slippery and is not. The drawn
     * silhouette has to stay *inside* the physics window, which the wobble makes
     * worth asserting rather than assuming.
     */
    const spline = curve();
    const patch = buildFilmPatch(spline, OPTIONS);
    const sample = createSplineSample();

    for (let v = 0; v < patch.positions.length / 3; v++) {
      const x = patch.positions[v * 3] as number;
      const z = patch.positions[v * 3 + 2] as number;
      let best = Infinity;
      let lateral = 0;
      for (let d = OPTIONS.fromM - 4; d <= OPTIONS.toM + 4; d += 0.1) {
        spline.sampleAt(d, sample);
        const distance = Math.hypot(sample.x - x, sample.z - z);
        if (distance < best) {
          best = distance;
          lateral = (x - sample.x) * sample.rightX + (z - sample.z) * sample.rightZ;
        }
      }
      expect(Math.abs(lateral - OPTIONS.centreM), `vertex ${v} outside the band`).toBeLessThan(
        OPTIONS.halfWidthM + 0.01,
      );
    }
  });

  test('the same seed is the same patch', () => {
    // A day's world is identical on every device, and a slick is part of it.
    const a = buildFilmPatch(curve(), OPTIONS);
    const b = buildFilmPatch(curve(), OPTIONS);
    const c = buildFilmPatch(curve(), { ...OPTIONS, seed: OPTIONS.seed + 1 });
    expect([...a.positions]).toEqual([...b.positions]);
    expect([...c.positions]).not.toEqual([...a.positions]);
  });

  test('faces up, so it is not culled away entirely', () => {
    /*
     * The bug this file shipped with: every triangle wound downward — 224 of 224 — so with
     * back-face culling on, which the renderer uses everywhere, the slick was drawn and invisible.
     * A whole session went on *"where is oil?"* while looking straight at it.
     *
     * Measured from the cross product of each triangle, deliberately, and not from `normals`: the
     * stored normals are the surface's own, written by hand and pointing up regardless of winding,
     * so asking them would be asking the array that cannot be wrong.
     */
    const patch = buildFilmPatch(curve(), OPTIONS);
    let up = 0;
    let down = 0;
    for (let i = 0; i < patch.indices.length; i += 3) {
      const a = (patch.indices[i] as number) * 3;
      const b = (patch.indices[i + 1] as number) * 3;
      const c = (patch.indices[i + 2] as number) * 3;
      const ux = (patch.positions[b] as number) - (patch.positions[a] as number);
      const uz = (patch.positions[b + 2] as number) - (patch.positions[a + 2] as number);
      const vx = (patch.positions[c] as number) - (patch.positions[a] as number);
      const vz = (patch.positions[c + 2] as number) - (patch.positions[a + 2] as number);
      /*
       * The y component of u × v: positive is anticlockwise seen from above, which is
       * front-facing. Degenerate triangles are skipped — the patch is a lens, so its two ends
       * pinch to a point and the last ring has no area at all. Counting those would make the
       * test fail on geometry that is correct and invisible either way.
       */
      const twiceArea = uz * vx - ux * vz;
      if (Math.abs(twiceArea) < 1e-6) continue;
      if (twiceArea > 0) up++;
      else down++;
    }
    expect(down, `${down} of ${up + down} triangles face the ground`).toBe(0);
    expect(up).toBeGreaterThan(0);
  });
});
