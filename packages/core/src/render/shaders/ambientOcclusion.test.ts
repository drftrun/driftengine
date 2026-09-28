import { expect, test } from 'vitest';
import {
  AO_BLUR_DEPTH_TOLERANCE,
  AO_BLUR_FRAG,
  AO_FRAG,
  AO_STORE,
  AO_THIN,
  blurWeight,
  gtaoArc,
  nextHorizon,
} from './ambientOcclusion.ts';

/**
 * The horizon estimate's arithmetic against values worked out by hand. The functions are the
 * shader's lines written out again, so what this proves is that the two agree on the formula the
 * header argues; the source assertions below hold the shader to it.
 */

test('AN OPEN PLANE FACING THE EYE SEES THE WHOLE SKY, and a trench of 45° walls half of it', () => {
  /* Horizons at the tangent, ±90°: 0.25 · (1 + 1) on each side. */
  expect(gtaoArc(-Math.PI / 2, Math.PI / 2, 0)).toBeCloseTo(1, 12);
  /* One side up to 45°: 0.5 + 0.25 · (-cos 90° + 1) = 0.75. */
  expect(gtaoArc(-Math.PI / 2, Math.PI / 4, 0)).toBeCloseTo(0.75, 12);
  /* Both sides up to 45°: 0.25 + 0.25. */
  expect(gtaoArc(-Math.PI / 4, Math.PI / 4, 0)).toBeCloseTo(0.5, 12);
  /*
   * A surface turned 30° from the eye with nothing on it, its horizons at its own tangent, -60° and
   * +90°: 0.25 · (cos 30° + cos 30° − π/3 · 1) + 0.25 · (cos 30° + cos 30° + π · 0.5)
   * = 0.25 · 0.684853 + 0.25 · 3.302847 = 0.996925.
   */
  expect(gtaoArc(-Math.PI / 3, Math.PI / 2, Math.PI / 6)).toBeCloseTo(0.996925, 5);
});

test('A HORIZON RISES WITH THE WALK AND SINKS A FIFTH OF THE WAY BACK PAST A THIN THING', () => {
  expect(nextHorizon(-1, 0.3)).toBe(0.3);
  expect(nextHorizon(0.3, 0.8)).toBe(0.8);
  /* Past the peak: 0.8 + (0.0 - 0.8) · 0.2 = 0.64, then 0.64 − 0.128 = 0.512. */
  expect(nextHorizon(0.8, 0)).toBeCloseTo(0.64, 12);
  expect(nextHorizon(nextHorizon(0.8, 0), 0)).toBeCloseTo(0.512, 12);
  expect(AO_THIN).toBe(0.2);
});

test('the shader carries the same arithmetic', () => {
  expect(AO_FRAG).toContain(`const float AO_THIN = ${AO_THIN.toFixed(1)};`);
  expect(AO_FRAG).toContain(
    'horizon0 = cosine > horizon0 ? cosine : mix(horizon0, cosine, AO_THIN);',
  );
  expect(AO_FRAG).toContain(
    'return 0.25 * (-cos(2.0 * h0 - normal) + c + h0 * s2) + 0.25 * (-cos(2.0 * h1 - normal) + c + h1 * s2);',
  );
  /* Never below the surface's own tangent, which is what makes an open plane read as open. */
  expect(AO_FRAG).toContain(
    'float h0 = max(-acos(clamp(horizon0, -1.0, 1.0)), normalAngle - 1.5707963);',
  );
  expect(AO_FRAG).toContain(
    'float h1 = min(acos(clamp(horizon1, -1.0, 1.0)), normalAngle + 1.5707963);',
  );
  /* Lines spread evenly in pixels, which is evenly in the world, rather than in UV. */
  expect(AO_FRAG).toContain('vec2 screen = vec2(cos(angle) * pixel.x / pixel.y, sin(angle));');
});

/**
 * A floor 1.6 m under the eye, seen 40 m out through a 60° lens 720 pixels tall: a pixel row is
 * 2 · tan 30° / 720 = 0.0016038 of screen slope, and a row's distance is 1.6 over its slope. The
 * inputs are generated from that; the expectations are not.
 */
function floorRow(offset: number): number {
  return -1.6 / (0.04 + offset * 0.0016038);
}

test('A FLOOR SEEN EDGE ON IS ONE SURFACE TO THE BLUR, whatever its depth does from row to row', () => {
  /*
   * Rows either side of 40 m are 38.5 m and 41.7 m away: 4% a row, twice the tolerance, so a blur
   * comparing each row with the centre's own depth keeps nothing past it and leaves the rotation
   * tile's rows on screen as stripes. On a plane 1/z is affine in the screen, so the depth its own
   * surface predicts at every offset is exact and each of the eight taps belongs.
   */
  const centre = floorRow(0);
  for (let offset = -3; offset <= 4; offset++) {
    expect(
      blurWeight(centre, floorRow(-1), floorRow(1), floorRow(offset), offset),
      `offset ${offset}`,
    ).toBeCloseTo(1, 6);
  }
});

test('A SILHOUETTE IS STILL AN EDGE, and a step on a facing surface blocks as it always did', () => {
  /* A rail 5 m out against a wall 30 m out on one side: the slope comes from the rail's side. */
  expect(blurWeight(-5, -30, -5, -30, -2)).toBe(0);
  expect(blurWeight(-5, -30, -5, -5, 3)).toBe(1);
  /* A floor row at the foot of a wall 38 m out: the wall's taps are refused, the floor's kept. */
  expect(blurWeight(floorRow(0), floorRow(-1), -38, -38, 2)).toBe(0);
  expect(blurWeight(floorRow(0), floorRow(-1), -38, floorRow(-3), -3)).toBeCloseTo(1, 6);
  /* A surface facing the eye 10 m out: 5% off is refused, 1% off is half in, as before. */
  expect(blurWeight(-10, -10, -10, -10.5, 2)).toBe(0);
  expect(blurWeight(-10, -10, -10, -10.1, 2)).toBeCloseTo(0.5, 6);
  expect(AO_BLUR_DEPTH_TOLERANCE).toBe(0.02);
});

test('AN OPEN PLANE SEEN EDGE ON AVERAGES TO OPEN ONLY IF NO ROTATION OF IT IS CLIPPED', () => {
  /*
   * A plane turned 80° from the eye, nothing on it, horizons at its own tangent. In a line at angle
   * φ its normal projects to n = atan(tan 80° · cos φ) at length √(cos² 80° + sin² 80° · cos² φ).
   * Averaged over every line that is exactly cos α + sin α · (1 − cos α) / sin α = 1, which is what
   * makes the estimate unbiased; the lines one pixel's two slices take, a quarter turn apart, are
   * not. The sixteen turns of the tile below reach 1.10, so storing each clamped to 1 averages
   * short of open, and the frame darkens every surface seen edge on.
   */
  const alpha = (80 * Math.PI) / 180;
  const slice = (phi: number): number => {
    const n = Math.atan(Math.tan(alpha) * Math.cos(phi));
    const length = Math.hypot(Math.cos(alpha), Math.sin(alpha) * Math.cos(phi));
    return length * gtaoArc(n - Math.PI / 2, n + Math.PI / 2, n);
  };
  const pixels: number[] = [];
  for (let tile = 0; tile < 16; tile++) {
    const turn = (tile * Math.PI) / 2 / 16;
    pixels.push((slice(turn) + slice(turn + Math.PI / 2)) / 2);
  }
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  expect(Math.max(...pixels)).toBeGreaterThan(1.09);
  expect(mean(pixels)).toBeCloseTo(1, 2);
  expect(mean(pixels.map((v) => Math.min(v, 1))), 'clamped before the blur').toBeLessThan(0.98);
  expect(
    mean(pixels.map((v) => Math.min(v * AO_STORE, 1) / AO_STORE)),
    'stored at scale',
  ).toBeCloseTo(1, 2);
});

test('the blur carries the same arithmetic, and the estimate is stored at scale and decoded once', () => {
  expect(AO_BLUR_FRAG).toContain(
    `const float AO_BLUR_DEPTH_TOLERANCE = ${AO_BLUR_DEPTH_TOLERANCE};`,
  );
  expect(AO_BLUR_FRAG).toContain(
    'float slope = abs(stepAfter) < abs(stepBefore) ? stepAfter : stepBefore;',
  );
  expect(AO_BLUR_FRAG).toContain(
    'float w = max(0.0, 1.0 - abs(z * (inverse + slope * float(i)) - 1.0) / AO_BLUR_DEPTH_TOLERANCE);',
  );
  expect(AO_FRAG).toContain(`const float AO_STORE = ${AO_STORE.toFixed(1)};`);
  expect(AO_FRAG).toContain('fragColor = clamp(visible / float(AO_SLICES) * AO_STORE, 0.0, 1.0);');
  expect(AO_BLUR_FRAG).toContain('fragColor = min(blurred * uAoScale, 1.0);');
});
