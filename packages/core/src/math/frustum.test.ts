import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import {
  boxInFrustum,
  createFrustum,
  frustumFromViewProjection,
  sphereInFrustum,
} from './frustum.ts';

/** A camera at the origin looking down -Z with a ninety-degree field of view. */
function lookingDownZ(): Float32Array {
  const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 100);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  return mat4.multiply(mat4.create(), projection, view) as Float32Array;
}

const ahead = (): Float32Array => frustumFromViewProjection(lookingDownZ(), createFrustum());

test('a point straight ahead is inside', () => {
  expect(sphereInFrustum(ahead(), 0, 0, -10, 1)).toBe(true);
});

test('a point behind the camera is outside', () => {
  expect(sphereInFrustum(ahead(), 0, 0, 10, 1)).toBe(false);
});

test('a point in front of the near plane is outside', () => {
  expect(sphereInFrustum(ahead(), 0, 0, -0.1, 0.01)).toBe(false);
});

test('a point past the far plane is outside', () => {
  expect(sphereInFrustum(ahead(), 0, 0, -200, 1)).toBe(false);
});

/**
 * The half of the test a normalisation bug hides.
 *
 * Without normalised planes the distance comes out in unscaled clip units, so comparing it
 * against a radius in metres compares two different quantities. The symptom is objects appearing
 * and vanishing at the edge of the screen, which reads as a threshold to be tuned rather than as
 * arithmetic to be fixed.
 */
test('a sphere outside the edge is kept when its radius reaches in', () => {
  const frustum = ahead();
  /* At z = -10 with a ninety-degree field of view the right edge of the frustum is at x = 10. */
  expect(sphereInFrustum(frustum, 12, 0, -10, 0.5), 'well outside, and small').toBe(false);
  expect(sphereInFrustum(frustum, 12, 0, -10, 4), 'outside, but big enough to show').toBe(true);

  /*
   * **The radius that separates a normalised test from an unnormalised one**, and the first two
   * assertions do not. Straight out of the matrix this frustum's side planes have a normal of
   * length √2, so an unnormalised test reports this sphere's centre 2.0 outside the right plane
   * where it is really 1.414 — and a radius between those two numbers is answered differently by
   * the two implementations. Both of the cases above are far enough from the boundary that the
   * factor does not reach the decision, which is exactly how a test like this comes to be
   * written and to prove nothing. Verified by deleting the normalisation and watching this line
   * fail on its own.
   */
  expect(sphereInFrustum(frustum, 12, 0, -10, 1.7), 'reaches in by 0.29 metres').toBe(true);
});

/**
 * A sphere spanning the whole frustum is inside it, and a plane-by-plane test says so only if it
 * asks the right question. Testing "is the centre inside every plane" fails here.
 */
test('a sphere larger than the frustum is inside it', () => {
  expect(sphereInFrustum(ahead(), 0, 0, -50, 500)).toBe(true);
});

test('an aspect ratio wider than tall widens what is visible', () => {
  const projection = mat4.perspective(mat4.create(), Math.PI / 2, 4, 1, 100);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const wide = frustumFromViewProjection(
    mat4.multiply(mat4.create(), projection, view) as Float32Array,
    createFrustum(),
  );
  expect(sphereInFrustum(wide, 25, 0, -10, 0.1), 'inside the wide frustum').toBe(true);
  expect(sphereInFrustum(ahead(), 25, 0, -10, 0.1), 'outside the square one').toBe(false);
});

test('it fills the frustum it was given rather than making one', () => {
  const out = createFrustum();
  expect(frustumFromViewProjection(lookingDownZ(), out)).toBe(out);
  expect(out.length, 'six planes of four').toBe(24);
});

/**
 * A box is outside only when it is wholly beyond one plane, which is the corner of it furthest
 * along that plane's normal being beyond it.
 *
 * **The corner is chosen per plane**, and a test that took one fixed corner — the maximum, say —
 * would answer correctly for half the planes and cull a box straddling the other half.
 */
test('a box is kept unless it lies wholly beyond one plane', () => {
  const frustum = ahead();
  /* In front, across the right edge at x = 10 when z = -10, and wholly past it. */
  expect(boxInFrustum(frustum, -1, -1, -11, 1, 1, -9)).toBe(true);
  expect(boxInFrustum(frustum, 9, -1, -11, 12, 1, -9)).toBe(true);
  expect(boxInFrustum(frustum, 12, -1, -11, 14, 1, -9)).toBe(false);
  /* Across the left edge, where the corner that matters is the minimum rather than the maximum. */
  expect(boxInFrustum(frustum, -12, -1, -11, -9, 1, -9)).toBe(true);
  expect(boxInFrustum(frustum, -14, -1, -11, -12, 1, -9)).toBe(false);
  /* Behind the eye, and past the far plane. */
  expect(boxInFrustum(frustum, -1, -1, 1, 1, 1, 3)).toBe(false);
  expect(boxInFrustum(frustum, -1, -1, -300, 1, 1, -200)).toBe(false);
  /*
   * A box meeting the frustum only along the edge where the right plane crosses z = -10 is kept,
   * as a sphere touching it is: the question is "wholly beyond", and touching is not beyond.
   */
  expect(boxInFrustum(frustum, 10, -1, -10, 12, 1, -8)).toBe(true);
  /* A box around the whole frustum contains it, and no plane has all of that box beyond it. */
  expect(boxInFrustum(frustum, -500, -500, -500, 500, 500, 500)).toBe(true);
});

test('the planes come out in double precision when they are asked for in it', () => {
  /*
   * A world past 2^24 metres has plane offsets a single-precision array cannot hold to the metre.
   * The same extraction writes whichever array it is handed.
   */
  const eye = 2 ** 26 + 0.25;
  const projection = mat4.perspective(new Float64Array(16), Math.PI / 2, 1, 1, 100);
  const view = mat4.lookAt(new Float64Array(16), [eye, 0, 0], [eye, 0, -1], [0, 1, 0]);
  const planes = frustumFromViewProjection(
    mat4.multiply(new Float64Array(16), projection, view),
    new Float64Array(24),
  );
  expect(planes).toBeInstanceOf(Float64Array);
  /* The left plane passes through the eye: its offset is the eye's x along its normal, exactly. */
  const offset = -((planes[0] as number) * eye + (planes[3] as number));
  expect(Math.abs(offset)).toBeLessThan(1e-6);
  expect(sphereInFrustum(planes, eye, 0, -10, 0.01)).toBe(true);
  expect(sphereInFrustum(planes, eye + 10.5, 0, -10, 0.25)).toBe(false);
});
