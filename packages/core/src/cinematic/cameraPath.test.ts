import { expect, test } from 'vitest';
import { createCameraPath, createCameraPathSample, sampleCameraPath } from './cameraPath.ts';

/**
 * A camera move through world space, keyed in time.
 *
 * Every expectation is a point a reader can place by hand: a key is where the camera is at its
 * time, and a straight, evenly timed run is a constant velocity with its midpoint halfway.
 */

const straight = createCameraPath(
  [
    { atSec: 0, eye: [0, 0, 0], target: [0, 0, -1], fovDeg: 50 },
    { atSec: 2, eye: [2, 0, 0], target: [2, 0, -1], fovDeg: 60 },
    { atSec: 4, eye: [4, 0, 0], target: [4, 0, -1], fovDeg: 70 },
  ],
  { loop: false },
);

test('AT A KEY THE CAMERA IS EXACTLY WHERE THE KEY PUTS IT', () => {
  const out = createCameraPathSample();
  sampleCameraPath(straight, 2, out);
  expect(out.eye).toEqual([2, 0, 0]);
  expect(out.target).toEqual([2, 0, -1]);
  expect(out.fovDeg).toBe(60);
});

test('an evenly timed straight run is a constant velocity, halfway at half time', () => {
  const out = createCameraPathSample();
  sampleCameraPath(straight, 1, out);
  expect(out.eye[0]).toBeCloseTo(1, 12);
  expect(out.eye[1]).toBeCloseTo(0, 12);
  sampleCameraPath(straight, 3, out);
  expect(out.eye[0]).toBeCloseTo(3, 12);
  expect(out.fovDeg).toBeCloseTo(65, 12);
});

test('an open path holds its ends, and a looped one wraps back through its first key', () => {
  const out = createCameraPathSample();
  sampleCameraPath(straight, -5, out);
  expect(out.eye).toEqual([0, 0, 0]);
  sampleCameraPath(straight, 50, out);
  expect(out.eye).toEqual([4, 0, 0]);

  /* A square, one second a side and back to the start at 4 s. */
  const square = createCameraPath(
    [
      { atSec: 0, eye: [0, 0, 0], target: [0, 0, 0], fovDeg: 50 },
      { atSec: 1, eye: [1, 0, 0], target: [0, 0, 0], fovDeg: 50 },
      { atSec: 2, eye: [1, 0, 1], target: [0, 0, 0], fovDeg: 50 },
      { atSec: 3, eye: [0, 0, 1], target: [0, 0, 0], fovDeg: 50 },
    ],
    { loop: true, periodSec: 4 },
  );
  expect(square.durationSec).toBe(4);
  sampleCameraPath(square, 5, out);
  expect(out.eye[0]).toBeCloseTo(1, 12);
  expect(out.eye[2]).toBeCloseTo(0, 12);
  sampleCameraPath(square, 4, out);
  expect(out.eye[0]).toBeCloseTo(0, 12);

  /*
   * Halfway along the closing side, which is where a loop's tangents have to wrap. At the last key
   * the tangent is (first − third) / 2 s = (−0.5, 0, −0.5); at the first key, reached again, it is
   * (second − last) / 2 s = (0.5, 0, −0.5). The Hermite weights at u = 0.5 are 0.5, 0.125, 0.5 and
   * −0.125, so x = 0.125 × −0.5 − 0.125 × 0.5 = −0.125 and z = 0.5 + 0.125 × (−0.5 + 0.5) = 0.5.
   */
  sampleCameraPath(square, 3.5, out);
  expect(out.eye[0]).toBeCloseTo(-0.125, 12);
  expect(out.eye[2]).toBeCloseTo(0.5, 12);
});

test('a curve between keys stays smooth: the velocity into a key equals the velocity out', () => {
  const bend = createCameraPath(
    [
      { atSec: 0, eye: [0, 0, 0], target: [0, 0, 0], fovDeg: 50 },
      { atSec: 1, eye: [1, 0, 0], target: [0, 0, 0], fovDeg: 50 },
      { atSec: 2, eye: [1, 0, 1], target: [0, 0, 0], fovDeg: 50 },
    ],
    { loop: false },
  );
  const a = createCameraPathSample();
  const b = createCameraPathSample();
  const h = 1e-5;
  sampleCameraPath(bend, 1 - h, a);
  sampleCameraPath(bend, 1, b);
  const inX = (b.eye[0] - a.eye[0]) / h;
  const inZ = (b.eye[2] - a.eye[2]) / h;
  sampleCameraPath(bend, 1 + h, a);
  const outX = (a.eye[0] - b.eye[0]) / h;
  const outZ = (a.eye[2] - b.eye[2]) / h;
  /* The tangent at the middle key is (next − previous) / 2 s: (1, 0, 1) / 2. */
  expect(inX).toBeCloseTo(0.5, 3);
  expect(inZ).toBeCloseTo(0.5, 3);
  expect(outX).toBeCloseTo(0.5, 3);
  expect(outZ).toBeCloseTo(0.5, 3);
});

test('keys out of time order, or too few to move between, are refused', () => {
  expect(() =>
    createCameraPath([{ atSec: 0, eye: [0, 0, 0], target: [0, 0, 1], fovDeg: 50 }], {
      loop: false,
    }),
  ).toThrow(/at least two keys/);
  expect(() =>
    createCameraPath(
      [
        { atSec: 1, eye: [0, 0, 0], target: [0, 0, 1], fovDeg: 50 },
        { atSec: 1, eye: [1, 0, 0], target: [0, 0, 1], fovDeg: 50 },
      ],
      { loop: false },
    ),
  ).toThrow(/later than the one before/);
  expect(() =>
    createCameraPath(
      [
        { atSec: 0, eye: [0, 0, 0], target: [0, 0, 1], fovDeg: 50 },
        { atSec: 3, eye: [1, 0, 0], target: [0, 0, 1], fovDeg: 50 },
      ],
      { loop: true, periodSec: 3 },
    ),
  ).toThrow(/period/);
});
