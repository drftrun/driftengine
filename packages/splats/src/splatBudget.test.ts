import { describe, expect, it } from 'vitest';
import { defaultSplatBudget } from './splatBudget.ts';
import { createSplatSortScratch, sortSplatsByDepth } from './splatSort.ts';
import type { SplatSortRequest } from './splatSort.ts';

/**
 * A request over splats laid out along the view axis, with everything not under test defaulted.
 *
 * The camera sits at the origin looking down +z, so a splat's z **is** its distance and the
 * screen-space size key is exactly `extent / z` — which is what makes the expectations below
 * hand-derived numbers rather than something read off a run.
 */
function request(over: Partial<SplatSortRequest> & { count: number }): SplatSortRequest {
  return {
    positions: new Float32Array(over.count * 3),
    extents: new Float32Array(over.count).fill(1),
    dirX: 0,
    dirY: 0,
    dirZ: 1,
    originX: 0,
    originY: 0,
    originZ: 0,
    budget: 0,
    out: new Uint32Array(over.count),
    ...over,
  };
}

/** Positions along the view axis, one per z. */
function alongZ(...z: number[]): Float32Array {
  const out = new Float32Array(z.length * 3);
  z.forEach((value, index) => {
    out[index * 3 + 2] = value;
  });
  return out;
}

describe('a splat budget', () => {
  it('drops the nearest splats when it is a prefix of the order, which is why it is not one', () => {
    /*
     * **The measurement the budget exists because of, asserted rather than recalled.** The order
     * is far to near, so `out[0]` is the *farthest* splat and a prefix of the order keeps the
     * far end and discards the near one — the splats closest to the camera, which are the largest
     * on screen and are most of the picture. This asserts that reading of the unbudgeted order,
     * so the comment in `splatSort.ts` cannot drift away from what the code does.
     */
    const positions = alongZ(1, 2, 3, 4);
    const req = request({ count: 4, positions });
    sortSplatsByDepth(req, createSplatSortScratch(4));

    const zOf = (slot: number): number => positions[(req.out[slot] ?? 0) * 3 + 2] ?? 0;
    expect([zOf(0), zOf(1), zOf(2), zOf(3)], 'far to near').toEqual([4, 3, 2, 1]);
    expect(
      [zOf(0), zOf(1)],
      'so a prefix of two keeps the far pair and throws away the near one',
    ).toEqual([4, 3]);
  });

  it('keeps the splats that are largest on screen, whatever their depth', () => {
    /*
     * Four splats at z = 1, 2, 3, 4 with extents chosen so the screen-space size ranking is the
     * *opposite* of the depth ranking: extent / z is 0.25, 1, 3, 8 for indices 0..3, so the two
     * worth keeping are the two farthest away. A prefix of the order would have kept those by
     * luck here; a suffix would have kept the wrong pair. What separates the two policies is that
     * this one is chosen by size, and the next test is the one where they disagree.
     */
    const req = request({
      count: 4,
      positions: alongZ(1, 2, 3, 4),
      extents: new Float32Array([0.25, 2, 9, 32]),
      budget: 2,
    });

    const drawn = sortSplatsByDepth(req, createSplatSortScratch(4));

    expect(drawn, 'exactly the budget').toBe(2);
    expect(Array.from(req.out.subarray(0, 2)), 'far to near among what survived').toEqual([3, 2]);
  });

  it('keeps a near giant and drops a near speck, which no prefix of the order can do', () => {
    /*
     * The case that decides the policy. Index 0 is a speck a hand's breadth from the camera and
     * index 3 is a boulder behind it; a prefix of the far-to-near order keeps the boulder and the
     * speck alike and drops whatever is nearest, and a suffix does the reverse. Only a size key
     * keeps the two that are actually large on screen.
     *
     *   index 0: extent 0.001 at z = 1   -> 0.001
     *   index 1: extent 4     at z = 2   -> 2
     *   index 2: extent 0.002 at z = 3   -> 0.00067
     *   index 3: extent 8     at z = 4   -> 2
     */
    const req = request({
      count: 4,
      positions: alongZ(1, 2, 3, 4),
      extents: new Float32Array([0.001, 4, 0.002, 8]),
      budget: 2,
    });

    const drawn = sortSplatsByDepth(req, createSplatSortScratch(4));

    expect(drawn).toBe(2);
    expect(Array.from(req.out.subarray(0, 2)), 'the two boulders, far to near').toEqual([3, 1]);
  });

  it('draws everything when the budget is at or above the count', () => {
    const req = request({ count: 4, positions: alongZ(1, 2, 3, 4), budget: 4 });
    expect(sortSplatsByDepth(req, createSplatSortScratch(4))).toBe(4);

    const none = request({ count: 4, positions: alongZ(1, 2, 3, 4), budget: 0 });
    expect(sortSplatsByDepth(none, createSplatSortScratch(4)), 'and when there is none').toBe(4);
  });

  it('spends the budget on what is in front of the camera', () => {
    /*
     * A splat behind the camera has no screen-space size at all, and a budget that spent slots on
     * one would be dropping something visible to keep something that is not. Splats at z = -3 and
     * -1 are behind a camera looking down +z; the two at +1 and +2 are the ones to keep.
     */
    const req = request({
      count: 4,
      positions: alongZ(-3, 1, -1, 2),
      budget: 2,
    });

    const drawn = sortSplatsByDepth(req, createSplatSortScratch(4));

    expect(drawn).toBe(2);
    expect(Array.from(req.out.subarray(0, 2)), 'far to near, both in front').toEqual([3, 1]);
  });

  it('measures distance from the camera rather than from the capture', () => {
    /*
     * The size key is `extent / distance`, so where the camera *is* decides it — and the depth
     * ordering alone cannot see that, because shifting every splat by the same amount leaves the
     * order untouched. Two equal splats at z = 10 and z = 30. From the origin the near one is
     * three times the size; from z = 20 the far one is twice as near as the other and wins.
     */
    const positions = alongZ(10, 30);
    const near = request({ count: 2, positions, budget: 1 });
    sortSplatsByDepth(near, createSplatSortScratch(2));
    expect(near.out[0], 'from the origin, the splat at 10').toBe(0);

    const moved = request({ count: 2, positions, originZ: 20, budget: 1 });
    sortSplatsByDepth(moved, createSplatSortScratch(2));
    expect(moved.out[0], 'from z = 20, the splat at 30').toBe(1);
  });

  it('never exceeds the budget even when every splat is the same size', () => {
    /*
     * A uniform capture puts every splat in one bucket of the size histogram, so a threshold on
     * its own would either keep all of them or none. Both are a budget that does not budget, and
     * the second is a capture that goes blank on the device the budget exists for.
     */
    const count = 1000;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) positions[index * 3 + 2] = 5;
    const req = request({ count, positions, budget: 137 });

    expect(sortSplatsByDepth(req, createSplatSortScratch(count))).toBe(137);
    expect(new Set(req.out.subarray(0, 137)).size, 'and each of them once').toBe(137);
  });

  it('writes each surviving index exactly once and touches nothing past them', () => {
    const count = 400;
    const positions = new Float32Array(count * 3);
    const extents = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      positions[index * 3] = Math.sin(index * 12.9898) * 20;
      positions[index * 3 + 1] = Math.cos(index * 78.233) * 20;
      positions[index * 3 + 2] = 40 + Math.sin(index * 43.7585) * 20;
      extents[index] = 0.05 + (index % 37) * 0.01;
    }
    const req = request({
      count,
      positions,
      extents,
      budget: 150,
      out: new Uint32Array(count).fill(7),
    });

    const drawn = sortSplatsByDepth(req, createSplatSortScratch(count));

    expect(drawn).toBe(150);
    expect(new Set(req.out.subarray(0, 150)).size, 'no index twice, none lost').toBe(150);
    expect(
      Array.from(req.out.subarray(150)).every((value) => value === 7),
      'the tail of the output is untouched',
    ).toBe(true);
  });
});

describe('defaultSplatBudget', () => {
  it('answers a positive count for a part it has never heard of', () => {
    /*
     * The unknown part is not assumed weak, which is `isWeakGpuFamily`'s own rule: guessing weak
     * on the unknown ships a thinned capture to every device released after this line was written.
     */
    expect(defaultSplatBudget('')).toBeGreaterThan(0);
    expect(defaultSplatBudget('Some Vendor Something 9000')).toBe(defaultSplatBudget(''));
    expect(defaultSplatBudget(undefined), 'and to a caller with no string at all').toBe(
      defaultSplatBudget(''),
    );
  });

  it('lowers the count for a family measured to struggle', () => {
    /*
     * The relationship rather than the numbers. Both are estimates until somebody holds a phone,
     * and asserting either literal would be a test that fails the day it is corrected — which is
     * `AGENTS.md`'s rule about not testing tuning constants.
     */
    const weak = defaultSplatBudget('ANGLE (Qualcomm, Adreno (TM) 619, OpenGL ES 3.2)');
    expect(weak).toBeGreaterThan(0);
    expect(weak).toBeLessThan(defaultSplatBudget('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)'));
  });
});
