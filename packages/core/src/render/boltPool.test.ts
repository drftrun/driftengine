import { expect, test } from 'vitest';
import { BoltPool } from './boltPool.ts';

/**
 * **A bolt is jagged, and it is a different jag a moment later.**
 *
 * Both halves are the effect. A polyline that happens to be straight is a wire; one
 * that bends the same way for its whole life is a rope. What reads as lightning is a
 * path with detail at several scales that is *replaced* several times while it lives —
 * so these are the two things worth protecting, and they are cheap to check because
 * the pool is deliberately GL-free.
 */

const OPTIONS = {
  capacity: 4,
  nodes: 9,
  lifeSec: 0.2,
  jitter: 0.25,
  restrikeHz: 20,
};

/** Greatest distance from the straight line between the two ends, over all segments. */
function maxDeviation(
  pool: BoltPool,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const span = Math.hypot(dx, dy, dz);
  let worst = 0;
  const { from, count } = pool.segments;
  for (let s = 0; s < count; s++) {
    const px = (from[s * 3] as number) - x0;
    const py = (from[s * 3 + 1] as number) - y0;
    const pz = (from[s * 3 + 2] as number) - z0;
    // Distance from the point to the line, via the cross product's magnitude.
    const cx = py * dz - pz * dy;
    const cy = pz * dx - px * dz;
    const cz = px * dy - py * dx;
    const d = Math.hypot(cx, cy, cz) / span;
    if (d > worst) worst = d;
  }
  return worst;
}

test('a struck bolt is jagged rather than straight', () => {
  const pool = new BoltPool(OPTIONS);
  pool.strike(0, 0, 0, 0, 1, 0, 7);
  pool.update(1 / 60);

  expect(pool.segments.count, 'a bolt of nine nodes is eight segments').toBe(8);
  /*
   * A quarter of the span is the authored jitter, and the coarsest displacement gets
   * the whole of it — so a fifteenth is a floor that only a path with no displacement
   * at all can fail. Hand-derived, deliberately loose: this guards "it bends", not
   * how much.
   */
  expect(maxDeviation(pool, 0, 0, 0, 0, 1, 0)).toBeGreaterThan(1 / 15);
});

test('a live bolt is redrawn, not animated', () => {
  const pool = new BoltPool(OPTIONS);
  pool.strike(0, 0, 0, 0, 1, 0, 7);
  pool.update(1 / 60);
  const first = Array.from(pool.segments.from.subarray(0, 24));

  // Past one re-strike interval (1/20 s), so the path is due to be replaced.
  pool.update(4 / 60);
  const second = Array.from(pool.segments.from.subarray(0, 24));

  let moved = 0;
  for (let i = 0; i < first.length; i++) {
    if (Math.abs((first[i] as number) - (second[i] as number)) > 1e-6) moved++;
  }
  expect(moved, 'the path never changed, so it is a rope rather than an arc').toBeGreaterThan(6);
});

test('the ends stay where they were struck', () => {
  const pool = new BoltPool(OPTIONS);
  pool.strike(1, 2, 3, 1, 4, 3, 11);
  for (let i = 0; i < 6; i++) pool.update(1 / 60);
  const { from, to, count } = pool.segments;
  // The first segment starts at the strike's origin and the last ends at its target,
  // whatever the middle is doing — an arc that wandered off its endpoints would
  // detach from the thing that made it.
  expect(from[0]).toBeCloseTo(1, 5);
  expect(from[1]).toBeCloseTo(2, 5);
  expect(to[(count - 1) * 3]).toBeCloseTo(1, 5);
  expect(to[(count - 1) * 3 + 1]).toBeCloseTo(4, 5);
});

test('a bolt dies, and its segments go with it', () => {
  const pool = new BoltPool(OPTIONS);
  pool.strike(0, 0, 0, 0, 1, 0, 3);
  pool.update(1 / 60);
  expect(pool.live).toBe(1);
  for (let i = 0; i < 20; i++) pool.update(1 / 60);
  expect(pool.live).toBe(0);
  expect(pool.segments.count).toBe(0);
});
