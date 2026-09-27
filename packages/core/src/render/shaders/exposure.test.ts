import { expect, test } from 'vitest';
import {
  AUTO_EXPOSURE_GLSL,
  EXPOSURE_ADAPT_FRAG,
  EXPOSURE_METER_FRAG,
  adaptBlend,
  autoExposureGain,
  clampAutoExposure,
} from './exposure.ts';
import { RUSH_FRAG } from './rush.ts';

/**
 * Eye adaptation's arithmetic against values worked out by hand. The functions are the shader's
 * lines written out again, so what this proves is the formula; the source assertions below hold
 * the shader to it.
 */

test('A FRAME ADAPTS TO MIDDLE GREY, as far as the strength asks and no further than six stops', () => {
  /* A shaded courtyard whose log-mean is 2^-6: full adaptation lifts it log2(0.18) + 6 stops. */
  expect(autoExposureGain(-6, 1)).toBeCloseTo(0.18 * 64, 10);
  /* Already at middle grey: nothing moves. */
  expect(autoExposureGain(Math.log2(0.18), 1)).toBeCloseTo(1, 12);
  /* Half strength moves half the stops: 2^((log2 0.18 + 6) / 2) = sqrt(11.52). */
  expect(autoExposureGain(-6, 0.5)).toBeCloseTo(Math.sqrt(11.52), 10);
  /* A black frame at 2^-12 would want 9.5 stops; it gets six. */
  expect(autoExposureGain(-12, 1)).toBe(64);
  expect(autoExposureGain(8, 1)).toBe(1 / 64);
  /* Off is exactly one. */
  expect(autoExposureGain(-6, 0)).toBe(1);
});

test('THE HELD BRIGHTNESS FOLLOWS OVER TIME, AND A CUT SNAPS IT', () => {
  /* 1.5 a second: after one second, 1 - e^-1.5 = 0.77687 of the way. */
  expect(adaptBlend(1, false)).toBeCloseTo(0.77687, 5);
  /* A 60 Hz frame: 1 - e^-0.025 = 0.024690. */
  expect(adaptBlend(1 / 60, false)).toBeCloseTo(0.02469, 5);
  expect(adaptBlend(1 / 60, true)).toBe(1);
  expect(adaptBlend(0, false)).toBe(0);
  expect(adaptBlend(Number.NaN, false)).toBe(0);
});

test('a strength is 0 to 1, and anything else is off', () => {
  expect(clampAutoExposure(0.7)).toBe(0.7);
  expect(clampAutoExposure(3)).toBe(1);
  expect(clampAutoExposure(-1)).toBe(0);
  expect(clampAutoExposure(Number.NaN)).toBe(0);
});

test('the shaders carry the same arithmetic, and the composite reads it before the curve', () => {
  expect(AUTO_EXPOSURE_GLSL).toContain('float stops = uAutoExposure * (-2.473931 - held);');
  expect(AUTO_EXPOSURE_GLSL).toContain('return exp2(clamp(stops, -6.0, 6.0));');
  expect(AUTO_EXPOSURE_GLSL).toContain('if (uAutoExposure <= 0.0) return 1.0;');
  expect(EXPOSURE_ADAPT_FRAG).toContain('fragColor = mix(held, measured, uBlend);');
  expect(EXPOSURE_METER_FRAG).toContain('sum += clamp(log2(max(luma, 1e-8)), -12.0, 8.0);');
  expect(RUSH_FRAG).toContain(AUTO_EXPOSURE_GLSL);
  /* In scene light, before the lens and the curve, on every path the composite ends by. */
  const gain = RUSH_FRAG.indexOf('light *= autoExposureGain() * local;');
  expect(gain).toBeGreaterThan(RUSH_FRAG.indexOf('vec3 finish(vec3 light) {'));
  expect(gain).toBeLessThan(RUSH_FRAG.indexOf('vec3 lensed = withVignette(light'));
});
