import { mat4 } from 'gl-matrix';
import { expect, test } from 'vitest';

import { boundsOfPositions, createBounds } from '../math/bounds.ts';
import { apparentSize, lodForBounds } from './lod.ts';

/** Geometry whose vertices all sit at `radius` from its own centre. */
function sphereOfRadius(radius: number) {
  return boundsOfPositions(
    new Float32Array([
      radius,
      0,
      0,
      -radius,
      0,
      0,
      0,
      radius,
      0,
      0,
      -radius,
      0,
      0,
      0,
      radius,
      0,
      0,
      -radius,
    ]),
    createBounds(),
  );
}

const unit = sphereOfRadius(1);
const at = (x: number, y: number, z: number): Float32Array =>
  mat4.fromTranslation(mat4.create(), [x, y, z]) as Float32Array;

/** Descending: the apparent size at which each level stops being good enough. */
const LEVELS = [0.5, 0.1, 0.02];

test('a nearer object gets a finer level', () => {
  const near = lodForBounds(unit, at(0, 0, -2), 0, 0, 0, LEVELS);
  const far = lodForBounds(unit, at(0, 0, -200), 0, 0, 0, LEVELS);
  expect(near).toBeLessThan(far);
});

/**
 * The whole argument for apparent size over distance, as an assertion.
 *
 * A threshold in metres puts these two on different levels while they cover the same part of the
 * screen — the cathedral drops to its coarsest form while it still fills the view, or the
 * doorknob keeps its finest while it is two pixels across.
 */
test('a big far object and a small near one land on the same level', () => {
  const cathedral = lodForBounds(sphereOfRadius(50), at(0, 0, -500), 0, 0, 0, LEVELS);
  const doorknob = lodForBounds(sphereOfRadius(0.5), at(0, 0, -5), 0, 0, 0, LEVELS);
  expect(cathedral).toBe(doorknob);
  expect(
    Math.abs(
      apparentSize(sphereOfRadius(50), at(0, 0, -500), 0, 0, 0) -
        apparentSize(sphereOfRadius(0.5), at(0, 0, -5), 0, 0, 0),
    ),
    'and they land there because they really are the same size on screen',
  ).toBeLessThan(1e-6);
});

test('an object past the coarsest threshold gets the last level, not an index off the end', () => {
  expect(lodForBounds(unit, at(0, 0, -100000), 0, 0, 0, LEVELS)).toBe(LEVELS.length - 1);
});

test('an object filling the view gets the finest level', () => {
  expect(lodForBounds(unit, at(0, 0, -1.2), 0, 0, 0, LEVELS)).toBe(0);
});

/** A viewpoint inside the object's own sphere fills the view, and says so without dividing by zero. */
test('a viewpoint inside the object is the finest level rather than a division by zero', () => {
  expect(apparentSize(unit, at(0, 0, 0), 0, 0, 0)).toBe(Infinity);
  expect(lodForBounds(unit, at(0, 0, 0), 0, 0, 0, LEVELS)).toBe(0);
});

test('scale counts, on the largest axis', () => {
  const stretched = mat4.scale(mat4.create(), at(0, 0, -200), [1, 1, 20]) as Float32Array;
  expect(
    lodForBounds(unit, stretched, 0, 0, 0, LEVELS),
    'twenty times as big at the same distance is a finer level',
  ).toBeLessThan(lodForBounds(unit, at(0, 0, -200), 0, 0, 0, LEVELS));
});

test('a caller with no thresholds gets the only level it has', () => {
  expect(lodForBounds(unit, at(0, 0, -10), 0, 0, 0, [])).toBe(0);
});

test('the eye is where the caller says, not the origin', () => {
  const object = at(0, 0, -200);
  expect(lodForBounds(unit, object, 0, 0, -199, LEVELS), 'standing next to it').toBeLessThan(
    lodForBounds(unit, object, 0, 0, 0, LEVELS),
  );
});
