import { describe, expect, test } from 'vitest';

import { RangeAlloc } from './rangeAlloc.ts';

/**
 * **What this file is for: the four ways a free list is wrong, and the one that only shows up
 * later.** A claim that overlaps a live range; a release that loses units; a free list that
 * refuses a request it has room for; and — the one that costs an afternoon — a layout that
 * depends on the order releases happened in, which makes a capture irreproducible without
 * anything ever failing.
 */
describe('a range is claimed, released and reused', () => {
  test('CLAIMS RUN END TO END, so nothing overlaps a live range', () => {
    const alloc = new RangeAlloc(100);
    expect(alloc.claim(10)).toBe(0);
    expect(alloc.claim(5)).toBe(10);
    expect(alloc.claim(1)).toBe(15);
    expect(alloc.used).toBe(16);
  });

  test('A RELEASED RANGE IS REUSED BY A REQUEST THAT FITS IT', () => {
    const alloc = new RangeAlloc(100);
    const first = alloc.claim(10);
    alloc.claim(10);
    alloc.release(first, 10);
    /* The hole is at 0 and holds exactly ten, so a ten fits it rather than going to the end. */
    expect(alloc.claim(10)).toBe(0);
    expect(alloc.used).toBe(20);
  });

  test('best fit, so a small request does not eat the only large hole', () => {
    const alloc = new RangeAlloc(100);
    const small = alloc.claim(4);
    alloc.claim(1);
    const large = alloc.claim(20);
    alloc.claim(1);
    alloc.release(small, 4);
    alloc.release(large, 20);
    /* A four fits the four-hole exactly; first fit would have taken the twenty. */
    expect(alloc.claim(4)).toBe(small);
    expect(alloc.claim(20)).toBe(large);
  });

  test('REFUSES WITH -1 RATHER THAN THROWING, because a frame loop calls this', () => {
    const alloc = new RangeAlloc(10);
    expect(alloc.claim(10)).toBe(0);
    expect(alloc.claim(1)).toBe(-1);
    /* And the refusal changed nothing: the capacity is still exactly used. */
    expect(alloc.used).toBe(10);
  });

  test('a run too fragmented to hold a request is refused even with room in total', () => {
    const alloc = new RangeAlloc(10);
    const a = alloc.claim(4);
    alloc.claim(2);
    const b = alloc.claim(4);
    alloc.release(a, 4);
    alloc.release(b, 4);
    /* Eight free, in two runs of four. A five does not fit and says so. */
    expect(alloc.used).toBe(2);
    expect(alloc.claim(5)).toBe(-1);
  });

  test('ADJACENT HOLES COALESCE, which is what stops a free list fragmenting to death', () => {
    const alloc = new RangeAlloc(10);
    const a = alloc.claim(3);
    const b = alloc.claim(3);
    alloc.release(a, 3);
    alloc.release(b, 3);
    /* Two neighbouring threes are one six, and a six fits only if they merged. */
    expect(alloc.claim(6)).toBe(0);
  });

  test('COALESCING DOES NOT DEPEND ON RELEASE ORDER, which a capture would expose and no test did', () => {
    const forwards = new RangeAlloc(12);
    const a1 = forwards.claim(4);
    const b1 = forwards.claim(4);
    const c1 = forwards.claim(4);
    forwards.release(a1, 4);
    forwards.release(b1, 4);
    forwards.release(c1, 4);

    const backwards = new RangeAlloc(12);
    const a2 = backwards.claim(4);
    const b2 = backwards.claim(4);
    const c2 = backwards.claim(4);
    backwards.release(c2, 4);
    backwards.release(b2, 4);
    backwards.release(a2, 4);

    /* Both are one free run of twelve, whichever order the middle was returned in. */
    expect(forwards.claim(12)).toBe(0);
    expect(backwards.claim(12)).toBe(0);
  });

  test('the high-water mark is what the fragmentation measurement reads', () => {
    const alloc = new RangeAlloc(100);
    const a = alloc.claim(30);
    alloc.claim(30);
    expect(alloc.highWater).toBe(60);
    alloc.release(a, 30);
    /* It records the worst the layout ever reached, so releasing does not lower it. */
    expect(alloc.highWater).toBe(60);
    expect(alloc.used).toBe(30);
  });

  test('a zero-unit claim takes nothing and is not a refusal', () => {
    /* A mesh with no clusters is legal and `buildGpuDrivenScene` says why: dropping it would
       shift every mesh after it and each of their clusters would draw with somebody else's
       matrix. So a zero claim has to succeed and occupy nothing. */
    const alloc = new RangeAlloc(4);
    expect(alloc.claim(0)).toBe(0);
    expect(alloc.used).toBe(0);
    expect(alloc.claim(4)).toBe(0);
  });

  test('A ZERO-UNIT CLAIM SUCCEEDS ON A FULL ALLOCATOR, which is the case that needs the guard', () => {
    /*
     * **The case the obvious test does not reach**, found by perturbation: with a hole left, the
     * search happens to return the right answer for a request of nothing, so removing the guard
     * changed nothing and the line looked dead. It is not. A mesh with no clusters added to a
     * scene whose cluster capacity is exactly full asks for nothing and must be given it —
     * refusing would drop a mesh that needs no room, and `buildGpuDrivenScene` says what dropping
     * one does to every mesh after it.
     */
    const alloc = new RangeAlloc(4);
    expect(alloc.claim(4)).toBe(0);
    expect(alloc.claim(1)).toBe(-1);
    expect(alloc.claim(0)).toBe(0);
  });
});
