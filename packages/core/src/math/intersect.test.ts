import { expect, test } from 'vitest';
import { rayAabb, rayClosestOnLine, rayPlane, raySphere } from './intersect.ts';

const MIN = [-1, -1, -1];
const MAX = [1, 1, 1];

test('a ray down -z hits a unit box in front of it', () => {
  expect(rayAabb([0, 0, 5], [0, 0, -1], MIN, MAX)).toBeCloseTo(4, 6);
});

test('a ray pointing away from the box misses', () => {
  expect(rayAabb([0, 0, 5], [0, 0, 1], MIN, MAX)).toBe(-1);
});

test('a ray beside the box misses', () => {
  expect(rayAabb([5, 0, 5], [0, 0, -1], MIN, MAX)).toBe(-1);
});

/* Inside is a hit at zero, not a miss: a camera within a pickable is looking at it. */
test('an origin inside the box hits at zero', () => {
  expect(rayAabb([0, 0, 0], [0, 0, -1], MIN, MAX)).toBe(0);
});

/*
 * An axis-parallel ray divides by a zero component. IEEE gives infinities that the
 * min/max comparisons handle correctly, and this is the case that breaks when somebody
 * "fixes" that by special-casing zero.
 */
test('a ray parallel to an axis and outside the slab misses rather than dividing wrongly', () => {
  expect(rayAabb([5, 0, 0], [0, 1, 0], MIN, MAX)).toBe(-1);
});

test('a ray parallel to an axis and inside the slab still hits', () => {
  expect(rayAabb([0, -5, 0], [0, 1, 0], MIN, MAX)).toBeCloseTo(4, 6);
});

import { rayTriangle } from './intersect.ts';

/* One triangle in the z = 0 plane: (0,0) (2,0) (0,2). */
const POSITIONS = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);

test('a ray through the middle of a triangle reports its distance', () => {
  expect(rayTriangle([0.4, 0.4, 3], [0, 0, -1], POSITIONS, 0, 1, 2)).toBeCloseTo(3, 6);
});

test('a ray outside the triangle misses', () => {
  expect(rayTriangle([1.8, 1.8, 3], [0, 0, -1], POSITIONS, 0, 1, 2)).toBe(-1);
});

test('a ray pointing away misses rather than reporting a negative distance', () => {
  expect(rayTriangle([0.4, 0.4, 3], [0, 0, 1], POSITIONS, 0, 1, 2)).toBe(-1);
});

/*
 * Back faces count. A card the camera has orbited behind is still the card, and a pick
 * that culled it would report the thing behind it instead — which reads as the click
 * going through the object rather than as a winding rule.
 */
test('a triangle hit from behind still counts', () => {
  expect(rayTriangle([0.4, 0.4, -3], [0, 0, 1], POSITIONS, 0, 1, 2)).toBeCloseTo(3, 6);
});

test('a ray parallel to the triangle plane misses', () => {
  expect(rayTriangle([0.4, 0.4, 3], [1, 0, 0], POSITIONS, 0, 1, 2)).toBe(-1);
});

test('a ray meets the plane it points at', () => {
  expect(rayPlane([0, 5, 0], [0, -1, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(5, 6);
});

test('a plane behind the ray is a miss', () => {
  expect(rayPlane([0, 5, 0], [0, 1, 0], [0, 0, 0], [0, 1, 0])).toBe(-1);
});

/*
 * The case a gizmo depends on. A grazing ray's intersection is finite, enormous and
 * wrong; a caller that took it would move the thing it was dragging to somewhere off the
 * far side of the world.
 */
test('a ray parallel to the plane is a miss rather than a distant hit', () => {
  expect(rayPlane([0, 5, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0])).toBe(-1);
});

test('a normal pointing the other way finds the same intersection', () => {
  expect(rayPlane([0, 5, 0], [0, -1, 0], [0, 0, 0], [0, -1, 0])).toBeCloseTo(5, 6);
});

const closest = new Float32Array(3);

test('two perpendicular skew lines report both parameters and the gap between them', () => {
  /* The ray runs along +x at y=0,z=2; the line runs along +y through the origin. */
  expect(rayClosestOnLine([-3, 0, 2], [1, 0, 0], [0, 0, 0], [0, 1, 0], closest)).toBe(true);
  expect(closest[0]).toBeCloseTo(3, 6);
  expect(closest[1]).toBeCloseTo(0, 6);
  expect(closest[2]).toBeCloseTo(2, 6);
});

test('an intersecting pair reports a distance of zero', () => {
  expect(rayClosestOnLine([-3, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], closest)).toBe(true);
  expect(closest[2]).toBeCloseTo(0, 6);
});

test('the line parameter is where along the axis the closest point sits', () => {
  expect(rayClosestOnLine([-3, 4, 2], [1, 0, 0], [0, 0, 0], [0, 1, 0], closest)).toBe(true);
  expect(closest[1]).toBeCloseTo(4, 6);
});

/*
 * Parallel has no closest pair — every point on one line is the same distance from the
 * other — so this refuses rather than picking one. A gizmo dragging along an axis keeps
 * its previous answer on a `false`, which is the only thing that does not teleport.
 */
test('parallel lines are refused and nothing is written', () => {
  closest.fill(-999);
  expect(rayClosestOnLine([0, 1, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0], closest)).toBe(false);
  expect(closest[0]).toBe(-999);
  expect(closest[1]).toBe(-999);
  expect(closest[2]).toBe(-999);
});

test('antiparallel lines are refused too', () => {
  expect(rayClosestOnLine([0, 1, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0], closest)).toBe(false);
});

test('a ray down -z hits the near side of a unit sphere', () => {
  expect(raySphere([0, 0, 5], [0, 0, -1], [0, 0, 0], 1)).toBeCloseTo(4, 6);
});

test('a ray beside the sphere misses', () => {
  expect(raySphere([2, 0, 5], [0, 0, -1], [0, 0, 0], 1)).toBe(-1);
});

test('a ray pointing away from the sphere misses', () => {
  expect(raySphere([0, 0, 5], [0, 0, 1], [0, 0, 0], 1)).toBe(-1);
});

/* Inside is the far root, not a miss: a pointer already within a handle is over it. */
test('an origin inside the sphere reports the far side', () => {
  expect(raySphere([0, 0, 0], [0, 0, -1], [0, 0, 0], 1)).toBeCloseTo(1, 6);
});

test('a tangent ray grazes at one root', () => {
  expect(raySphere([1, 0, 5], [0, 0, -1], [0, 0, 0], 1)).toBeCloseTo(5, 6);
});
