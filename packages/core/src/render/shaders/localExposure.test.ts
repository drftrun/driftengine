import { describe, expect, it, test } from 'vitest';
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
  LOCAL_EXPOSURE_FLOATS,
  localExposureShapedGain,
  resolveLocalExposure,
} from './localExposure.ts';
import type { LocalExposureOptions } from './localExposure.ts';
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
  expect(LOCAL_EXPOSURE_GLSL).toContain(
    'float stops = (local - pivot) * keep + (pixel - local) * uLocalShape.z;',
  );
  expect(LOCAL_EXPOSURE_GLSL).toContain(
    'return exp2(clamp(stops, -uLocalPivot.z, uLocalPivot.z));',
  );
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

describe('local exposure as a shape', () => {
  const pack = (setting: number | LocalExposureOptions): Float32Array => {
    const out = new Float32Array(LOCAL_EXPOSURE_FLOATS);
    resolveLocalExposure(setting, out);
    return out;
  };

  /*
   * **The one number is the shape it always was, to the bit**: both shares `1 − s` about the held
   * level, no detail term, the engine's blend and three stops, so `(local − held) · (−s)` is the
   * old `s · (held − local)` exactly, a negation and a product IEEE keeps.
   */
  it('DRAWS WHAT ONE STRENGTH DREW, TO THE BIT', () => {
    for (const s of [0.25, 0.5, 1]) {
      const shape = pack(s);
      for (const [local, held] of [
        [-4, -1],
        [-1.3, -2.9],
        [2.5, -3],
      ] as const) {
        const f = Math.fround;
        expect(localExposureShapedGain(f(local + 0.7), f(local), f(local), f(held), 1, shape)).toBe(
          localExposureGain(f(local), f(held), Math.fround(s)),
        );
      }
    }
  });

  /*
   * **About middle grey at the frame's exposure**, by hand. At exposure 1 grey is log2(0.18) =
   * −2.473931. A region two stops above it keeping half of them moves −1 stop, and a pixel a stop
   * above that region keeping 1.5 of it moves +0.5: −0.5 in all, a gain of 2^−0.5 = 0.707107. A
   * region three stops below keeping 0.6 moves +1.2, 2^1.2 = 2.297397. At exposure 2 grey is a
   * stop lower, so the region that was two above is three above and moves −1.5 with the pixel's
   * +0.5: 2^−1 = 0.5. A bias of +0.5 raises grey, so it is 1.5 above: −0.75 + 0.5, 2^−0.25 =
   * 0.840896. And a range of 1 holds the shadow's 1.2 to 1: a gain of 2.
   */
  it('TURNS EACH REGION ABOUT MIDDLE GREY AT THE FRAME’S EXPOSURE, ITS DETAIL KEPT APART', () => {
    const grey = Math.log2(0.18);
    const shape = pack({
      highlightContrast: 0.5,
      shadowContrast: 0.6,
      detail: 1.5,
      blurredBlend: 0,
    });
    expect(localExposureShapedGain(grey + 3, grey + 2, grey + 2, 0, 1, shape)).toBeCloseTo(
      0.707107,
      6,
    );
    expect(localExposureShapedGain(grey - 3, grey - 3, grey - 3, 0, 1, shape)).toBeCloseTo(
      2.297397,
      6,
    );
    expect(localExposureShapedGain(grey + 3, grey + 2, grey + 2, 0, 2, shape)).toBeCloseTo(0.5, 6);
    const biased = pack({
      highlightContrast: 0.5,
      shadowContrast: 0.6,
      detail: 1.5,
      blurredBlend: 0,
      middleGreyBias: 0.5,
    });
    expect(localExposureShapedGain(grey + 3, grey + 2, grey + 2, 0, 1, biased)).toBeCloseTo(
      0.840896,
      6,
    );
    const held = pack({ highlightContrast: 0.5, shadowContrast: 0.6, blurredBlend: 0, range: 1 });
    expect(localExposureShapedGain(grey - 3, grey - 3, grey - 3, 0, 1, held)).toBeCloseTo(2, 6);
  });

  it('IS OFF WHERE NOTHING MOVES, IN EITHER FORM', () => {
    const out = new Float32Array(LOCAL_EXPOSURE_FLOATS);
    expect(resolveLocalExposure(0, out)).toBe(false);
    expect(resolveLocalExposure({ highlightContrast: 1, shadowContrast: 1 }, out)).toBe(false);
    expect(
      resolveLocalExposure({ highlightContrast: 1, shadowContrast: 1, detail: 1.2 }, out),
    ).toBe(true);
    expect(resolveLocalExposure(0.4, out)).toBe(true);
  });
});
