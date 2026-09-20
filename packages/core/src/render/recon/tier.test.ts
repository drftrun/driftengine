import { expect, test } from 'vitest';

import { probeCapabilities } from '../deviceFeatures.ts';
import { reconstructionSupported, selectTier } from './tier.ts';

/**
 * A request that cannot be served gets the tier below, and a test says so rather than a document.
 *
 * Pure, so every branch is asserted without a device: the capabilities are `probeCapabilities`'s,
 * over a device shape with the features named.
 */

const HALF = probeCapabilities({ features: new Set(['shader-f16']), limits: {} }, 'webgpu');

test('tier 0 is tier 0', () => {
  expect(selectTier(0)).toBe(0);
});

test('TIER 1 IS TIER 0 ON EVERY DEVICE: it was withdrawn by the spec’s stop condition', () => {
  /*
   * Measured before 4.0.0: a network on the finished frame averaged +0.01 dB on scenes it had not
   * seen and lost the one clear difference in a blind comparison, so the spec's fallback was taken
   * and no weights ship. A consumer asking for the learned tier gets the analytic one, which is the
   * degradation the design was built around rather than a gap.
   */
  expect(selectTier(1)).toBe(0);
});

test('TIER 2 IS FRAME GENERATION OVER THE ANALYTIC TIER', () => {
  /*
   * It used to fall to tier 0 wherever tier 1 could not run, so that a device lacking half
   * precision could not choose frame generation over the analytic tier for a consumer who had
   * asked for the learned base. With no learned base there is nothing to choose between, and a
   * request for tier 2 is a request for exactly that.
   */
  expect(selectTier(2)).toBe(2);
});

test('no request comes back above itself', () => {
  for (const requested of [0, 1, 2] as const) {
    expect(selectTier(requested)).toBeLessThanOrEqual(requested);
  }
});

test('reconstruction runs where compute does, and WebGL2 is refused in writing', () => {
  expect(reconstructionSupported(HALF)).toBe(true);
  expect(
    reconstructionSupported(probeCapabilities({ features: new Set(), limits: {} }, 'webgl2')),
  ).toBe(false);
});
