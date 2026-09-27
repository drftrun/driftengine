import { expect, test } from 'vitest';

import { halfBits } from '../halfFloat.ts';
import { pointLightShape } from './falloff.ts';
import { LightField, FIELD_FADE_SEC } from './lightField.ts';

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

test('A FIELD BAKES THE BRICKS IT IS ASKED FOR, AND IS READY WHEN THE LAST LANDS', () => {
  /* Two lights a few metres apart, a metre of reach each, at a spacing of a third of a metre. */
  const field = new LightField([source(0.5, 0.5, 0.5, 1), source(5.5, 0.5, 0.5, 1)], {
    spacing: 1 / 3,
    falloff: 'smooth',
  });
  const total = field.layout.count;
  expect(total).toBeGreaterThan(2);
  expect(field.bake(2)).toBe(2);
  expect(field.ready).toBe(false);
  expect(field.progress).toBe(2 / total);
  expect(field.takeBaked()).toEqual({ from: 0, to: 2 });
  expect(field.takeBaked(), 'taken once').toEqual({ from: 2, to: 2 });
  expect(field.bake(1000)).toBe(total - 2);
  expect(field.ready).toBe(true);
  expect(field.bake(5), 'nothing left').toBe(0);
});

test('EACH BRICK LANDS IN ITS PLACE IN THE ATLAS, its light first and its direction beside it', () => {
  /*
   * One light at (0.5, 0.5, 0.5) reaching a metre: the grid starts at -1, so brick (1, 1, 1) has
   * its first sample at the origin, sqrt(0.75) from the light. Where that brick sits in the atlas
   * is read off the field, and its two blocks are four texels apart along x.
   */
  const field = new LightField([source(0.5, 0.5, 0.5, 1)], { spacing: 1 / 3, falloff: 'smooth' });
  field.bake(1000);
  const { layout } = field;
  const cell = 1 + layout.dims[0] * (1 + layout.dims[1] * 1);
  const brick = (layout.index[cell] as number) - 1;
  const [ax, ay, az] = field.atlasCorner(brick);
  const [w, h] = field.atlasSize;
  const texel = (x: number, y: number, z: number) => ((z * h + y) * w + x) * 4;
  const shape = pointLightShape(Math.sqrt(0.75), 1, 'smooth');
  expect(field.atlas[texel(ax, ay, az)]).toBe(halfBits(shape));
  expect(field.atlas[texel(ax, ay, az) + 3], 'valid').toBe(halfBits(1));
  expect(field.atlas[texel(ax + 4, ay, az)]).toBe(halfBits(1 / Math.sqrt(3)));
});

test('THE RADIUS SHRINKS AT ONCE AND GROWS SLOWLY, and nothing is summed until the field is whole', () => {
  const field = new LightField([source(0.5, 0.5, 0.5, 1)], { spacing: 1 / 3, falloff: 'smooth' });
  field.follow(10, 0, 0, 0, 0.1);
  expect(field.presence, 'not baked: nothing summed, every light exact').toBe(0);

  field.bake(1000);
  field.follow(10, 0, 0, 0, 0.1);
  expect(field.radius).toBe(10);
  field.follow(4, 0, 0, 0, 0.1);
  expect(field.radius, 'shrinks at once').toBe(4);
  field.follow(10, 0, 0, 0, 0.1);
  /* Eased at two per second: 4 + 6 * (1 - e^-0.2). */
  expect(field.radius).toBeCloseTo(4 + 6 * (1 - Math.exp(-0.2)), 9);
  /* And the summed light has faded in by three tenths of a second of its FIELD_FADE_SEC. */
  expect(field.presence).toBeCloseTo(0.3 / FIELD_FADE_SEC, 9);
});

test('a field marks the lights it sums, so the selection hands them over', () => {
  const lights = [source(0.5, 0.5, 0.5, 1)];
  new LightField(lights, { spacing: 1 / 3, falloff: 'smooth' });
  expect((lights[0] as { inLightField?: boolean }).inLightField).toBe(true);
});

test('A FIELD SUMS ITS LIGHTS AS THEY STOOD WHEN IT WAS MADE, and dimming one later bakes nothing new', () => {
  /*
   * A scene dims its candles at dawn by rewriting their colour and reach, and those are the same
   * objects the field was made from, because the field marks them for the selection. A bake paced
   * over a loading screen would read whatever they had become by the time it reached them: a
   * field made at night and baked into the morning would sum candles already out. So it keeps its
   * own copy, and `scale` is how a scene dims what was summed.
   */
  const light: ReturnType<typeof source> & { inLightField?: boolean } = source(0.5, 0.5, 0.5, 1);
  const field = new LightField([light], { spacing: 1 / 3, falloff: 'smooth' });
  light.r = 0;
  light.radius = 0;
  field.bake(1000);
  const { layout } = field;
  const cell = 1 + layout.dims[0] * (1 + layout.dims[1] * 1);
  const [ax, ay, az] = field.atlasCorner((layout.index[cell] as number) - 1);
  const [w, h] = field.atlasSize;
  const at = ((az * h + ay) * w + ax) * 4;
  expect(field.atlas[at]).toBe(halfBits(pointLightShape(Math.sqrt(0.75), 1, 'smooth')));
  expect(light.inLightField, 'and the scene still sees the mark').toBe(true);
});

test('A FIELD BAKED BEHIND A LOADING SCREEN IS IN AT ONCE, with no fade asked for, whatever the step', () => {
  /*
   * The fade exists so a field that completes in view does not pop. One baked behind a veil has
   * nothing on screen to pop, and a held capture steps its clock by zero once the hold is reached:
   * a fade counted in seconds never finished there, and the veil waiting on it never lifted.
   */
  const field = new LightField([source(0.5, 0.5, 0.5, 1)], {
    spacing: 1 / 3,
    falloff: 'smooth',
    fadeSec: 0,
  });
  field.bake(1000);
  field.follow(3, 0, 0, 0, 0);
  expect(field.presence).toBe(1);
});
