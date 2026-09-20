import { mulberry32 } from '@driftengine/core';
import { readDrft, writeDrft, type DrftSplatBlock } from '@driftengine/drft';
import { packSplats } from '@driftengine/splats';
import { expect, test } from 'vitest';

import { lookAt, renderTestScene, type TestCamera, type TestScene } from '../testScene.ts';
import { optimiseGaussians } from './optimise.ts';
import type { GaussianSet, RasterCamera } from './project.ts';
import { rasteriseGaussians } from './rasterise.ts';
import { structuralSimilarity } from './similarity.ts';

/**
 * **A clip becomes splats the engine already knows how to draw.**
 *
 * The fit is held three ways. One Gaussian against one rendered blob says the descent recovers
 * what it is shown — where it stands, how big it is and what colour it is — which is the smallest
 * statement that can be made about a fit and the only one that is exact. A synthetic room says the
 * whole thing works at once: seeded from a scatter that knows nothing about the scene, it has to
 * reach a structural similarity against the very frames it was fitted to, inside a splat budget.
 * And the answer has to survive the packing and the container, because a capture nothing can load
 * is not a capture.
 */

/*
 * **These tests state their own time**, because the default is five seconds and a fit is the one
 * thing in this package that is genuinely slow: the room measures 4.7 s alone and more than that
 * under a full suite, where the workers are competing. A timeout that fires under load and not on
 * its own is a test that fails for a reason that has nothing to do with the code.
 */
const PATIENT = 120_000;

const BLOB_WIDTH = 64;
const BLOB_HEIGHT = 64;
const BLOB_INTRINSICS = [80, 80, BLOB_WIDTH / 2, BLOB_HEIGHT / 2] as const;

function gaussian(
  position: readonly [number, number, number],
  scale: number,
  colour: readonly [number, number, number],
  opacity: number,
): GaussianSet {
  return {
    count: 1,
    positions: Float64Array.from(position),
    scales: Float64Array.from([scale, scale, scale]),
    rotations: Float64Array.from([0, 0, 0, 1]),
    colors: Float64Array.from(colour),
    opacities: Float64Array.from([opacity]),
  };
}

/** Four cameras around a point, near enough to it that one blob fills part of every frame. */
function around(target: readonly [number, number, number], reach: number): Float64Array[] {
  const eyes: [number, number, number][] = [
    [-reach, 0, 0],
    [reach, 0, 0],
    [0, -reach, 0],
    [0, reach, 0],
  ];
  return eyes.map((eye) => lookAt(eye, target));
}

test(
  'ONE GAUSSIAN FITTED TO ONE BLOB RECOVERS IT: where it stands, how big, what colour',
  () => {
    const truth = gaussian([0.05, -0.03, 2.2], 0.08, [0.8, 0.3, 0.2], 0.9);
    const poses = around([0, 0, 2.2], 0.3);
    const targets = poses.map((worldToCamera) => {
      const camera: RasterCamera = {
        width: BLOB_WIDTH,
        height: BLOB_HEIGHT,
        intrinsics: BLOB_INTRINSICS,
        worldToCamera,
      };
      const frame = new Float64Array(BLOB_WIDTH * BLOB_HEIGHT * 4);
      rasteriseGaussians(truth, camera, frame);
      return frame;
    });

    const fitted = optimiseGaussians(targets, poses, {
      intrinsics: BLOB_INTRINSICS,
      width: BLOB_WIDTH,
      height: BLOB_HEIGHT,
      /* Started a tenth of a metre behind where it belongs, half the size, and grey. */
      seeds: Float64Array.from([0, 0, 2.1]),
      initialScale: 0.04,
      budget: 1,
      iterations: 800,
      random: mulberry32(5),
    });

    expect(fitted.count).toBe(1);
    for (let c = 0; c < 3; c += 1) {
      expect(
        Math.abs((fitted.positions[c] as number) - (truth.positions[c] as number)),
      ).toBeLessThan(0.02);
      expect(Math.abs((fitted.scales[c] as number) - 0.08)).toBeLessThan(0.02);
      expect(Math.abs((fitted.colors[c] as number) - (truth.colors[c] as number))).toBeLessThan(
        0.08,
      );
    }
    expect(fitted.opacities[0]).toBeGreaterThan(0.6);
  },
  PATIENT,
);

const SCENE: TestScene = {
  boxes: [
    { min: [-0.7, -0.7, 3.4], max: [0.7, 0.7, 4.6], seed: 1 },
    { min: [-2.4, -1.1, 5.0], max: [-1.0, 1.0, 6.6], seed: 2 },
    { min: [1.0, -1.0, 4.4], max: [2.4, 0.6, 6.0], seed: 5 },
  ],
  planes: [{ normal: [0, 1, 0], offset: -1.3, seed: 3 }],
};
const SCENE_WIDTH = 48;
const SCENE_HEIGHT = 36;
const SCENE_INTRINSICS = [48, 48, SCENE_WIDTH / 2, SCENE_HEIGHT / 2] as const;

/*
 * Two settings, because only one of these tests is about how good the fit is. **The quality claim
 * is the expensive one** — five hundred Gaussians over four hundred steps, measured at 4.7 s — and
 * the round trip, the repeat and the band are about shape and reproducibility, which a fit an
 * eighteenth of the size says just as well. A test file that ran the good fit four times would
 * cost twenty seconds of a seventy-four second suite to say one thing four ways.
 */
const QUALITY = { seeds: 140, budget: 500, iterations: 400, initialScale: 0.12 } as const;
const QUICK = { seeds: 60, budget: 140, iterations: 90, initialScale: 0.15 } as const;

/** The scene from a short arc, as linear frames that cover themselves completely. */
function sceneFrames(): { poses: Float64Array[]; targets: Float64Array[] } {
  const poses: Float64Array[] = [];
  const targets: Float64Array[] = [];
  for (let at = 0; at < 4; at += 1) {
    const t = at / 3;
    const camera: TestCamera = {
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
      intrinsics: SCENE_INTRINSICS,
      worldToCamera: lookAt([-0.5 + t, 0.1, 0], [0, 0, 5]),
    };
    const pixels = new Uint8Array(SCENE_WIDTH * SCENE_HEIGHT * 4);
    renderTestScene(SCENE, camera, pixels);
    const frame = new Float64Array(SCENE_WIDTH * SCENE_HEIGHT * 4);
    /*
     * The scene is generated rather than photographed, so its bytes are already linear and the
     * only conversion is the range. Alpha is one everywhere, which is what a frame with something
     * behind every pixel says.
     */
    for (let at2 = 0; at2 < SCENE_WIDTH * SCENE_HEIGHT; at2 += 1) {
      for (let c = 0; c < 3; c += 1) {
        frame[at2 * 4 + c] = (pixels[at2 * 4 + c] as number) / 255;
      }
      frame[at2 * 4 + 3] = 1;
    }
    poses.push(camera.worldToCamera);
    targets.push(frame);
  }
  return { poses, targets };
}

/** A scatter through the space the scene occupies, which knows nothing else about it. */
function scatter(count: number, random: () => number): Float64Array {
  const seeds = new Float64Array(count * 3);
  for (let at = 0; at < count; at += 1) {
    seeds[at * 3] = -2.4 + random() * 4.8;
    seeds[at * 3 + 1] = -1.3 + random() * 2.4;
    seeds[at * 3 + 2] = 3.2 + random() * 3.6;
  }
  return seeds;
}

/** The mean structural similarity of two linear frames, over their three colour channels. */
function likeness(a: Float64Array, b: Float64Array, width: number, height: number): number {
  const first = new Float64Array(width * height);
  const second = new Float64Array(width * height);
  let total = 0;
  for (let c = 0; c < 3; c += 1) {
    for (let at = 0; at < width * height; at += 1) {
      first[at] = a[at * 4 + c] as number;
      second[at] = b[at * 4 + c] as number;
    }
    total += structuralSimilarity(first, second, width, height);
  }
  return total / 3;
}

function fitScene(
  seed: number,
  settings: typeof QUALITY | typeof QUICK,
  iterations: number = settings.iterations,
) {
  const { poses, targets } = sceneFrames();
  const fitted = optimiseGaussians(targets, poses, {
    intrinsics: SCENE_INTRINSICS,
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    seeds: scatter(settings.seeds, mulberry32(seed)),
    budget: settings.budget,
    iterations,
    initialScale: settings.initialScale,
    refineEvery: 30,
    random: mulberry32(seed),
  });
  return { fitted, poses, targets };
}

/** How like its own frames a fitted capture is, at its worst view. */
function worstLikeness(
  fitted: {
    count: number;
    positions: Float32Array;
    scales: Float32Array;
    rotations: Float32Array;
    colors: Float32Array;
    opacities: Float32Array;
  },
  poses: readonly Float64Array[],
  targets: readonly Float64Array[],
): number {
  const set: GaussianSet = {
    count: fitted.count,
    positions: Float64Array.from(fitted.positions),
    scales: Float64Array.from(fitted.scales),
    rotations: Float64Array.from(fitted.rotations),
    colors: Float64Array.from(fitted.colors),
    opacities: Float64Array.from(fitted.opacities),
  };
  const rendered = new Float64Array(SCENE_WIDTH * SCENE_HEIGHT * 4);
  let worst = 1;
  for (let at = 0; at < poses.length; at += 1) {
    rasteriseGaussians(
      set,
      {
        width: SCENE_WIDTH,
        height: SCENE_HEIGHT,
        intrinsics: SCENE_INTRINSICS,
        worldToCamera: poses[at] as Float64Array,
      },
      rendered,
    );
    worst = Math.min(
      worst,
      likeness(rendered, targets[at] as Float64Array, SCENE_WIDTH, SCENE_HEIGHT),
    );
  }
  return worst;
}

test(
  'A SYNTHETIC ROOM IS FITTED FROM A SCATTER, above a likeness floor and inside its budget',
  () => {
    const { fitted, poses, targets } = fitScene(20260920, QUALITY);
    expect(fitted.count).toBeLessThanOrEqual(QUALITY.budget);
    expect(fitted.count).toBeGreaterThan(QUALITY.seeds);

    /*
     * **The control is the same scatter with the fit switched off**, which is the one comparison
     * that separates *this cloud found the room* from *any cloud of this size scores this well*.
     * It measures 0.12 against the fit's 0.61, and it costs 26 ms to say so.
     */
    const started = fitScene(20260920, QUALITY, 0);
    const before = worstLikeness(started.fitted, started.poses, started.targets);
    const after = worstLikeness(fitted, poses, targets);
    expect(before).toBeLessThan(0.25);
    /*
     * The floor is below what this measures rather than at it: a floor set at the measurement fails
     * on the next tuning pass, and one this far below still separates a fit that found the room from
     * a fit that found a fog.
     */
    expect(after).toBeGreaterThan(0.5);
    expect(after).toBeGreaterThan(before * 3);
  },
  PATIENT,
);

test(
  'the fitted capture packs, writes and reads back splat for splat',
  () => {
    const { fitted } = fitScene(4, QUICK);
    const data = packSplats(fitted);
    const asset = readDrft(
      writeDrft({
        meshes: [],
        splats: {
          count: data.count,
          positions: data.positions,
          records: data.packed,
          wordsPerSplat: data.wordsPerSplat,
          boundsMin: data.boundsMin,
          boundsMax: data.boundsMax,
        },
      }),
    );
    const block = asset.splats as DrftSplatBlock;
    expect(block).not.toBeNull();
    expect(block.count).toBe(data.count);
    expect(block.wordsPerSplat).toBe(data.wordsPerSplat);

    /*
     * **The file's order is its own**, by `coarseFirstOrder`, so the comparison is splat for splat
     * rather than slot for slot: every record that went in comes back exactly once. A capture read
     * through the engine's own reader is what proves the fit speaks the format, which is the whole
     * head start this task has.
     */
    const words = data.wordsPerSplat;
    const key = (records: Uint32Array, at: number): string =>
      Array.from(records.subarray(at * words, (at + 1) * words)).join(',');
    const wanted = new Set<string>();
    for (let at = 0; at < data.count; at += 1) wanted.add(key(data.packed, at));
    expect(wanted.size).toBe(data.count);
    for (let at = 0; at < block.count; at += 1) {
      expect(wanted.delete(key(block.records, at))).toBe(true);
    }
    expect(wanted.size).toBe(0);

    /*
     * And the words still mean what they meant. A position is three floats reinterpreted rather than
     * converted, so reading them back as floats is what says the reinterpretation survived the
     * container — every splat inside the bounds the packer measured.
     */
    const floats = new Float32Array(
      block.records.buffer,
      block.records.byteOffset,
      block.count * words,
    );
    for (let at = 0; at < block.count; at += 1) {
      for (let c = 0; c < 3; c += 1) {
        const value = floats[at * words + c] as number;
        expect(value).toBeGreaterThanOrEqual(data.boundsMin[c] as number);
        expect(value).toBeLessThanOrEqual(data.boundsMax[c] as number);
      }
    }
  },
  PATIENT,
);

test(
  'the same frames and the same seed give the same splats',
  () => {
    const first = fitScene(9, QUICK).fitted;
    const second = fitScene(9, QUICK).fitted;
    expect(second.count).toBe(first.count);
    expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
    expect(Array.from(second.scales)).toEqual(Array.from(first.scales));
    expect(Array.from(second.rotations)).toEqual(Array.from(first.rotations));
    expect(Array.from(second.colors)).toEqual(Array.from(first.colors));
    expect(Array.from(second.opacities)).toEqual(Array.from(first.opacities));
  },
  PATIENT,
);

test(
  'a degree-1 band is fitted when it is asked for, and absent when it is not',
  () => {
    const { poses, targets } = sceneFrames();
    const common = {
      intrinsics: SCENE_INTRINSICS,
      width: SCENE_WIDTH,
      height: SCENE_HEIGHT,
      seeds: scatter(40, mulberry32(2)),
      budget: 60,
      iterations: 60,
      initialScale: 0.15,
      random: mulberry32(2),
    };
    const plain = optimiseGaussians(targets, poses, common);
    expect(plain.sh1).toBeUndefined();

    const turning = optimiseGaussians(targets, poses, { ...common, viewDependent: true });
    expect(turning.sh1?.length).toBe(turning.count * 9);
    /* The band is fitted rather than carried: something in it has moved off zero. */
    expect(Array.from(turning.sh1 as Float32Array).some((value) => value !== 0)).toBe(true);
  },
  PATIENT,
);
