import { mulberry32 } from '@driftengine/core';
import { expect, test } from 'vitest';

import { lookAt } from './testScene.ts';
import { relativePose, triangulate } from './twoView.ts';

/**
 * **Two views give a relative pose, and a pair with no parallax says so.** The second half is the
 * one that matters: a camera that turned without moving can be fitted with a translation that
 * explains the pictures and means nothing, and every distance measured afterwards is then wrong in
 * a way no later stage can see. So a rotation is reported as a rotation.
 *
 * The correspondences here are exact projections of known points, which is what lets a pose be
 * asserted to a tenth of a degree; the image pipeline's own noise is `features.test.ts`'s subject.
 */

const INTRINSICS = [420, 420, 320, 240] as const;

/** A camera's 3 × 4 world-to-camera, and the points it sees, projected exactly. */
function project(
  worldToCamera: Float64Array,
  points: readonly (readonly [number, number, number])[],
): Float64Array {
  const out = new Float64Array(points.length * 2);
  points.forEach((point, at) => {
    const camera = [0, 0, 0];
    for (let r = 0; r < 3; r += 1) {
      camera[r] =
        (worldToCamera[r * 4] as number) * point[0] +
        (worldToCamera[r * 4 + 1] as number) * point[1] +
        (worldToCamera[r * 4 + 2] as number) * point[2] +
        (worldToCamera[r * 4 + 3] as number);
    }
    out[at * 2] = (INTRINSICS[0] * (camera[0] as number)) / (camera[2] as number) + INTRINSICS[2];
    out[at * 2 + 1] =
      (INTRINSICS[1] * (camera[1] as number)) / (camera[2] as number) + INTRINSICS[3];
  });
  return out;
}

/** A cloud with depth, which is what gives a pair its parallax. */
function cloud(seed: number, count: number): (readonly [number, number, number])[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => {
    return [(random() - 0.5) * 4, (random() - 0.5) * 3, 3 + random() * 5] as readonly [
      number,
      number,
      number,
    ];
  });
}

/** The angle between two directions, in degrees. */
function angle(a: readonly number[], b: readonly number[]): number {
  const dot =
    (a[0] as number) * (b[0] as number) +
    (a[1] as number) * (b[1] as number) +
    (a[2] as number) * (b[2] as number);
  const length =
    Math.sqrt((a[0] as number) ** 2 + (a[1] as number) ** 2 + (a[2] as number) ** 2) *
    Math.sqrt((b[0] as number) ** 2 + (b[1] as number) ** 2 + (b[2] as number) ** 2);
  return (Math.acos(Math.min(1, Math.max(-1, dot / length))) * 180) / Math.PI;
}

/** How far a rotation is from another, in degrees: the angle of the rotation between them. */
function apart(actual: Float64Array, expected: Float64Array): number {
  let trace = 0;
  for (let r = 0; r < 3; r += 1) {
    for (let k = 0; k < 3; k += 1) {
      trace += (actual[r * 3 + k] as number) * (expected[r * 3 + k] as number);
    }
  }
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}

/** The truth for a pair of poses: B's rotation and translation relative to A. */
function truth(
  a: Float64Array,
  b: Float64Array,
): { rotation: Float64Array; translation: number[] } {
  /* R = Rb · Raᵀ, t = tb − R · ta. */
  const rotation = new Float64Array(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += (b[r * 4 + k] as number) * (a[c * 4 + k] as number);
      rotation[r * 3 + c] = sum;
    }
  }
  const translation = [0, 0, 0];
  for (let r = 0; r < 3; r += 1) {
    let sum = b[r * 4 + 3] as number;
    for (let k = 0; k < 3; k += 1)
      sum -= (rotation[r * 3 + k] as number) * (a[k * 4 + 3] as number);
    translation[r] = sum;
  }
  return { rotation, translation };
}

const POINTS = cloud(20260920, 120);
const FIRST = lookAt([0, 0, 0], [0, 0, 5]);
const SECOND = lookAt([0.6, 0.15, 0.2], [0.05, 0, 5]);

test('THE RELATIVE POSE OF A KNOWN PAIR IS RECOVERED, to a tenth of a degree', () => {
  const a = project(FIRST, POINTS);
  const b = project(SECOND, POINTS);
  const rotation = new Float64Array(9);
  const translation = new Float64Array(3);
  const answer = relativePose(a, b, POINTS.length, INTRINSICS, mulberry32(7), {
    rotation,
    translation,
  });
  expect(answer.model).toBe('essential');
  expect(answer.inliers).toBeGreaterThan(POINTS.length * 0.9);
  const expected = truth(FIRST, SECOND);
  expect(apart(rotation, expected.rotation)).toBeLessThan(0.1);
  /* A two-view translation has no scale, so it is the direction that is asserted. */
  expect(angle(Array.from(translation), expected.translation)).toBeLessThan(0.1);
  /* And the pair has real parallax, which is what makes the translation meaningful. */
  expect(answer.parallax).toBeGreaterThan(2);
});

test('A PURE ROTATION IS REPORTED AS ONE, rather than fitted with a translation that means nothing', () => {
  /* The same centre, turned about it: every point moves, and none of it is parallax. */
  const turned = lookAt([0, 0, 0], [0.35, 0.1, 5]);
  const a = project(FIRST, POINTS);
  const b = project(turned, POINTS);
  const rotation = new Float64Array(9);
  const translation = new Float64Array(3);
  const answer = relativePose(a, b, POINTS.length, INTRINSICS, mulberry32(7), {
    rotation,
    translation,
  });
  expect(answer.model).toBe('homography');
  expect(answer.parallax).toBeLessThan(0.5);
  /* No translation is claimed, and the turn itself is still recovered. */
  expect(Math.sqrt(translation[0] ** 2 + translation[1] ** 2 + translation[2] ** 2)).toBe(0);
  expect(apart(rotation, truth(FIRST, turned).rotation)).toBeLessThan(0.5);
});

test('a baseline too short to measure is no baseline: the pair is reported as a turn', () => {
  /*
   * A millimetre to the side, five metres from the scene: the rays to a point differ by a
   * hundredth of a degree, which is less than the noise any real match carries. An essential matrix
   * still fits it, and the translation it answers would be a direction picked out of rounding.
   */
  const crept = lookAt([0.001, 0, 0], [0.001, 0, 5]);
  const a = project(FIRST, POINTS);
  const b = project(crept, POINTS);
  const rotation = new Float64Array(9);
  const translation = new Float64Array(3);
  const answer = relativePose(a, b, POINTS.length, INTRINSICS, mulberry32(7), {
    rotation,
    translation,
  });
  expect(answer.parallax).toBeLessThan(1);
  expect(answer.model).toBe('homography');
  expect(
    translation[0] * translation[0] +
      translation[1] * translation[1] +
      translation[2] * translation[2],
  ).toBe(0);

  /*
   * And a step of five centimetres, which the essential matrix does win: the pair is fitted, its
   * parallax measured at half a degree, and the answer downgraded to a turn anyway. A parallax
   * above zero is how one can tell that happened rather than the homography simply scoring better.
   */
  const stepped = lookAt([0.05, 0, 0], [0.05, 0, 5]);
  const small = new Float64Array(9);
  const none = new Float64Array(3);
  const short = relativePose(
    a,
    project(stepped, POINTS),
    POINTS.length,
    INTRINSICS,
    mulberry32(7),
    { rotation: small, translation: none },
  );
  expect(short.model).toBe('homography');
  expect(short.parallax).toBeGreaterThan(0);
  expect(short.parallax).toBeLessThan(1);
  expect(none[0] * none[0] + none[1] * none[1] + none[2] * none[2]).toBe(0);
});

test('a third of the matches being wrong does not move the answer', () => {
  const random = mulberry32(3);
  const a = project(FIRST, POINTS);
  const b = project(SECOND, POINTS);
  const spoiled = Float64Array.from(b);
  let wrong = 0;
  for (let at = 0; at < POINTS.length; at += 1) {
    if (at % 3 !== 0) continue;
    spoiled[at * 2] = random() * 640;
    spoiled[at * 2 + 1] = random() * 480;
    wrong += 1;
  }
  expect(wrong / POINTS.length).toBeGreaterThan(0.3);
  const rotation = new Float64Array(9);
  const translation = new Float64Array(3);
  const answer = relativePose(a, spoiled, POINTS.length, INTRINSICS, mulberry32(11), {
    rotation,
    translation,
  });
  const expected = truth(FIRST, SECOND);
  expect(answer.inliers).toBeGreaterThan(POINTS.length * 0.6);
  expect(apart(rotation, expected.rotation)).toBeLessThan(0.5);
  expect(angle(Array.from(translation), expected.translation)).toBeLessThan(1);
});

test('the same seed gives the same inliers, and a different one still agrees about the pose', () => {
  const a = project(FIRST, POINTS);
  const b = project(SECOND, POINTS);
  const run = (seed: number) => {
    const rotation = new Float64Array(9);
    const translation = new Float64Array(3);
    const answer = relativePose(a, b, POINTS.length, INTRINSICS, mulberry32(seed), {
      rotation,
      translation,
    });
    return { ...answer, rotation };
  };
  const first = run(5);
  const again = run(5);
  expect(again.inliers).toBe(first.inliers);
  expect(Array.from(again.rotation)).toEqual(Array.from(first.rotation));
  expect(apart(run(9).rotation, first.rotation)).toBeLessThan(0.1);
});

test('TRIANGULATION PUTS THE POINTS BACK WHERE THEY WERE, up to the pair’s one scale', () => {
  const a = project(FIRST, POINTS);
  const b = project(SECOND, POINTS);
  const rotation = new Float64Array(9);
  const translation = new Float64Array(3);
  relativePose(a, b, POINTS.length, INTRINSICS, mulberry32(7), { rotation, translation });
  const points = new Float64Array(POINTS.length * 3);
  const count = triangulate(a, b, POINTS.length, INTRINSICS, rotation, translation, points);
  expect(count).toBeGreaterThan(POINTS.length * 0.9);
  /*
   * The points come back in the first camera's frame rather than the world's, and without the
   * baseline's scale — which two views cannot know. So the truth is taken into that frame, and one
   * ratio fixes the scale for all of them.
   */
  const inFirst = POINTS.map((point) => {
    const camera = [0, 0, 0];
    for (let r = 0; r < 3; r += 1) {
      camera[r] =
        (FIRST[r * 4] as number) * point[0] +
        (FIRST[r * 4 + 1] as number) * point[1] +
        (FIRST[r * 4 + 2] as number) * point[2] +
        (FIRST[r * 4 + 3] as number);
    }
    return camera;
  });
  const scale = ((inFirst[0] as number[])[2] as number) / ((points[2] as number) || 1);
  for (let at = 0; at < POINTS.length; at += 1) {
    if ((points[at * 3 + 2] as number) === 0) continue;
    const truthPoint = inFirst[at] as number[];
    for (let c = 0; c < 3; c += 1) {
      const scaled = (points[at * 3 + c] as number) * scale;
      expect(Math.abs(scaled - (truthPoint[c] as number)), `point ${at}`).toBeLessThan(0.01);
    }
  }
});
