import { describe, expect, it } from 'vitest';

import {
  AMBIENT_SH_FLOATS,
  AMBIENT_SH_VALUES,
  ambientFromSH,
  packAmbientSH,
} from './ambientHarmonics.ts';

/** Nine coefficients with only `index` set, the same in all three channels. */
function only(index: number, value: number): number[] {
  const out = new Array<number>(AMBIENT_SH_VALUES).fill(0);
  out[index * 3] = value;
  out[index * 3 + 1] = value;
  out[index * 3 + 2] = value;
  return out;
}

describe('a draw’s own ambient', () => {
  /*
   * A radiance of 1 from every direction is `c00 = 1 / Y00 = 1 / 0.282095`, and a Lambertian
   * surface under it receives an irradiance of π — an ambient of 1, which is what the gradient
   * would hand the shader for a sky and ground of 1. Every normal alike.
   */
  it('A CONSTANT RADIANCE IS THE SAME AMBIENT WHICHEVER WAY THE SURFACE FACES', () => {
    const out = new Float32Array(3);
    const coefficients = only(0, 1 / 0.282095);
    for (const [x, y, z] of [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
      [0.6, -0.8, 0],
    ] as const) {
      ambientFromSH(coefficients, x, y, z, out);
      expect(out[0]).toBeCloseTo(1, 6);
      expect(out[2]).toBeCloseTo(1, 6);
    }
  });

  /*
   * The first band, scaled by 2/3 by the cosine lobe: `Y1,-1 = 0.488603 y`, so a coefficient of 1
   * gives 0.488603 × 2/3 = 0.325735 facing up, and its negative facing down, clamped to nothing.
   * `Y2,0 = 0.315392 (3z² − 1)`, scaled by 1/4: 0.157696 facing ±z and −0.078848 facing y, clamped.
   */
  it('scales the bands by the cosine lobe and clamps what rings below zero', () => {
    const out = new Float32Array(3);
    ambientFromSH(only(1, 1), 0, 1, 0, out);
    expect(out[0]).toBeCloseTo(0.325735, 5);
    ambientFromSH(only(1, 1), 0, -1, 0, out);
    expect(out[0]).toBe(0);
    ambientFromSH(only(6, 1), 0, 0, 1, out);
    expect(out[1]).toBeCloseTo(0.157696, 5);
    ambientFromSH(only(6, 1), 0, 1, 0, out);
    expect(out[1]).toBe(0);
  });

  it('packs twenty-seven numbers and a flag that says they are on, and zeros for none', () => {
    const out = new Float32Array(AMBIENT_SH_FLOATS);
    const coefficients = Array.from({ length: AMBIENT_SH_VALUES }, (_, i) => i + 1);
    packAmbientSH(coefficients, out);
    expect(Array.from(out.subarray(0, AMBIENT_SH_VALUES))).toEqual(coefficients);
    expect(out[AMBIENT_SH_VALUES]).toBe(1);
    packAmbientSH(null, out);
    expect(Array.from(out)).toEqual(new Array(AMBIENT_SH_FLOATS).fill(0));
  });

  it('refuses a list that is not nine coefficients of three channels', () => {
    const out = new Float32Array(AMBIENT_SH_FLOATS);
    expect(() => packAmbientSH(new Array(9).fill(1), out)).toThrow(/27/);
    expect(() => packAmbientSH(new Array(12).fill(1), out)).toThrow(/27/);
  });
});
