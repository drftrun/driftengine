import { expect, it } from 'vitest';

import { clothPlace } from './clothPlacement.ts';

const near = (actual: ArrayLike<number>, expected: number[], digits = 5): void => {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i] as number, `component ${i}`).toBeCloseTo(expected[i] as number, digits);
  }
};

/*
 * Three particles at rest in the xy plane — a at the origin, b one along x, c one along y — whose
 * normal is +z. A vertex at barycentrics (u, v) = (0.25, 0.5) for b and c, 0.1 along the normal:
 * a·0.25 + b·0.25 + c·0.5 + n·0.1 = (0.25, 0.5, 0.1).
 */
const REST = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

/*
 * **The vertex follows its triangle: its barycentric point, raised along the triangle's normal, and
 * its normal turned as the triangle turned.** The triangle as it rests puts the vertex at (0.25,
 * 0.5, 0.1). Turned a quarter about x — y goes to z, z to −y — and moved by (2, 0, 0), the same
 * vertex is at (2.25, −0.1, 0.5), and a rest normal of +z is now −y.
 */
it('A BOUND VERTEX FOLLOWS ITS TRIANGLE, RAISED ALONG ITS NORMAL AND TURNED WITH IT', () => {
  const out = { position: new Float64Array(3), normal: new Float64Array(3) };
  clothPlace(REST, REST, 0, 1, 2, 0.25, 0.5, 0.1, [0, 0, 1], out);
  near(out.position, [0.25, 0.5, 0.1]);
  near(out.normal, [0, 0, 1]);

  const now = new Float32Array([2, 0, 0, 3, 0, 0, 2, 0, 1]);
  clothPlace(now, REST, 0, 1, 2, 0.25, 0.5, 0.1, [0, 0, 1], out);
  near(out.position, [2.25, -0.1, 0.5]);
  near(out.normal, [0, -1, 0]);
});

/*
 * A vertex bound to one particle — all three indices the same — sits on that particle and keeps
 * its normal: there is no triangle to turn it.
 */
it('a vertex bound to one particle sits on it and keeps its normal', () => {
  const out = { position: new Float64Array(3), normal: new Float64Array(3) };
  const now = new Float32Array([5, 6, 7, 0, 0, 0, 0, 0, 0]);
  clothPlace(now, REST, 0, 0, 0, 0, 0, 0.3, [0, 1, 0], out);
  near(out.position, [5, 6, 7]);
  near(out.normal, [0, 1, 0]);
});
