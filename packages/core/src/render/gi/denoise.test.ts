import { expect, test } from 'vitest';

import { GI_SOURCE_FIELD, GI_SOURCE_PROBES, GI_SOURCE_SCREEN } from './chain.ts';
import {
  DENOISE_MIN_ALPHA,
  filterStepFor,
  newTemporalPixel,
  spatialDenoise,
  temporalDenoise,
} from './denoise.ts';

import type { DenoiseFrame } from './denoise.ts';

/**
 * **What this file is for: a filter that loses energy is worse than no filter at all.**
 *
 * Indirect light is integrated from a handful of rays a pixel, so it arrives noisy and has to be
 * filtered — and every way of filtering it can quietly darken the scene. A spatial kernel whose
 * weights do not sum to one darkens wherever a neighbour was rejected, which is every edge. A
 * temporal blend that treats a disoccluded pixel as merely stale smears the thing that moved. And
 * a blend whose weight does not settle either oscillates or never arrives at the mean it is
 * averaging.
 *
 * Each of those reads as "the lighting needs a tuning pass" rather than as a filter being wrong.
 */

/** A frame of the shape the denoiser takes, filled by a caller-supplied function per pixel. */
function frame(
  width: number,
  height: number,
  fill: (
    x: number,
    y: number,
  ) => {
    radiance: [number, number, number];
    depth: number;
    normal: [number, number, number];
    source: number;
  },
): DenoiseFrame {
  const radiance = new Float32Array(width * height * 3);
  const depth = new Float32Array(width * height);
  const normal = new Float32Array(width * height * 3);
  const source = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const cell = fill(x, y);
      radiance[at * 3] = cell.radiance[0];
      radiance[at * 3 + 1] = cell.radiance[1];
      radiance[at * 3 + 2] = cell.radiance[2];
      depth[at] = cell.depth;
      normal[at * 3] = cell.normal[0];
      normal[at * 3 + 1] = cell.normal[1];
      normal[at * 3 + 2] = cell.normal[2];
      source[at] = cell.source;
    }
  }
  return { radiance, depth, normal, source, width, height };
}

/** A deterministic noise, so a failure is reproducible rather than a seed away. */
function wobble(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n) - 0.5;
}

function meanOf(values: Float32Array, at: readonly number[]): number {
  let total = 0;
  for (const index of at) total += values[index * 3] as number;
  return total / at.length;
}

function varianceOf(values: Float32Array, at: readonly number[]): number {
  const mean = meanOf(values, at);
  let total = 0;
  for (const index of at) total += ((values[index * 3] as number) - mean) ** 2;
  return total / at.length;
}

test('A CONSTANT SIGNAL IS UNCHANGED, which is the weights summing to one', () => {
  /*
   * **The cheapest way to be wrong here is to lose energy at every edge.** A kernel that rejects a
   * neighbour on depth or normal and does not renormalise what is left keeps a smaller total, so
   * every silhouette in the scene darkens by however much of its kernel fell off the surface —
   * which reads as contact shadowing, looks plausible, and is the filter eating light.
   *
   * A frame that is constant everywhere has to come back constant, including along the
   * discontinuity where half of every kernel is rejected.
   */
  const width = 16;
  const height = 16;
  const source = frame(width, height, (x) => ({
    radiance: [0.7, 0.4, 0.2],
    /* A cliff down the middle, so half of every kernel there is rejected. */
    depth: x < 8 ? 5 : 20,
    normal: [0, 0, 1],
    source: GI_SOURCE_PROBES,
  }));
  const out = new Float32Array(width * height * 3);
  spatialDenoise(source, { step: 1 }, out);

  for (let at = 0; at < width * height; at++) {
    expect(out[at * 3]).toBeCloseTo(0.7, 5);
    expect(out[at * 3 + 1]).toBeCloseTo(0.4, 5);
    expect(out[at * 3 + 2]).toBeCloseTo(0.2, 5);
  }
});

test('NOISE ON A FLAT SURFACE IS REDUCED, and not across a depth discontinuity', () => {
  /*
   * Two planes at very different depths, each carrying its own mean and the same noise. The noise
   * has to fall on both, and neither plane's mean may move toward the other's — a filter that
   * blends across the cliff pulls a bright wall's light onto the dark floor in front of it, which
   * is a halo along every silhouette.
   */
  const width = 24;
  const height = 24;
  const near = 0.2;
  const far = 0.9;
  const source = frame(width, height, (x, y) => ({
    radiance: [(x < 12 ? near : far) + wobble(x, y) * 0.3, 0, 0],
    depth: x < 12 ? 5 : 40,
    normal: [0, 0, 1],
    source: GI_SOURCE_PROBES,
  }));
  const out = new Float32Array(width * height * 3);
  spatialDenoise(source, { step: 1 }, out);

  /* Columns well inside each plane, so this is about the filter rather than about the border. */
  const left: number[] = [];
  const right: number[] = [];
  for (let y = 4; y < 20; y++) {
    for (let x = 2; x < 9; x++) left.push(y * width + x);
    for (let x = 15; x < 22; x++) right.push(y * width + x);
  }

  expect(varianceOf(out, left)).toBeLessThan(varianceOf(source.radiance, left) * 0.5);
  expect(varianceOf(out, right)).toBeLessThan(varianceOf(source.radiance, right) * 0.5);

  /* And neither mean moved toward the other. */
  expect(meanOf(out, left)).toBeCloseTo(near, 1);
  expect(meanOf(out, right)).toBeCloseTo(far, 1);

  /* The pixel hard against the cliff still belongs to its own plane. */
  const edge = 10 * width + 11;
  expect(out[edge * 3] as number).toBeLessThan((near + far) / 2);
});

test('and not across a normal discontinuity either', () => {
  /* Two faces of a corner at the same depth: a filter weighted on depth alone blends them. */
  const width = 20;
  const height = 8;
  const source = frame(width, height, (x, y) => ({
    radiance: [x < 10 ? 0.1 : 0.9, 0, 0],
    depth: 10,
    normal: x < 10 ? [0, 0, 1] : [1, 0, 0],
    source: GI_SOURCE_PROBES,
  }));
  const out = new Float32Array(width * height * 3);
  spatialDenoise(source, { step: 1 }, out);

  expect(out[(4 * width + 3) * 3] as number).toBeCloseTo(0.1, 4);
  expect(out[(4 * width + 16) * 3] as number).toBeCloseTo(0.9, 4);
});

test('A DISTANT TILTED SURFACE IS ONE SURFACE, which is what makes the depth tolerance relative', () => {
  /*
   * **A centimetre is a discontinuity across a desk and nothing at all across a valley.** A plane
   * tilted away from the camera at a hundred metres has neighbours metres apart in depth and is
   * still one surface; an absolute tolerance chops it into strips, rejects every tap, and leaves
   * the noise exactly where it was — on the geometry furthest away, which is where there are
   * fewest rays a pixel and the noise is worst.
   */
  const width = 24;
  const height = 8;
  const source = frame(width, height, (x) => ({
    /*
     * The noise varies along `x` and not along `y`, so the vertical half of the pass is a no-op on
     * it and any reduction below came from the horizontal half — which is the half the depth
     * tolerance decides. Without that, a plane whose depth is constant down the column filters
     * vertically whatever the tolerance says and the test measures the wrong pass.
     */
    radiance: [0.5 + wobble(x, 0) * 0.4, 0, 0],
    /* Receding half a metre a pixel, a hundred metres out. */
    depth: 100 + x * 0.5,
    normal: [0, 0, 1],
    source: GI_SOURCE_SCREEN,
  }));
  const out = new Float32Array(width * height * 3);
  spatialDenoise(source, { step: 1 }, out);

  const middle: number[] = [];
  for (let y = 2; y < 6; y++) for (let x = 6; x < 18; x++) middle.push(y * width + x);
  expect(varianceOf(out, middle)).toBeLessThan(varianceOf(source.radiance, middle) * 0.5);
});

test('THE KERNEL IS SYMMETRIC AROUND A PIXEL, which reading its own output would break', () => {
  /*
   * **The second half of a separable pass must not read what it has already written.** Filtering
   * in place means a pixel's taps on one side are raw and on the other are already filtered, which
   * is a wider and lopsided kernel rather than the one declared — and it leans in whichever
   * direction the loop runs, so a bright point smears upward and leftward and nothing says why.
   *
   * One bright pixel in a flat frame, and what comes out has to be the same on both sides of it.
   */
  const width = 17;
  const height = 17;
  const source = frame(width, height, (x, y) => ({
    radiance: [x === 8 && y === 8 ? 1 : 0, 0, 0],
    depth: 10,
    normal: [0, 0, 1],
    source: GI_SOURCE_SCREEN,
  }));
  const out = new Float32Array(width * height * 3);
  spatialDenoise(source, { step: 1 }, out);

  for (let d = 1; d <= 4; d++) {
    expect(out[(8 * width + 8 - d) * 3] as number, `horizontal at ${d}`).toBeCloseTo(
      out[(8 * width + 8 + d) * 3] as number,
      6,
    );
    expect(out[((8 - d) * width + 8) * 3] as number, `vertical at ${d}`).toBeCloseTo(
      out[((8 + d) * width + 8) * 3] as number,
      6,
    );
  }
  /* And the impulse did spread, so the symmetry above is not the symmetry of nothing happening. */
  expect(out[(8 * width + 9) * 3] as number).toBeGreaterThan(0);
});

test('THE FILTER WIDTH COMES FROM WHERE THE LIGHT CAME FROM', () => {
  /*
   * **Task 6's `source` discriminant is what this is for.** A sample the screen answered is as
   * sharp as the frame it came from and wants the narrowest filter there is; one the world field
   * answered is a cone's worth of surface; one the probes answered is already an interpolation over
   * metres and filtering it narrowly buys nothing. Filtering all three the same width either
   * smears the sharp one or leaves the coarse one noisy.
   */
  expect(filterStepFor(GI_SOURCE_SCREEN)).toBeLessThan(filterStepFor(GI_SOURCE_FIELD));
  expect(filterStepFor(GI_SOURCE_FIELD)).toBeLessThan(filterStepFor(GI_SOURCE_PROBES));
  expect(filterStepFor(GI_SOURCE_SCREEN)).toBeGreaterThanOrEqual(1);
});

test('A DISOCCLUDED PIXEL TAKES THE SPATIAL ANSWER ALONE, rather than a stale history', () => {
  /*
   * **A disocclusion is not a stale history, it is a wrong one.** Reprojection finds where a pixel
   * was; nothing in it knows whether what was there is what is there now. A character stepping
   * away from a wall uncovers pixels whose history is the character — and blending nine parts of
   * that is a smear of them that follows them about, which is the failure temporal filtering is
   * best known for.
   */
  const pixel = newTemporalPixel();
  const out = new Float32Array(3);

  /* Twenty frames of a settled history. */
  for (let i = 0; i < 20; i++) {
    temporalDenoise([0.2, 0.2, 0.2], [0.2, 0.2, 0.2], null, false, pixel, out);
  }
  expect(out[0]).toBeCloseTo(0.2, 5);
  expect(pixel.samples).toBe(20);

  /* Then the thing in front moves away, and this frame is a different surface. */
  temporalDenoise([0.8, 0.8, 0.8], [0.2, 0.2, 0.2], null, true, pixel, out);
  expect(out[0]).toBeCloseTo(0.8, 5);
  expect(pixel.samples).toBe(1);
});

test('THE DENOISED RESULT AT CONVERGENCE IS THE NOISY MEAN, so the filter is not darkening', () => {
  /*
   * **A filter that settles below what it was averaging is the defect that survives every visual
   * check.** It looks like the scene wanting more light; it is the accumulation losing some. So
   * the weight of the first frames is an honest running mean — one over the count — rather than a
   * fixed blend that biases toward whatever it started at, and the floor below it is what lets a
   * moving scene keep up.
   */
  const pixel = newTemporalPixel();
  const out = new Float32Array(3);
  const mean = 0.35;
  let total = 0;

  for (let i = 0; i < 400; i++) {
    const noisy = mean + wobble(i, 7) * 0.6;
    total += noisy;
    temporalDenoise(
      [noisy, noisy, noisy],
      [out[0] as number, out[1] as number, out[2] as number],
      null,
      false,
      pixel,
      out,
    );
  }

  expect(out[0] as number).toBeCloseTo(total / 400, 2);
  expect(out[0] as number).toBeCloseTo(mean, 1);
});

test('AND WHILE IT IS SETTLING THE ANSWER IS THE EXACT MEAN, not a blend biased toward its start', () => {
  /*
   * **A fixed blend weight converges *near* the mean and an honest running one converges *to* it**,
   * and over stationary noise the two are close enough that the test above passes either way. What
   * separates them is the first few frames: one over the count is the arithmetic mean of exactly
   * what has been seen, so four samples come back as their own average rather than as a fifth of
   * the last one plus whatever the pixel happened to start at. That is what makes a pixel that has
   * just been disoccluded usable on its second frame instead of on its twentieth.
   */
  const pixel = newTemporalPixel();
  const out = new Float32Array(3);
  const seen = [0.1, 0.9, 0.4, 0.2];
  for (const value of seen) {
    temporalDenoise(
      [value, value, value],
      [out[0] as number, out[1] as number, out[2] as number],
      null,
      false,
      pixel,
      out,
    );
  }
  expect(out[0] as number).toBeCloseTo(seen.reduce((a, b) => a + b, 0) / seen.length, 6);
  expect(pixel.samples).toBe(4);
});

test('THE FILTER CONVERGES RATHER THAN OSCILLATING', () => {
  /*
   * A step change, then a constant: the answer has to approach the new value monotonically and
   * settle on it. A blend weight outside zero-to-one overshoots and comes back, which on a scene
   * whose lighting changes reads as a flicker after every change rather than during it.
   */
  const pixel = newTemporalPixel();
  const out = new Float32Array(3);
  for (let i = 0; i < 50; i++) {
    temporalDenoise(
      [0, 0, 0],
      [out[0] as number, out[1] as number, out[2] as number],
      null,
      false,
      pixel,
      out,
    );
  }

  let previous = out[0] as number;
  let overshoot = 0;
  for (let i = 0; i < 200; i++) {
    temporalDenoise(
      [1, 1, 1],
      [out[0] as number, out[1] as number, out[2] as number],
      null,
      false,
      pixel,
      out,
    );
    const value = out[0] as number;
    expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
    overshoot = Math.max(overshoot, value - 1);
    previous = value;
  }
  expect(overshoot).toBeLessThanOrEqual(0);
  expect(previous).toBeCloseTo(1, 3);

  /* And the weight has a floor, or a long-lived pixel stops responding to the world at all. */
  expect(DENOISE_MIN_ALPHA).toBeGreaterThan(0);
});

test('a history outside the colours actually present is pulled back to them', () => {
  /*
   * **The reuse this task was asked for.** `clipToNeighbourhood` in `temporalAa.ts` already
   * constrains a reprojected history to the box of what is around the pixel this frame, clipping
   * toward the centre rather than clamping per channel so a hue does not shift. It is the one part
   * of the temporal machinery that already exists, and writing a second one would be two answers
   * to one question.
   */
  const pixel = newTemporalPixel();
  const out = new Float32Array(3);
  for (let i = 0; i < 30; i++) {
    temporalDenoise([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], null, false, pixel, out);
  }

  /* A history far outside what is around it now, with a tight neighbourhood around this frame. */
  const bounded = newTemporalPixel();
  bounded.samples = 30;
  bounded.value.set([9, 9, 9]);
  temporalDenoise(
    [0.5, 0.5, 0.5],
    [9, 9, 9],
    { min: [0.4, 0.4, 0.4], max: [0.6, 0.6, 0.6] },
    false,
    bounded,
    out,
  );
  expect(out[0] as number).toBeLessThan(0.65);
  expect(out[0] as number).toBeGreaterThan(0.35);
});
