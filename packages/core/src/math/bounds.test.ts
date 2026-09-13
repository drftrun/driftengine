import { expect, test } from 'vitest';

import { boundsOfBox, boundsOfPositions, createBounds } from './bounds.ts';

test('a unit cube is bounded by its own corners', () => {
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ]);
  const bounds = boundsOfPositions(positions, createBounds());
  expect(Array.from(bounds.min)).toEqual([-1, -1, -1]);
  expect(Array.from(bounds.max)).toEqual([1, 1, 1]);
  expect(Array.from(bounds.centre)).toEqual([0, 0, 0]);
  expect(bounds.radius).toBeCloseTo(Math.sqrt(3), 5);
});

/**
 * The radius is measured from the centre of the box and not from the origin.
 *
 * A sphere around the origin is what a naive implementation produces, and it is enormous for
 * anything modelled away from it: a building placed at the far edge of a world gets a radius the
 * size of the world and culls nothing, ever.
 */
test('an off-centre mesh gets a radius about its own centre', () => {
  const bounds = boundsOfPositions(new Float32Array([99, 0, 0, 101, 0, 0]), createBounds());
  expect(Array.from(bounds.centre)).toEqual([100, 0, 0]);
  expect(bounds.radius).toBeCloseTo(1, 5);
});

/**
 * The radius is the furthest vertex and not half the diagonal.
 *
 * Half the diagonal is the box's circumradius, which is right for a box and loose for a sphere:
 * a flat plate 100 across and 1 thick gets a sphere of 50.0 either way here, but a mesh whose
 * vertices sit well inside its own box — anything rounded — gets a sphere the corners fit in
 * rather than one the geometry fits in, and every test against it is answered too generously.
 */
test('the radius reaches the geometry, not the corners of its box', () => {
  /* An octahedron: six vertices on the axes, and its box corners are far outside it. */
  const positions = new Float32Array([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
  const bounds = boundsOfPositions(positions, createBounds());
  expect(bounds.radius, 'the vertices are all at 1; the box corners are at √3').toBeCloseTo(1, 5);
});

test('an empty mesh is empty rather than infinite', () => {
  const bounds = boundsOfPositions(new Float32Array(0), createBounds());
  expect(bounds.radius).toBe(0);
  expect(Array.from(bounds.centre)).toEqual([0, 0, 0]);
  expect(Array.from(bounds.min)).toEqual([0, 0, 0]);
  expect(Array.from(bounds.max)).toEqual([0, 0, 0]);
});

test('it fills the object it was given rather than making one', () => {
  const out = createBounds();
  expect(boundsOfPositions(new Float32Array([1, 2, 3]), out)).toBe(out);
});

/** A trailing partial vertex is ignored rather than read as zeroes. */
test('a positions array that is not a multiple of three ignores the remainder', () => {
  const bounds = boundsOfPositions(new Float32Array([5, 5, 5, 9, 9]), createBounds());
  expect(Array.from(bounds.max), 'the 9s are half a vertex and cannot be placed').toEqual([
    5, 5, 5,
  ]);
});

/**
 * A named box encloses its own corners, which is the one place half the diagonal is right.
 *
 * `boundsOfPositions` deliberately measures the furthest vertex instead, and the two answers
 * differ: a cube's vertices sit on its corners so they agree here, and for anything hollow they
 * do not. What this asserts is the *box* contract — a caller naming a region is promising the
 * whole region, not the geometry that happens to be in it.
 */
test('a named box takes the radius of its own corner', () => {
  const bounds = boundsOfBox(-1, -1, -1, 1, 1, 1, createBounds());
  expect(Array.from(bounds.min)).toEqual([-1, -1, -1]);
  expect(Array.from(bounds.max)).toEqual([1, 1, 1]);
  expect(Array.from(bounds.centre)).toEqual([0, 0, 0]);
  expect(bounds.radius).toBeCloseTo(Math.sqrt(3), 5);
});

/** Measured from the box's own centre, not from the origin — the same trap the vertex form has. */
test('a named box far from the origin keeps a radius of its own size', () => {
  const bounds = boundsOfBox(100, 100, 100, 102, 102, 102, createBounds());
  expect(Array.from(bounds.centre)).toEqual([101, 101, 101]);
  expect(bounds.radius).toBeCloseTo(Math.sqrt(3), 5);
});

/** A streamed world's squares are flat, and a flat box is a box rather than a special case. */
test('a flat square keeps its extent in the two axes it has', () => {
  const bounds = boundsOfBox(0, 0, 0, 64, 0, 64, createBounds());
  expect(Array.from(bounds.max)).toEqual([64, 0, 64]);
  expect(Array.from(bounds.centre)).toEqual([32, 0, 32]);
  expect(bounds.radius).toBeCloseTo(Math.sqrt(32 * 32 * 2), 5);
});

test('a named box fills the object it was given rather than making one', () => {
  const out = createBounds();
  expect(boundsOfBox(0, 0, 0, 1, 1, 1, out)).toBe(out);
});
