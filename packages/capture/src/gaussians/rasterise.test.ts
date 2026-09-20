import { expect, test } from 'vitest';

import { lookAt } from '../testScene.ts';
import { LOW_PASS, projectGaussian, type GaussianSet, type RasterCamera } from './project.ts';
import { rasteriseGaussians } from './rasterise.ts';

/**
 * **A Gaussian on screen is an ellipse whose size the geometry fixes**, and these hold the
 * projection to that: a round Gaussian at a known distance covers a known number of pixels, one
 * twice as far covers half the width, and one small enough to fall between pixels still covers one
 * — which is what the low-pass is for.
 *
 * Compositing is held to what alpha compositing means: a near opaque Gaussian hides what is behind
 * it, a faint one lets it through in the proportion it states.
 */

const WIDTH = 64;
const HEIGHT = 64;
const CAMERA: RasterCamera = {
  width: WIDTH,
  height: HEIGHT,
  intrinsics: [100, 100, WIDTH / 2, HEIGHT / 2],
  worldToCamera: lookAt([0, 0, 0], [0, 0, 1]),
};

function one(
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

function join(sets: readonly GaussianSet[]): GaussianSet {
  return {
    count: sets.length,
    positions: Float64Array.from(sets.flatMap((set) => Array.from(set.positions))),
    scales: Float64Array.from(sets.flatMap((set) => Array.from(set.scales))),
    rotations: Float64Array.from(sets.flatMap((set) => Array.from(set.rotations))),
    colors: Float64Array.from(sets.flatMap((set) => Array.from(set.colors))),
    opacities: Float64Array.from(sets.flatMap((set) => Array.from(set.opacities))),
  };
}

test('A GAUSSIAN PROJECTS TO AN ELLIPSE THE GEOMETRY FIXES, and halves as it doubles its distance', () => {
  const near = projectGaussian(one([0, 0, 2], 0.05, [1, 1, 1], 1), 0, CAMERA);
  expect(near).not.toBeNull();
  /* Straight ahead, so it lands in the middle. */
  expect(near?.x).toBeCloseTo(WIDTH / 2, 9);
  expect(near?.y).toBeCloseTo(HEIGHT / 2, 9);
  /* A round Gaussian of σ at distance z covers f·σ/z pixels: 100 · 0.05 / 2 = 2.5, squared. */
  expect(near?.a).toBeCloseTo(2.5 * 2.5 + LOW_PASS, 6);
  expect(near?.d).toBeCloseTo(2.5 * 2.5 + LOW_PASS, 6);
  expect(near?.b).toBeCloseTo(0, 9);
  expect(near?.depth).toBeCloseTo(2, 9);

  const far = projectGaussian(one([0, 0, 4], 0.05, [1, 1, 1], 1), 0, CAMERA);
  /* Twice as far is half as wide, so a quarter of the variance. */
  expect((far?.a as number) - LOW_PASS).toBeCloseTo(((near?.a as number) - LOW_PASS) / 4, 6);

  /* Behind the camera there is nothing to draw. */
  expect(projectGaussian(one([0, 0, -2], 0.05, [1, 1, 1], 1), 0, CAMERA)).toBeNull();
});

test('a Gaussian smaller than a pixel still covers one, which is what the low-pass is for', () => {
  const tiny = projectGaussian(one([0, 0, 2], 0.0001, [1, 1, 1], 1), 0, CAMERA);
  /* Its own width is a two-hundredth of a pixel, so what is left is very nearly the low-pass. */
  expect(tiny?.a).toBeCloseTo(LOW_PASS, 4);
  expect((tiny?.a as number) - LOW_PASS).toBeGreaterThan(0);
  const out = new Float32Array(WIDTH * HEIGHT * 4);
  rasteriseGaussians(one([0, 0, 2], 0.0001, [1, 1, 1], 1), CAMERA, out);
  /*
   * Its centre falls on the corner between four pixels, each half a pixel away in both axes, so
   * each takes exp(−0.5 · 0.5 / 0.3) = 0.43 of it — four pixels covered by a Gaussian that is a
   * two-hundredth of one across, which is the whole point of the low-pass.
   */
  const middle = (HEIGHT / 2) * WIDTH + WIDTH / 2;
  expect(out[middle * 4 + 3]).toBeCloseTo(0.4346, 3);
  let covered = 0;
  for (let at = 0; at < WIDTH * HEIGHT; at += 1)
    if ((out[at * 4 + 3] as number) > 0.01) covered += 1;
  expect(covered).toBeGreaterThanOrEqual(4);
});

test('THE NEARER GAUSSIAN HIDES THE FURTHER, in the proportion its opacity states', () => {
  const out = new Float32Array(WIDTH * HEIGHT * 4);
  const middle = (HEIGHT / 2) * WIDTH + WIDTH / 2;
  /* An opaque red in front of a green: only the red arrives. */
  rasteriseGaussians(
    join([one([0, 0, 2], 0.1, [1, 0, 0], 1), one([0, 0, 4], 0.2, [0, 1, 0], 1)]),
    CAMERA,
    out,
  );
  expect(out[middle * 4]).toBeGreaterThan(0.99);
  expect(out[middle * 4 + 1]).toBeLessThan(0.01);
  expect(out[middle * 4 + 3]).toBeGreaterThan(0.99);

  /* Half-opaque, and half the green comes through — alpha compositing, in order. */
  rasteriseGaussians(
    join([one([0, 0, 2], 0.1, [1, 0, 0], 0.5), one([0, 0, 4], 0.2, [0, 1, 0], 1)]),
    CAMERA,
    out,
  );
  expect(out[middle * 4]).toBeCloseTo(0.5, 2);
  expect(out[middle * 4 + 1]).toBeCloseTo(0.5, 2);

  /* And the order is by depth, not by the order they were given. */
  const swapped = new Float32Array(WIDTH * HEIGHT * 4);
  rasteriseGaussians(
    join([one([0, 0, 4], 0.2, [0, 1, 0], 1), one([0, 0, 2], 0.1, [1, 0, 0], 0.5)]),
    CAMERA,
    swapped,
  );
  expect(swapped[middle * 4]).toBeCloseTo(out[middle * 4] as number, 6);
  expect(swapped[middle * 4 + 1]).toBeCloseTo(out[middle * 4 + 1] as number, 6);
});

test('an empty sky stays empty, and what falls outside the frame is not drawn', () => {
  const out = new Float32Array(WIDTH * HEIGHT * 4);
  rasteriseGaussians({ ...one([0, 0, 2], 0.05, [1, 1, 1], 1), count: 0 }, CAMERA, out);
  expect(out.every((value) => value === 0)).toBe(true);
  /* Far to the side: its ellipse reaches nowhere near the frame. */
  rasteriseGaussians(one([8, 0, 2], 0.05, [1, 1, 1], 1), CAMERA, out);
  expect(out.every((value) => value === 0)).toBe(true);
});

test('the cloud is drawn where it stands: moving it moves the pixels', () => {
  const out = new Float32Array(WIDTH * HEIGHT * 4);
  /*
   * X = 0.21 puts it at 100 · 0.21 / 2 + 32 = 42.5, and **Y = −0.01 at 32.5, because the camera's
   * y points down** while the world's points up: a positive Y moves a splat up the frame. Together
   * they are pixel (42, 32)'s own centre — a centre on a pixel's corner would sit equally between
   * four of them.
   */
  rasteriseGaussians(one([0.21, -0.01, 2], 0.05, [1, 1, 1], 1), CAMERA, out);
  let brightest = 0;
  for (let at = 1; at < WIDTH * HEIGHT; at += 1) {
    if ((out[at * 4 + 3] as number) > (out[brightest * 4 + 3] as number)) brightest = at;
  }
  expect(brightest % WIDTH).toBe(42);
  expect(Math.floor(brightest / WIDTH)).toBe(32);
});
