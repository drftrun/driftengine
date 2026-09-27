import { expect, test } from 'vitest';
import { FILM_LOOK_GLSL, grainSeed, grainWeight, vignetteFactor } from './filmLook.ts';

/**
 * The lens's falloff and the print's grain weighting, against values worked out by hand. The two
 * functions are the shader's arithmetic written out again, so what this proves is that the two
 * agree on the formula the header argues; the source assertions below hold the shader to it.
 */

test('THE VIGNETTE IS ONE AT THE CENTRE AND 1 / (1 + k)^2 AT THE CORNER, on a circle', () => {
  /* Centre: no distance, no loss. */
  expect(vignetteFactor(0.5, 0.5, 1920, 1080, 0.5)).toBe(1);
  /* Corner: r = 1, so 1 / 1.5^2 = 0.4444, about 1.17 stops. */
  expect(vignetteFactor(0, 0, 1920, 1080, 0.5)).toBeCloseTo(1 / 2.25, 10);
  /*
   * The middle of the left edge on a 16:9 frame: r^2 = 960^2 / (960^2 + 540^2) = 0.75964, and
   * 1 / (1 + 0.5 * 0.75964)^2 = 0.52524. The top edge's middle is 540^2 over the same, 0.24036,
   * which gives 0.79694: a wide frame's side is further from its centre than its top is.
   */
  expect(vignetteFactor(0, 0.5, 1920, 1080, 0.5)).toBeCloseTo(0.52524, 4);
  expect(vignetteFactor(0.5, 0, 1920, 1080, 0.5)).toBeCloseTo(0.79694, 4);
  /* And off is off. */
  expect(vignetteFactor(0, 0, 1920, 1080, 0)).toBe(1);
});

test('the grain is full in the midtones and a quarter at black and at white', () => {
  expect(grainWeight(0.5)).toBe(1);
  expect(grainWeight(0)).toBe(0.25);
  expect(grainWeight(1)).toBe(0.25);
  /* 0.25 + 3 * 0.2 * 0.8 = 0.73. */
  expect(grainWeight(0.2)).toBeCloseTo(0.73, 10);
});

test('the shader carries the same arithmetic, and off is a branch on a uniform', () => {
  expect(FILM_LOOK_GLSL).toContain('float r2 = dot(d, d) / dot(corner, corner);');
  expect(FILM_LOOK_GLSL).toContain('return c / (falloff * falloff);');
  expect(FILM_LOOK_GLSL).toContain('float weight = 0.25 + 3.0 * luma * (1.0 - luma);');
  expect(FILM_LOOK_GLSL).toContain('if (uVignette <= 0.0) return c;');
  expect(FILM_LOOK_GLSL).toContain('if (uGrain.x <= 0.0) return c;');
});

test('a seed becomes a whole number a float carries exactly, whatever the caller had', () => {
  expect(grainSeed(7)).toBe(7);
  expect(grainSeed(-7.9)).toBe(7);
  expect(grainSeed(16777216 + 3)).toBe(3);
  expect(grainSeed(Number.NaN)).toBe(0);
});
