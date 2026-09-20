import { createGraphEvaluator, graphFromWeights } from '@driftengine/texture';
import { expect, test } from 'vitest';

import { depthAnything2 } from './depthAnything2.ts';
import {
  MINIATURE_CASES,
  MINIATURE_DEPTH_ANYTHING_2,
  MINIATURE_SEED,
  miniatureCheckpoint2,
  miniatureImages,
} from './miniature.ts';

/**
 * **Depth Anything V2 here answers as Transformers does**, on a seeded miniature in the older names
 * its published checkpoint keeps: the numbers are what the library's own model wrote for this
 * checkpoint and image at the manifest's pinned revision, loaded through `from_pretrained` with
 * nothing missing, unexpected or mismatched (`tools/capture-weights/reference/da2_miniature.py`).
 *
 * **Three parts in a million, absolute below one**: the output is a rectified sum of terms near
 * one, so what agrees is the absolute error — 7.8e-7 at worst over the whole map, the library summing
 * in single precision — and more than half the map is exactly zero on both sides, which the
 * rectifier's placement has to reproduce.
 */

const TOLERANCE = 3e-6;

test('ONE VIEW ON A RESIZED GRID ANSWERS AS TRANSFORMERS DOES, rectified zeros included', () => {
  const { height, width } = MINIATURE_CASES.single;
  const checkpoint = miniatureCheckpoint2(MINIATURE_DEPTH_ANYTHING_2, MINIATURE_SEED);
  const graph = graphFromWeights(
    { get: (name) => checkpoint.get(name), names: () => checkpoint.keys() },
    depthAnything2(MINIATURE_DEPTH_ANYTHING_2, height, width),
  );
  const [image] = miniatureImages(1, height, width, MINIATURE_SEED);
  const depth = createGraphEvaluator(graph)
    .run(new Map([['image', image as Float32Array]]))
    .get('depth') as Float32Array;
  const expected: readonly (readonly [number, number, number])[] = [
    [8, 40, 0.4670678377151489],
    [13, 30, 0.2858422100543976],
    [19, 35, 0.2189655750989914],
    [15, 35, 0.13237625360488892],
    [0, 0, 0],
    [13, 20, 0],
    [27, 41, 0],
  ];
  for (const [y, x, value] of expected) {
    const actual = depth[y * width + x] as number;
    expect(Math.abs(actual - value), `(${y}, ${x}) ${actual} against ${value}`).toBeLessThanOrEqual(
      TOLERANCE * Math.max(1, value),
    );
  }
});
