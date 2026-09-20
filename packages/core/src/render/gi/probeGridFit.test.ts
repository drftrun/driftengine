import { expect, test } from 'vitest';

import { MAX_ENV_PROBES } from '../probeGrid.ts';
import { fitProbeGrid } from './probeGridFit.ts';

/**
 * A probe grid for a scene that asked for indirect light and never thought about probe spacing.
 *
 * **A declared grid always wins**; this is what a scene gets when it declared none, and the whole
 * of its job is that turning the feature on shows light rather than a warning.
 */

function box(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): { min: Float32Array; max: Float32Array } {
  return { min: Float32Array.from(min), max: Float32Array.from(max) };
}

test('THE GRID SURROUNDS THE SCENE, with a probe outside every face', () => {
  /*
   * **A surface on the boundary has to be between probes on both sides of it.** A grid that stops
   * at the bounds leaves every outward-facing wall interpolating between probes that are all
   * behind it, which reads as the room's edges being lit by the room's middle.
   */
  const grid = fitProbeGrid(box([-4, 0, -6], [4, 3, 6]), 2, MAX_ENV_PROBES);
  for (let axis = 0; axis < 3; axis += 1) {
    const low = grid.origin[axis] as number;
    const high = low + (grid.spacing[axis] as number) * ((grid.counts[axis] as number) - 1);
    expect(low, `axis ${String(axis)} low`).toBeLessThanOrEqual([-4, 0, -6][axis] as number);
    expect(high, `axis ${String(axis)} high`).toBeGreaterThanOrEqual([4, 3, 6][axis] as number);
  }
});

test('the asked spacing is used while it fits, on every axis equally', () => {
  const grid = fitProbeGrid(box([0, 0, 0], [4, 4, 4]), 2, MAX_ENV_PROBES);
  expect(Array.from(grid.spacing)).toEqual([2, 2, 2]);
  /* Four metres at two metres a step, plus one probe outside each face: four probes an axis. */
  expect(Array.from(grid.counts)).toEqual([4, 4, 4]);
});

test('A GRID THAT WOULD NOT FIT IS WIDENED UNIFORMLY, so the probes stay cubic', () => {
  /*
   * Widening one axis at a time would make a probe's cell a slab, and a slab interpolates over
   * different distances along different axes — so a surface's light changes as it turns, which is
   * the one thing an irradiance probe must not do.
   */
  const grid = fitProbeGrid(box([-50, -50, -50], [50, 50, 50]), 1, MAX_ENV_PROBES);
  const total =
    (grid.counts[0] as number) * (grid.counts[1] as number) * (grid.counts[2] as number);
  expect(total).toBeLessThanOrEqual(MAX_ENV_PROBES);
  expect(grid.spacing[0]).toBe(grid.spacing[1]);
  expect(grid.spacing[1]).toBe(grid.spacing[2]);
  expect(grid.spacing[0] as number).toBeGreaterThan(1);
});

test('a scene of one point is a grid of one rather than a division by zero', () => {
  const grid = fitProbeGrid(box([3, 3, 3], [3, 3, 3]), 2, MAX_ENV_PROBES);
  expect(Array.from(grid.counts)).toEqual([1, 1, 1]);
  expect(Array.from(grid.origin)).toEqual([3, 3, 3]);
  for (const step of grid.spacing) expect(step).toBeGreaterThan(0);
});

test('an enormous scene is capped rather than allocating, and a flat one is not a zero count', () => {
  const huge = fitProbeGrid(box([-1e6, -1e6, -1e6], [1e6, 1e6, 1e6]), 2, MAX_ENV_PROBES);
  const total =
    (huge.counts[0] as number) * (huge.counts[1] as number) * (huge.counts[2] as number);
  expect(total).toBeLessThanOrEqual(MAX_ENV_PROBES);
  expect(total).toBeGreaterThan(0);

  /* A floor: no extent on one axis at all, which is what a scene of one ground plane measures. */
  const flat = fitProbeGrid(box([-10, 0, -10], [10, 0, 10]), 2, MAX_ENV_PROBES);
  for (const count of flat.counts) expect(count).toBeGreaterThanOrEqual(1);
  expect(flat.counts[1]).toBe(1);
});

test('a budget of nothing still gives a grid of one, because a probe array cannot be empty', () => {
  const grid = fitProbeGrid(box([-4, 0, -6], [4, 3, 6]), 2, 0);
  expect(Array.from(grid.counts)).toEqual([1, 1, 1]);
});
