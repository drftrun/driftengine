import { expect, test } from 'vitest';

import { RECONSTRUCTION_RANGE } from '../renderQuality.ts';
import { reconRenderSize } from './frameSizes.ts';

/**
 * How large the renderer draws when a reconstruction is going to enlarge it.
 *
 * Small on its own, and the reason it is not written inline at the one call site is that every rule
 * here is one somebody would reasonably get wrong, and getting one wrong is a frame that draws at a
 * size nobody asked for — which looks like a driver fault rather than a setting.
 */

test('reconstruction off draws at the output size, exactly', () => {
  /* This is the gate the published scenes are held to: off changes no number anywhere. */
  expect(reconRenderSize(1280, 720, 0)).toEqual({ width: 1280, height: 720 });
  expect(reconRenderSize(1, 1, 0)).toEqual({ width: 1, height: 1 });
});

test('a ratio divides each axis, and ROUNDS UP so the render is never smaller than asked', () => {
  /*
   * Rounding down would draw fewer pixels than the ratio says, which is a free frame-rate win
   * nobody asked for and a softer picture they did not agree to. 1280/1.5 is 853.33.
   */
  expect(reconRenderSize(1280, 720, 1.5)).toEqual({ width: 854, height: 480 });
  expect(reconRenderSize(1920, 1080, 2)).toEqual({ width: 960, height: 540 });
  expect(reconRenderSize(1920, 1080, 1.3)).toEqual({ width: 1477, height: 831 });
});

test('A RENDER SIZE IS NEVER ZERO, however small the output and however large the ratio', () => {
  /* A zero-width texture is a device error, and a one-pixel canvas is a real thing during layout. */
  expect(reconRenderSize(1, 1, 2)).toEqual({ width: 1, height: 1 });
  expect(reconRenderSize(0, 0, 2)).toEqual({ width: 1, height: 1 });
  /* And off, which is the path a zero-sized canvas actually takes on every frame before layout. */
  expect(reconRenderSize(0, 0, 0)).toEqual({ width: 1, height: 1 });
  expect(reconRenderSize(-4, -4, 0)).toEqual({ width: 1, height: 1 });
  expect(reconRenderSize(3, 2, RECONSTRUCTION_RANGE.most)).toEqual({ width: 2, height: 1 });
});

test('the render never has more pixels than the output, at any ratio in the range', () => {
  for (const ratio of [RECONSTRUCTION_RANGE.least, 1.5, 1.75, RECONSTRUCTION_RANGE.most]) {
    for (let width = 1; width <= 400; width += 7) {
      const height = Math.max(1, Math.round(width * 0.5625));
      const size = reconRenderSize(width, height, ratio);
      expect(size.width, `${String(width)} at ${String(ratio)}`).toBeLessThanOrEqual(width);
      expect(size.height).toBeLessThanOrEqual(height);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  }
});

test('THE RENDER’S ASPECT IS NOT THE OUTPUT’S, which is why the projection keeps the output’s', () => {
  /*
   * **The defect this pins**: rounding each axis up independently moves the aspect by up to a
   * texel's worth, so a projection built from the render size draws a picture stretched by that
   * much — a fraction of a per cent, invisible in a screenshot and visible as a slow wobble when
   * the drawing buffer resizes. The camera's aspect is the output's and this never touches it.
   */
  const size = reconRenderSize(1280, 720, 1.7);
  expect(size).toEqual({ width: 753, height: 424 });
  const outputAspect = 1280 / 720;
  const renderAspect = size.width / size.height;
  expect(renderAspect).not.toBeCloseTo(outputAspect, 4);
  expect(renderAspect).toBeCloseTo(outputAspect, 2);
});

test('a ratio of one is the resolve with no upscaling, and draws at the output size', () => {
  /* Not the same thing as off: the resolve still runs, and 0 is what turns it off. */
  expect(reconRenderSize(1280, 720, 1)).toEqual({ width: 1280, height: 720 });
});

test('A RATIO BELOW ONE DOES NOT ENLARGE THE RENDER, and neither does one that is not a number', () => {
  /*
   * `resolveRenderQuality` never hands one over — it clamps to the range or to off — but this is a
   * public function reached with whatever number a caller has, and a ratio below one divides the
   * other way: at 0.5 the renderer would draw four times the pixels it shows, which is a frame rate
   * nobody can explain. `NaN` is the same hazard through a different door, and both are off.
   */
  expect(reconRenderSize(1280, 720, 0.5)).toEqual({ width: 1280, height: 720 });
  expect(reconRenderSize(1280, 720, 0.999)).toEqual({ width: 1280, height: 720 });
  expect(reconRenderSize(1280, 720, Number.NaN)).toEqual({ width: 1280, height: 720 });
  expect(reconRenderSize(1280, 720, Number.POSITIVE_INFINITY)).toEqual({ width: 1, height: 1 });
});
