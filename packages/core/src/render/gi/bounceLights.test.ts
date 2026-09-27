import { expect, test } from 'vitest';

import { POINT_LIGHT_COS_INNER, POINT_LIGHT_COS_OUTER } from '../clusteredLights.ts';
import {
  BOUNCE_LIGHT_FLOATS,
  MAX_BOUNCE_LIGHTS,
  createBounceLights,
  resolveBounceLights,
} from './bounceLights.ts';

/** A frame's light list of `weights.length` lights, each at x = its index, reaching two metres. */
function frame(weights: number[]) {
  const count = weights.length;
  return {
    lightCount: count,
    lightPositions: Float32Array.from({ length: count * 3 }, (_, k) => (k % 3 === 0 ? k / 3 : 0)),
    lightColors: new Float32Array(count * 3).fill(0.5),
    lightRadii: new Float32Array(count).fill(2),
    lightWeights: Float32Array.from(weights),
  };
}

test('A SUMMED LIGHT IS LEFT OUT OF THE BOUNCE, AND AN EXACT ONE IS IN IT AT ITS WEIGHT', () => {
  /*
   * Three lights: one a DriftLight field sums (its weight carries a negative sign), one fading at
   * half, one at full. The summed one already reaches the bounce through the field, so a second
   * copy here would count it twice; the other two go in with their weight folded into the colour,
   * which is how the lit shader scales a fading light.
   */
  const out = createBounceLights();
  expect(resolveBounceLights(frame([-1, 0.5, 1]), out)).toBe(2);
  /* The first packed is light 1, at x = 1, reaching 2 m, at half its colour, a point: no cone. */
  expect(Array.from(out.subarray(0, BOUNCE_LIGHT_FLOATS))).toEqual([
    1,
    0,
    0,
    2,
    0.25,
    0.25,
    0.25,
    POINT_LIGHT_COS_INNER,
    0,
    0,
    0,
    POINT_LIGHT_COS_OUTER,
  ]);
  expect(out[BOUNCE_LIGHT_FLOATS], 'then light 2, at x = 2').toBe(2);
  expect(out[BOUNCE_LIGHT_FLOATS + 4], 'at full colour').toBe(0.5);
});

test('THE BOUNCE TAKES AT MOST THIRTY-TWO LIGHTS, the first the selection chose', () => {
  const out = createBounceLights();
  expect(resolveBounceLights(frame(new Array(40).fill(1)), out)).toBe(MAX_BOUNCE_LIGHTS);
  expect(out[(MAX_BOUNCE_LIGHTS - 1) * BOUNCE_LIGHT_FLOATS], 'the last is light 31').toBe(31);
});

test('a frame that reported no lights lights nothing', () => {
  expect(resolveBounceLights(null, createBounceLights())).toBe(0);
  expect(resolveBounceLights(frame([0, 0]), createBounceLights()), 'faded to nothing').toBe(0);
});
