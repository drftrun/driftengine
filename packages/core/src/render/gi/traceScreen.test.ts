import { expect, test } from 'vitest';

import { newScreenSpaceHit } from '../screenSpaceReflection.ts';
import {
  GI_SCREEN_MARCH,
  SCREEN_TRACE_BIAS_M,
  screenRayOrigin,
  traceScreen,
} from './traceScreen.ts';

/**
 * **What this file is for: the miss, which is the only thing the screen owes the chain.**
 *
 * A hit is easy and a hit is also not what makes this legitimate. `ROADMAP.md` refused screen-space
 * global illumination because its error is unbounded, and the thing that makes it bounded here is
 * that a ray the screen cannot answer says so — rather than clamping to the border texel, or
 * believing a surface it never crossed, or hitting the floor it started on.
 */

/** Where the wall stands, and how wide the frame is at it. */
const WALL_Z = -5;

/**
 * A projection with the eye at the origin looking down `-z`, and a frame two units wide at one.
 *
 * Refuses a point behind the eye and a point outside the frame, which is `projectToUv`'s own
 * contract in miniature. The real one is tested where it lives; this is a stand-in that has the
 * same two refusals so the march can be exercised without a renderer.
 */
function project(x: number, y: number, z: number, uv: Float32Array): boolean {
  if (z >= -1e-4) return false;
  const u = 0.5 + x / (-z * 2);
  const v = 0.5 + y / (-z * 2);
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  uv[0] = u;
  uv[1] = v;
  return true;
}

/**
 * The depth the frame drew, quantised the way a real one is.
 *
 * **The quantisation is the point of the fourth test.** A depth buffer holds a rounded number, so
 * a ray running along the surface it started on reads a scene distance that is alternately a
 * fraction in front of it and a fraction behind — and one pair of those in the wrong order is a
 * crossing, which is a hit on the surface the ray is leaving.
 */
const DEPTH_QUANTUM_M = 0.001;

function sceneDistance(u: number, v: number): number {
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    throw new Error(`the march sampled outside the frame at ${u}, ${v}`);
  }
  /* A hole in the wall at the right of the frame, which is sky and is not a surface. */
  if (u > 0.7) return Infinity;
  const exact = Math.hypot((u - 0.5) * -WALL_Z * 2, (v - 0.5) * -WALL_Z * 2, -WALL_Z);
  return Math.round(exact / DEPTH_QUANTUM_M) * DEPTH_QUANTUM_M;
}

const EYE = [0, 0, 0] as const;

test('a ray that crosses visible geometry reports that crossing', () => {
  const hit = newScreenSpaceHit();
  const found = traceScreen(
    [0, 0, -2],
    [0, 0, 1],
    [0, 0, -1],
    EYE,
    GI_SCREEN_MARCH,
    project,
    sceneDistance,
    hit,
  );

  expect(found).toBe(true);
  expect(hit.hit).toBe(true);
  /* Straight down the middle, so the crossing is at the centre of the frame, three metres out. */
  expect(hit.u).toBeCloseTo(0.5, 3);
  expect(hit.v).toBeCloseTo(0.5, 3);
  expect(hit.distanceM).toBeCloseTo(3, 1);
});

test('a ray that leaves the frame misses, which is the delegation working', () => {
  /*
   * **The guarantee itself is not this file's, and saying so is the point.** A march that clamps
   * its sample to the edge of the frame acquires a smear of whatever is at that edge and drags it
   * as the camera turns — the unbounded error `ROADMAP.md` refused screen-space global
   * illumination over. `traceScreenSpaceRay` refuses to sample outside the frame and `projectToUv`
   * refuses to produce a position for a point that is outside it, and both refusals are pinned
   * where they live: *stops where the ray leaves the frame rather than sampling the border* and
   * *refuses a point outside the frame rather than clamping to its border*, in
   * `screenSpaceReflection.test.ts`. The first of those counts its samples, which it did not until
   * this wave went looking — asserting only the outcome passed a march that clamped and read the
   * border anyway, because the *thickness* check happened to reject what it found.
   *
   * What this asserts is that the adapter does not defeat any of that on its way past.
   */
  const hit = newScreenSpaceHit();
  const found = traceScreen(
    [0, 0, -2],
    [0, 1, 0],
    [1, 0, -0.05],
    EYE,
    GI_SCREEN_MARCH,
    project,
    sceneDistance,
    hit,
  );

  expect(found).toBe(false);
  expect(hit.hit).toBe(false);
});

test('A RAY BEHIND A SURFACE MISSES, rather than hitting the thing standing in front of it', () => {
  /*
   * **A hit is a crossing, not a comparison.** A ray that is already further from the eye than
   * whatever the frame drew has not crossed anything; it is looking at the back of the world, and
   * the surface between it and the eye is one it can never reach. Reporting that surface is how a
   * screen-space method invents light behind walls.
   */
  /*
   * **Twenty centimetres behind it, which is inside the march's own thickness.** A metre behind is
   * not a test of the crossing rule at all: the thickness check rejects that on its own, so a
   * march that took any comparison for a hit would still pass. The crossing rule is the only thing
   * standing between a ray this close behind a surface and a hit on it.
   */
  const hit = newScreenSpaceHit();
  const found = traceScreen(
    [0, 0, -5.2],
    [0, 0, 1],
    [0, 0, -1],
    EYE,
    GI_SCREEN_MARCH,
    project,
    sceneDistance,
    hit,
  );

  expect(found).toBe(false);
});

test('a ray through the hole in the wall keeps going rather than stopping at its edge', () => {
  /* Sky is not a surface. A ray crossing it must carry on, which is what lets light through a
     doorway; the march records "in front of nothing" rather than treating it as a miss. */
  const hit = newScreenSpaceHit();
  const found = traceScreen(
    [3.2, 0, -4],
    [0, 0, 1],
    [0, 0, 1],
    EYE,
    GI_SCREEN_MARCH,
    project,
    sceneDistance,
    hit,
  );
  expect(found).toBe(false);
});

test('A RAY DOES NOT HIT THE SURFACE IT STARTED ON, which the bias is the whole reason for', () => {
  /*
   * **The failure this prevents is the one the effect is remembered for.** A ray leaving a surface
   * nearly tangent to it stays within the depth buffer's own rounding of that surface for its whole
   * length, so its samples land a fraction in front and a fraction behind in whatever order the
   * quantisation happens to produce — and one pair in the wrong order is a crossing. Across a
   * floor that is every pixel at once, and it reads as speckle rather than as a trace being wrong.
   *
   * The bias has to be larger than the depth buffer's quantum, and `SCREEN_TRACE_BIAS_M` says so.
   */
  expect(SCREEN_TRACE_BIAS_M).toBeGreaterThan(DEPTH_QUANTUM_M);

  const hit = newScreenSpaceHit();
  const offenders: string[] = [];
  /* Twenty rays fanned along the wall, every one of them nearly tangent to it. */
  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    const found = traceScreen(
      [(i - 10) * 0.05, 0, WALL_Z],
      [0, 0, 1],
      /* Exactly tangent. Any component along the normal would do the bias's job for it. */
      [Math.cos(angle), Math.sin(angle), 0],
      EYE,
      GI_SCREEN_MARCH,
      project,
      sceneDistance,
      hit,
    );
    if (found) offenders.push(`ray ${i} hit its own wall at ${hit.distanceM.toFixed(4)} m`);
  }
  expect(offenders).toEqual([]);
});

test('the bias lifts the origin along the normal and leaves the direction alone', () => {
  const out = new Float32Array(3);
  screenRayOrigin([1, 2, 3], [0, 1, 0], 0.25, out);
  expect(Array.from(out)).toEqual([1, 2.25, 3]);

  /* A normal that is not unit length is normalised, because a caller's is often interpolated. */
  screenRayOrigin([0, 0, 0], [0, 4, 0], 0.5, out);
  expect(Array.from(out)).toEqual([0, 0.5, 0]);

  /* A zero normal has no direction to lift along, so it lifts by nothing rather than by NaN. */
  screenRayOrigin([7, 8, 9], [0, 0, 0], 0.5, out);
  expect(Array.from(out)).toEqual([7, 8, 9]);
});
