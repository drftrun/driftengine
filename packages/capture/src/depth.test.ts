import { createGraphEvaluator, type NetworkGraph, type WeightSource } from '@driftengine/texture';
import { expect, test } from 'vitest';

import { createDepthEstimator } from './depth.ts';
import {
  MINIATURE_DEPTH_ANYTHING_3,
  MINIATURE_SEED,
  miniatureCheckpoint,
} from './models/miniature.ts';
import { prepareDepthFrame } from './prepare.ts';

/**
 * **A clip's frames in, depth and cameras out.** The model's own agreement with its upstream is
 * `depthAnything3.test.ts`; this is the way in — the frames prepared as the upstream prepares them,
 * the views run together, a graph built once per size, and the logits decoded.
 *
 * The miniature's size is 42, so an 84 × 56 frame halves to 42 × 28: three patches by two.
 */

const config = MINIATURE_DEPTH_ANYTHING_3;
const checkpoint = miniatureCheckpoint(config, MINIATURE_SEED);
const weights: WeightSource = {
  get: (name) => checkpoint.get(name),
  names: () => checkpoint.keys(),
};

/** A frame of one colour, which the area resize leaves flat. */
const frame = (width: number, height: number, value: number) => ({
  pixels: Uint8Array.from({ length: width * height * 4 }, (_, at) => (at % 4 === 3 ? 255 : value)),
  width,
  height,
});

test('A CLIP’S FRAMES BECOME DEPTH, CONFIDENCE AND A CAMERA A VIEW', async () => {
  const built: NetworkGraph[] = [];
  const estimator = createDepthEstimator(
    config,
    weights,
    async (graph, inputs) => {
      built.push(graph);
      return createGraphEvaluator(graph).run(inputs);
    },
    { size: 42 },
  );
  const estimate = await estimator.estimate([frame(84, 56, 90), frame(84, 56, 140)]);
  expect([estimate.width, estimate.height]).toEqual([42, 28]);
  expect(estimate.views.length).toBe(2);
  for (const view of estimate.views) {
    expect(view.depth.length).toBe(42 * 28);
    /* Depth is an exponential, so it is positive, and confidence is one more than one. */
    expect(view.depth.every((value) => value > 0)).toBe(true);
    expect(view.confidence.every((value) => value > 1)).toBe(true);
    expect(view.worldToCamera.length).toBe(12);
    /* The principal point sits at the middle of the prepared frame. */
    expect(view.intrinsics[2]).toBeCloseTo(21, 6);
    expect(view.intrinsics[5]).toBeCloseTo(14, 6);
  }
  /* The two views are one run: the model's across-view blocks need them together. */
  expect(built.length).toBe(1);
  expect(built[0]?.inputs.map((input) => input.name)).toEqual(['image0', 'image1']);
  /* And each view is decoded from its own logits: two different frames, two different depths. */
  const [first, second] = estimate.views;
  expect(Array.from(first?.depth ?? [])).not.toEqual(Array.from(second?.depth ?? []));
});

test('the graph is built once per count of views and size, and kept', async () => {
  const built: NetworkGraph[] = [];
  const estimator = createDepthEstimator(
    config,
    weights,
    async (graph, inputs) => {
      built.push(graph);
      return createGraphEvaluator(graph).run(inputs);
    },
    { size: 42 },
  );
  const one = [frame(84, 56, 90)];
  await estimator.estimate(one);
  await estimator.estimate([frame(84, 84, 30)]);
  await estimator.estimate(one);
  expect(built.map((graph) => graph.inputs[0]?.shape.join('x'))).toEqual([
    '3x28x42',
    '3x42x42',
    '3x28x42',
  ]);
  /* The third estimate is the first clip's size again, so it is the very graph built for it. */
  expect(built[2]).toBe(built[0]);
  expect(built[1]).not.toBe(built[0]);
});

test('frames of different prepared sizes are refused rather than run as a clip', async () => {
  const estimator = createDepthEstimator(config, weights, async () => new Map(), { size: 42 });
  await expect(estimator.estimate([frame(84, 56, 10), frame(84, 84, 10)])).rejects.toThrow(
    /one estimate is one clip/,
  );
  await expect(estimator.estimate([])).rejects.toThrow(/needs a frame/);
});

test('a frame is prepared once, as the preparation prepares it', async () => {
  let given: Float32Array | undefined;
  const estimator = createDepthEstimator(
    config,
    weights,
    async (graph, inputs) => {
      given = inputs.get('image0') as Float32Array;
      return createGraphEvaluator(graph).run(inputs);
    },
    { size: 42 },
  );
  await estimator.estimate([frame(84, 56, 90)]);
  const expected = prepareDepthFrame(frame(84, 56, 90).pixels, 84, 56, 42);
  expect(Array.from(given ?? [])).toEqual(Array.from(expected.pixels));
});
