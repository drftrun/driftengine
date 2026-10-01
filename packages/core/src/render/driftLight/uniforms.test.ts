import { expect, test } from 'vitest';

import { LightField } from './lightField.ts';
import { createDriftLightUniforms, resolveDriftLight } from './uniforms.ts';
import { WorldLightField } from './worldLightField.ts';

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

test('A WORLD VOLUME TELLS THE SHADER IT IS DENSE by a negative spacing, and lays light below direction', () => {
  /* Two samples along each axis at 8 m: light 1, 2, … in the first, direction 10, 20, … in the second. */
  const light = new Float32Array(8 * 4);
  const direction = new Float32Array(8 * 4);
  for (let sample = 0; sample < 8; sample++) {
    light[sample * 4] = sample + 1;
    light[sample * 4 + 3] = 1;
    direction[sample * 4] = (sample + 1) * 10;
  }
  const field = new WorldLightField(
    { origin: [100, 0, 200], spacing: 8, dims: [2, 2, 2], light, direction },
    { fadeSec: 0 },
  );
  field.follow(40, 0, 0, 0, 0);
  const out = createDriftLightUniforms();
  resolveDriftLight(field, false, EYE, out);
  expect(Array.from(out.light)).toEqual([1, 40, 2, 1]);
  expect(Array.from(out.origin)).toEqual([100, 0, 200, -8]);

  /* Four texels up where the volume has two: rows 0–1 hold light, rows 2–3 its direction. Sample
     (1, 1, 1), the eighth, is light 8 at row 1 of slice 1 and direction 80 at row 3. */
  expect(field.atlasSize).toEqual([2, 4, 2]);
  const at = (x: number, y: number, z: number) => (x + 2 * (y + 4 * z)) * 4;
  expect(halfValue(field.atlas[at(1, 1, 1)] as number)).toBe(8);
  expect(halfValue(field.atlas[at(1, 3, 1)] as number)).toBe(80);
  expect(halfValue(field.atlas[at(0, 2, 0)] as number)).toBe(10);
});

/** A half float's bits as the number, for the few whole numbers this test writes. */
function halfValue(bits: number): number {
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  return exponent === 0 ? mantissa / 1024 / 16384 : (1 + mantissa / 1024) * 2 ** (exponent - 15);
}
