import { expect, test } from 'vitest';
import { pickNearest, raySphere, screenRay } from './pick.ts';
import type { PickCandidate } from './pick.ts';

/** The inverse of an identity view-projection is the identity, which makes the ray predictable. */
function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

test('a ray through the screen centre runs down the view axis', () => {
  const origin = new Float32Array(3);
  const direction = new Float32Array(3);
  screenRay(400, 300, 800, 600, identity(), origin, direction);
  expect(origin[0]).toBeCloseTo(0, 6);
  expect(origin[1]).toBeCloseTo(0, 6);
  expect(Math.abs(direction[2] as number)).toBeCloseTo(1, 6);
});

test('a ray through a corner points into that corner', () => {
  const origin = new Float32Array(3);
  const direction = new Float32Array(3);
  screenRay(0, 0, 800, 600, identity(), origin, direction);
  expect(origin[0]).toBeCloseTo(-1, 6);
  expect(origin[1]).toBeCloseTo(1, 6);
});

test('the direction is a unit vector', () => {
  const origin = new Float32Array(3);
  const direction = new Float32Array(3);
  screenRay(123, 456, 800, 600, identity(), origin, direction);
  expect(
    Math.hypot(direction[0] as number, direction[1] as number, direction[2] as number),
  ).toBeCloseTo(1, 6);
});

const forward = () => ({
  origin: Float32Array.from([0, 0, 0]),
  direction: Float32Array.from([0, 0, -1]),
});

test('a sphere in front of the ray is hit at its near side', () => {
  const { origin, direction } = forward();
  const candidate: PickCandidate = { entity: 1, cx: 0, cy: 0, cz: -10, radius: 2 };
  expect(raySphere(origin, direction, candidate)).toBeCloseTo(8, 6);
});

test('a sphere beside the ray is missed', () => {
  const { origin, direction } = forward();
  expect(raySphere(origin, direction, { entity: 1, cx: 50, cy: 0, cz: -10, radius: 2 })).toBe(-1);
});

test('a sphere behind the ray is missed', () => {
  const { origin, direction } = forward();
  expect(raySphere(origin, direction, { entity: 1, cx: 0, cy: 0, cz: 10, radius: 2 })).toBe(-1);
});

test('a ray starting inside a sphere hits it at the far side rather than missing', () => {
  const { origin, direction } = forward();
  expect(raySphere(origin, direction, { entity: 1, cx: 0, cy: 0, cz: 0, radius: 5 })).toBeCloseTo(
    5,
    6,
  );
});

test('picking returns the nearest of two overlapping candidates', () => {
  const { origin, direction } = forward();
  expect(
    pickNearest(origin, direction, [
      { entity: 7, cx: 0, cy: 0, cz: -20, radius: 3 },
      { entity: 9, cx: 0, cy: 0, cz: -5, radius: 3 },
    ]),
  ).toBe(9);
});

test('picking nothing returns -1, which entity zero would otherwise be mistaken for', () => {
  const { origin, direction } = forward();
  expect(pickNearest(origin, direction, [])).toBe(-1);
  expect(pickNearest(origin, direction, [{ entity: 0, cx: 99, cy: 0, cz: 0, radius: 1 }])).toBe(-1);
});

test('entity zero can be picked, and is distinguishable from nothing', () => {
  const { origin, direction } = forward();
  expect(pickNearest(origin, direction, [{ entity: 0, cx: 0, cy: 0, cz: -5, radius: 1 }])).toBe(0);
});
