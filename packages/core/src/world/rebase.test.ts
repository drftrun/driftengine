import { expect, test } from 'vitest';
import { renderOrigin, toRenderSpace, toWorldSpace } from './rebase.ts';

test('the origin is the camera cell s minimum corner', () => {
  const origin = new Float64Array(3);
  renderOrigin(700, -10, 1000, 256, origin);
  expect(Array.from(origin)).toEqual([512, -256, 768]);
});

test('the origin moves in whole cells and never continuously', () => {
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  renderOrigin(600, 0, 0, 256, a);
  renderOrigin(700, 0, 0, 256, b);
  expect(Array.from(a)).toEqual(Array.from(b));
});

test('a position far from the origin converts with single-precision error under a bound', () => {
  const origin = new Float64Array(3);
  const world = 100_000_000.5;
  renderOrigin(world, 0, 0, 256, origin);
  const render = new Float32Array(3);
  toRenderSpace(world, 0, 0, origin, render);
  const back = new Float64Array(3);
  toWorldSpace(render, origin, back);
  expect(Math.abs((back[0] as number) - world)).toBeLessThan(1e-3);
});

test('narrowing the whole coordinate instead would lose far more, which is why this exists', () => {
  /*
   * Single precision has 24 bits of mantissa, so its spacing past 2^24 is more than one unit and
   * a world coordinate loses its fraction outright. Below that it is exact, which is why a value
   * like eight million shows no error at all and is the wrong number to make this point with.
   */
  const world = 100_000_000.5;
  expect(Math.abs(Math.fround(world) - world)).toBeGreaterThan(0.4);
});

test('converting and converting back is exact in double precision near the origin', () => {
  const origin = new Float64Array([1024, 0, -2048]);
  const render = new Float32Array(3);
  toRenderSpace(1024.5, 3.25, -2047.75, origin, render);
  const back = new Float64Array(3);
  toWorldSpace(render, origin, back);
  expect(Array.from(back)).toEqual([1024.5, 3.25, -2047.75]);
});

test('crossing an origin boundary changes the origin by exactly one cell', () => {
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  renderOrigin(255.9, 0, 0, 256, a);
  renderOrigin(256.1, 0, 0, 256, b);
  expect((b[0] as number) - (a[0] as number)).toBe(256);
});
