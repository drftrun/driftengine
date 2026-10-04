import { expect, test } from 'vitest';
import { HIGHLIGHT_SHOULDER_GLSL, OUTPUT_TRANSFORM_GLSL } from './outputTransform.ts';
import { RUSH_FRAG } from './rush.ts';
import { OUTPUT_TRANSFORM_CODE } from '../vertexDefaults.ts';

/**
 * The highlight shoulder, written out again from the shader's four lines, against values worked
 * out by hand; and the source assertions that hold both grade paths to it. What the first half
 * proves is the formula, and the second that the shader is that formula, called for mode 3 by the
 * forward passes and the resolve alike.
 */
function shoulder(r: number, g: number, b: number): [number, number, number] {
  const m = Math.max(r, g, b);
  if (m <= 0.8) return [r, g, b];
  const e = m - 0.8;
  const k = (0.8 + (0.2 * e) / (e + 0.2)) / m;
  return [r * k, g * k, b * k];
}

test('AN OVERBRIGHT COLOUR KEEPS ITS HUE: the brightest channel eases toward 1 and the others follow', () => {
  /* m 1.6, e 0.8: 0.8 + 0.16 / 1.0 = 0.96, so every channel is scaled by 0.6. */
  const [r, g, b] = shoulder(1.6, 0.4, 0.2);
  expect(r).toBeCloseTo(0.96, 12);
  expect(g).toBeCloseTo(0.24, 12);
  expect(b).toBeCloseTo(0.12, 12);
  /* m 1.0, e 0.2: 0.8 + 0.04 / 0.4 = 0.9. */
  expect(shoulder(1, 0.5, 0.25)[0]).toBeCloseTo(0.9, 12);
  /* Below the knee nothing moves, and at it the curve meets the identity. */
  expect(shoulder(0.5, 0.4, 0.3)).toEqual([0.5, 0.4, 0.3]);
  expect(shoulder(0.8, 0.2, 0.1)).toEqual([0.8, 0.2, 0.1]);
  /* However bright, never past 1. */
  expect(shoulder(1000, 0, 0)[0]).toBeLessThan(1);
});

test('the shader is that formula, and both grade paths call it for mode 3', () => {
  expect(HIGHLIGHT_SHOULDER_GLSL).toContain('float m = max(c.r, max(c.g, c.b));');
  expect(HIGHLIGHT_SHOULDER_GLSL).toContain('if (m <= 0.8) return c;');
  expect(HIGHLIGHT_SHOULDER_GLSL).toContain('return c * ((0.8 + 0.2 * e / (e + 0.2)) / m);');
  expect(OUTPUT_TRANSFORM_CODE.shoulder).toBe(3);
  const call = 'if (uOutputTransform == 3) c = highlightShoulder(c * uOutputExposure);';
  expect(OUTPUT_TRANSFORM_GLSL, 'the forward passes').toContain(call);
  expect(RUSH_FRAG, 'the resolve').toContain(call);
});
