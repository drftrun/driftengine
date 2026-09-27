import { expect, test } from 'vitest';

import { LightField } from './lightField.ts';
import { createDriftLightUniforms, resolveDriftLight } from './uniforms.ts';

const source = (x: number, y: number, z: number, radius: number) => ({
  x,
  y,
  z,
  radius,
  r: 1,
  g: 1,
  b: 1,
  flicker: 0,
  shadowNear: 0.1,
  sourceRadius: 0.02,
});

/** An eye at the choice's centre, which leaves the radius as the selection gave it. */
const EYE = [0, 0, 0];

test('NO FIELD, OR ONE NOT YET WHOLE, SUMS NOTHING: every light stays exact', () => {
  const out = createDriftLightUniforms();
  resolveDriftLight(null, false, EYE, out);
  expect(out.light[0]).toBe(0);
  const field = new LightField([source(0.5, 0.5, 0.5, 1)], { spacing: 1 / 3, falloff: 'smooth' });
  field.follow(3, 0, 0, 0, 0.1);
  resolveDriftLight(field, false, EYE, out);
  expect(out.light[0]).toBe(0);
});

test('A WHOLE FIELD HANDS THE SHADER ITS RADIUS AND WHERE ITS GRID STARTS', () => {
  const field = new LightField([source(0.5, 0.5, 0.5, 1)], { spacing: 1 / 3, falloff: 'smooth' });
  field.bake(1000);
  field.scale = 0.5;
  field.follow(3, 1, 2, 3, 0.25);
  const out = createDriftLightUniforms();
  resolveDriftLight(field, false, [1, 2, 3], out);
  /* Half faded in after a quarter second of its half-second fade; radius 3; band 2; scale 0.5. */
  expect(Array.from(out.light)).toEqual([0.5, 3, 2, 0.5]);
  /* The grid starts at -1 on each axis, and samples are a third of a metre apart. */
  expect(Array.from(out.origin)).toEqual([-1, -1, -1, Math.fround(1 / 3)]);
});

test('THE RADIUS IS MEASURED FROM THE EYE, so an eye away from the choice gets that much less', () => {
  /*
   * The choice was centred at the origin with a radius of 3; the eye stands 1.5 m off it (a 0.9,
   * 1.2 right triangle). A pixel 1.5 m from the eye on the far side is 3 m from the centre, the
   * edge of what was promised, so the shader's radius is 1.5. And an eye 4 m off gets none at all
   * rather than a negative radius, which would put every pixel past it.
   */
  const field = new LightField([source(0.5, 0.5, 0.5, 1)], { spacing: 1 / 3, falloff: 'smooth' });
  field.bake(1000);
  field.follow(3, 0, 0, 0, 1);
  const out = createDriftLightUniforms();
  resolveDriftLight(field, false, [0.9, 1.2, 0], out);
  expect(out.light[1]).toBeCloseTo(1.5, 6);
  resolveDriftLight(field, false, [0, 4, 0], out);
  expect(out.light[1]).toBe(0);
});

test('A PROBE BAKE SEES ONLY THE SUMMED LIGHT: its radius is zero, whichever camera chose', () => {
  const field = new LightField([source(0.5, 0.5, 0.5, 1)], { spacing: 1 / 3, falloff: 'smooth' });
  field.bake(1000);
  field.follow(3, 0, 0, 0, 1);
  const out = createDriftLightUniforms();
  resolveDriftLight(field, true, EYE, out);
  expect(out.light[1]).toBe(0);
  expect(out.light[0], 'and all of it').toBe(1);
});
