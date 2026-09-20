import { mulberry32 } from '@driftengine/core';
import { expect, test } from 'vitest';

import { createCloud, materialise, start, type Cloud } from './parameters.ts';
import { refineCloud, FADED } from './refine.ts';

/**
 * **Where the cloud grows and what it throws away**, held directly rather than through a fit.
 *
 * A fit can reach its likeness floor with the refinement doing almost anything — growing the wrong
 * Gaussians, or growing blindly — because five hundred Gaussians in roughly the right places look
 * much like five hundred in exactly the right places at this size. So the decisions are made here
 * one at a time, on clouds small enough to name every splat in.
 */

const BUDGET = 16;

/** A cloud of `count` Gaussians in a row, all the same size, with nothing pulling on them. */
function row(count: number, scale: number): Cloud {
  const seeds = new Float64Array(count * 3);
  for (let at = 0; at < count; at += 1) {
    seeds[at * 3] = at;
    seeds[at * 3 + 2] = 5;
  }
  const cloud = createCloud(BUDGET, 1, false);
  start(cloud, seeds, count, scale);
  materialise(cloud);
  return cloud;
}

/** A splat's opacity, set through the logit the cloud actually holds. */
function setOpacity(cloud: Cloud, at: number, opacity: number): void {
  cloud.logits.values[at] = Math.log(opacity / (1 - opacity));
  materialise(cloud);
}

const OPTIONS = { budget: BUDGET, splitAbove: 0.5, random: mulberry32(1) };

test('A FADED GAUSSIAN IS DROPPED, and the ones that stay keep their own history', () => {
  const cloud = row(4, 0.1);
  setOpacity(cloud, 1, FADED / 2);
  /* Adam's history, so the gather can be seen to carry the right rows with the right splats. */
  for (let at = 0; at < 4; at += 1) cloud.positions.moment[at * 3] = 100 + at;

  refineCloud(cloud, { ...OPTIONS, budget: 4 });

  expect(cloud.count).toBe(3);
  /* Splats 0, 2 and 3, in order, with 1 gone — positions and moments moving together. */
  expect(Array.from(cloud.positions.values.subarray(0, 9)).filter((_, i) => i % 3 === 0)).toEqual([
    0, 2, 3,
  ]);
  expect([0, 1, 2].map((slot) => cloud.positions.moment[slot * 3])).toEqual([100, 102, 103]);
});

test('the Gaussians the frames pull hardest on are the ones made into two', () => {
  const cloud = row(5, 0.1);
  /* Only one of them is being asked to move, and the busiest fifth of five is one splat. */
  cloud.motion[3] = 9;
  refineCloud(cloud, OPTIONS);

  expect(cloud.count).toBe(6);
  /* The sixth splat is a copy of the fourth, which is the one that was pulled. */
  expect(cloud.positions.values[5 * 3]).toBe(3);
  /* Its own history starts empty, which is what lets it separate from the splat it came from. */
  cloud.positions.moment[3 * 3] = 7;
  expect(cloud.positions.moment[5 * 3]).toBe(0);
  /* And the pull is spent: a refinement measures the interval since the last one. */
  expect(Array.from(cloud.motion.subarray(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
});

test('a small Gaussian is cloned where it stands; a large one is split and the halves move apart', () => {
  const small = row(2, 0.1);
  small.motion[0] = 5;
  small.motion[1] = 5;
  refineCloud(small, OPTIONS);
  /* Narrower than the split threshold, so the busiest is copied and left exactly where it was. */
  expect(small.count).toBe(3);
  materialise(small);
  expect(small.positions.values[2 * 3]).toBe(small.positions.values[0]);
  expect(small.scales[2 * 3]).toBeCloseTo(small.scales[0] as number, 12);

  /* Wider than the split threshold, and both halves come out smaller and somewhere else. */
  const large = row(2, 0.8);
  large.motion[0] = 5;
  refineCloud(large, OPTIONS);
  expect(large.count).toBe(3);
  materialise(large);
  const parent = large.scales[0] as number;
  const child = large.scales[2 * 3] as number;
  expect(parent).toBeCloseTo(0.8 / 1.6, 6);
  expect(child).toBeCloseTo(0.8 / 1.6, 6);
  const apart = Math.abs(
    (large.positions.values[2 * 3] as number) - (large.positions.values[0] as number),
  );
  expect(apart).toBeGreaterThan(0);
  /* Somewhere inside the shape they came from, which is at most three standard deviations. */
  expect(apart).toBeLessThan(3 * 0.8);
});

test('the budget is what stops the growth, and an empty cloud is refused rather than emptied', () => {
  const cloud = row(15, 0.1);
  for (let at = 0; at < 15; at += 1) cloud.motion[at] = 15 - at;
  refineCloud(cloud, OPTIONS);
  /* A fifth of fifteen is three, and there is room for only one. */
  expect(cloud.count).toBe(BUDGET);

  const faded = row(3, 0.1);
  for (let at = 0; at < 3; at += 1) setOpacity(faded, at, FADED / 2);
  expect(refineCloud(faded, OPTIONS)).toBe(3);
  expect(faded.count).toBe(3);
});
