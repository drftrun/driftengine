import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { createFrustum, frustumFromViewProjection, sphereInFrustum } from './frustum.ts';

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
