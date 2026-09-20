import { expect, test } from 'vitest';

import { derivedTangentFrame, surfaceLod } from './surfaceFrame.ts';

type Vec3 = [number, number, number];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(a: Vec3): Vec3 {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('A MIP LEVEL IS HOW MANY TEXELS ONE PIXEL COVERS, as a power of two', () => {
  /* One pixel steps a sixty-fourth of the texture across a 256-texel layer: four texels, level 2. */
  expect(surfaceLod(1 / 64, 0, 0, 0, 256)).toBeCloseTo(2, 9);
  /* The longer of the two axes decides, and its length is its length rather than its larger lane. */
  expect(surfaceLod(0, 0, 3 / 256, 4 / 256, 256)).toBeCloseTo(Math.log2(5), 9);
  /* Magnified — less than a texel a pixel — is level 0, never negative. */
  expect(surfaceLod(1 / 1024, 0, 0, 1 / 1024, 256)).toBe(0);
  /* And a surface whose UVs do not move at all is level 0 rather than a logarithm of zero. */
  expect(surfaceLod(0, 0, 0, 0, 256)).toBe(0);
});

test('THE DERIVED FRAME IS THE SURFACE’S OWN U AND V, for any screen map of either handedness', () => {
  /*
   * The algebra is in the plan and in the module: dt and db come out as the determinant times U
   * and V, and the fold and the scale divide it away exactly. So this is asserted against the
   * axes the surface was built from, never against the formula.
   */
  const random = lcg(0x7a11f00d);
  const out = new Float32Array(6);
  for (let trial = 0; trial < 300; trial += 1) {
    const U = normalise([random() - 0.5, random() - 0.5, random() - 0.5]);
    const helper = normalise([random() - 0.5, random() - 0.5, random() - 0.5]);
    const V = normalise(cross(cross(U, helper), U));
    const n = cross(U, V);
    let [a, b, c, d] = [random() - 0.5, random() - 0.5, random() - 0.5, random() - 0.5];
    if (Math.abs(a * d - b * c) < 1e-3) continue;
    /* Half of them mirrored, which is what a WebGPU framebuffer's downward y does to a pixel. */
    if (trial % 2 === 1) [b, d] = [-b, -d];
    const dp1: Vec3 = [U[0] * a + V[0] * c, U[1] * a + V[1] * c, U[2] * a + V[2] * c];
    const dp2: Vec3 = [U[0] * b + V[0] * d, U[1] * b + V[1] * d, U[2] * b + V[2] * d];
    derivedTangentFrame(n, dp1, dp2, [a, c], [b, d], out);
    for (let k = 0; k < 3; k += 1) {
      expect(out[k], `trial ${trial} tangent`).toBeCloseTo(U[k] as number, 4);
      expect(out[3 + k], `trial ${trial} bitangent`).toBeCloseTo(V[k] as number, 4);
    }
  }
});

test('a UV layout stretched along one axis keeps both directions and one shared scale', () => {
  /*
   * u changes twice as fast as v across the same world distance, so u's gradient is twice as long.
   * The frame is a pair of cotangents: the directions stay +x and -z, and the longer one is scaled
   * to one with the shorter keeping its proportion — the "one scale for both axes" tangentFrame.ts
   * insists on, because two scales would shear the layout.
   */
  const out = new Float32Array(6);
  derivedTangentFrame([0, 1, 0], [1, 0, 0], [0, 0, -1], [2, 0], [0, 1], out);
  expect(Array.from(out).map((x) => Math.round(x * 1e6) / 1e6 + 0)).toEqual([1, 0, 0, 0, 0, -0.5]);
});

test('A MESH WITH NO UVS GIVES NO FRAME, so a normal map on it cannot turn the normal', () => {
  /* Every UV zero, which is what the upload writes for a mesh that carried none. */
  const out = new Float32Array(6);
  derivedTangentFrame([0, 1, 0], [1, 0, 0], [0, 0, 1], [0, 0], [0, 0], out);
  expect(Array.from(out).every((x) => Math.abs(x) < 1e-9)).toBe(true);
});
