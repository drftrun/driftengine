import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { boundsOfPositions, createBounds } from '../math/bounds.ts';
import { createFrustum, frustumFromViewProjection } from '../math/frustum.ts';
import { boundsVisible } from './visibility.ts';

/** A camera at the origin looking down -Z with a ninety-degree field of view. */
function ahead() {
  const projection = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 100);
  const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  return frustumFromViewProjection(
    mat4.multiply(mat4.create(), projection, view) as Float32Array,
    createFrustum(),
  );
}

/** A unit sphere's worth of geometry, centred on its own origin. */
const unit = boundsOfPositions(
  new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]),
  createBounds(),
);

const at = (x: number, y: number, z: number): Float32Array =>
  mat4.fromTranslation(mat4.create(), [x, y, z]) as Float32Array;

test('a mesh in front of the camera is visible', () => {
  expect(boundsVisible(ahead(), unit, at(0, 0, -10))).toBe(true);
});

test('a mesh behind the camera is not', () => {
  expect(boundsVisible(ahead(), unit, at(0, 0, 10))).toBe(false);
});

test('a mesh past the far plane is not', () => {
  expect(boundsVisible(ahead(), unit, at(0, 0, -200))).toBe(false);
});

/**
 * The whole reason this is a function rather than two lines at each call site.
 *
 * A bounding sphere put through a scaling matrix is a sphere of a different size. Forgetting the
 * factor culls an enlarged object while it is plainly on screen, and the failure reads as a
 * threshold to tune rather than a multiplication that is missing.
 */
test('a scaled-up mesh is visible where an unscaled one is not', () => {
  const frustum = ahead();
  const far = at(14, 0, -10);
  expect(boundsVisible(frustum, unit, far), 'a unit sphere at x = 14 is off the right edge').toBe(
    false,
  );

  const enlarged = mat4.scale(mat4.create(), far, [6, 6, 6]) as Float32Array;
  expect(boundsVisible(frustum, unit, enlarged), 'six times the size reaches back in').toBe(true);
});

/**
 * Non-uniform scale takes the largest axis, which is the sphere the ellipsoid fits inside.
 *
 * Taking the average, or the x scale, is the version that happens to work until something is
 * stretched along one axis — a banner, a beam, a blade of grass.
 */
test('a mesh stretched along one axis takes that axis', () => {
  const frustum = ahead();
  const stretched = mat4.scale(mat4.create(), at(14, 0, -10), [1, 1, 6]) as Float32Array;
  expect(
    boundsVisible(frustum, unit, stretched),
    'the largest scale is 6, so the sphere around it reaches in',
  ).toBe(true);
});

/**
 * A rotation is not a scale, and a matrix that does both must not be read as doing more.
 *
 * Reading a basis vector's length is what separates them: a rotation preserves length, so this
 * gets the scale out of a rotating matrix without decomposing it.
 */
test('a rotation alone does not change what is visible', () => {
  const frustum = ahead();
  const spun = mat4.rotateY(mat4.create(), at(14, 0, -10), 0.7) as Float32Array;
  expect(boundsVisible(frustum, unit, spun), 'still a unit sphere, still off the edge').toBe(false);
});

/** Bounds measured about their own centre have to be carried through the matrix, not ignored. */
test('a mesh modelled away from its own origin is placed by its centre', () => {
  const offCentre = boundsOfPositions(new Float32Array([49, 0, 0, 51, 0, 0]), createBounds());
  const frustum = ahead();
  /* Its centre is at x = 50, so a translation of -50 puts it in front of the camera. */
  expect(boundsVisible(frustum, offCentre, at(-50, 0, -10)), 'brought back to the middle').toBe(
    true,
  );
  expect(boundsVisible(frustum, offCentre, at(0, 0, -10)), 'left out at x = 50').toBe(false);
});
