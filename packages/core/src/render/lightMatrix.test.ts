import { expect, test } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';
import { computeLightMatrix } from './lightMatrix.ts';
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
