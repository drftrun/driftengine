import { expect, test } from 'vitest';

import {
  SHADOW_DEPTH_FADE,
  SHADOW_PCF_OFFSETS,
  SHADOW_TERMINATOR_BAND,
  directionalVisibility,
  receiverPlaneDepthGradient,
  receiverPlaneFromWeights,
  shadowFactor,
  shadowReach,
} from './shadow.ts';

import type { ShadowSettings } from './shadow.ts';

/**
 * **What this file is for: every one of these fades returns 1, and returning 1 is invisible.**
 *
 * A shadow lookup is a stack of guards — the light is off, the receiver faces away, the point is
 * outside the map, it is near the map's border, the sun is too low — and each of them answers
 * "fully lit". A guard that fires when it should not therefore does nothing a viewer can see except
 * remove a shadow that ought to be there, which reads as the scene not having one. So each is
 * tested at both ends of its own band rather than at a point in the middle of it.
 */

const SETTINGS: ShadowSettings = {
  strength: 1,
  mapSize: 1024,
  depthSpan: 80,
  maxDistance: 60,
  maxSlope: 4,
  taps: 12,
  /* A sun well up, so the elevation fade is not the thing under test. */
  lightDir: [0.2, 0.96, 0.2],
};

/**
 * A light-space clip position from a point already in the map's 0-to-1 space.
 *
 * `x` and `y` go back to -1..1 and the depth does not, because WebGPU clips depth to 0..1 and this
 * is the second pipeline's lookup. See `shadowFactor`.
 */
function clipAt(u: number, v: number, depth: number): [number, number, number, number] {
  return [u * 2 - 1, v * 2 - 1, depth, 1];
}

/** A map that is empty: everything reads the far plane, so nothing is ever occluded. */
const EMPTY = (): number => 1;

/** A map with an occluder at a fixed depth everywhere. */
function occludedAt(depth: number): () => number {
  return () => depth;
}

test('a light that is off returns exactly one, with no arithmetic in between', () => {
  expect(shadowFactor(clipAt(0.5, 0.5, 0.6), [0, 0], 1, { ...SETTINGS, strength: 0 }, EMPTY)).toBe(
    1,
  );
});

test('AN EMPTY MAP CASTS NOTHING, which is the compare and not a fade', () => {
  expect(shadowFactor(clipAt(0.5, 0.5, 0.6), [0, 0], 1, SETTINGS, EMPTY)).toBeCloseTo(1, 6);
});

test('A RECEIVER BEHIND AN OCCLUDER IS SHADOWED, by the strength and nothing else', () => {
  /*
   * Dead centre of the map, facing the sun, with an occluder well in front: every fade is one, so
   * what comes back is `1 - strength` exactly. Anything else means a fade fired that should not.
   */
  const factor = shadowFactor(clipAt(0.5, 0.5, 0.6), [0, 0], 1, SETTINGS, occludedAt(0.2));
  expect(factor).toBeCloseTo(0, 3);

  /* And at half strength it is half shadowed, which is what strength means. */
  const half = shadowFactor(
    clipAt(0.5, 0.5, 0.6),
    [0, 0],
    1,
    { ...SETTINGS, strength: 0.5 },
    occludedAt(0.2),
  );
  expect(half).toBeCloseTo(0.5, 3);
});

test('a point outside the map is lit, on every side and past the far plane', () => {
  for (const [u, v, d] of [
    [-0.05, 0.5, 0.6],
    [1.05, 0.5, 0.6],
    [0.5, -0.05, 0.6],
    [0.5, 1.05, 0.6],
    [0.5, 0.5, 1.4],
  ] as const) {
    expect(shadowFactor(clipAt(u, v, d), [0, 0], 1, SETTINGS, occludedAt(0.1))).toBe(1);
  }
});

test('THE RECEIVER FADE GIVES UP AT THE TERMINATOR, and only there', () => {
  /*
   * **A surface nearly edge-on to the sun has an orthographic projection collapsing toward a line**,
   * and no finite bias represents that slope — so the shadow *modulation* is faded out through a
   * narrow band while the Lambert term keeps supplying the falloff. Below 0.08 there is no shadow
   * at all; above 0.20 there is all of it.
   */
  const shadowed = (ndl: number): number =>
    shadowFactor(clipAt(0.5, 0.5, 0.6), [0, 0], ndl, SETTINGS, occludedAt(0.2));

  expect(shadowed(0.07)).toBe(1);
  expect(shadowed(0.25)).toBeCloseTo(0, 3);
  /*
   * **And the ramp is the cubic, checked away from its midpoint.** `smoothstep` and a linear ramp
   * agree exactly at the middle of their band, so a test that probed only there could not tell them
   * apart — and a linear fade has a crease at each end where its slope jumps, which on a terminator
   * is a line running across every curved surface in the scene. A quarter of the way in, the cubic
   * is 0.156 where a ramp is 0.250.
   */
  const band = SHADOW_TERMINATOR_BAND;
  const quarter = band[0] + (band[1] - band[0]) * 0.25;
  expect(shadowed(quarter)).toBeCloseTo(1 - 0.15625, 4);
});

test('THE BORDER FADES TOWARD LIT rather than cutting at it', () => {
  /*
   * The map only covers a radius around the viewer. A hard edge makes distant geometry switch from
   * shadowed to lit as the camera moves, which reads as the shadow following the camera.
   */
  const middle = shadowFactor(clipAt(0.5, 0.5, 0.6), [0, 0], 1, SETTINGS, occludedAt(0.2));
  const nearEdge = shadowFactor(clipAt(0.94, 0.5, 0.6), [0, 0], 1, SETTINGS, occludedAt(0.2));
  const atEdge = shadowFactor(clipAt(0.995, 0.5, 0.6), [0, 0], 1, SETTINGS, occludedAt(0.2));

  expect(middle).toBeLessThan(nearEdge);
  expect(nearEdge).toBeLessThan(atEdge);
  expect(atEdge).toBeCloseTo(1, 3);
});

test('THE FAR END OF STORED DEPTH FADES TOWARD LIT, over its band and nowhere nearer', () => {
  /*
   * **A fit has to keep its receivers short of this band, so the band is pinned where it is.** It
   * was two literals nothing tested — moving its start from 0.9 to 0.95 changed no answer here —
   * until a fit that followed the eye put the eye's whole sphere inside it and every shadow below
   * the eye came out faded. `fitShadow` derives its least depth reach from `SHADOW_DEPTH_FADE`, and
   * this is what that derivation is about.
   */
  const at = (depth: number): number =>
    shadowFactor(clipAt(0.5, 0.5, depth), [0, 0], 1, SETTINGS, occludedAt(0.05));
  const [start, end] = SHADOW_DEPTH_FADE;
  expect(at(start - 0.01)).toBeCloseTo(0, 3);
  /* The cubic, a quarter of the way in, where a ramp and a cubic disagree: 0.156 against 0.25. */
  expect(at(start + (end - start) * 0.25)).toBeCloseTo(0.15625, 4);
  expect(at(start + (end - start) * 0.5)).toBeCloseTo(0.5, 4);
  expect(at(end - 0.0005)).toBeGreaterThan(0.999);
});

test('A LOW SUN CASTS NOTHING, because its stripes would be the whole map', () => {
  /*
   * Faded once by the source's elevation, which the whole map shares — so a low sun loses its
   * shadows evenly instead of acquiring a hard length cut somewhere in the scene.
   */
  const low = { ...SETTINGS, lightDir: [0.99, 0.05, 0] as const };
  expect(shadowFactor(clipAt(0.5, 0.5, 0.6), [0, 0], 1, low, occludedAt(0.2))).toBe(1);
});

test('a shadow fades with how far it has been cast along the ground', () => {
  /*
   * `shadowReach` is the same fade a point light's shadow uses. An occluder far above its receiver
   * throws a shadow that has travelled a long way, and past `maxDistance` it is gone — which is
   * what stops a map's worth of geometry shadowing the whole world.
   */
  expect(shadowReach(0, 60)).toBe(1);
  expect(shadowReach(60, 60)).toBe(0);
  /* 21 is exactly where the fade starts — `POINT_SHADOW_FADE_START` of 60 — so it is still whole. */
  expect(shadowReach(21, 60)).toBe(1);
  expect(shadowReach(40, 60)).toBeGreaterThan(0);
  expect(shadowReach(40, 60)).toBeLessThan(1);

  /*
   * Fully shadowed close under the occluder, fading as the gap grows — **with a reach short enough
   * that the gap can exceed it.** At the settings above a full-depth ray travels only 13.6 m along
   * the ground, because a high sun casts a short shadow however deep the map is, so nothing ever
   * reaches the 21 m where the fade starts. That is the fade behaving, and it is also a corpus
   * that cannot see it.
   */
  const close = { ...SETTINGS, maxDistance: 20 };
  const near = directionalVisibility(0.6, 0.6, 0.59, close);
  const far = directionalVisibility(0.6, 0.6, 0.0, close);
  expect(near).toBeCloseTo(0, 6);
  expect(far).toBeGreaterThan(near);
  expect(far).toBeGreaterThan(0.5);
});

test('THE RECEIVER PLANE IS SOLVED, and refused where it cannot be', () => {
  /*
   * A plane tilted in the light's own space: moving one pixel right moves `u` by a and the depth by
   * c, so the depth per unit of `u` is c/a. The solve has to recover exactly that from the two
   * derivative vectors, whatever basis they came in.
   */
  const out = new Float32Array(2);
  receiverPlaneDepthGradient([0.01, 0, 0.004], [0, 0.01, 0.002], out);
  expect(out[0]).toBeCloseTo(0.4, 6);
  expect(out[1]).toBeCloseTo(0.2, 6);

  /* A basis that is not axis-aligned gives the same plane. */
  receiverPlaneDepthGradient([0.01, 0.01, 0.006], [0.01, -0.01, 0.002], out);
  expect(out[0]).toBeCloseTo(0.4, 6);
  expect(out[1]).toBeCloseTo(0.2, 6);

  /*
   * **And a triangle almost edge-on in the light's projection gets nothing rather than a number.**
   * Its determinant is near zero, and dividing by it turns a fraction of a texel into whole map
   * units of depth — the stripes `SHADOW_SLOPE_TEXELS` exists to clamp. Refusing is cheaper than
   * clamping and says what happened.
   */
  receiverPlaneDepthGradient([0.01, 0.01, 0.5], [0.01, 0.0100001, 0.5], out);
  expect(Array.from(out)).toEqual([0, 0]);
});

test('the taps are a Poisson disc, inside the unit circle and not clustered on an axis', () => {
  expect(SHADOW_PCF_OFFSETS).toHaveLength(12);
  let onAxis = 0;
  for (const [x, y] of SHADOW_PCF_OFFSETS) {
    expect(Math.hypot(x, y), `tap ${x},${y} is outside the disc`).toBeLessThanOrEqual(1.001);
    if (Math.abs(x) < 0.05 || Math.abs(y) < 0.05) onAxis += 1;
  }
  /* A set that lined up on the axes would filter along them and band across them. */
  expect(onAxis).toBeLessThan(3);
});

test('THE PLANE COMPENSATION IS CLAMPED, or one tap swings a whole map of depth', () => {
  /*
   * **A product of an unbounded gradient and a bounded offset, and only one of the two was ever
   * bounded.** A tap lands at most a couple of texels from the receiver, so a gradient that has
   * blown up turns a fraction of a texel into a depth swing of whole map units — and what draws is
   * hard straight stripes lying along the map's texel grid, oblique on screen because that grid is
   * turned by the sun rather than by the camera. The clamp is 9.1 texels' worth.
   */
  const wild = shadowFactor(clipAt(0.5, 0.5, 0.6), [1e6, 1e6], 1, SETTINGS, occludedAt(0.2));
  const calm = shadowFactor(clipAt(0.5, 0.5, 0.6), [0, 0], 1, SETTINGS, occludedAt(0.2));
  /* Clamped, the wild gradient can move the answer a little and cannot invert it. */
  expect(wild).toBeLessThan(0.5);
  expect(Math.abs(wild - calm)).toBeLessThan(0.5);
  expect(Number.isFinite(wild)).toBe(true);
});

/**
 * A triangle whose light-space depth is `a·x + b·y + c` in clip units, with barycentric gradients
 * chosen so that the screen axes are the clip axes — which makes the expected answer arithmetic
 * rather than a second implementation of the thing under test.
 */
function plane(
  a: number,
  b: number,
  c: number,
): {
  corners: readonly [number, number, number][];
  gx: [number, number, number];
  gy: [number, number, number];
} {
  const corners: [number, number, number][] = [
    [0, 0, c],
    [1, 0, a + c],
    [0, 1, b + c],
  ];
  /* Moving one pixel in screen x moves one unit along clip x: weight 0 loses what weight 1 gains. */
  return { corners, gx: [-1, 1, 0], gy: [-1, 0, 1] };
}

test('the receiver plane comes from the barycentric gradients, in the map own units', () => {
  const out = new Float32Array(2);
  const { corners, gx, gy } = plane(0.25, -0.5, 0.3);
  receiverPlaneFromWeights(corners[0], corners[1], corners[2], gx, gy, out);
  /*
   * **The factor of two is the remap and it is the whole of what this function adds.** The lookup
   * addresses the map in 0-to-1 coordinates where clip x is -1 to 1, so a depth slope stated per
   * clip unit is twice that per map unit — and a gradient off by two compensates a tap by half of
   * what it should, which is acne on exactly the grazing surfaces the compensation exists for.
   */
  expect(out[0]).toBeCloseTo(0.5, 6);
  expect(out[1]).toBeCloseTo(-1, 6);
});

test('a plane of constant depth asks for no compensation at all', () => {
  const out = new Float32Array(2);
  const { corners, gx, gy } = plane(0, 0, 0.42);
  receiverPlaneFromWeights(corners[0], corners[1], corners[2], gx, gy, out);
  expect(Array.from(out)).toEqual([0, 0]);
});

test('a triangle edge-on in the light is refused rather than amplified', () => {
  const out = new Float32Array(2);
  const { corners } = plane(0.25, -0.5, 0.3);
  /* Two screen directions that move the same way across the light's projection: no second axis. */
  receiverPlaneFromWeights(corners[0], corners[1], corners[2], [-1, 1, 0], [-1, 1.0000001, 0], out);
  expect(Array.from(out)).toEqual([0, 0]);
});
