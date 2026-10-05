import { expect, test } from 'vitest';

import { flatFrag } from '../shaders/flat/index.ts';
import { pointLightShape } from './falloff.ts';

const collapse = (text: string): string => text.replace(/\s+/g, ' ');
const frame = collapse(
  flatFrag({
    pointShadows: true,
    directionalShadows: true,
    environmentProbe: true,
    nightEmissive: false,
  }),
);

/**
 * **A light summed into the field falls off exactly as the lit shader draws it**, or the two
 * disagree at the crossfade and a seam walks across every floor as the camera moves. The shader is
 * GLSL and this is TypeScript, so what ties them is these assertions reading the shader's text and
 * the numbers below, worked by hand from it.
 */
test("A SUMMED LIGHT FALLS OFF AS THE LIT SHADER DRAWS ONE, in both of its falloffs and a light's own", () => {
  expect(frame).toContain(
    'float window = clamp(1.0 - pow(dist / max(lightRadius, 1e-4), 4.0), 0.0, 1.0);',
  );
  expect(frame).toContain('falloff = window * window / max(dist * dist, 0.01);');
  expect(frame).toContain('falloff = clamp(1.0 - dist / lightRadius, 0.0, 1.0);');
  expect(frame).toContain('float reach = dist / max(lightRadius, 1e-4);');
  expect(frame).toContain('falloff = pow(clamp(1.0 - reach * reach, 0.0, 1.0), lightExponent);');
  expect(frame).toContain(
    'float shape = (lightExponent > 0.0 || uLightFalloff == 1 ? falloff : falloff * falloff) * coneFalloff * photometric;',
  );

  /* Smooth, the default: (1 - 0.3 / 1.2)^2 = 0.75^2. */
  expect(pointLightShape(0.3, 1.2, 'smooth')).toBeCloseTo(0.5625, 12);
  /* Inverse square: the window is 1 - 0.25^4 = 0.99609375, squared over 0.09. */
  expect(pointLightShape(0.3, 1.2, 'inverseSquare')).toBeCloseTo(
    (0.99609375 * 0.99609375) / 0.09,
    9,
  );
  /* Closer than ten centimetres the inverse square holds at its floor: 0.05 / 1.2 is 1/24, so the
     window is 1 - (1/24)^4, squared, over the 0.01 floor rather than over 0.0025. */
  expect(pointLightShape(0.05, 1.2, 'inverseSquare')).toBeCloseTo(
    (1 - (1 / 24) ** 4) ** 2 / 0.01,
    9,
  );
  /* A light's own exponent wins over either: (1 - 0.25^2)^8 = 0.9375^8, with no distance term. */
  expect(pointLightShape(0.3, 1.2, 'inverseSquare', 8)).toBeCloseTo(0.9375 ** 8, 12);
  expect(pointLightShape(0.3, 1.2, 'smooth', 8)).toBeCloseTo(0.596_719_473_833_218_2, 12);
  expect(pointLightShape(1.2, 1.2, 'smooth', 8)).toBe(0);
  /* Nothing at or past the radius in either. */
  expect(pointLightShape(1.2, 1.2, 'smooth')).toBe(0);
  expect(pointLightShape(1.5, 1.2, 'inverseSquare')).toBe(0);
});
