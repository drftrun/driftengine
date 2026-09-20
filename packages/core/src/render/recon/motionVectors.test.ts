import { mat4, vec4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { jitterProjection } from '../temporalAa.ts';
import {
  MOTION_FORMAT,
  cameraMotion,
  objectMotion,
  skinVertex,
  unjitteredUv,
} from './motionVectors.ts';

/**
 * Where a pixel's surface was last frame.
 *
 * **A motion vector is the offset from this frame's pixel to where its surface was, in the
 * coordinates of an unjittered frame.** Every reconstruction step after this reads it that way: the
 * history is a picture of the unjittered scene, so a vector that carried either frame's jitter would
 * look every sample up a fraction of a pixel away, in a pattern that repeats with the jitter period —
 * which reads as shimmer and is diagnosed as everything except its cause.
 *
 * Coordinates here are clip-up: `u` and `v` run 0 to 1 with `v = 0` where clip y is -1.
 */

const EYE_AT = (x: number): Float64Array =>
  mat4.lookAt(new Float64Array(16), [x, 1, 5], [x, 1, 0], [0, 1, 0]) as Float64Array;
const LENS = mat4.perspective(new Float64Array(16), Math.PI / 3, 16 / 9, 0.1, 100) as Float64Array;

function viewProj(view: Float64Array, lens = LENS): Float64Array {
  return mat4.multiply(new Float64Array(16), lens, view) as Float64Array;
}

/** A world point's clip-up uv and clip depth under a view-projection. */
function project(m: Float64Array, p: readonly number[]): [number, number, number] {
  const clip = vec4.transformMat4(
    new Float64Array(4),
    Float64Array.of(p[0] as number, p[1] as number, p[2] as number, 1),
    m,
  );
  return [(clip[0] / clip[3]) * 0.5 + 0.5, (clip[1] / clip[3]) * 0.5 + 0.5, clip[2] / clip[3]];
}

/** `previous × inverse(current)`, the matrix both renderers already build for motion blur. */
function reprojection(previous: Float64Array, current: Float64Array): Float64Array {
  const out = mat4.invert(new Float64Array(16), current) as Float64Array;
  return mat4.multiply(out, previous, out) as Float64Array;
}

const SURFACE = [0.4, 1.3, -2] as const;

test('the target is two half-float motion channels and a flag, at the render size', () => {
  expect(MOTION_FORMAT).toBe('rgba16float');
});

test('a still camera over a still surface has no motion', () => {
  const m = viewProj(EYE_AT(0));
  const [u, v, z] = project(m, SURFACE);
  const out = new Float32Array(2).fill(9);
  expect(cameraMotion(reprojection(m, m), u, v, z, out)).toBe(true);
  expect(Math.abs(out[0] as number)).toBeLessThan(1e-6);
  expect(Math.abs(out[1] as number)).toBeLessThan(1e-6);
});

test('a camera moving right leaves the surface where it was, which is to the right of here', () => {
  /*
   * The eye steps right, so this frame sees the surface further left than last frame did: the
   * vector from here back to where it was points right.
   */
  const before = viewProj(EYE_AT(0));
  const after = viewProj(EYE_AT(0.2));
  const [u, v, z] = project(after, SURFACE);
  const out = new Float32Array(2);
  expect(cameraMotion(reprojection(before, after), u, v, z, out)).toBe(true);
  const was = project(before, SURFACE);
  expect(out[0]).toBeGreaterThan(0.005);
  expect(out[0]).toBeCloseTo(was[0] - u, 6);
  expect(out[1]).toBeCloseTo(was[1] - v, 6);
});

test('a camera that turns, rises and closes in moves every surface to where it projected before', () => {
  /*
   * **Exact against the projection, at points across the frame and at different depths.** A step
   * sideways leaves the reprojected w at exactly one, so a test of that alone cannot tell a vector
   * divided by w from one that is not; a turn and a dolly cannot be told apart from anything else by
   * a sign.
   */
  const before = viewProj(EYE_AT(0));
  const moved = mat4.lookAt(new Float64Array(16), [0.3, 1.4, 4.2], [-0.5, 1.1, 0], [0, 1, 0]);
  const after = viewProj(moved as Float64Array);
  const matrix = reprojection(before, after);
  let largest = 0;
  for (const point of [
    [0.4, 1.3, -2],
    [-1.5, 0.2, -6],
    [2, 2.5, -1],
    [-0.3, -0.8, -12],
  ]) {
    const [u, v, z] = project(after, point);
    const out = new Float32Array(2);
    expect(cameraMotion(matrix, u, v, z, out)).toBe(true);
    const was = project(before, point);
    expect(out[0], point.join()).toBeCloseTo(was[0] - u, 6);
    expect(out[1]).toBeCloseTo(was[1] - v, 6);
    largest = Math.max(largest, Math.abs(was[1] - v));
  }
  /* The vertical half moved too, or its sign was never asked about. */
  expect(largest).toBeGreaterThan(0.01);
});

test('a surface that was behind the eye last frame has nowhere to have been', () => {
  const before = mat4.lookAt(
    new Float64Array(16),
    [0, 1, -10],
    [0, 1, -20],
    [0, 1, 0],
  ) as Float64Array;
  const after = viewProj(EYE_AT(0));
  const [u, v, z] = project(after, SURFACE);
  const out = new Float32Array(2).fill(9);
  expect(cameraMotion(reprojection(viewProj(before), after), u, v, z, out)).toBe(false);
  expect(Array.from(out)).toEqual([0, 0]);
});

test('an object moving under a still camera moves and its background does not', () => {
  const m = viewProj(EYE_AT(0));
  const modelBefore = mat4.fromTranslation(new Float64Array(16), [0, 0, 0]) as Float64Array;
  const modelAfter = mat4.fromTranslation(new Float64Array(16), [0.3, 0, 0]) as Float64Array;
  const local = Float64Array.of(0.4, 1.3, -2, 1);
  const clip = (model: Float64Array): Float64Array => {
    const world = vec4.transformMat4(new Float64Array(4), local, model);
    return vec4.transformMat4(new Float64Array(4), world, m) as Float64Array;
  };
  const out = new Float32Array(2);
  expect(objectMotion(clip(modelAfter), clip(modelBefore), out)).toBe(true);
  /* It moved right, so where it was is to the left — by exactly the difference of its projections. */
  expect(out[0]).toBeLessThan(-0.005);
  expect(out[0]).toBeCloseTo(project(m, [0.4, 1.3, -2])[0] - project(m, [0.7, 1.3, -2])[0], 6);
  expect(Math.abs(out[1] as number)).toBeLessThan(1e-6);
  /* The wall behind it takes the camera's motion, which is none. */
  const [u, v, z] = project(m, [0, 1, -8]);
  const wall = new Float32Array(2);
  cameraMotion(reprojection(m, m), u, v, z, wall);
  expect(Math.abs(wall[0] as number)).toBeLessThan(1e-6);
  /* And a vertex behind either eye has no motion to state. */
  const behind = Float64Array.of(0, 0, 0, -1);
  expect(objectMotion(clip(modelAfter), behind, out)).toBe(false);
  expect(Array.from(out)).toEqual([0, 0]);
  out.fill(9);
  expect(objectMotion(behind, clip(modelBefore), out)).toBe(false);
  expect(Array.from(out)).toEqual([0, 0]);
});

test('A SKINNED VERTEX MOVES WITH ITS PREVIOUS POSE, not with its previous object transform', () => {
  /*
   * **The case that makes an animated character ghost.** The rig stands still — the same model
   * matrix both frames — and its arm swings: the palette changed. A motion vector taken from the
   * model alone is zero on the arm, and the resolve then blends the arm's history where the arm is
   * no longer.
   */
  const m = viewProj(EYE_AT(0));
  const model = new Float64Array(mat4.create());
  const rest = new Float32Array(16 * 2);
  rest.set(mat4.create(), 0);
  rest.set(mat4.create(), 16);
  const swung = new Float32Array(rest);
  swung.set(mat4.fromTranslation(mat4.create(), [0, 0.5, 0]), 16);
  /* And a joint that turns a quarter about z, so a palette read the wrong way round is caught. */
  const turned = new Float32Array(rest);
  turned.set(mat4.fromZRotation(mat4.create(), Math.PI / 2), 16);
  const bent = new Float64Array(4);
  skinVertex(turned, [0, 1, 0, 0], [0.25, 0.75, 0, 0], [0.4, 1.3, -2], bent);
  /* A quarter turn takes (0.4, 1.3) to (-1.3, 0.4); a quarter of it stays, three quarters turn. */
  expect(bent[0]).toBeCloseTo(0.25 * 0.4 + 0.75 * -1.3, 6);
  expect(bent[1]).toBeCloseTo(0.25 * 1.3 + 0.75 * 0.4, 6);
  expect(bent[2]).toBeCloseTo(-2, 6);
  const joints = [0, 1, 0, 0];
  const weights = [0.25, 0.75, 0, 0];
  const position = [0.4, 1.3, -2];
  const clipOf = (palette: Float32Array): Float64Array => {
    const local = new Float64Array(4);
    skinVertex(palette, joints, weights, position, local);
    expect(local[3]).toBeCloseTo(1, 12);
    const world = vec4.transformMat4(new Float64Array(4), local, model);
    return vec4.transformMat4(new Float64Array(4), world, m) as Float64Array;
  };
  /* Three quarters of half a unit up, weighted by the joint that moved. */
  const moved = new Float64Array(4);
  skinVertex(swung, joints, weights, position, moved);
  expect(moved[0]).toBeCloseTo(0.4, 12);
  expect(moved[1]).toBeCloseTo(1.3 + 0.375, 12);
  expect(moved[2]).toBeCloseTo(-2, 12);
  expect(moved[3]).toBeCloseTo(1, 12);
  const out = new Float32Array(2);
  expect(objectMotion(clipOf(swung), clipOf(rest), out)).toBe(true);
  expect(out[1]).toBeLessThan(-0.01);
  /* The model alone says it never moved, which is the defect. */
  const still = new Float32Array(2);
  objectMotion(clipOf(rest), clipOf(rest), still);
  expect(Array.from(still)).toEqual([0, 0]);
});

test('THE JITTER NEVER ENTERS A MOTION VECTOR, so two differently jittered frames meet on one surface', () => {
  /*
   * Frame A and frame B are drawn with different jitter. Each observed the surface at its jittered
   * position; taking the jitter back out and following the motion from B lands where A's
   * unjittered picture — the history — holds the surface. Followed through the jittered matrices
   * instead, it lands where A *observed* the surface, which is A's jitter away from the history:
   * three tenths of a pixel here, a different amount every frame, which is the shimmer.
   */
  const width = 1280;
  const height = 720;
  const cleanA = viewProj(EYE_AT(0));
  const cleanB = viewProj(EYE_AT(0.1));
  const jittered = (m: Float64Array, jx: number, jy: number): Float64Array =>
    jitterProjection(new Float64Array(16), m, jx, jy, width, height) as Float64Array;
  const jA: [number, number] = [0.3, -0.2];
  const jB: [number, number] = [-0.25, 0.35];
  const seenA = project(jittered(cleanA, ...jA), SURFACE);
  const seenB = project(jittered(cleanB, ...jB), SURFACE);

  const here = new Float32Array(2);
  unjitteredUv(seenB[0], seenB[1], jB[0], jB[1], width, height, here);
  const motion = new Float32Array(2);
  expect(
    cameraMotion(
      reprojection(cleanA, cleanB),
      here[0] as number,
      here[1] as number,
      seenB[2],
      motion,
    ),
  ).toBe(true);
  const was = new Float32Array(2);
  unjitteredUv(seenA[0], seenA[1], jA[0], jA[1], width, height, was);
  expect(((here[0] as number) + (motion[0] as number) - (was[0] as number)) * width).toBeCloseTo(
    0,
    3,
  );
  expect(((here[1] as number) + (motion[1] as number) - (was[1] as number)) * height).toBeCloseTo(
    0,
    3,
  );

  /* The same lookup through the jittered matrices misses by the jitter difference. */
  const wrong = new Float32Array(2);
  cameraMotion(
    reprojection(jittered(cleanA, ...jA), jittered(cleanB, ...jB)),
    seenB[0],
    seenB[1],
    seenB[2],
    wrong,
  );
  const missX = (seenB[0] + (wrong[0] as number) - (was[0] as number)) * width;
  expect(missX).toBeCloseTo(jA[0], 3);
});

test('taking the jitter out is the jitter in uv units, the right way round in each axis', () => {
  const out = new Float32Array(2);
  unjitteredUv(0.5, 0.5, 0.25, -0.5, 100, 50, out);
  /* A quarter pixel right on a hundred-pixel frame is 0.0025 of it; half a pixel down on fifty, 0.01. */
  expect(out[0]).toBeCloseTo(0.4975, 7);
  expect(out[1]).toBeCloseTo(0.51, 7);
});
