import { expect, test } from 'vitest';

import { bakeBrick, BRICK_TEXELS } from './bake.ts';
import { layoutLightField } from './layout.ts';

/*
 * At a spacing of a third of a metre a brick spans one metre. `sampleAt` finds the brick holding a
 * world point on one of its samples, bakes that brick, and reads the point's two texels: the light
 * arriving, and the direction it mostly arrives from.
 */
const SPACING = 1 / 3;
const source = (x: number, y: number, z: number, radius: number, r = 1, g = 1, b = 1) => ({
  x,
  y,
  z,
  radius,
  r,
  g,
  b,
  sourceRadius: 0.02,
});
const open = (): number => 10;

function sampleAt(
  lights: ReturnType<typeof source>[],
  distance: ((x: number, y: number, z: number) => number) | null,
  x: number,
  y: number,
  z: number,
) {
  const layout = layoutLightField(lights, SPACING);
  const at = [x, y, z];
  const cell = [0, 0, 0];
  const local = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const from = ((at[axis] as number) - (layout.origin[axis] as number)) / layout.span;
    cell[axis] = Math.min(Math.floor(from + 1e-9), (layout.dims[axis] as number) - 1);
    local[axis] = Math.round((from - (cell[axis] as number)) * 3);
  }
  const brick =
    (layout.index[
      (cell[0] as number) +
        layout.dims[0] * ((cell[1] as number) + layout.dims[1] * (cell[2] as number))
    ] as number) - 1;
  if (brick < 0) throw new Error('no brick holds that point');
  const light = new Float32Array(BRICK_TEXELS * 4);
  const direction = new Float32Array(BRICK_TEXELS * 4);
  bakeBrick(layout, brick, lights, 'smooth', distance, light, direction);
  const texel = ((local[0] as number) + 4 * ((local[1] as number) + 4 * (local[2] as number))) * 4;
  return {
    light: Array.from(light.subarray(texel, texel + 4)),
    direction: Array.from(direction.subarray(texel, texel + 4)),
  };
}

test('A SAMPLE HOLDS THE LIGHT THE SHADER WOULD DRAW THERE, and the way it comes from', () => {
  /*
   * One light at (0.5, 0.5, 0.5) reaching a metre, coloured (1, 0.5, 0.25). The corner sample is
   * sqrt(0.75) away, so the smooth falloff is (1 - sqrt(0.75))^2, and the light comes from the
   * diagonal (1, 1, 1) / sqrt(3). The fourth channel of the first texel says the sample is valid.
   */
  const { light, direction } = sampleAt([source(0.5, 0.5, 0.5, 1, 1, 0.5, 0.25)], open, 0, 0, 0);
  const shape = (1 - Math.sqrt(0.75)) ** 2;
  expect(light[0]).toBeCloseTo(shape, 6);
  expect(light[1]).toBeCloseTo(shape * 0.5, 6);
  expect(light[2]).toBeCloseTo(shape * 0.25, 6);
  expect(light[3]).toBe(1);
  for (let axis = 0; axis < 3; axis++) expect(direction[axis]).toBeCloseTo(1 / Math.sqrt(3), 6);
});

test('two equal lights on opposite sides leave no direction, only light', () => {
  /*
   * Lights at x = 0 and x = 2/3 around the sample at x = 1/3, each a third of a metre off: the
   * directions cancel, so the sample says "from everywhere" and the shader spreads it over every
   * facing.
   */
  const { light, direction } = sampleAt(
    [source(0, 0, 0, 1), source(2 / 3, 0, 0, 1)],
    open,
    1 / 3,
    0,
    0,
  );
  expect(light[0]).toBeCloseTo(2 * (1 - 1 / 3) ** 2, 6);
  expect(Math.hypot(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0)).toBeCloseTo(0, 6);
});

test('A WALL STOPS THE LIGHT, and a sample inside the wall is not a sample', () => {
  /*
   * A wall 10 cm thick across x = 0.5 and a light at x = 0.9: the sample at the origin is behind
   * the wall and reads no light, but stays valid. A wall laid over x = 0 instead puts that sample
   * inside solid, where it is not a sample at all.
   */
  const wall = (x: number): number => Math.abs(x - 0.5) - 0.05;
  const behind = sampleAt([source(0.9, 0, 0, 1.2)], wall, 0, 0, 0);
  expect(behind.light[0]).toBe(0);
  expect(behind.light[3]).toBe(1);

  const around = (x: number): number => Math.min(Math.abs(x) - 0.05, 10);
  const inside = sampleAt([source(0.9, 0, 0, 1.2)], around, 0, 0, 0);
  expect(inside.light[3], 'a sample inside solid is invalid').toBe(0);
  expect(inside.light[0]).toBe(0);
});

test('with no field there is no occlusion: a scene without one gets the light unoccluded', () => {
  const wall = sampleAt([source(0.9, 0, 0, 1.2)], null, 0, 0, 0);
  expect(wall.light[0]).toBeCloseTo((1 - 0.9 / 1.2) ** 2, 6);
});
