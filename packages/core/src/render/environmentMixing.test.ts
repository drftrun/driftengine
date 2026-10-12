import { expect, it } from 'vitest';

import {
  environmentMixingFactor,
  noEnvironmentMixing,
  resolveEnvironmentMixing,
} from './environmentMixing.ts';

/*
 * **A mirror keeps the capture, a rough surface takes its place's light, and between them a
 * smoothstep.** A weight of 2.06 between roughness 0.1 and 0.3: at 0.05 the surface reflects the
 * probe as it is, 1; halfway, at 0.2, the smoothstep is 0.5 and the factor 1 + 1.06 · 0.5 = 1.53;
 * at 0.15 it is 3 · 0.25² − 2 · 0.25³ = 0.15625, so 1.165625; and from 0.3 up the whole 2.06. A
 * weight below one dims the same way, 0.44 to 0.44.
 */
it('MIXES THE PLACE’S WEIGHT IN BY ROUGHNESS, A MIRROR KEEPING THE CAPTURE', () => {
  const mixing = resolveEnvironmentMixing(2.06, 0.1, 0.3, new Float32Array(4));
  expect(environmentMixingFactor(mixing, 0.05)).toBe(1);
  expect(environmentMixingFactor(mixing, 0.2)).toBeCloseTo(1.53, 6);
  expect(environmentMixingFactor(mixing, 0.15)).toBeCloseTo(1.165625, 6);
  expect(environmentMixingFactor(mixing, 0.3)).toBeCloseTo(2.06, 6);
  expect(environmentMixingFactor(mixing, 0.9)).toBeCloseTo(2.06, 6);
  const dim = resolveEnvironmentMixing(0.44, 0.1, 0.3, new Float32Array(4));
  expect(environmentMixingFactor(dim, 0.8)).toBeCloseTo(0.44, 6);
});

/*
 * **None is all zeros but the roughnesses, the weight stored less one**, so a program a binder never
 * wrote reflects exactly as it did; and a weight that is not a number at or above zero is none.
 * The roughnesses are held to the unit range, the upper never below the lower.
 */
it('IS NONE AT A WEIGHT OF ONE, AND AT ANY WEIGHT IT CANNOT READ', () => {
  const none = noEnvironmentMixing(new Float32Array(4));
  expect(Array.from(none)).toEqual([0, Math.fround(0.1), Math.fround(0.3), 0]);
  expect(environmentMixingFactor(new Float32Array(4), 0.5)).toBe(1);
  for (const weight of [1, Number.NaN, -2]) {
    expect(resolveEnvironmentMixing(weight, 0.1, 0.3, new Float32Array(4))[0]).toBe(0);
  }
  const held = resolveEnvironmentMixing(2, 0.6, 0.2, new Float32Array(4));
  expect([held[1], held[2]].map((v) => Math.round((v as number) * 10) / 10)).toEqual([0.6, 0.6]);
});
