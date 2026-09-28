import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import {
  DEFAULT_DISOCCLUSION,
  disocclusionWeight,
  normalFromPositions,
  planarity,
  surfaceSlope,
  worldPositionFromDepth,
} from './disocclusion.ts';

/**
 * A pixel that was hidden last frame does not take its colour from what was in front of it.
 *
 * **What is compared.** The camera moved, so this frame's depth and last frame's are depths from
 * two eyes. The weight compares the depth this surface *should* have had last frame — the w of its
 * reprojected position — with the depth last frame actually held where it lands. Equal, and it is
 * the same surface; the second nearer, and something stood in front of it.
 */

const P = DEFAULT_DISOCCLUSION;

test('matching depth and matching normal trust the history fully', () => {
  expect(disocclusionWeight(10, 10, 0, 1, P)).toBe(1);
  expect(disocclusionWeight(0.5, 0.5, 0.01, 0.99, P)).toBe(1);
});

test('A LARGE DEPTH DISAGREEMENT TRUSTS NOTHING', () => {
  /* A wall two metres in front of where the surface was: whatever the history holds is the wall. */
  expect(disocclusionWeight(10, 8, 0, 1, P)).toBe(0);
  expect(disocclusionWeight(10, 12, 0, 1, P)).toBe(0);
});

test('the same small disagreement is forgiven more under fast motion than slow', () => {
  /*
   * A depth read at a reprojected position under fast motion comes from a different part of a
   * texel, and depth varies across a texel at a grazing angle. The tolerance grows with the motion.
   */
  const slow = disocclusionWeight(10, 10.25, 0, 1, P);
  const fast = disocclusionWeight(10, 10.25, 0.05, 1, P);
  expect(fast).toBeGreaterThan(slow);
  expect(slow).toBeLessThan(1);
});

test('A FLIPPED NORMAL TRUSTS NOTHING EVEN WHERE THE DEPTH MATCHES, which is thin geometry', () => {
  /* A leaf's two sides are at the same depth; the history of the front is not the back. */
  expect(disocclusionWeight(10, 10, 0, -1, P)).toBe(0);
  expect(disocclusionWeight(10, 10, 0, P.normalFloor, P)).toBe(0);
  expect(disocclusionWeight(10, 10, 0, P.normalCeiling, P)).toBe(1);
  const between = disocclusionWeight(10, 10, 0, (P.normalFloor + P.normalCeiling) / 2, P);
  expect(between).toBeGreaterThan(0);
  expect(between).toBeLessThan(1);
  /*
   * **A smoothstep, not a ramp**: a quarter of the way into the band trusts 5/32, where a ramp
   * trusts a quarter. The smoothstep's slope is zero at both ends, so a history does not begin to
   * fade at a crease in the input.
   */
  const quarter = P.normalFloor + (P.normalCeiling - P.normalFloor) / 4;
  expect(disocclusionWeight(10, 10, 0, quarter, P)).toBeCloseTo(5 / 32, 12);
});

test('A PIXEL WHOSE REPROJECTION LEFT THE SCREEN HAS NO HISTORY AT ALL', () => {
  /* The resolve passes no depth — zero — where the surface was off last frame's picture. */
  expect(disocclusionWeight(10, 0, 0, 1, P)).toBe(0);
  expect(disocclusionWeight(10, -1, 0, 1, P)).toBe(0);
  expect(disocclusionWeight(10, Number.NaN, 0, 1, P)).toBe(0);
  expect(disocclusionWeight(Number.NaN, 10, 0, 1, P)).toBe(0);
  expect(disocclusionWeight(10, 10, Number.NaN, 1, P)).toBe(0);
  expect(disocclusionWeight(10, 10, 0, Number.NaN, P)).toBe(0);
});

test('THE WEIGHT IS CONTINUOUS IN EVERY INPUT, so an edge does not flicker between keeping and dropping', () => {
  /*
   * A step anywhere in this function is a line on screen along which the history is kept on one
   * frame and dropped on the next. Swept finely, no two neighbouring inputs give weights further
   * apart than a bounded slope allows.
   */
  const steps = 4000;
  const sweep = (f: (t: number) => number, span: number, slope: number): void => {
    let previous = f(0);
    for (let i = 1; i <= steps; i += 1) {
      const value = f((i / steps) * span);
      expect(Math.abs(value - previous), `step ${String(i)}`).toBeLessThanOrEqual(
        (slope * span) / steps,
      );
      previous = value;
    }
  };
  /*
   * The bounds are the derivation's. A smoothstep over a width `w` is never steeper than 1.5 / w;
   * the depth's falls over one tolerance of relative disagreement, which moves by 1/10 per unit at a
   * depth of ten, and by at most 1.05 per unit where the expected depth sweeps from 1 to 2 against
   * 1.05; the motion moves the tolerance by `motionScale`; the normal's falls over its own band.
   */
  const T = P.depthTolerance;
  sweep((d) => disocclusionWeight(10, 10 + d, 0, 1, P), 3, 1.5 / T / 10);
  sweep((d) => disocclusionWeight(10, 10 - d, 0.02, 1, P), 3, 1.5 / T / 10);
  sweep((z) => disocclusionWeight(1 + z, 1.05, 0, 1, P), 1, (1.5 / T) * 1.05);
  sweep((n) => disocclusionWeight(10, 10, 0, n - 1, P), 2, 1.5 / (P.normalCeiling - P.normalFloor));
  /* At a disagreement of 0.03 the tolerance's growth is never steeper than 1.5 × 0.03 / T² × scale. */
  sweep(
    (m) => disocclusionWeight(10, 10.3, m, 1, P),
    0.2,
    ((1.5 * 0.03) / (T * T)) * P.motionScale,
  );
});

test('the weight never rises as the disagreement grows, nor falls as the normals agree more', () => {
  let previous = 2;
  for (let d = 0; d <= 3; d += 0.01) {
    const w = disocclusionWeight(10, 10 + d, 0.01, 0.9, P);
    expect(w).toBeLessThanOrEqual(previous);
    previous = w;
  }
  previous = -1;
  for (let n = -1; n <= 1; n += 0.01) {
    const w = disocclusionWeight(10, 10, 0, n, P);
    expect(w).toBeGreaterThanOrEqual(previous);
    previous = w;
  }
});

test('the disagreement is relative, so a far surface is not held to a near one’s tolerance', () => {
  /* A tenth of a unit at a hundred units is a tenth of a percent; at one unit it is ten percent. */
  expect(disocclusionWeight(100, 100.1, 0, 1, P)).toBe(1);
  expect(disocclusionWeight(1, 1.1, 0, 1, P)).toBe(0);
});

test('A SURFACE’S OWN SLOPE IS FORGIVEN, because a new jitter samples it somewhere else', () => {
  /*
   * Two and a half percent apart is refused on a surface facing the eye, where a tolerance of one
   * percent is fully spent at two. A surface whose depth moves two percent across a texel has
   * samples that far apart from nothing but the jitter, so its slope widens the tolerance to three.
   */
  expect(disocclusionWeight(10, 10.25, 0, 1, P)).toBe(0);
  expect(disocclusionWeight(10, 10.25, 0, 1, P, 0.02)).toBe(1);
});

test('the weight is continuous in the slope, as it is in the motion', () => {
  /* The slope moves the tolerance one for one, so the bound is the motion sweep's at a scale of one. */
  const T = P.depthTolerance;
  let previous = disocclusionWeight(10, 10.3, 0, 1, P, 0);
  for (let i = 1; i <= 4000; i += 1) {
    const value = disocclusionWeight(10, 10.3, 0, 1, P, (i / 4000) * 0.2);
    expect(Math.abs(value - previous)).toBeLessThanOrEqual(((1.5 * 0.03) / (T * T)) * (0.2 / 4000));
    previous = value;
  }
});

test('A SURFACE’S SLOPE IS THE STEP TO THE NEIGHBOUR ON IT, and a sliver has none', () => {
  /* Nearer on one side and farther on the other: the smaller step, a tenth of a unit in ten. */
  expect(surfaceSlope(9.9, 10, 10.3)).toBeCloseTo(0.01, 12);
  /*
   * Nearer or farther than both: every step leaves this surface for another one, so neither is its
   * slope. A rod before a far wall, and a crack between two near faces.
   */
  expect(surfaceSlope(20, 10, 20)).toBe(0);
  expect(surfaceSlope(5, 10, 5)).toBe(0);
  /* One neighbour, at the border or where there is nothing drawn, is the only step there is. */
  expect(surfaceSlope(0, 10, 10.2)).toBeCloseTo(0.02, 12);
  expect(surfaceSlope(0, 10, 0)).toBe(0);
});

test('THREE TEXELS ON ONE PLANE ARE PLANAR AT ANY ANGLE, and an edge or a sliver is not', () => {
  /*
   * Inverse depth is affine across a plane on screen: 0.1, 0.11 and 0.12 in a row are one plane
   * however steeply it is turned — the depths themselves, 10, 9.09 and 8.33, are not evenly spaced —
   * so its two steps are equal and opposite.
   */
  expect(planarity(1 / 0.1, 1 / 0.11, 1 / 0.12)).toBe(1);
  /* One side steps to the wall behind and the other does not: an edge. */
  expect(planarity(10, 10, 20)).toBe(0);
  /* Both step the same way: a rod in front of a wall, a sliver. */
  expect(planarity(20, 10, 20)).toBe(0);
  /*
   * Steps of 0.022 and −0.01 in inverse depth disagree by 0.012 of 0.032 — three eighths, the middle
   * of the band — and a smoothstep is a half there.
   */
  expect(planarity(1 / 0.09, 10, 1 / 0.122)).toBeCloseTo(0.5, 9);
  /* A surface facing the eye has no steps to compare, and nothing on one side nothing to judge by. */
  expect(planarity(10, 10, 10)).toBe(1);
  expect(planarity(0, 10, 20)).toBe(1);
});

test('A SMALL STEP IS AS MUCH AN EDGE AS A LARGE ONE, because a normal across it is still wrong', () => {
  /*
   * A rod a hundredth of the depth in front of a wall passes a depth test, and a normal differenced
   * across it is still tilted by its height over the texel's width — nearly edge-on where texels are
   * small. What makes it an edge is that one side steps and the other does not, not the size.
   */
  expect(planarity(10, 10, 10.1)).toBe(0);
  expect(planarity(10, 9.9, 10)).toBe(0);
});

test('a world position comes back out of a depth through the inverse view-projection', () => {
  const view = mat4.lookAt(new Float64Array(16), [1, 2, 6], [0, 1, 0], [0, 1, 0]);
  const lens = mat4.perspective(new Float64Array(16), Math.PI / 3, 1.5, 0.1, 50);
  const viewProj = mat4.multiply(new Float64Array(16), lens, view) as Float64Array;
  const inverse = mat4.invert(new Float64Array(16), viewProj) as Float64Array;
  const point = [0.3, 0.8, -1.2, 1];
  const clip = new Float64Array(4);
  for (let r = 0; r < 4; r += 1) {
    clip[r] =
      (viewProj[r] as number) * (point[0] as number) +
      (viewProj[4 + r] as number) * (point[1] as number) +
      (viewProj[8 + r] as number) * (point[2] as number) +
      (viewProj[12 + r] as number);
  }
  const u = ((clip[0] as number) / (clip[3] as number)) * 0.5 + 0.5;
  const v = ((clip[1] as number) / (clip[3] as number)) * 0.5 + 0.5;
  const z = (clip[2] as number) / (clip[3] as number);
  const out = new Float64Array(3);
  expect(worldPositionFromDepth(inverse, u, v, z, out)).toBe(true);
  expect(out[0]).toBeCloseTo(0.3, 9);
  expect(out[1]).toBeCloseTo(0.8, 9);
  expect(out[2]).toBeCloseTo(-1.2, 9);
  /* A singular matrix answers nothing rather than infinity, and so does a point at infinity. */
  expect(worldPositionFromDepth(new Float64Array(16), u, v, z, out)).toBe(false);
  const nearlyInfinite = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1e-14);
  expect(worldPositionFromDepth(nearlyInfinite, 0.75, 0.5, 0, out)).toBe(false);
});

test('a normal from three positions faces the eye, and is a unit, whichever way the rows run', () => {
  const out = new Float64Array(3);
  /* A floor seen from above: right is +x, up the screen is -z. */
  expect(normalFromPositions([0, 0, 0], [1, 0, 0], [0, 0, -1], [0, 5, 0], out)).toBe(true);
  expect(Array.from(out, (x) => x + 0)).toEqual([0, 1, 0]);
  /* The same floor with the screen's rows the other way: still facing up, towards the eye. */
  expect(normalFromPositions([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 5, 0], out)).toBe(true);
  expect(Array.from(out, (x) => x + 0)).toEqual([0, 1, 0]);
  /* Scaled edges give the same unit normal, and a degenerate triple gives none. */
  expect(normalFromPositions([0, 0, 0], [3, 0, 0], [0, 0, -0.01], [0, 5, 0], out)).toBe(true);
  expect(out[1]).toBeCloseTo(1, 12);
  expect(normalFromPositions([0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 5, 0], out)).toBe(false);
  /* A surface a tenth of a millimetre across is still a surface: the test is relative to its size. */
  expect(normalFromPositions([0, 0, 0], [1e-4, 0, 0], [0, 0, -1e-4], [0, 5, 0], out)).toBe(true);
  expect(out[1]).toBeCloseTo(1, 12);
  /* And a tilted plane, whose every component is asked about: x + y = 0, seen from (5, 5, 0). */
  expect(normalFromPositions([0, 0, 0], [1, -1, 0], [0, 0, 1], [5, 5, 0], out)).toBe(true);
  expect(out[0]).toBeCloseTo(Math.SQRT1_2, 12);
  expect(out[1]).toBeCloseTo(Math.SQRT1_2, 12);
  expect(out[2]).toBeCloseTo(0, 12);
});
