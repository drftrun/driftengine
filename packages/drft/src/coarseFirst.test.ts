import { describe, expect, it } from 'vitest';
import { coarseFirstOrder } from './coarseFirst.ts';

/** A cube of points on a grid, given in the order a nested loop produces them. */
function grid(side: number): { positions: Float32Array; count: number } {
  const count = side * side * side;
  const positions = new Float32Array(count * 3);
  let at = 0;
  for (let x = 0; x < side; x++) {
    for (let y = 0; y < side; y++) {
      for (let z = 0; z < side; z++) {
        positions[at++] = x;
        positions[at++] = y;
        positions[at++] = z;
      }
    }
  }
  return { positions, count };
}

/** How much of each axis of the whole capture a prefix of the order actually covers. */
function coverage(
  positions: Float32Array,
  order: Uint32Array,
  take: number,
): [number, number, number] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const wholeMin = [Infinity, Infinity, Infinity];
  const wholeMax = [-Infinity, -Infinity, -Infinity];
  for (let slot = 0; slot < order.length; slot++) {
    const splat = order[slot] ?? 0;
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[splat * 3 + axis] ?? 0;
      if (value < (wholeMin[axis] ?? 0)) wholeMin[axis] = value;
      if (value > (wholeMax[axis] ?? 0)) wholeMax[axis] = value;
      if (slot < take) {
        if (value < (min[axis] ?? 0)) min[axis] = value;
        if (value > (max[axis] ?? 0)) max[axis] = value;
      }
    }
  }
  return [0, 1, 2].map((axis) => {
    const whole = (wholeMax[axis] ?? 0) - (wholeMin[axis] ?? 0);
    if (whole === 0) return 1;
    return ((max[axis] ?? 0) - (min[axis] ?? 0)) / whole;
  }) as [number, number, number];
}

describe('coarseFirstOrder', () => {
  it('writes every splat exactly once', () => {
    const { positions, count } = grid(9);
    const order = coarseFirstOrder(positions, count);

    expect(order.length).toBe(count);
    expect(new Set(order).size, 'a permutation, not a resampling').toBe(count);
  });

  it('a sixteenth of the order already spans the whole capture', () => {
    /*
     * **The property the whole chunk layout exists for.** A tenth of a streaming capture should
     * be a complete sparse version of the place, not a detailed corner of it — the same trick
     * `coarseLevel.ts` plays for meshes, where a decimated whole body reads as a car and one
     * finished wheel does not.
     *
     * **Why the bar is three quarters and not one.** Taking the first `1/2^k` of a bit-reversed
     * walk selects exactly the Morton codes whose low `k` bits are zero, and a Morton code
     * interleaves the three axes — so at `k = 4` one axis is quantised to a stride of four cells
     * and the others to two. On a sixteen-cell axis that reaches cell 12 of 15, which is 0.8, and
     * it climbs towards 1 as a capture gets bigger. The number that matters is the contrast with
     * the next test, where the same prefix of the *input* order spans a fifth of one axis.
     */
    const { positions, count } = grid(16);
    const order = coarseFirstOrder(positions, count);

    const covered = coverage(positions, order, Math.ceil(count / 16));
    for (const axis of covered) expect(axis).toBeGreaterThan(0.75);
  });

  it('spans it even when the capture arrives sorted along one axis', () => {
    /*
     * **The case that decides the design.** The nested loop above already emits x slowest, so a
     * plain prefix of the *input* order is a slab of low x — which is exactly the "one corner of
     * a detailed capture" failure. This asserts the ordering fixes it rather than inheriting it,
     * which a decimation of the input order would not: it is why the positions are sorted
     * spatially before the sequence is applied rather than after.
     */
    const { positions, count } = grid(16);
    const take = Math.ceil(count / 16);

    const identity = new Uint32Array(count);
    for (let index = 0; index < count; index++) identity[index] = index;
    const rawCoverage = coverage(positions, identity, take);
    expect(rawCoverage[0], 'the input order really is a slab').toBeLessThan(0.2);

    /*
     * **Every axis, not only the one the input is sorted along.** Checking x alone passes with
     * the spatial sort removed entirely — a bit-reversed decimation of this input order happens
     * to spread x and y perfectly and collapses z to a single plane, so the assertion that named
     * the interesting axis was the one that could not see the interesting failure. Found by
     * perturbing the sort away and watching this test stay green.
     */
    const order = coarseFirstOrder(positions, count);
    for (const axis of coverage(positions, order, take)) expect(axis).toBeGreaterThan(0.75);
  });

  it('spreads the second block over the gaps the first left', () => {
    /*
     * Every block is a complete sparse capture, not only the first — otherwise the load opens on
     * a whole place and then fills in one corner at a time, which looks worse than not opening
     * early at all.
     */
    const { positions, count } = grid(16);
    const order = coarseFirstOrder(positions, count);
    const block = Math.ceil(count / 16);

    const second = order.slice(block, block * 2);
    const covered = coverage(positions, second, second.length);
    for (const axis of covered) expect(axis).toBeGreaterThan(0.75);
  });

  it('answers an empty capture with an empty order', () => {
    expect(coarseFirstOrder(new Float32Array(0), 0).length).toBe(0);
  });

  it('answers a one-splat capture', () => {
    expect(Array.from(coarseFirstOrder(new Float32Array([1, 2, 3]), 1))).toEqual([0]);
  });
});
