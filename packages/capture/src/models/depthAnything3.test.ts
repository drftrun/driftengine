import { createGraphEvaluator, graphFromWeights } from '@driftengine/texture';
import { expect, test } from 'vitest';

import { decodeCamera, decodeDepth, depthAnything3 } from './depthAnything3.ts';
import {
  MINIATURE_CASES,
  MINIATURE_DEPTH_ANYTHING_3,
  MINIATURE_SEED,
  miniatureCheckpoint,
  miniatureImages,
} from './miniature.ts';

/**
 * **Depth Anything 3 here answers as the upstream's own code answers**, on a seeded miniature of
 * its layout: every tensor name and shape of the real checkpoints, four blocks, a head of sixteen
 * features. The expected numbers are not worked out here and not produced by this code: they are
 * what the upstream's modules, at the manifest's pinned revision, wrote for this checkpoint and
 * these images (`tools/capture-weights/reference/`) — so a layer that differs from theirs in any
 * way the numbers can see fails.
 *
 * **The tolerance is three parts in a million**, three times the worst disagreement over every
 * pixel and pose value of both cases — 1.03e-6, the upstream summing in single precision and the
 * reference evaluator in double. Ten of twelve slips written into a copy of the definition fail
 * it: the rotary sign, the across-view positions, the positional resize's step, the camera token
 * a second view takes, the order of a tap's two halves, the head's aspect, its fusion's alignment,
 * which tap the camera decoder reads, the confidence's `+ 1`, and the block norms' ε. **Two do
 * not**: an ε of 1e-6 where 1e-5 is trained, in the query-key and final norms or in the head's,
 * moves these outputs by one to three millionths — the size of summing in another order, so no
 * tolerance can tell the two apart, and also the measure of how little such a slip would change.
 */

const TOLERANCE = 3e-6;

function run(views: number, height: number, width: number): Map<string, Float32Array> {
  const checkpoint = miniatureCheckpoint(MINIATURE_DEPTH_ANYTHING_3, MINIATURE_SEED);
  const graph = graphFromWeights(
    { get: (name) => checkpoint.get(name), names: () => checkpoint.keys() },
    depthAnything3(MINIATURE_DEPTH_ANYTHING_3, views, height, width),
  );
  const images = miniatureImages(views, height, width, MINIATURE_SEED);
  const out = createGraphEvaluator(graph).run(
    new Map(images.map((image, v) => [`image${v}`, image])),
  );
  return new Map([...out].map(([name, values]) => [name, Float32Array.from(values)]));
}

function expectClose(actual: ArrayLike<number>, expected: readonly number[]): void {
  expected.forEach((value, i) => {
    expect(
      Math.abs((actual[i] as number) - value),
      `[${i}] ${actual[i]} against ${value}`,
    ).toBeLessThanOrEqual(TOLERANCE * Math.max(1, Math.abs(value)));
  });
}

test('ONE VIEW ON A RESIZED GRID ANSWERS AS THE UPSTREAM DOES: depth, confidence and camera', () => {
  /* 28 × 42 is a 2 × 3 grid against a trained 2 × 2, so the positions are resized, the upstream's way. */
  const { height, width } = MINIATURE_CASES.single;
  const out = run(1, height, width);
  const depth = new Float32Array(height * width);
  const confidence = new Float32Array(height * width);
  decodeDepth(out.get('logits0') as Float32Array, depth, confidence);
  const at = (y: number, x: number): number => depth[y * width + x] as number;
  expectClose(
    [at(0, 0), at(13, 20), at(27, 41), at(5, 33)],
    [1.5394936800003052, 2.075392961502075, 1.1914589405059814, 1.947701096534729],
  );
  expectClose(
    [
      confidence[0] as number,
      confidence[13 * width + 20] as number,
      confidence[27 * width + 41] as number,
    ],
    [1.7990171909332275, 1.4530408382415771, 1.8366918563842773],
  );
  expectClose(
    out.get('pose') as Float32Array,
    [
      0.25446802377700806, -0.32902708649635315, 0.012861846014857292, 0.1285683810710907,
      -0.1804066151380539, -0.15986452996730804, -0.053892526775598526, 0.24058201909065247, 0,
    ],
  );
});

test('TWO VIEWS ATTEND ACROSS EACH OTHER AS THE UPSTREAM DOES, the second with the source camera token', () => {
  const { height, width } = MINIATURE_CASES.pair;
  const out = run(2, height, width);
  const depth = new Float32Array(height * width);
  const confidence = new Float32Array(height * width);
  decodeDepth(out.get('logits1') as Float32Array, depth, confidence);
  expectClose(
    [depth[0] as number, depth[14 * width + 14] as number, depth[27 * width + 27] as number],
    [1.1397887468338013, 1.7807254791259766, 1.5588253736495972],
  );
  expectClose(
    out.get('pose') as Float32Array,
    [
      0.4381571412086487, -0.47711920738220215, 0.09050924330949783, 0.18168753385543823,
      -0.10938532650470734, -0.264864057302475, -0.16601696610450745, 0.08105003088712692, 0,
      0.3636206388473511, -0.4355652332305908, 0.14751069247722626, -0.005823008716106415,
      -0.0385906845331192, -0.24907353520393372, -0.33957159519195557, 0.09084084630012512, 0,
    ],
  );
});

test('a size that is not whole patches is refused before anything is built', () => {
  expect(() => depthAnything3(MINIATURE_DEPTH_ANYTHING_3, 1, 28, 40)).toThrow(/14-pixel patches/);
});

test('A CAMERA IS DECODED AS THE UPSTREAM DECODES IT: the inverse of camera-to-world, and a pinhole from two fields of view', () => {
  /*
   * A quarter turn about z, q = (0, 0, sin 45°, cos 45°), is the camera-to-world rotation
   * [[0, −1, 0], [1, 0, 0], [0, 0, 1]] at t = (1, 2, 3). Its inverse is the transpose
   * [[0, 1, 0], [−1, 0, 0], [0, 0, 1]] with −Rᵀt = (−2, 1, −3). Fields of view of a right angle
   * put the focal length at half the image: tan 45° = 1.
   */
  const half = Math.SQRT1_2;
  const pose = Float32Array.of(1, 2, 3, 0, 0, half, half, Math.PI / 2, Math.PI / 2);
  const worldToCamera = new Float32Array(12);
  const intrinsics = new Float32Array(9);
  decodeCamera(pose, 0, 280, 504, worldToCamera, intrinsics);
  expectClose(worldToCamera, [0, 1, 0, -2, -1, 0, 0, 1, 0, 0, 1, -3]);
  expectClose(intrinsics, [252, 0, 252, 0, 140, 140, 0, 0, 1]);
});
