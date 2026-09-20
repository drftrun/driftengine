import { expect, test } from 'vitest';

import { projectionForFrame } from './splatMatrix.ts';

/**
 * The projection a reconstructed frame draws a capture with.
 *
 * **The jitter is stated in the camera's own convention, so it goes on before the correction.**
 * The correction the pass takes negates y, and a jitter applied after it with the same sign lands
 * on the other side of the pixel — which is a capture drawn a jitter away from where the resolve
 * un-jitters it, every frame, in a pattern that repeats with the sequence.
 *
 * Hand-derived: w is minus z, so rows 0 and 1 of column 2 gain the jitter times -1, and the
 * correction then negates the whole of row 1.
 */
test('the jitter moves the caller’s projection before the backend’s correction does', () => {
  const projection = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]);
  const flipY = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const out = new Float32Array(16);
  projectionForFrame(out, flipY, projection, new Float32Array([0.01, -0.02]), new Float32Array(16));
  const expected = [2, 0, 0, 0, 0, -3, 0, 0, -0.01, -0.02, -1, -1, 0, 0, -0.2, 0];
  for (let i = 0; i < 16; i += 1) expect(out[i]).toBeCloseTo(expected[i] as number, 7);
});

test('no jitter is the corrected projection it always was', () => {
  const projection = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]);
  const flipY = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const out = new Float32Array(16);
  projectionForFrame(out, flipY, projection, new Float32Array(2), new Float32Array(16));
  /* `+ 0` folds the negative zeros a product by -1 leaves, which are equal values. */
  expect(Array.from(out, (value) => value + 0)).toEqual([
    2,
    0,
    0,
    0,
    0,
    -3,
    0,
    0,
    0,
    0,
    -1,
    -1,
    0,
    0,
    Math.fround(-0.2),
    0,
  ]);
});
