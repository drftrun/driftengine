import { describe, expect, it } from 'vitest';

import { DEFAULT_FILMIC_CURVE, FILMIC_CONSTANTS, resolveFilmicCurve } from './filmicCurve.ts';

/*
 * **The constants are where the curve's promise is kept**: the shader joins a toe, a line and a
 * shoulder at the matches solved here, and mid grey stays mid grey only if the toe's match is
 * solved for it. Every expectation below is worked by hand from the default curve — slope 0.88,
 * toe 0.55, shoulder 0.26, clips 0 and 0.04.
 */
describe('THE FILMIC CURVE’S CONSTANTS HOLD MID GREY AT MID GREY', () => {
  it('SOLVES THE DEFAULT CURVE’S MATCHES', () => {
    const out = new Float32Array(FILMIC_CONSTANTS);
    resolveFilmicCurve(DEFAULT_FILMIC_CURVE, out);
    /*
     * toe scale 1 + 0 - 0.55 = 0.45; shoulder scale 1 + 0.04 - 0.26 = 0.78. The toe holds mid
     * grey: bt = 0.18 / 0.45 - 1 = -0.6, so toeMatch = log10 0.18 - ½ ln(0.4 / 1.6) · 0.45 / 0.88
     * = -0.744727 + 0.354450 = -0.390277; straight = 0.45 / 0.88 + 0.390277 = 0.901641; shoulder
     * = 0.26 / 0.88 - 0.901641 = -0.606186.
     */
    expect(Array.from(out.slice(0, 5))).toEqual([
      Math.fround(0.88),
      0,
      Math.fround(0.04),
      Math.fround(0.45),
      Math.fround(0.78),
    ]);
    expect(out[5]).toBeCloseTo(-0.390277, 5);
    expect(out[6]).toBeCloseTo(0.901641, 5);
    expect(out[7]).toBeCloseTo(-0.606186, 5);
  });

  it('TAKES 0.18 TO 0.18 ON THE TOE IT SOLVED', () => {
    const out = new Float32Array(FILMIC_CONSTANTS);
    resolveFilmicCurve(DEFAULT_FILMIC_CURVE, out);
    const [slope = 0, black = 0, , toeScale = 0, , toeMatch = 0] = out;
    /* The toe's own expression at log10 0.18, which lies below the toe's match. */
    const log = Math.log10(0.18);
    expect(log).toBeLessThan(toeMatch);
    const toe =
      -black + (2 * toeScale) / (1 + Math.exp(((-2 * slope) / toeScale) * (log - toeMatch)));
    expect(toe).toBeCloseTo(0.18, 5);
  });

  it('PUTS MID GREY ON THE STRAIGHT LINE WHERE THE TOE IS LONGER THAN 0.8', () => {
    const out = new Float32Array(FILMIC_CONSTANTS);
    resolveFilmicCurve({ ...DEFAULT_FILMIC_CURVE, toe: 0.9 }, out);
    /* (1 - 0.9 - 0.18) / 0.88 + log10 0.18 = -0.090909 - 0.744727 = -0.835636. */
    expect(out[5]).toBeCloseTo(-0.835636, 5);
    const [slope = 0, , , , , , straightMatch = 0] = out;
    expect(slope * (Math.log10(0.18) + straightMatch)).toBeCloseTo(0.18, 5);
  });

  /*
   * On a high range display the white clip rises by the headroom, so the shoulder rolls off toward
   * the display's peak — and nothing below the shoulder moves: the toe's match and mid grey are
   * solved without the white clip, so they are the numbers worked by hand above.
   */
  it('RAISES THE SHOULDER TO THE DISPLAY’S PEAK AND LEAVES MID GREY WHERE IT WAS', () => {
    const out = new Float32Array(FILMIC_CONSTANTS);
    resolveFilmicCurve(DEFAULT_FILMIC_CURVE, out, 4);
    /* White clip 0.04 + (4 - 1) = 3.04; shoulder scale 1 + 3.04 - 0.26 = 3.78. */
    expect(out[2]).toBeCloseTo(3.04, 5);
    expect(out[4]).toBeCloseTo(3.78, 5);
    expect(out[5]).toBeCloseTo(-0.390277, 5);
    expect(out[6]).toBeCloseTo(0.901641, 5);
  });

  it('CLAMPS A CURVE THAT RUNS BACKWARDS OR DIVIDES BY ZERO, AND SAYS IT DID', () => {
    const out = new Float32Array(FILMIC_CONSTANTS);
    expect(resolveFilmicCurve(DEFAULT_FILMIC_CURVE, out), 'the defaults are in range').toBe(false);
    /* A toe of 1 with no black clip is a toe scale of zero: kept at 0.999, a scale of 0.001. */
    expect(resolveFilmicCurve({ ...DEFAULT_FILMIC_CURVE, toe: 1 }, out)).toBe(true);
    expect(out[3]).toBeCloseTo(0.001, 6);
    expect(resolveFilmicCurve({ ...DEFAULT_FILMIC_CURVE, slope: -1 }, out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.01, 6);
    /* Not a number: the default's own, 0.04. */
    expect(resolveFilmicCurve({ ...DEFAULT_FILMIC_CURVE, whiteClip: Number.NaN }, out)).toBe(true);
    expect(out[2]).toBeCloseTo(0.04, 6);
    expect(Array.from(out).every(Number.isFinite), 'and nothing it writes is NaN').toBe(true);
  });
});
