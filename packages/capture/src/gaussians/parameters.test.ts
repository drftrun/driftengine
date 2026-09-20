import { expect, test } from 'vitest';

import { createGradients } from './gradients.ts';
import { chain, createCloud, harvest, materialise, start, viewOf } from './parameters.ts';

/**
 * **The two parameters the fit does not hold directly, and the arithmetic that undoes them.**
 *
 * A scale is stepped as its logarithm and an opacity as its logit, so both are transformed on the
 * way out and both gradients are transformed on the way back. **Adam cannot see whether that
 * second half is right**: it divides every step by the size of that parameter's own gradients, so
 * a factor applied to all of them changes almost nothing about the descent — a fit with the chain
 * rule missing converges about as well and is computing a gradient that is not the gradient. So it
 * is held here by its own arithmetic, against derivatives taken by hand, rather than by a fit.
 */

const BUDGET = 4;

function cloudOf(seeds: number[], scale: number) {
  const cloud = createCloud(BUDGET, 1, false);
  start(cloud, Float64Array.from(seeds), seeds.length / 3, scale);
  materialise(cloud);
  return cloud;
}

test('A SCALE IS HELD AS ITS LOGARITHM AND AN OPACITY AS ITS LOGIT, and both come back whole', () => {
  const cloud = cloudOf([1, 2, 3, -1, 0, 4], 0.2);
  expect(cloud.count).toBe(2);
  /* Every seed starts where it was put, round at the scale it was given, grey, faint and upright. */
  expect(Array.from(cloud.positions.values.subarray(0, 6))).toEqual([1, 2, 3, -1, 0, 4]);
  for (let at = 0; at < 2; at += 1) {
    for (let c = 0; c < 3; c += 1) {
      expect(cloud.scales[at * 3 + c]).toBeCloseTo(0.2, 12);
      expect(cloud.colors.values[at * 3 + c]).toBe(0.5);
    }
    expect(Array.from(cloud.rotations.values.subarray(at * 4, at * 4 + 4))).toEqual([0, 0, 0, 1]);
    /* A tenth, which is the logistic of the logit that was stored rather than the logit itself. */
    expect(cloud.opacities[at]).toBeCloseTo(0.1, 12);
  }
});

test('the gradients come back through the same two transforms, by their own derivatives', () => {
  const cloud = cloudOf([0, 0, 2], 0.2);
  const gradients = createGradients(BUDGET);
  /* One value per family, chosen so nothing cancels and every factor is visible in the answer. */
  gradients.positions[0] = 3;
  gradients.positions[1] = -4;
  gradients.positions[2] = 12;
  gradients.scales[0] = 7;
  gradients.rotations[2] = -5;
  gradients.colors[1] = 9;
  gradients.opacities[0] = 8;
  chain(cloud, gradients);

  /* Position, rotation and colour are themselves: nothing stands between them and the render. */
  expect(Array.from(cloud.positions.gradient.subarray(0, 3))).toEqual([3, -4, 12]);
  expect(cloud.rotations.gradient[2]).toBe(-5);
  expect(cloud.colors.gradient[1]).toBe(9);

  /* d(scale)/d(log scale) is the scale, so 7 by the metre is 7 × 0.2 by the logarithm. */
  expect(cloud.logScales.gradient[0]).toBeCloseTo(7 * 0.2, 12);
  /* The logistic's derivative is p(1 − p), so 8 by the proportion is 8 × 0.1 × 0.9 by the logit. */
  expect(cloud.logits.gradient[0]).toBeCloseTo(8 * 0.1 * 0.9, 12);

  /* And the pull recorded for the refinement is the length of the position's gradient: 3, 4, 12. */
  expect(cloud.motion[0]).toBeCloseTo(13, 12);
  /* It accumulates across steps rather than being replaced, because a refinement spans many. */
  chain(cloud, gradients);
  expect(cloud.motion[0]).toBeCloseTo(26, 12);
});

test('what comes out is a capture, cut to what the cloud holds', () => {
  const cloud = cloudOf([1, 2, 3, -1, 0, 4], 0.2);
  const source = harvest(cloud);
  expect(source.count).toBe(2);
  /* Single precision, and no longer than the count — the budget's slack does not ship. */
  expect(source.positions).toBeInstanceOf(Float32Array);
  expect(source.positions.length).toBe(6);
  expect(source.scales.length).toBe(6);
  expect(source.rotations.length).toBe(8);
  expect(source.opacities.length).toBe(2);
  expect(source.sh1).toBeUndefined();
  expect(Array.from(source.positions)).toEqual([1, 2, 3, -1, 0, 4]);

  /* A cloud that carries a band hands it over at nine a splat; one that does not says nothing. */
  const turning = createCloud(BUDGET, 1, true);
  start(turning, Float64Array.from([0, 0, 1]), 1, 0.2);
  materialise(turning);
  expect(harvest(turning).sh1?.length).toBe(9);
  expect(viewOf(turning, BUDGET).sh1).not.toBeUndefined();
  expect(viewOf(cloud, BUDGET).sh1).toBeUndefined();
});

test('a cloud with no scale to start from is refused rather than given one', () => {
  const cloud = createCloud(BUDGET, 1, false);
  expect(() => start(cloud, Float64Array.from([0, 0, 1]), 1, 0)).toThrow(/spacing/);
});
