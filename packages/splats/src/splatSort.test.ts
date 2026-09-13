import { describe, expect, it } from 'vitest';
import { createSplatSortScratch, sortSplatsByDepth } from './splatSort.ts';
import type { SplatSortRequest } from './splatSort.ts';

/**
 * A request with everything not under test defaulted: no budget, camera at the origin.
 *
 * The budget is `splatBudget.test.ts`'s subject; everything here is about the ordering, which is
 * what the sort did before a budget existed and must go on doing when there is none.
 */
function request(
  positions: Float32Array,
  count: number,
  dir: readonly [number, number, number],
  out: Uint32Array,
): SplatSortRequest {
  return {
    positions,
    extents: new Float32Array(count).fill(1),
    count,
    dirX: dir[0],
    dirY: dir[1],
    dirZ: dir[2],
    originX: 0,
    originY: 0,
    originZ: 0,
    budget: 0,
    out,
  };
}

/** Positions along one axis, so the expected order is readable from the input. */
function alongZ(...z: number[]): Float32Array {
  const out = new Float32Array(z.length * 3);
  z.forEach((value, index) => {
    out[index * 3 + 2] = value;
  });
  return out;
}

describe('sortSplatsByDepth', () => {
  it('orders far to near along the direction given', () => {
    /*
     * **The one property a screenshot cannot check.** A near-to-far order still draws a cloud, and
     * is wrong at every silhouette because `over` compositing is not commutative. Splats at
     * z = 1, 5, 3, 2 with the camera looking down +z: farthest first is 5, 3, 2, 1, which is
     * indices 1, 2, 3, 0.
     */
    const positions = alongZ(1, 5, 3, 2);
    const out = new Uint32Array(4);
    const scratch = createSplatSortScratch(4);

    const drawn = sortSplatsByDepth(request(positions, 4, [0, 0, 1], out), scratch);

    expect(drawn).toBe(4);
    expect(Array.from(out)).toEqual([1, 2, 3, 0]);
  });

  it('reverses when the direction does', () => {
    /* The same capture seen from the other side: nearest becomes farthest. */
    const positions = alongZ(1, 5, 3, 2);
    const out = new Uint32Array(4);
    const scratch = createSplatSortScratch(4);

    sortSplatsByDepth(request(positions, 4, [0, 0, -1], out), scratch);

    expect(Array.from(out)).toEqual([0, 3, 2, 1]);
  });

  it('emits every index exactly once', () => {
    /*
     * A counting sort scatters by a computed offset, so an off-by-one in the prefix sum drops one
     * splat and doubles another — which in a picture is one missing Gaussian among a million and
     * is invisible. This is the assertion that sees it.
     */
    const count = 500;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      /* An irrational step, so the depths do not fall on bucket boundaries. */
      positions[index * 3 + 2] = (index * Math.SQRT2) % 17;
    }
    const out = new Uint32Array(count);
    const scratch = createSplatSortScratch(count);

    sortSplatsByDepth(request(positions, count, [0, 0, 1], out), scratch);

    const seen = new Set(out);
    expect(seen.size, 'every index appears').toBe(count);
    expect(Math.min(...out)).toBe(0);
    expect(Math.max(...out)).toBe(count - 1);
  });

  it('is actually sorted, checked against the depths rather than against itself', () => {
    const count = 300;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      positions[index * 3] = Math.sin(index * 12.9898) * 40;
      positions[index * 3 + 1] = Math.cos(index * 78.233) * 40;
      positions[index * 3 + 2] = Math.sin(index * 43.7585) * 40;
    }
    const out = new Uint32Array(count);
    const scratch = createSplatSortScratch(count);
    const dir = [0.36, 0.48, 0.8];

    sortSplatsByDepth(
      request(positions, count, [dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0], out),
      scratch,
    );

    const depthOf = (index: number): number =>
      (positions[index * 3] ?? 0) * (dir[0] ?? 0) +
      (positions[index * 3 + 1] ?? 0) * (dir[1] ?? 0) +
      (positions[index * 3 + 2] ?? 0) * (dir[2] ?? 0);
    /*
     * Non-increasing rather than strictly decreasing: two splats can share a bucket, and the
     * tolerance is one bucket of the measured range — which is what a sixteen-bit key promises
     * and the only thing it promises.
     */
    const range = 80 * (Math.abs(dir[0] ?? 0) + Math.abs(dir[1] ?? 0) + Math.abs(dir[2] ?? 0));
    const bucket = range / 65535;
    for (let slot = 1; slot < count; slot++) {
      const previous = depthOf(out[slot - 1] ?? 0);
      const current = depthOf(out[slot] ?? 0);
      expect(current, `slot ${slot} is nearer than the one before it`).toBeLessThanOrEqual(
        previous + bucket,
      );
    }
  });

  it('loses nothing when every depth is identical', () => {
    /*
     * A plane seen exactly side-on, or a capture of one splat: the range is zero and the key is a
     * division by it. With no range there is no ordering to get wrong, so the answer is input
     * order — but it must still be every splat, once.
     */
    const positions = alongZ(2, 2, 2, 2, 2);
    const out = new Uint32Array(5);
    const scratch = createSplatSortScratch(5);

    const drawn = sortSplatsByDepth(request(positions, 5, [0, 0, 1], out), scratch);

    expect(drawn).toBe(5);
    expect(Array.from(out).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('closes over nothing, because a worker runs its stringified source', () => {
    /*
     * `createSplatSortWorker` ships `sortSplatsByDepth.toString()` so there is one implementation
     * of the ordering rather than two — the 2026-08-17 rule about what happens to two
     * implementations of one decision. A stringified function loses its scope, so any module-scope
     * name it referenced becomes an undefined identifier in the worker: it would throw the first
     * time the view turned, in a context with no stack anybody reads, and the capture would
     * silently stop re-ordering.
     *
     * The bucket count therefore comes from `counts.length`. This asserts that, rather than
     * trusting it to stay true.
     */
    const source = sortSplatsByDepth.toString();
    expect(source, 'no depth-bucket constant').not.toContain('SPLAT_SORT_BUCKETS');
    expect(source, 'no size-bucket constant either').not.toContain('SPLAT_SIZE_BUCKETS');
    expect(source, 'the depth count comes from the scratch').toContain('counts.length');
    expect(source, 'and so does the size count').toContain('sizeCounts.length');
  });

  it('answers zero for an empty capture rather than touching the output', () => {
    const out = new Uint32Array(3).fill(9);
    expect(
      sortSplatsByDepth(request(new Float32Array(0), 0, [0, 0, 1], out), createSplatSortScratch(1)),
    ).toBe(0);
    expect(Array.from(out), 'nothing written').toEqual([9, 9, 9]);
  });

  it('sorts a prefix without reading past it', () => {
    /* A capture may be sorted a prefix at a time while it streams in, so the sort takes a count
       rather than assuming the arrays are exactly full. This is not how a budget works — see
       `splatBudget.test.ts` for that — it is about arrays that are longer than the data in them. */
    const positions = alongZ(1, 5, 3, 99, 98);
    const out = new Uint32Array(5).fill(7);
    const scratch = createSplatSortScratch(5);

    sortSplatsByDepth(request(positions, 3, [0, 0, 1], out), scratch);

    expect(Array.from(out.subarray(0, 3))).toEqual([1, 2, 0]);
    expect(Array.from(out.subarray(3)), 'the tail is untouched').toEqual([7, 7]);
  });
});
