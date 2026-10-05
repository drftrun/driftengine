import { describe, expect, it } from 'vitest';

import { SKIN_BLUR_EDGES, SKIN_BLUR_TAPS, burleyMass, skinBlurWeight } from './skinBlur.ts';

/** Every weight a channel takes across one axis: the centre, and each other tap twice. */
function total(d: number, widest: number): number {
  let sum = skinBlurWeight(0, d, widest);
  for (let tap = 1; tap < SKIN_BLUR_TAPS.length; tap++) sum += 2 * skinBlurWeight(tap, d, widest);
  return sum;
}

/** Burley's profile across a line, integrated numerically: the reference the closed form answers to. */
function integrate(from: number, to: number, d: number): number {
  const n = 20000;
  const step = (to - from) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = from + (i + 0.5) * step;
    sum += ((Math.exp(-x / d) + Math.exp(-x / (3 * d))) / (8 * d)) * step;
  }
  return sum;
}

describe('skin blur', () => {
  /*
   * **Every channel's weights sum to one**, whatever its distance against the widest: the cells
   * tile the line from the centre to infinity, and each weight is the profile's mass over its cell.
   */
  it('GIVES EACH CHANNEL WEIGHTS THAT SUM TO ONE, EXACTLY', () => {
    const widest = 0.0102;
    for (const d of [widest, 0.0042, 0.0026]) expect(total(d, widest)).toBeCloseTo(1, 12);
  });

  /*
   * **Each weight is the profile's mass over its cell**, which is the closed form the shader writes;
   * here against the profile integrated numerically, the centre cell from −0.2 to 0.2 of the widest
   * distance and a middle one from 1.6 to 2.8 of it.
   */
  it('WEIGHS EACH TAP BY THE PROFILE’S MASS OVER ITS CELL', () => {
    const widest = 0.0102;
    for (const d of [widest, 0.0026]) {
      expect(skinBlurWeight(0, d, widest)).toBeCloseTo(2 * integrate(0, 0.2 * widest, d), 9);
      expect(skinBlurWeight(3, d, widest)).toBeCloseTo(
        integrate(SKIN_BLUR_EDGES[2] * widest, SKIN_BLUR_EDGES[3] * widest, d),
        9,
      );
    }
    expect(burleyMass(1e9, 0.01)).toBe(0.5);
  });

  /*
   * **A channel that travels less stays nearer the centre**: at the default skin blue scatters a
   * quarter as far as red, and its centre cell, ±0.2 of red's distance, is ±0.78 of its own —
   * 2(½ − (e^(−0.785) + 3e^(−0.262))/8) = 0.3085 of its light, where red keeps
   * 2(½ − (e^(−0.2) + 3e^(−0.0667))/8) = 0.094: a shadow's edge blurs red furthest.
   */
  it('KEEPS A CHANNEL THAT TRAVELS LESS NEARER THE CENTRE', () => {
    const widest = 0.0102;
    expect(skinBlurWeight(0, widest, widest)).toBeCloseTo(0.0937, 4);
    expect(skinBlurWeight(0, 0.0026, widest)).toBeCloseTo(0.3085, 4);
  });
});
