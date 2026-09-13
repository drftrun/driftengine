import { expect, test } from 'vitest';

import { keptNodes, scratchFor } from './replay.ts';
import type { ScheduledPass } from './schedule.ts';

const pass = (first: number, count: number): ScheduledPass => ({
  writes: 0,
  first,
  count,
  clear: 0,
  discard: 0,
});

test('a kept pass contributes its nodes in its own order', () => {
  const out = new Int32Array(8);
  const n = keptNodes([pass(0, 2), pass(4, 1)], 2, out);
  expect(n).toBe(3);
  expect(Array.from(out.subarray(0, n))).toEqual([0, 1, 4]);
});

test('a node no pass claims is not replayed', () => {
  /* 2 and 3 belong to a pass the scheduler dropped, so nothing may draw them. */
  const out = new Int32Array(8);
  const n = keptNodes([pass(0, 2), pass(4, 2)], 2, out);
  expect(Array.from(out.subarray(0, n))).toEqual([0, 1, 4, 5]);
});

test('it fills nothing when every pass was dropped', () => {
  const out = new Int32Array(8);
  expect(keptNodes([], 0, out)).toBe(0);
});

/**
 * The array is the caller's and is sized with the arena, so this cannot happen in the renderer.
 * It is asserted anyway, because the alternative to stopping is writing past the end of it.
 */
test('it stops at the end of the array it was given', () => {
  const out = new Int32Array(2);
  expect(keptNodes([pass(0, 5)], 1, out)).toBe(2);
  expect(Array.from(out)).toEqual([0, 1]);
});

test('a scratch already large enough is returned unchanged', () => {
  const scratch = new Int32Array(8);
  expect(scratchFor(scratch, 8)).toBe(scratch);
});

test('a scratch too small is replaced by one that fits', () => {
  const scratch = new Int32Array(4);
  const grown = scratchFor(scratch, 9);
  expect(grown).not.toBe(scratch);
  expect(grown.length).toBeGreaterThanOrEqual(9);
});

/**
 * The defect the test above this block was written against, from the other side.
 *
 * `it stops at the end of the array it was given` says the truncation cannot happen in the
 * renderer because the array is sized with the arena. It was not: `replayScratch` was sized with
 * `MAX_DRAWS_PER_FRAME` while the arena it reads reallocates at twice its capacity, and a node is
 * recorded per *verb* — overlays, scatter, plumes, text — so a frame reached this with the draw
 * ring nowhere near full. What it cost was the tail of the frame's passes, replayed by nobody,
 * with no warning and no error.
 */
test('sized from the arena, every node of every pass is kept', () => {
  const passes = [pass(0, 3), pass(3, 4)];
  const small = new Int32Array(4);
  expect(keptNodes(passes, passes.length, small)).toBe(4);

  const sized = scratchFor(small, 7);
  expect(keptNodes(passes, passes.length, sized)).toBe(7);
  expect(Array.from(sized.subarray(0, 7))).toEqual([0, 1, 2, 3, 4, 5, 6]);
});
