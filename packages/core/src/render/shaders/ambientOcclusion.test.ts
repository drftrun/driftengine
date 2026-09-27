import { expect, test } from 'vitest';
import { AO_FRAG, AO_THIN, gtaoArc, nextHorizon } from './ambientOcclusion.ts';

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
