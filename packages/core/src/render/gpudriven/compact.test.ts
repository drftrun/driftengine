import { expect, test } from 'vitest';

import { CLUSTER_INDEX_CAP } from './indirect.ts';
import {
  DRAW_INDIRECT_WORDS,
  PHASE_ONE,
  PHASE_TWO,
  compactPhase,
  type ClusterPhase,
} from './compact.ts';

const COUNT = 8;

interface Frame {
  selected: Uint32Array;
  keep: Uint32Array;
  history: Uint32Array;
  list: Uint32Array;
  drawn: Uint32Array;
  args: Uint32Array;
}

function frame(history: readonly number[]): Frame {
  return {
    selected: new Uint32Array(COUNT).fill(1),
    keep: new Uint32Array(COUNT).fill(1),
    history: Uint32Array.from(history),
    list: new Uint32Array(COUNT),
    drawn: new Uint32Array(COUNT),
    args: new Uint32Array(DRAW_INDIRECT_WORDS),
  };
}

function run(f: Frame, phase: ClusterPhase): number[] {
  const kept = compactPhase(phase, f.selected, f.keep, f.history, COUNT, f.list, f.drawn, f.args);
  return Array.from(f.list.subarray(0, kept));
}

test('phase one takes the clusters the history holds, and phase two takes the rest', () => {
  const f = frame([1, 0, 1, 0, 0, 0, 1, 0]);
  expect(run(f, PHASE_ONE)).toEqual([0, 2, 6]);
  expect(run(f, PHASE_TWO)).toEqual([1, 3, 4, 5, 7]);
});

test('THE TWO PHASES PARTITION THE LIVE CLUSTERS, so a stale history costs a test and never a hole', () => {
  /*
   * `twoPhase.ts` states the invariant and this is the compaction obeying it: whatever the history
   * holds, every cluster that survives the cut and the cull is drawn exactly once. A history that
   * is entirely wrong — which after a teleport is all of it — moves work between the halves and
   * loses none of it.
   */
  const f = frame([1, 1, 0, 1, 0, 0, 1, 1]);
  const both = [...run(f, PHASE_ONE), ...run(f, PHASE_TWO)].sort((a, b) => a - b);
  expect(both).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test('A CLUSTER THE CUT REJECTED IS IN NEITHER LIST, which is the level of detail doing its job', () => {
  const f = frame([1, 1, 0, 0, 0, 0, 0, 0]);
  f.selected[0] = 0;
  f.selected[3] = 0;
  expect(run(f, PHASE_ONE)).toEqual([1]);
  expect(run(f, PHASE_TWO)).toEqual([2, 4, 5, 6, 7]);
});

test('and a cluster the cull rejected is in neither list either', () => {
  const f = frame([1, 1, 0, 0, 0, 0, 0, 0]);
  f.keep[1] = 0;
  f.keep[4] = 0;
  expect(run(f, PHASE_ONE)).toEqual([0]);
  expect(run(f, PHASE_TWO)).toEqual([2, 3, 5, 6, 7]);
});

test('the draw block issues one instance a kept cluster, over the fixed vertex count', () => {
  const f = frame([1, 1, 1, 0, 0, 0, 0, 0]);
  run(f, PHASE_ONE);
  expect(Array.from(f.args)).toEqual([CLUSTER_INDEX_CAP, 3, 0, 0]);
});

test('A KEPT CLUSTER IS RECORDED FOR NEXT FRAME, which is what makes phase one worth having', () => {
  const f = frame([1, 0, 1, 0, 0, 0, 0, 0]);
  run(f, PHASE_ONE);
  run(f, PHASE_TWO);
  expect(Array.from(f.drawn)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
});

test('A CLUSTER THAT WAS VISIBLE AND IS NOW CULLED LEAVES THE HISTORY', () => {
  /*
   * `updateHistory` in `twoPhase.ts` makes the same point about replacing rather than
   * accumulating: a cluster kept once and culled afterwards that stayed in the history would be
   * drawn in phase one for ever on the strength of having been visible one frame.
   */
  const f = frame([1, 1, 1, 0, 0, 0, 0, 0]);
  f.keep[1] = 0;
  run(f, PHASE_ONE);
  run(f, PHASE_TWO);
  expect(f.drawn[1]).toBe(0);
  expect(f.drawn[0]).toBe(1);
});

/*
 * **Each phase has its own cull, and they differ by the pyramid.** Phase one tests last frame's
 * clusters against the frustum and the cones only, because the pyramid it would need is this
 * frame's and is not built yet; phase two tests every cluster against all three, the pyramid
 * reduced from what phase one drew. So a cluster that was visible last frame and is hidden now is
 * kept by phase one's cull and dropped by phase two's — and the history is phase two's answer.
 *
 * **It was the union of what both phases drew**, which never forgets an occluded cluster: phase one
 * draws it without the pyramid, marks it, and it is drawn again next frame, for as long as it stays
 * in the frustum. Measured in the city, one held place drew 1,283 clusters after a flight and 1,386
 * after standing still, the same picture to within the readout's pixels.
 */
test('A CLUSTER PHASE ONE DREW AND PHASE TWO\u2019S PYRAMID HIDES LEAVES THE HISTORY', () => {
  const f = frame([1, 1, 1, 0, 0, 0, 0, 0]);
  expect(run(f, PHASE_ONE)).toEqual([0, 1, 2]);
  /* Phase two's own cull: the pyramid hides cluster 1, which phase one's could not know. */
  f.keep[1] = 0;
  expect(run(f, PHASE_TWO)).toEqual([3, 4, 5, 6, 7]);
  expect(Array.from(f.drawn)).toEqual([1, 0, 1, 1, 1, 1, 1, 1]);
});

test('PHASE ONE WRITES NO HISTORY, because its cull cannot say what is hidden', () => {
  const f = frame([1, 1, 1, 0, 0, 0, 0, 0]);
  run(f, PHASE_ONE);
  expect(Array.from(f.drawn)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
});

test('THE HISTORY IS PHASE TWO\u2019S ANSWER FOR EVERY CLUSTER, seen or not, and phase two draws only the unseen', () => {
  const f = frame([1, 0, 1, 0, 1, 0, 1, 0]);
  f.keep.set([1, 1, 0, 0, 1, 1, 0, 0]);
  f.selected[4] = 0;
  expect(run(f, PHASE_TWO)).toEqual([1, 5]);
  /* Selected and kept, whichever side of the history it was on. */
  expect(Array.from(f.drawn)).toEqual([1, 1, 0, 0, 0, 1, 0, 0]);
});

test('an empty phase writes a block of no instances rather than leaving the last one standing', () => {
  const f = frame([0, 0, 0, 0, 0, 0, 0, 0]);
  run(f, PHASE_TWO);
  expect(f.args[1]).toBe(8);
  expect(run(f, PHASE_ONE)).toEqual([]);
  expect(Array.from(f.args)).toEqual([CLUSTER_INDEX_CAP, 0, 0, 0]);
});

test('PHASE TWO AGAINST A HISTORY OF ZEROS TAKES EVERY SELECTED CLUSTER, which is how the blended set is compacted', () => {
  /*
   * **The trick `gpuDrivenPass.ts` uses to compact a set that is not divided, pinned here.**
   *
   * The two occlusion phases split the opaque scene between them by the history: phase one draws
   * what was seen last frame and phase two draws what was not. The blended set is not split —
   * every blended cluster in the cut is drawn, once — so the pass compacts it as phase two against
   * a buffer of zeros, where `seen` is false for every cluster and phase two wants exactly that.
   *
   * **Binding the real history there instead is the defect this guards**, and it is not a crash:
   * roughly the clusters that were visible last frame would be dropped, so the transparent surfaces
   * would flicker in and out as the camera moved, which reads as a driver problem.
   */
  const count = 6;
  const selected = new Uint32Array([1, 1, 1, 1, 1, 1]);
  const keep = new Uint32Array([1, 1, 0, 1, 1, 1]);
  const zeros = new Uint32Array(count);
  const list = new Uint32Array(count);
  const drawn = new Uint32Array(count);
  const args = new Uint32Array(DRAW_INDIRECT_WORDS);

  expect(compactPhase(PHASE_TWO, selected, keep, zeros, count, list, drawn, args)).toBe(5);
  expect(Array.from(list.subarray(0, 5))).toEqual([0, 1, 3, 4, 5]);

  /* And against a history that holds anything, the same call drops exactly what it holds. */
  const seen = new Uint32Array([0, 1, 0, 1, 0, 0]);
  const fewer = new Uint32Array(count);
  expect(
    compactPhase(PHASE_TWO, selected, keep, seen, count, fewer, new Uint32Array(count), args),
  ).toBe(3);
});
