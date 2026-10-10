import { expect, test } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';
import {
  computeLightMatrix,
  computeLightMatrixForBounds,
  orthographicDepthSpan,
} from './lightMatrix.ts';
import type { Vec3 } from '../math/color.ts';

const RADIUS = 45;
const MAP_SIZE = 2048;

const SUN_DIRECTIONS: Vec3[] = [
  [0, 1, 0], // straight overhead — the degenerate `up` case
  [0, -1, 0],
  [1, 0, 0],
  [0.6, 0.5, -0.62],
  [-0.3, 0.9, 0.31],
  [0.7071, 0.02, 0.7071], // grazing the horizon
];

/** Points on the covered sphere, which the frustum must contain. */
function spherePoints(cx: number, cy: number, cz: number, r: number): number[][] {
  const out: number[][] = [];
  for (const [dx, dy, dz] of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0.577, 0.577, 0.577],
    [-0.577, -0.577, 0.577],
  ]) {
    out.push([cx + (dx ?? 0) * r, cy + (dy ?? 0) * r, cz + (dz ?? 0) * r]);
  }
  return out;
}

test('the frustum contains the focus sphere from any sun direction', () => {
  const m = mat4.create();
  const p = vec4.create();

  for (const dir of SUN_DIRECTIONS) {
    computeLightMatrix(dir, 12, 3, -7, RADIUS, MAP_SIZE, m);

    for (const [x, y, z] of spherePoints(12, 3, -7, RADIUS)) {
      vec4.set(p, x ?? 0, y ?? 0, z ?? 0, 1);
      vec4.transformMat4(p, p, m);
      const label = `dir ${dir.join(',')} point ${x},${y},${z}`;
      // One texel of slack: the projection is snapped to the texel grid.
      expect(p[0], `${label} x`).toBeGreaterThanOrEqual(-1.01);
      expect(p[0], `${label} x`).toBeLessThanOrEqual(1.01);
      expect(p[1], `${label} y`).toBeGreaterThanOrEqual(-1.01);
      expect(p[1], `${label} y`).toBeLessThanOrEqual(1.01);
      expect(p[2], `${label} z`).toBeGreaterThanOrEqual(-1.01);
      expect(p[2], `${label} z`).toBeLessThanOrEqual(1.01);
    }
  }
});

test('sub-texel focus movement leaves the matrix identical, so shadows do not swim', () => {
  const a = mat4.create();
  const b = mat4.create();
  const dir: Vec3 = [0.4, 0.8, 0.45];

  // A texel is 2*radius/mapSize across; move a small fraction of one.
  const texel = (RADIUS * 2) / MAP_SIZE;
  computeLightMatrix(dir, 0, 0, 0, RADIUS, MAP_SIZE, a);
  computeLightMatrix(dir, texel * 0.01, 0, 0, RADIUS, MAP_SIZE, b);

  // This is the whole point of texel snapping: without it these differ
  // slightly every frame and shadow edges crawl.
  expect(Array.from(b)).toEqual(Array.from(a));
});

test('moving a long way does move the frustum', () => {
  const a = mat4.create();
  const b = mat4.create();
  const dir: Vec3 = [0.4, 0.8, 0.45];

  computeLightMatrix(dir, 0, 0, 0, RADIUS, MAP_SIZE, a);
  computeLightMatrix(dir, 60, 0, 0, RADIUS, MAP_SIZE, b);

  expect(Array.from(b)).not.toEqual(Array.from(a));
});

test('the matrix is stable — same inputs, same matrix', () => {
  const a = mat4.create();
  const b = mat4.create();
  computeLightMatrix([0.4, 0.8, 0.45], 5, 2, 9, RADIUS, MAP_SIZE, a);
  computeLightMatrix([0.4, 0.8, 0.45], 5, 2, 9, RADIUS, MAP_SIZE, b);
  expect(Array.from(b)).toEqual(Array.from(a));
});

/*
 * **The span read off a matrix is the one it was built with**, whatever its bearing, focus and size:
 * six radii, the depth range computeLightMatrix gives every square. A tight square of 6 m and the
 * wide one of 45 m, under a high sun and a low one.
 */
test('READS THE DEPTH SPAN A LIGHT MATRIX WAS BUILT WITH OFF THE MATRIX ITSELF', () => {
  const m = mat4.create();
  for (const [dir, radius] of [
    [[0.4, 0.8, 0.45], 6],
    [[0.4, 0.8, 0.45], 45],
    [[0.9, 0.2, -0.3], 6],
  ] as const) {
    const built = computeLightMatrix(dir as unknown as Vec3, 5, 2, 9, radius, MAP_SIZE, m);
    expect(built, 'six radii').toBeCloseTo(radius * 6, 9);
    expect(orthographicDepthSpan(m), `radius ${radius}`).toBeCloseTo(radius * 6, 4);
  }
});

/*
 * **A box of known size is covered whole, from any sun.** A model, a level or a room is not a
 * sphere around a viewer, and a radius chosen by eye left part of one outside the map: so every
 * corner of a box well off the origin, long in one axis and tall in another, lands inside the
 * map's square and its depth range under five suns, and the span returned is the matrix's own.
 */
test('A BOX FITTED BY ITS BOUNDS LIES WHOLE INSIDE THE MAP, FROM ANY SUN', () => {
  const min: Vec3 = [-14, 0, -6];
  const max: Vec3 = [30, 19, 8];
  const suns: Vec3[] = [
    [0.2, 0.94, 0.27],
    [0.7, 0.3, -0.65],
    [-0.5, 0.8, 0.33],
    [0, 1, 0],
    [0.98, 0.17, 0.1],
  ];
  const out = mat4.create();
  const corner = vec4.create();
  for (const raw of suns) {
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    const sun: Vec3 = [raw[0] / len, raw[1] / len, raw[2] / len];
    const span = computeLightMatrixForBounds(sun, min, max, 2048, out);
    expect(span).toBeCloseTo(orthographicDepthSpan(out), 3);
    for (let i = 0; i < 8; i++) {
      vec4.set(
        corner,
        i & 1 ? max[0] : min[0],
        i & 2 ? max[1] : min[1],
        i & 4 ? max[2] : min[2],
        1,
      );
      vec4.transformMat4(corner, corner, out);
      expect(Math.abs(corner[0]), `corner ${i} across, sun ${raw}`).toBeLessThanOrEqual(1);
      expect(Math.abs(corner[1]), `corner ${i} up, sun ${raw}`).toBeLessThanOrEqual(1);
      expect(Math.abs(corner[2]), `corner ${i} in depth, sun ${raw}`).toBeLessThanOrEqual(1);
    }
  }
  /*
   * And the case with no slack: a rod lying flat under an overhead sun, whose ends are the sphere's
   * own diameter across the map, so a radius any smaller than the half-diagonal, or a snap not
   * allowed for, puts an end outside.
   */
  computeLightMatrixForBounds([0, 1, 0], [-10.37, 2, 0], [10.41, 2.001, 0.001], 2048, out);
  for (const x of [-10.37, 10.41]) {
    vec4.set(corner, x, 2, 0, 1);
    vec4.transformMat4(corner, corner, out);
    expect(Math.abs(corner[0]), `the rod's end at ${x}`).toBeLessThanOrEqual(1);
    expect(Math.abs(corner[0]), `and near the edge, or the check is slack`).toBeGreaterThan(0.99);
  }
});
