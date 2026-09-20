import { mulberry32 } from '@driftengine/core';
import { expect, test } from 'vitest';

import { structuralSimilarity, SIMILARITY_WINDOW } from './similarity.ts';

/**
 * **What "the fit looks like the frame" means, as a number.** A squared difference says how far
 * apart two pictures are and nothing about whether they show the same thing: a fit that is uniformly
 * a little dark scores badly on it and looks right, and one that is right on average with the
 * structure smeared away scores well and looks wrong. Structural similarity compares local means,
 * variances and covariance instead, which is why the fit is held to it.
 */

const WIDTH = 16;
const HEIGHT = 16;

function fill(make: (x: number, y: number) => number): Float64Array {
  const out = new Float64Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) out[y * WIDTH + x] = make(x, y);
  }
  return out;
}

test('A PICTURE IS EXACTLY ITSELF, and the measure says so', () => {
  const random = mulberry32(11);
  const picture = fill(() => random());
  expect(structuralSimilarity(picture, picture, WIDTH, HEIGHT)).toBeCloseTo(1, 12);
});

test('two flat patches are compared by their means alone, by the formula’s own arithmetic', () => {
  /*
   * Where neither picture varies, every variance and the covariance are zero and the measure is
   * `(2·μx·μy + C1) / (μx² + μy² + C1)` — which is worth holding to a literal, because it is the
   * half of the formula a wrong constant hides in.
   */
  const bright = fill(() => 0.8);
  const dim = fill(() => 0.5);
  const c1 = 0.01 * 0.01;
  const expected = (2 * 0.8 * 0.5 + c1) / (0.8 * 0.8 + 0.5 * 0.5 + c1);
  expect(structuralSimilarity(bright, dim, WIDTH, HEIGHT)).toBeCloseTo(expected, 12);
  expect(expected).toBeCloseTo(0.8989, 4);
});

test('the spread is estimated the way the original estimates it, over n − 1', () => {
  /*
   * Four pixels, one window, the same two values arranged two ways: the means agree exactly, so
   * the brightness half is 1, and the two arrangements share no variation at all, so the covariance
   * is 0 and what is left is `C2 / (varA + varB + C2)`. Each variance is 1 ÷ 3 over n − 1 and would
   * be 1 ÷ 4 over n — a fifth apart in the answer, which is why it is pinned here rather than left
   * to a comparison that cannot see it.
   */
  const a = Float64Array.from([0, 0, 1, 1]);
  const b = Float64Array.from([0, 1, 0, 1]);
  const c2 = 0.03 * 0.03;
  const unbiased = c2 / (1 / 3 + 1 / 3 + c2);
  expect(structuralSimilarity(a, b, 2, 2)).toBeCloseTo(unbiased, 12);
  expect(unbiased).toBeCloseTo(0.001348, 6);
});

test('structure counts for more than brightness does', () => {
  /* A picture with its structure intact but every value lifted, against one with the same mean
     and the structure destroyed. The second is the worse match, which a squared difference
     alone need not say. */
  const random = mulberry32(3);
  const picture = fill((x, y) => 0.25 + 0.5 * (((x >> 2) + (y >> 2)) % 2));
  let total = 0;
  for (const value of picture) total += value;
  const mean = total / picture.length;
  const lifted = fill((x, y) => (picture[y * WIDTH + x] as number) * 0.9 + 0.05);
  const noise = fill(() => mean + (random() - 0.5) * 0.5);
  const keptStructure = structuralSimilarity(picture, lifted, WIDTH, HEIGHT);
  const lostStructure = structuralSimilarity(picture, noise, WIDTH, HEIGHT);
  expect(keptStructure).toBeGreaterThan(0.9);
  expect(lostStructure).toBeLessThan(0.3);
});

test('the window is the unit of comparison, and a picture smaller than one is still answered', () => {
  expect(SIMILARITY_WINDOW).toBe(8);
  const tiny = new Float64Array(9).fill(0.4);
  const same = new Float64Array(9).fill(0.4);
  expect(structuralSimilarity(tiny, same, 3, 3)).toBeCloseTo(1, 12);
});
