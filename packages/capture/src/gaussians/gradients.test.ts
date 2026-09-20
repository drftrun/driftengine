import { mulberry32 } from '@driftengine/core';
import { expect, test } from 'vitest';

import { lookAt } from '../testScene.ts';
import { accumulateGradients, createGradients, imageLoss } from './gradients.ts';
import type { GaussianSet, RasterCamera } from './project.ts';
import { rasteriseGaussians } from './rasterise.ts';

/**
 * **Every analytic gradient against a central difference of the rasteriser it differentiates.**
 *
 * A gradient that is subtly wrong does not fail loudly: it trains to a slightly wrong cloud, and
 * the picture still looks like the scene. So each parameter is nudged either way, the loss
 * measured, and the slope compared with what the chain rule claims — position, scale, rotation,
 * colour and opacity, over three arrangements that put different terms under load. It found two
 * real defects on its first run: a factor of two on every off-diagonal term of the covariance, and
 * one scrambled column of the quaternion's derivative.
 *
 * **The difference is taken into a double frame, and the step is measured rather than chosen.**
 * Two things spoil it from opposite ends. Above about a ten-thousandth, pixels cross the
 * rasteriser's faint cutoff as the parameter moves, and the loss takes a step the derivative cannot
 * see — measured at 22% on a position. Below about a millionth, the difference is lost in the
 * frame's own rounding, which is where a single-precision frame puts the floor for every step: a
 * part in five hundred at best. A hundred-thousandth into a double frame is between the two, and
 * every family lands within 5 · 10⁻⁸ there.
 */

const WIDTH = 24;
const HEIGHT = 24;
const CAMERA: RasterCamera = {
  width: WIDTH,
  height: HEIGHT,
  intrinsics: [40, 40, WIDTH / 2, HEIGHT / 2],
  worldToCamera: lookAt([0, 0, 0], [0, 0, 1]),
};
const PIXELS = WIDTH * HEIGHT * 4;

/** A cloud that overlaps itself, so occlusion is part of what is differentiated. */
function cloud(count: number, arrange?: (set: GaussianSet) => void): GaussianSet {
  const random = mulberry32(20260920);
  const set: GaussianSet = {
    count,
    positions: new Float64Array(count * 3),
    scales: new Float64Array(count * 3),
    rotations: new Float64Array(count * 4),
    colors: new Float64Array(count * 3),
    opacities: new Float64Array(count),
  };
  for (let at = 0; at < count; at += 1) {
    set.positions[at * 3] = (random() - 0.5) * 0.3;
    set.positions[at * 3 + 1] = (random() - 0.5) * 0.3;
    set.positions[at * 3 + 2] = 1.6 + random() * 0.8;
    for (let c = 0; c < 3; c += 1) set.scales[at * 3 + c] = 0.05 + random() * 0.05;
    for (let c = 0; c < 4; c += 1) set.rotations[at * 4 + c] = random() - 0.5;
    for (let c = 0; c < 3; c += 1) set.colors[at * 3 + c] = 0.2 + random() * 0.7;
    set.opacities[at] = 0.3 + random() * 0.6;
  }
  arrange?.(set);
  return set;
}

/** The same cloud moved a little, so the loss is neither zero nor enormous. */
function targetFor(set: GaussianSet): Float64Array {
  const shifted: GaussianSet = {
    count: set.count,
    positions: Float64Array.from(set.positions),
    scales: Float64Array.from(set.scales),
    rotations: Float64Array.from(set.rotations),
    colors: Float64Array.from(set.colors),
    opacities: Float64Array.from(set.opacities),
  };
  for (let at = 0; at < shifted.count; at += 1) {
    shifted.positions[at * 3] = (shifted.positions[at * 3] as number) + 0.02;
    shifted.opacities[at] = Math.min(1, (shifted.opacities[at] as number) * 0.9);
  }
  const target = new Float64Array(PIXELS);
  rasteriseGaussians(shifted, CAMERA, target);
  return target;
}

function lossOf(set: GaussianSet, target: Float64Array): number {
  const rendered = new Float64Array(PIXELS);
  rasteriseGaussians(set, CAMERA, rendered);
  return imageLoss(rendered, target, new Float64Array(PIXELS));
}

const STEP = 1e-5;
const TOLERANCE = 2e-7;

/** Every parameter of a family, nudged either way, against what the chain rule claims. */
function checkAgainstDifference(label: string, set: GaussianSet): void {
  const target = targetFor(set);
  const rendered = new Float64Array(PIXELS);
  rasteriseGaussians(set, CAMERA, rendered);
  const dPixels = new Float64Array(PIXELS);
  const loss = imageLoss(rendered, target, dPixels);
  /*
   * A cloud that already matched its target would hold every gradient at zero and prove nothing.
   * The three arrangements measure 0.86, 0.84 and 0.62 against their own shifted copies.
   */
  expect(loss).toBeGreaterThan(0.5);
  const gradients = createGradients(set.count);
  accumulateGradients(set, CAMERA, dPixels, gradients);

  const families: (readonly [string, Float64Array, Float64Array])[] = [
    ['position', set.positions, gradients.positions],
    ['scale', set.scales, gradients.scales],
    ['rotation', set.rotations, gradients.rotations],
    ['colour', set.colors, gradients.colors],
    ['opacity', set.opacities, gradients.opacities],
  ];
  if (set.sh1 !== undefined) families.push(['sh1', set.sh1, gradients.sh1]);
  let largest = 0;
  for (const [name, values, analytic] of families) {
    for (let i = 0; i < values.length; i += 1) {
      const held = values[i] as number;
      values[i] = held + STEP;
      const up = lossOf(set, target);
      values[i] = held - STEP;
      const down = lossOf(set, target);
      values[i] = held;
      const numeric = (up - down) / (2 * STEP);
      largest = Math.max(largest, Math.abs(numeric));
      /* Relative to the slope, but never dividing by a slope smaller than one. */
      const off = Math.abs(numeric - (analytic[i] as number)) / Math.max(1, Math.abs(numeric));
      expect(off, `${label} ${name}[${i}]: ${analytic[i]} against ${numeric}`).toBeLessThan(
        TOLERANCE,
      );
    }
  }
  /* And the slopes are real ones: a cloud whose every gradient is a rounding error tests nothing. */
  expect(largest).toBeGreaterThan(1);
}

test('EVERY GRADIENT IS THE SLOPE THE RASTERISER ACTUALLY HAS, over five occluding Gaussians', () => {
  checkAgainstDifference('cloud', cloud(5));
});

test('a round Gaussian is the case where a covariance term can hide', () => {
  /*
   * Identity rotation and one scale on all three axes: the screen ellipse is a circle, its
   * off-diagonal is zero, and a term carrying the wrong factor there moves nothing until something
   * turns. It is also where the rasteriser's own floor on the ellipse's spread applies.
   */
  checkAgainstDifference(
    'round',
    cloud(5, (set) => {
      for (let at = 0; at < set.count; at += 1) {
        for (let c = 0; c < 3; c += 1) set.scales[at * 3 + c] = 0.07;
        for (let c = 0; c < 4; c += 1) set.rotations[at * 4 + c] = c === 3 ? 1 : 0;
      }
    }),
  );
});

test('a cloud with a degree-1 band answers for its coefficients too', () => {
  /*
   * The band is a colour that turns with the camera, so its nine coefficients are nine more
   * parameters and the same difference holds them. They are kept small enough that no channel
   * reaches the shader's clamp, which is flat and has no slope for a difference to find.
   */
  checkAgainstDifference(
    'band',
    cloud(5, (set) => {
      const random = mulberry32(7);
      const sh1 = new Float64Array(set.count * 9);
      for (let i = 0; i < sh1.length; i += 1) sh1[i] = (random() - 0.5) * 0.2;
      Object.assign(set, { sh1 });
    }),
  );
});

test('and a cloud at the corner of the frame, where the perspective term is largest', () => {
  /*
   * A position moves the mean and, through the Jacobian, the covariance. The second term is what a
   * gradient written from the mean alone misses: it is nearly nothing at the centre of the frame,
   * which is where a cloud arranged for convenience sits.
   */
  checkAgainstDifference(
    'edge',
    cloud(5, (set) => {
      for (let at = 0; at < set.count; at += 1) {
        set.positions[at * 3] = 0.42 + 0.02 * at;
        set.positions[at * 3 + 1] = -0.38 - 0.02 * at;
      }
    }),
  );
});
