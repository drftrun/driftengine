import { expect, test } from 'vitest';

import { softVisibility } from './visibility.ts';

/* Distance functions made by hand, so every answer below can be read off the geometry. */
const open = (): number => 10;
/** A wall ten centimetres thick across x = 0.5. */
const wall = (x: number): number => Math.abs(x - 0.5) - 0.05;
/** The floor of a room at y = -0.45: a path along y = 0 passes 45 cm above it. */
const floor = (_x: number, y: number): number => y + 0.45;

test('A LIGHT IN OPEN AIR IS SEEN WHOLE, and one behind a wall not at all', () => {
  expect(softVisibility(open, 0, 0, 0, 1, 0, 0, 0.02)).toBe(1);
  expect(softVisibility(wall, 0, 0, 0, 1, 0, 0, 0.02)).toBe(0);
});

test('a surface beside the path does not shade a small light passing well clear of it', () => {
  /*
   * The floor is 0.45 m from every point of the path. A light 2 cm across, a metre away, fills a
   * cone 2 cm wide at the far end and less on the way, so nothing along the path comes close.
   */
  expect(softVisibility(floor, 0, 0, 0, 1, 0, 0, 0.02)).toBe(1);
});

test('A LARGER LIGHT IS PARTLY HIDDEN BY AN EDGE A SMALL ONE CLEARS: its shadow is softer', () => {
  /*
   * A wall ending 1 cm below the path at x = 0.5: a light's cone there has radius R * t / L, with t
   * and L both about 0.5 and 1, so R / 2. A 1 cm light (cone 0.5 cm) clears the edge whole; a 20 cm
   * one (cone 10 cm) sees about a tenth of itself over it.
   */
  const edge = (x: number, y: number): number => {
    const dx = Math.abs(x - 0.5) - 0.05;
    const dy = y + 0.01;
    return Math.max(dx, dy);
  };
  const small = softVisibility(edge, 0, 0, 0, 1, 0, 0, 0.01);
  const large = softVisibility(edge, 0, 0, 0, 1, 0, 0, 0.2);
  expect(small).toBe(1);
  expect(large).toBeGreaterThan(0);
  expect(large).toBeLessThan(0.3);
});
