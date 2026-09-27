import { expect, test } from 'vitest';
import {
  EXPOSURE_LOCAL_FRAG,
  LOCAL_BINS,
  LOCAL_BLURRED_BLEND,
  LOCAL_EXPOSURE_GLSL,
  LOCAL_GRID_WIDTH,
  clampLocalExposure,
  localBin,
  localExposureGain,
  sliceLocal,
} from './localExposure.ts';
import { RUSH_FRAG } from './rush.ts';

/**
 * Local exposure's arithmetic against values worked out by hand. The functions are the shader's
 * lines written out again, so what this proves is the formula; the source assertions below hold
 * the shader to it.
 */

test('A REGION IS BROUGHT TOWARD THE FRAME BY THE STRENGTH, and no further than three stops', () => {
  /* A gallery five stops under a frame held at 2^-3, at half strength: lifted two and a half. */
  expect(localExposureGain(-8, -3, 0.5)).toBeCloseTo(2 ** 2.5, 10);
  /* Sunlit paving two stops over it: brought down one. */
  expect(localExposureGain(-1, -3, 0.5)).toBeCloseTo(0.5, 12);
  /* At the frame's own level nothing moves. */
  expect(localExposureGain(-3, -3, 0.5)).toBe(1);
  /* Five stops at full strength would be five; it is three either way. */
  expect(localExposureGain(-8, -3, 1)).toBe(8);
  expect(localExposureGain(2, -3, 1)).toBe(1 / 8);
  /* Off is exactly one, whatever the region. */
  expect(localExposureGain(-8, -3, 0)).toBe(1);
});

test('A PIXEL READS ITS OWN BRIGHTNESS BAND, so shade beside sun is lifted as shade', () => {
  /* Ten bands of two stops from 2^-12: 2^-9 is the middle of band 1 and takes it alone. */
  expect(localBin(-9)).toEqual({ lower: 1, upper: 2, weight: 0 });
  /* 2^-8 is on the edge between bands 1 and 2, half of each. */
  expect(localBin(-8)).toEqual({ lower: 1, upper: 2, weight: 0.5 });
  /* The ends hold rather than reading past the grid. */
  expect(localBin(-20)).toEqual({ lower: 0, upper: 1, weight: 0 });
  /* 2^20 holds at 2^8, half a band past the last centre, and reads the last band twice. */
  expect(localBin(20)).toEqual({ lower: LOCAL_BINS - 1, upper: LOCAL_BINS - 1, weight: 0.5 });

  /*
   * A tile half in sun at 2^1 and half in shade at 2^-9, whose mean is 2^-4. A shaded pixel takes
   * the shade's band, -9, blended 0.4 toward the tile's -4: -7. Without the bands it would take
   * -4 and be lifted three stops less than the shade beside it.
   */
  expect(LOCAL_BLURRED_BLEND).toBe(0.4);
  expect(sliceLocal(-9 * 0.5, 0.5, 0, 0, 0, -4)).toBeCloseTo(-7, 12);
  /* A band nothing in the tile fell in: the tile's own mean. */
  expect(sliceLocal(0, 0, 0, 0, 0.3, -4)).toBe(-4);
  /* Between two bands the sums and counts mix, so the mean is weighted by what each band holds. */
  expect(sliceLocal(-9 * 0.25, 0.25, -7 * 0.75, 0.75, 0.5, -8)).toBeCloseTo(
    0.6 * ((-9 * 0.125 + -7 * 0.375) / 0.5) + 0.4 * -8,
    12,
  );
});

test('a strength is 0 to 1, and anything else is off', () => {
  expect(clampLocalExposure(0.4)).toBe(0.4);
  expect(clampLocalExposure(2)).toBe(1);
  expect(clampLocalExposure(-1)).toBe(0);
  expect(clampLocalExposure(Number.NaN)).toBe(0);
});

test('the shaders carry the same arithmetic, and the composite applies it with the eye', () => {
  expect(LOCAL_GRID_WIDTH).toBe(32 * (LOCAL_BINS + 1));
  expect(LOCAL_EXPOSURE_GLSL).toContain('if (uLocalExposure <= 0.0) return 1.0;');
  expect(LOCAL_EXPOSURE_GLSL).toContain('float stops = uLocalExposure * (held - local);');
  expect(LOCAL_EXPOSURE_GLSL).toContain('return exp2(clamp(stops, -3.0, 3.0));');
  expect(EXPOSURE_LOCAL_FRAG).toContain('float band = floor(uvBlock);');
  /* The last block keeps every tap, which is what makes it the tile's mean. */
  expect(EXPOSURE_LOCAL_FRAG).toContain('float kept = band > 9.0 || tapBand == band ? 1.0 : 0.0;');
  /*
   * **Every fetch at an explicit level**: the grid pass branches on each tap's band, which is not
   * uniform, and WGSL refuses an implicit derivative there outright.
   */
  expect(EXPOSURE_LOCAL_FRAG).not.toContain('texture(uScene');
  expect(LOCAL_EXPOSURE_GLSL).not.toContain('texture(uExposureLocal');
  expect(RUSH_FRAG).toContain(LOCAL_EXPOSURE_GLSL);
  /* Read from the light before the eye scales it, since the grid measured the light before it. */
  const local = RUSH_FRAG.indexOf('float local = localExposureGain(vUv, light);');
  const gain = RUSH_FRAG.indexOf('light *= autoExposureGain() * local;');
  expect(local).toBeGreaterThan(RUSH_FRAG.indexOf('vec3 finish(vec3 light) {'));
  expect(gain).toBeGreaterThan(local);
});
