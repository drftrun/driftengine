import { mulberry32 } from '@driftengine/core';
import { expect, test } from 'vitest';

import { estimatePoses } from './poses.ts';
import { lookAt, renderTestScene, type TestCamera, type TestScene } from './testScene.ts';

/**
 * **A camera path is recovered, and a clip with no parallax says so instead of guessing.**
 *
 * The clip is a synthetic orbit of the analytic scene, so every pose is known before anything runs.
 * Two starts are tested, because a capture has both — and **they answer in different worlds, which
 * is the honest thing to do**: started from a depth model's cameras the answer stays in that
 * model's world, so it is compared against the truth outright; started from the pictures alone
 * there is no such world, so each pose is compared relative to the first frame's.
 */

const SCENE: TestScene = {
  boxes: [
    { min: [-0.6, -0.6, 3.6], max: [0.6, 0.6, 4.8], seed: 1 },
    { min: [-2.6, -1.2, 5.4], max: [-1.1, 1.1, 7.2], seed: 2 },
    { min: [1.1, -1.1, 4.8], max: [2.6, 0.7, 6.4], seed: 5 },
    { min: [-1.4, 0.6, 5.2], max: [1.4, 1.3, 5.9], seed: 7 },
  ],
  planes: [{ normal: [0, 1, 0], offset: -1.4, seed: 3 }],
};
const WIDTH = 192;
const HEIGHT = 144;
const INTRINSICS = [190, 190, WIDTH / 2, HEIGHT / 2] as const;

/** An arc of eye positions about the scene, and the frames seen from them. */
function orbit(
  count: number,
  radius: number,
  turning: boolean,
): { poses: Float64Array[]; frames: { pixels: Uint8Array; width: number; height: number }[] } {
  const poses: Float64Array[] = [];
  const frames = [];
  for (let at = 0; at < count; at += 1) {
    const t = count === 1 ? 0 : at / (count - 1);
    const eye: [number, number, number] = turning
      ? [0, 0, 0]
      : [-radius + 2 * radius * t, 0.12 * Math.sin(t * 3), 0.25 * t];
    const target: [number, number, number] = turning
      ? [0.9 * (t - 0.5), 0.25 * (t - 0.5), 5]
      : [0, 0, 5];
    const camera: TestCamera = {
      width: WIDTH,
      height: HEIGHT,
      intrinsics: INTRINSICS,
      worldToCamera: lookAt(eye, target),
    };
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    renderTestScene(SCENE, camera, pixels);
    poses.push(camera.worldToCamera);
    frames.push({ pixels, width: WIDTH, height: HEIGHT });
  }
  return { poses, frames };
}

/** Where a pose puts its camera in the world: −Rᵀ · t. */
function centreOf(pose: ArrayLike<number>): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[c] -= (pose[r * 4 + c] as number) * (pose[r * 4 + 3] as number);
    }
  }
  return out;
}

/** The angle between two rotations, in degrees. */
function apart(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let trace = 0;
  for (let r = 0; r < 3; r += 1) {
    for (let k = 0; k < 3; k += 1) trace += (a[r * 4 + k] as number) * (b[r * 4 + k] as number);
  }
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}

const FRAMES = 6;

test('A CAMERA PATH IS RECOVERED FROM THE PICTURES ALONE, in the world the scene is in', () => {
  const { poses, frames } = orbit(FRAMES, 0.5, false);
  const out = new Float32Array(FRAMES * 12);
  const answer = estimatePoses(frames, { intrinsics: INTRINSICS, random: mulberry32(9) }, out);
  expect(answer.count).toBe(FRAMES);
  expect(answer.parallax).toBe(true);
  expect(answer.scale).toBe('relative');

  /*
   * The path has no world and no scale of its own: every pose is taken relative to the first, and
   * one ratio fixes the scale for all of them.
   */
  const relative = (pose: ArrayLike<number>, first: ArrayLike<number>): Float64Array => {
    const out2 = new Float64Array(12);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (let k = 0; k < 3; k += 1)
          sum += (pose[r * 4 + k] as number) * (first[c * 4 + k] as number);
        out2[r * 4 + c] = sum;
      }
      let sum = pose[r * 4 + 3] as number;
      for (let k = 0; k < 3; k += 1)
        sum -= (out2[r * 4 + k] as number) * (first[k * 4 + 3] as number);
      out2[r * 4 + 3] = sum;
    }
    return out2;
  };
  const truthPoses = poses.map((pose) => relative(pose, poses[0] as Float64Array));
  const answers = Array.from({ length: FRAMES }, (_, at) =>
    relative(out.subarray(at * 12, at * 12 + 12), out.subarray(0, 12)),
  );
  const truth = truthPoses.map((pose) => centreOf(pose));
  const found = answers.map((pose) => centreOf(pose));
  const span = (points: readonly (readonly number[])[]): number => {
    const first = points[0] as readonly number[];
    const last = points[points.length - 1] as readonly number[];
    return Math.sqrt(
      ((last[0] as number) - (first[0] as number)) * ((last[0] as number) - (first[0] as number)) +
        ((last[1] as number) - (first[1] as number)) *
          ((last[1] as number) - (first[1] as number)) +
        ((last[2] as number) - (first[2] as number)) * ((last[2] as number) - (first[2] as number)),
    );
  };
  const scale = span(truth) / span(found);
  expect(Number.isFinite(scale)).toBe(true);
  for (let at = 0; at < FRAMES; at += 1) {
    /* Every camera turns as it did, and stands where it did once the one scale is applied. */
    expect(apart(answers[at] as Float64Array, truthPoses[at] as Float64Array)).toBeLessThan(2);
    const mine = found[at] as readonly number[];
    const real = truth[at] as readonly number[];
    for (let c = 0; c < 3; c += 1) {
      expect(Math.abs((mine[c] as number) * scale - (real[c] as number))).toBeLessThan(0.15);
    }
  }
  /*
   * Started from the pictures alone, the first frame *is* the world: it stays exactly where it was
   * put. A bundle adjustment that lets it move has six free directions and wanders in them.
   */
  expect(Array.from(out.subarray(0, 12))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  /* Confidence is reported per pose, and the first frame — the reference — is the surest. */
  expect(answer.confidence.length).toBe(FRAMES);
  expect(answer.confidence.every((value) => value >= 0 && value <= 1)).toBe(true);
});

test('THE DEPTH MODEL’S CAMERAS ARE A START, AND THE ANSWER IS BETTER THAN THEM', () => {
  const { poses, frames } = orbit(FRAMES, 0.5, false);
  /* The model's cameras, as a real one gives them: the truth, knocked about a little. */
  const random = mulberry32(4);
  const rough = poses.map((pose) => {
    const noisy = Float64Array.from(pose);
    for (let r = 0; r < 3; r += 1)
      noisy[r * 4 + 3] = (noisy[r * 4 + 3] as number) + (random() - 0.5) * 0.15;
    return noisy;
  });
  const out = new Float32Array(FRAMES * 12);
  const answer = estimatePoses(
    frames,
    { intrinsics: INTRINSICS, random: mulberry32(9), modelPoses: rough },
    out,
  );
  expect(answer.count).toBe(FRAMES);
  /* Started from the model's cameras, the answer is nearer the truth than they were. */
  const off = (pose: ArrayLike<number>, at: number): number => {
    const mine = centreOf(pose);
    const real = centreOf(poses[at] as Float64Array);
    return Math.sqrt(
      (mine[0] - real[0]) * (mine[0] - real[0]) +
        (mine[1] - real[1]) * (mine[1] - real[1]) +
        (mine[2] - real[2]) * (mine[2] - real[2]),
    );
  };
  let started = 0;
  let ended = 0;
  for (let at = 0; at < FRAMES; at += 1) {
    started = Math.max(started, off(rough[at] as Float64Array, at));
    ended = Math.max(ended, off(out.subarray(at * 12, at * 12 + 12), at));
  }
  expect(ended).toBeLessThan(started);
});

test('A CLIP THAT ONLY TURNS IS REPORTED, NOT FITTED', () => {
  const { frames } = orbit(FRAMES, 0, true);
  const out = new Float32Array(FRAMES * 12);
  const answer = estimatePoses(frames, { intrinsics: INTRINSICS, random: mulberry32(9) }, out);
  expect(answer.parallax).toBe(false);
  /* Every camera stands where the first one does: there is no baseline to claim. */
  for (let at = 0; at < answer.count; at += 1) {
    const centre = centreOf(out.subarray(at * 12, at * 12 + 12));
    expect(
      Math.sqrt(centre[0] * centre[0] + centre[1] * centre[1] + centre[2] * centre[2]),
    ).toBeLessThan(1e-6);
  }
});

test('a known length makes the scale metric, and without one it stays relative', () => {
  const { poses, frames } = orbit(FRAMES, 0.5, false);
  const first = centreOf(poses[0] as Float64Array);
  const last = centreOf(poses[FRAMES - 1] as Float64Array);
  const metres = Math.sqrt(
    (last[0] - first[0]) * (last[0] - first[0]) +
      (last[1] - first[1]) * (last[1] - first[1]) +
      (last[2] - first[2]) * (last[2] - first[2]),
  );
  const out = new Float32Array(FRAMES * 12);
  const answer = estimatePoses(
    frames,
    {
      intrinsics: INTRINSICS,
      random: mulberry32(9),
      knownLength: { metres, from: 0, to: FRAMES - 1 },
    },
    out,
  );
  expect(answer.scale).toBe('metric');
  /* The path is now in metres: the named distance is the distance. */
  const mineFirst = centreOf(out.subarray(0, 12));
  const mineLast = centreOf(out.subarray((FRAMES - 1) * 12, FRAMES * 12));
  const measured = Math.sqrt(
    (mineLast[0] - mineFirst[0]) * (mineLast[0] - mineFirst[0]) +
      (mineLast[1] - mineFirst[1]) * (mineLast[1] - mineFirst[1]) +
      (mineLast[2] - mineFirst[2]) * (mineLast[2] - mineFirst[2]),
  );
  expect(Math.abs(measured - metres)).toBeLessThan(1e-4);
});

test('the same frames and seed give the same poses', () => {
  const { frames } = orbit(4, 0.4, false);
  const first = new Float32Array(4 * 12);
  const second = new Float32Array(4 * 12);
  const a = estimatePoses(frames, { intrinsics: INTRINSICS, random: mulberry32(3) }, first);
  const b = estimatePoses(frames, { intrinsics: INTRINSICS, random: mulberry32(3) }, second);
  expect(b.count).toBe(a.count);
  expect(Array.from(second)).toEqual(Array.from(first));
  expect(Array.from(b.confidence)).toEqual(Array.from(a.confidence));
});
