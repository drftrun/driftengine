import { expect, test } from 'vitest';

import { layoutLightField } from './layout.ts';

/** A light as the layout reads one: where it is and how far it reaches. */
const light = (x: number, y: number, z: number, radius: number) => ({ x, y, z, radius });

/*
 * Every case at a spacing of a third of a metre, so a brick's four samples a side span exactly one
 * metre and the grid's lines fall on whole metres: the arithmetic below is done on the integers.
 */
const SPACING = 1 / 3;

test('A LIGHT TAKES THE BRICKS ITS REACH TOUCHES, and not the corner its bounding box reaches', () => {
  /*
   * A light at (0.9, 0.9, 0.9) reaching 0.15 m: its box runs 0.75 to 1.05 on each axis, so eight
   * bricks are candidates, {0, 1} on each. The sphere is 0.1 m from the three faces at 1 and
   * 0.141 m from the three edges (the square root of 0.02), both inside its reach, but 0.173 m from
   * the corner (the square root of 0.03), which is outside it. Seven bricks, not eight.
   */
  const layout = layoutLightField([light(0.9, 0.9, 0.9, 0.15)], SPACING);
  expect(layout.count).toBe(7);
  expect(Array.from(layout.dims)).toEqual([2, 2, 2]);
  expect(Array.from(layout.origin)).toEqual([0, 0, 0]);
  /* The far corner, brick (1, 1, 1), is the last cell of the index and is empty. */
  expect(layout.index[7]).toBe(0);
});

test('bricks are numbered in index order, whatever order the lights came in', () => {
  /* Two lights a metre apart along x, each well inside one brick: brick (0,0,0) is numbered 1. */
  const a = layoutLightField([light(0.5, 0.5, 0.5, 0.2), light(1.5, 0.5, 0.5, 0.2)], SPACING);
  const b = layoutLightField([light(1.5, 0.5, 0.5, 0.2), light(0.5, 0.5, 0.5, 0.2)], SPACING);
  expect(Array.from(a.index)).toEqual([1, 2]);
  expect(Array.from(b.index)).toEqual([1, 2]);
  expect(Array.from(a.brickCoords)).toEqual([0, 0, 0, 1, 0, 0]);
});

test('A BRICK LISTS EVERY LIGHT THAT REACHES IT, and only those', () => {
  /*
   * Lights 0 and 1 both reach brick (0,0,0); light 2 sits in brick (2,0,0) and reaches nothing
   * else. So brick 1 lists 0 and 1, the brick at x = 1 lists light 1 (it reaches 1.35), and the
   * brick at x = 2 lists light 2.
   */
  const layout = layoutLightField(
    [light(0.5, 0.5, 0.5, 0.3), light(0.9, 0.5, 0.5, 0.45), light(2.5, 0.5, 0.5, 0.2)],
    SPACING,
  );
  expect(layout.count).toBe(3);
  const lightsOf = (brick: number): number[] =>
    Array.from(layout.lights.subarray(layout.lightStart[brick], layout.lightStart[brick + 1]));
  expect(lightsOf(0)).toEqual([0, 1]);
  expect(lightsOf(1)).toEqual([1]);
  expect(lightsOf(2)).toEqual([2]);
});

test('no lights lay out nothing, rather than a grid of one empty brick', () => {
  const layout = layoutLightField([], SPACING);
  expect(layout.count).toBe(0);
  expect(layout.index.length).toBe(0);
});

test('A GRID WIDER THAN 256 BRICKS ON ANY AXIS IS REFUSED, which is the least 3D texture WebGL2 promises', () => {
  /*
   * Two candles 300 m apart along x, at a metre a brick: 301 bricks across, one high and one deep.
   * Only 301 cells, so a limit on the cell count alone passes it, and the index is then a texture
   * 301 texels wide that a device promising 256 is free to refuse.
   */
  expect(() =>
    layoutLightField([light(0.5, 0.5, 0.5, 0.2), light(300.5, 0.5, 0.5, 0.2)], SPACING),
  ).toThrow(/301 x 1 x 1/);
  /* And 256 across is exactly what fits. */
  expect(
    layoutLightField([light(0.5, 0.5, 0.5, 0.2), light(255.5, 0.5, 0.5, 0.2)], SPACING).dims[0],
  ).toBe(256);
});
