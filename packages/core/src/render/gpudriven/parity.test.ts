/**
 * The two pipelines agree about what a pixel is looking at.
 *
 * **Pixel identity between the two frames would be dishonest to claim and is not what this
 * checks.** They are different frames: different rasterisation rules, a different lighting subset
 * while the second pipeline is a draft, and a shading pass that runs per material rather than per
 * draw. What *must* hold — and what is the only thing that can silently drift — is the
 * reconstruction: a visibility buffer records a triangle and nothing else, so every attribute the
 * shading needs is interpolated afterwards, where the forward path is handed varyings the
 * rasteriser interpolated for it.
 *
 * **So the reference is the surface, not the other pipeline.** A pixel is a ray; the ray meets the
 * triangle at one world point; the attribute there is the weighted sum of the vertices' by that
 * point's own barycentrics. That definition mentions no screen and no `w`, which is exactly what
 * makes it an independent check of a formula written entirely in terms of both. Deriving the
 * expected value from the screen-space formula would be the formula agreeing with itself.
 *
 * The three things asserted, in the order they can go wrong:
 *
 * 1. The reconstruction is the surface's own value, on a triangle steep enough for the
 *    perspective to matter.
 * 2. **With the correction turned off it is not** — the 2026-08 rule about asserting against the
 *    mechanism disabled. A number on its own says a test ran; a pair says the mechanism does
 *    something.
 * 3. The analytic gradients are the reconstruction's own rate of change, against a finite
 *    difference of it. A compute invocation has no `dpdx`, so this is the only thing standing
 *    between a texture fetch and a mip level chosen at random.
 *
 * ## What the two pipelines measure at, on a picture, and when
 *
 * **Measured 2026-09-16 on an AMD Radeon RX 9070 XT (ANGLE, Vulkan, RADV), WebGPU, 1280x720**, by
 * capturing each draft rig twice — once as it stands and once with `?pipeline=forward`, which
 * draws the same geometry through `createMesh`/`drawMesh`:
 *
 * ```sh
 * npx vite demo/dev --port 5199
 * node scripts/shots.mjs capture gpud --base=http://localhost:5199 --backend=webgpu --scenes=14 --hold=60
 * node scripts/shots.mjs capture fwd  --base=http://localhost:5199 --backend=webgpu --scenes=14 --hold=60 --query=pipeline=forward
 * node scripts/shots.mjs diff fwd-webgpu gpud-webgpu --scenes=14,15,16 --delta=16 --region=0,120,1280,560
 * ```
 *
 * | rig       | pixels past delta 16 | mean delta | mean luminance, forward to gpu-driven |
 * | --------- | -------------------- | ---------- | ------------------------------------- |
 * | dense     | 11,353 of 563,200    | 41.4       | 70.3 to 69.4                          |
 * | occlusion | **0** of 563,200     | 0.0        | 62.7 to 62.7                          |
 * | materials | 10,144 of 563,200    | 70.4       | 57.2 to 58.3                          |
 *
 * **The occlusion rig is pixel-identical between the two pipelines**, which is a stronger
 * statement than the bound this file was written expecting and is worth saying plainly: where the
 * two compute the same lighting they agree to the pixel, interpolation included. That rig's
 * materials are white with no emissive and its environment has no shadow map and no probe, so the
 * forward path's standard material reduces to exactly the expression `shade.wgsl.ts` carries.
 *
 * The other two differ where the shading subset shows: the dense rig interpolates a colour that
 * varies per vertex across triangles smaller than a pixel, and the materials rig uses the emissive
 * term, which the forward path applies through `emissiveGain` and a different expression. **Two
 * per cent of the region on the dense rig**, against 39% before `depthCorrection` — the figures
 * this table held until 2026-09-16 were measured through a projection that mirrored the picture
 * vertically, so they were comparing a scene with its own reflection.
 *
 * **Re-measure when the shading gains a term, and expect the two counts to fall to the occlusion
 * rig's.** A drift in the reconstruction moves the luminance; a missing lighting term moves the
 * count and leaves it.
 */

import { expect, test } from 'vitest';

import {
  SCREEN_VERTEX_FLOATS,
  attributeGradients,
  barycentricGradients,
  interpolate,
  perspectiveBarycentrics,
  screenBarycentrics,
  screenVertex,
} from './shadeBins.ts';

const WIDTH = 640;
const HEIGHT = 360;
const FOV_Y = Math.PI / 3;
const ASPECT = WIDTH / HEIGHT;
const FOCAL = 1 / Math.tan(FOV_Y / 2);

/**
 * A camera at the origin looking down −z, written out rather than built from a matrix.
 *
 * The projection is three lines at this position, and writing it out is what lets the ray below be
 * written out too — the check needs both halves to be independent, and two functions derived from
 * one matrix are not.
 */
function clipOf(p: readonly [number, number, number]): [number, number, number] {
  return [(p[0] * FOCAL) / ASPECT, p[1] * FOCAL, -p[2]];
}

/** The world direction a pixel centre looks along. */
function rayOf(px: number, py: number): [number, number, number] {
  const ndcX = (px / WIDTH) * 2 - 1;
  const ndcY = (py / HEIGHT) * 2 - 1;
  return [(ndcX * ASPECT) / FOCAL, ndcY / FOCAL, -1];
}

type Vec3 = readonly [number, number, number];

function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Where a pixel's ray meets the triangle, and the attribute the surface carries there.
 *
 * Möller's plane intersection and then areal coordinates, both in world space. Answers null where
 * the ray misses, which a caller must treat as "pick another pixel" rather than as a zero.
 */
function surfaceAt(
  a: Vec3,
  b: Vec3,
  c: Vec3,
  attributes: readonly [number, number, number],
  px: number,
  py: number,
): number | null {
  const direction = rayOf(px, py);
  const normal = cross(sub(b, a), sub(c, a));
  const denominator = dot(normal, direction);
  if (Math.abs(denominator) < 1e-12) return null;
  const t = dot(normal, a) / denominator;
  if (!(t > 0)) return null;
  const hit: [number, number, number] = [direction[0] * t, direction[1] * t, direction[2] * t];

  const whole = dot(normal, normal);
  const wa = dot(normal, cross(sub(b, hit), sub(c, hit))) / whole;
  const wb = dot(normal, cross(sub(c, hit), sub(a, hit))) / whole;
  const wc = 1 - wa - wb;
  if (wa < 0 || wb < 0 || wc < 0) return null;
  return attributes[0] * wa + attributes[1] * wb + attributes[2] * wc;
}

/** The visibility-buffer reconstruction, exactly as `shadeBins.ts` composes it. */
function reconstruct(
  a: Vec3,
  b: Vec3,
  c: Vec3,
  attributes: readonly [number, number, number],
  px: number,
  py: number,
  correct = true,
): { value: number; screen: Float32Array; lambda: Float32Array; weights: Float32Array } | null {
  const screen = new Float32Array(3 * SCREEN_VERTEX_FLOATS);
  const corners = [a, b, c];
  for (let i = 0; i < 3; i += 1) {
    const clip = clipOf(corners[i] as Vec3);
    if (!screenVertex(clip[0], clip[1], clip[2], WIDTH, HEIGHT, screen, i * SCREEN_VERTEX_FLOATS)) {
      return null;
    }
  }
  const lambda = new Float32Array(3);
  if (!screenBarycentrics(screen, px, py, lambda)) return null;
  const weights = new Float32Array(3);
  if (correct) {
    if (!perspectiveBarycentrics(screen, lambda, weights)) return null;
  } else {
    /* The affine version: the screen weights used as they stand. This is the classic
       affine-texturing look, and on a floor it is unmistakable. */
    weights.set(lambda);
  }
  return {
    value: interpolate(attributes[0], attributes[1], attributes[2], weights),
    screen,
    lambda,
    weights,
  };
}

/**
 * A triangle steep enough for the perspective to matter, and asymmetric in every way it can be.
 *
 * **Every vertex at a different depth and every attribute a different value.** A fixture with two
 * vertices at one depth makes the perspective denominator constant along an axis, and one with a
 * zero attribute multiplies a weight away — both hid perturbations elsewhere in this wave, and
 * both would hide the difference this file exists to measure.
 */
const A: Vec3 = [-3.1, -1.4, -3.2];
const B: Vec3 = [4.3, -1.1, -14.7];
const C: Vec3 = [0.7, 3.9, -7.1];
const ATTRIBUTES: readonly [number, number, number] = [0.17, 0.83, 0.41];

/** Pixels inside the triangle, found once so every test below asks about the same points. */
const INSIDE: Array<[number, number]> = [];
for (let py = 4.5; py < HEIGHT; py += 11) {
  for (let px = 4.5; px < WIDTH; px += 11) {
    if (surfaceAt(A, B, C, ATTRIBUTES, px, py) !== null) INSIDE.push([px, py]);
  }
}

test('the fixture covers enough of the frame for the comparison to mean anything', () => {
  /* A check that compared four pixels would pass on a formula that is wrong nearly everywhere. */
  expect(INSIDE.length).toBeGreaterThan(300);
});

test('THE RECONSTRUCTION IS WHAT THE SURFACE CARRIES WHERE THE PIXEL LOOKS', () => {
  let worst = 0;
  for (const [px, py] of INSIDE) {
    const wanted = surfaceAt(A, B, C, ATTRIBUTES, px, py) as number;
    const got = reconstruct(A, B, C, ATTRIBUTES, px, py);
    expect(got).not.toBeNull();
    worst = Math.max(worst, Math.abs((got as { value: number }).value - wanted));
  }
  /*
   * **2e-6 of a range of 0.66**, which is float32 arithmetic and not an approximation: both halves
   * are exact in real arithmetic and differ only by the order the products are summed in.
   */
  expect(worst).toBeLessThan(2e-6);
});

test('AND WITHOUT THE CORRECTION IT IS NOT, which is what makes the number above a measurement', () => {
  let worst = 0;
  for (const [px, py] of INSIDE) {
    const wanted = surfaceAt(A, B, C, ATTRIBUTES, px, py) as number;
    const got = reconstruct(A, B, C, ATTRIBUTES, px, py, false);
    worst = Math.max(worst, Math.abs((got as { value: number }).value - wanted));
  }
  /* 0.1 of a 0.66 range — a sixth of the whole span, on one triangle. */
  expect(worst).toBeGreaterThan(0.1);
});

test('THE ANALYTIC GRADIENTS ARE THE RECONSTRUCTION’S OWN RATE OF CHANGE', () => {
  /*
   * Against a central difference of the reconstruction itself, because that is the quantity a
   * texture fetch's level of detail is computed from. A fragment shader differences its
   * neighbours; a compute invocation has none, so this is derived — and an undetected error here
   * is a mip level chosen at random, which reads as a texture that sparkles rather than as a
   * missing derivative.
   */
  const step = 0.25;
  let worst = 0;
  let sampled = 0;
  for (const [px, py] of INSIDE) {
    const at = reconstruct(A, B, C, ATTRIBUTES, px, py);
    if (at === null) continue;
    const gradients = new Float32Array(6);
    expect(barycentricGradients(at.screen, at.lambda, gradients)).toBe(true);
    const analytic = attributeGradients(ATTRIBUTES[0], ATTRIBUTES[1], ATTRIBUTES[2], gradients);

    const right = reconstruct(A, B, C, ATTRIBUTES, px + step, py);
    const left = reconstruct(A, B, C, ATTRIBUTES, px - step, py);
    const down = reconstruct(A, B, C, ATTRIBUTES, px, py + step);
    const up = reconstruct(A, B, C, ATTRIBUTES, px, py - step);
    if (right === null || left === null || down === null || up === null) continue;
    sampled += 1;

    const dx = (right.value - left.value) / (2 * step);
    const dy = (down.value - up.value) / (2 * step);
    const scale = Math.max(Math.abs(dx), Math.abs(dy), 1e-5);
    worst = Math.max(worst, Math.abs(analytic.dx - dx) / scale, Math.abs(analytic.dy - dy) / scale);
  }
  expect(sampled).toBeGreaterThan(300);
  /*
   * **1e-3 relative, and the floor is the difference rather than the derivative.** A central
   * difference of a ratio of linear functions carries a second-order error in the step, so
   * tightening this means shrinking the step until the subtraction loses its own significance.
   */
  expect(worst).toBeLessThan(1e-3);
});
