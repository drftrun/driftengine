import { expect, test } from 'vitest';
import { uvMiss } from './collapseMeasures.ts';

/**
 * How far a texture slides, read back off the triangles a collapse leaves.
 *
 * Two unit right triangles a metre apart in z: `A` at z = 0 painted with uv equal to x and y, and `B`
 * at z = 1, moved 0.03 along x and painted half a unit further along u. Each expectation is worked
 * from that construction by hand.
 */
const positions = Float64Array.from([
  ...[0, 0, 0, 1, 0, 0, 0, 1, 0],
  ...[-0.03, 0, 1, 0.97, 0, 1, -0.03, 1, 1],
  /* The sample, set per test. */
  ...[0, 0, 0],
]);
const uvs = Float32Array.from([...[0, 0, 1, 0, 0, 1], ...[0.5, 0, 1.5, 0, 0.5, 1], ...[0, 0]]);
const A = [0, 1, 2];
const B = [3, 4, 5];
const SAMPLE = 6;

function place(x: number, y: number, u: number, v: number): void {
  positions.set([x, y, 0], SAMPLE * 3);
  uvs.set([u, v], SAMPLE * 2);
}

test('A SAMPLE OUTSIDE EVERY TRIANGLE IS MEASURED AGAINST THE NEAREST, whatever order they come in', () => {
  /*
   * At x = -0.04, y = 0.5 the sample lies 0.04 past A's edge x = 0, where A's mapping carries on to
   * exactly its uv, and 0.01 past B's edge x = -0.03, where B puts u at
   * 0.51 · 0.5 − 0.01 · 1.5 + 0.5 · 0.5 = 0.49. B is the nearer, so the miss is 0.49 + 0.04 = 0.53.
   * Taking the least miss of the two would call a texture that has slid half a unit a match.
   */
  place(-0.04, 0.5, -0.04, 0.5);
  expect(uvMiss(positions, uvs, [...A, ...B], SAMPLE)).toBeCloseTo(0.53, 5);
  expect(uvMiss(positions, uvs, [...B, ...A], SAMPLE)).toBeCloseTo(0.53, 5);
});

test('a sample well past every triangle has nothing under it, and misses without bound', () => {
  /* 0.2 past A's edge and 0.17 past B's: both beyond the band a curved border is allowed. */
  place(-0.2, 0.5, -0.2, 0.5);
  expect(uvMiss(positions, uvs, [...A, ...B], SAMPLE)).toBe(Infinity);
});
