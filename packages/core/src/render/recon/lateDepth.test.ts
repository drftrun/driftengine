import { expect, test } from 'vitest';

import { lateDepthAt, lateDepthCell } from './lateDepth.ts';

/**
 * The depth a late draw is tested against at an output pixel, from the render's jittered depth.
 *
 * Depths here are reversed, as the engine stores them: nearer is larger. Every tap is a 4x4 block
 * of render texels, row-major, starting one texel up and left of the cell's first texel.
 */

/** A 4x4 block of taps from a depth function of the tap's column and row offset (-1..2). */
function block(depth: (x: number, y: number) => number): Float64Array {
  const taps = new Float64Array(16);
  for (let r = 0; r < 4; r += 1)
    for (let c = 0; c < 4; c += 1) taps[r * 4 + c] = depth(c - 1, r - 1);
  return taps;
}

test('A PLANE SEEN ASLANT IS TESTED WHERE THE PIXEL IS, NOT AT ITS NEAREST NEIGHBOUR', () => {
  /*
   * d = 0.2 + 0.01x + 0.002y. At a quarter across and half down, the plane stands at
   * 0.2 + 0.0025 + 0.001 = 0.2035; the tolerance a jittered plane owes is a quarter of its largest
   * step, 0.0025, taken toward the far side: 0.2010. The nearest of the four, 0.212, is what hid a
   * glow lying on a wall seen aslant.
   */
  const taps = block((x, y) => 0.2 + 0.01 * x + 0.002 * y);
  expect(lateDepthAt(taps, 0.25, 0.5)).toBeCloseTo(0.201, 12);
});

test('A PLANE GIVES ONE DEPTH AT A PIXEL WHATEVER THE JITTER', () => {
  /*
   * The render is 960x600 under a 1440x900 output, and draws the plane D(u, v) = a + bu + cv, where
   * (u, v) is the unjittered position in render texels. A texel (tx, ty) jittered by (jx, jy) holds
   * the plane at (tx + 0.5 - jx, ty + 0.5 - jy). The output pixel at (700.5, 300.5) stands at
   * u = 467, v = 200 1/3, so the plane is at 0.3 - 0.3269 + 0.0601 = 0.0332 there, and less the
   * quarter step (0.25 * 0.0007) the test answers 0.033025 — for every jitter.
   */
  const [a, b, c] = [0.3, -0.0007, 0.0003];
  const cell = new Float64Array(4);
  for (const [jx, jy] of [
    [0, 0],
    [0.3, -0.2],
    [-0.45, 0.4],
  ] as const) {
    lateDepthCell(700.5, 300.5, 960, 600, 1440, 900, jx, jy, cell);
    const [bx, by, fx, fy] = cell as unknown as [number, number, number, number];
    const taps = block((x, y) => a + b * (bx + x + 0.5 - jx) + c * (by + y + 0.5 - jy));
    expect(lateDepthAt(taps, fx, fy), `jitter ${jx}, ${jy}`).toBeCloseTo(0.033025, 12);
  }
});

test('AT A SILHOUETTE THE NEAREST OF THE FOUR STANDS, even one running along a row', () => {
  /* The cell's lower row is a near object at 0.5 over a far wall at 0.1. Each texel's two
     differences down its column disagree — one is the jump, the other nothing — so none carries a
     slope across the edge and the near object keeps its own depth. */
  const alongRow = block((_x, y) => (y >= 1 ? 0.5 : 0.1));
  expect(lateDepthAt(alongRow, 0.5, 0.25)).toBe(0.5);
  /* And one texel of a pole in front of a sloped wall. */
  const pole = block((x, y) => (x === 1 && y === 1 ? 0.6 : 0.2 + 0.01 * x));
  expect(lateDepthAt(pole, 0.5, 0.5)).toBe(0.6);
});

test('A GLOW ON A WALL AT ITS EDGE IS TESTED WHERE THE PIXEL IS, not at the nearest texel of the wall', () => {
  /*
   * The wall recedes toward its edge, d = 0.3 - 0.02x, and the sky (0) begins past it. A quarter
   * across from the last texel of wall, the wall stands at 0.295; less a quarter of its own step,
   * 0.005, that is 0.290. The jump to the sky never enters the wall's slope. The nearest of the
   * four, 0.3, is what a strip of neon along the edge failed against on one frame in two.
   */
  const edge = block((x) => (x <= 0 ? 0.3 - 0.02 * x : 0));
  expect(lateDepthAt(edge, 0.25, 0.5)).toBeCloseTo(0.29, 12);
});

test('THE CELL MOVES WITH THE JITTER, as the render texels did', () => {
  /*
   * Output pixel (10.5, 4.5) at two thirds is render position (7, 3). A texel sits at its index
   * plus a half less the jitter, so with a jitter of (0.25, -0.25) that position is texel
   * coordinate (6.75, 2.25): the cell starts at (6, 2), three quarters and a quarter across.
   */
  const cell = new Float64Array(4);
  lateDepthCell(10.5, 4.5, 2, 2, 3, 3, 0.25, -0.25, cell);
  expect(Array.from(cell)).toEqual([6, 2, 0.75, 0.25]);
});
