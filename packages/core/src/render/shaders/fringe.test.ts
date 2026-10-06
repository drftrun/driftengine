import { describe, expect, it } from 'vitest';

import { FRINGE_FLOATS, resolveFringe } from './fringe.ts';

/*
 * **The pull is the wavelength's distance from blue, and it reaches its whole at the edge.**
 * Worked by hand: intensity 3 is 0.03; a start of 0.5 leaves half the half-frame, so twice that
 * reaches the edge; red is 0.007 · (611.3 − 464.3) = 1.029 of it and green 0.007 · (549.1 − 464.3)
 * = 0.5936. So red 0.03 · 2 · 1.029 = 0.06174 and green 0.03 · 2 · 0.5936 = 0.035616.
 */
describe('A LENS’S FRINGE PULLS RED FURTHEST AND BLUE NOT AT ALL', () => {
  it('SCALES EACH COLOUR BY ITS WAVELENGTH, PAST THE START', () => {
    const out = new Float32Array(FRINGE_FLOATS);
    resolveFringe(3, 0.5, out);
    expect(out[0]).toBeCloseTo(0.06174, 6);
    expect(out[1]).toBeCloseTo(0.035616, 6);
    expect(out[2]).toBeCloseTo(0.5, 6);
  });

  it('IS NONE AT NO INTENSITY, AT A START PAST THE EDGE, AND AT A NUMBER THAT IS NOT ONE', () => {
    const out = new Float32Array(FRINGE_FLOATS);
    for (const [intensity, start] of [
      [0, 0],
      [-2, 0],
      [3, 1],
      [Number.NaN, 0],
    ] as const) {
      resolveFringe(intensity, start, out);
      expect([out[0], out[1]], `${intensity} from ${start}`).toEqual([0, 0]);
    }
  });
});
