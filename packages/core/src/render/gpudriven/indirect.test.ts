import { expect, test } from 'vitest';

import {
  CLUSTER_INDEX_CAP,
  INDIRECT_DISPATCH_WORDS,
  INDIRECT_DRAW_WORDS,
  clusterVertexCluster,
  writeClusterDrawArgs,
  writeDispatchArgs,
} from './indirect.ts';
import { VIS_MAX_TRIANGLES } from './visbuffer.ts';

test('a cluster draw issues one instance per surviving cluster and a fixed index count', () => {
  const out = new Uint32Array(INDIRECT_DRAW_WORDS);
  writeClusterDrawArgs(out, 0, 913);
  expect(Array.from(out)).toEqual([CLUSTER_INDEX_CAP, 913, 0, 0, 0]);
  expect(CLUSTER_INDEX_CAP).toBe(VIS_MAX_TRIANGLES * 3);
});

test('a frame that kept nothing draws nothing rather than one instance', () => {
  const out = new Uint32Array(INDIRECT_DRAW_WORDS).fill(7);
  writeClusterDrawArgs(out, 0, 0);
  expect(out[1]).toBe(0);
});

test('the block is written where the caller says, not at the start', () => {
  const out = new Uint32Array(INDIRECT_DRAW_WORDS * 2);
  writeClusterDrawArgs(out, INDIRECT_DRAW_WORDS, 4);
  expect(out[0]).toBe(0);
  expect(out[INDIRECT_DRAW_WORDS]).toBe(CLUSTER_INDEX_CAP);
  expect(out[INDIRECT_DRAW_WORDS + 1]).toBe(4);
});

test('a dispatch rounds its group count up, because the remainder still has work in it', () => {
  const out = new Uint32Array(INDIRECT_DISPATCH_WORDS);
  writeDispatchArgs(out, 0, 129, 64);
  expect(Array.from(out)).toEqual([3, 1, 1]);
});

test('AN EMPTY LIST IS ZERO GROUPS, not one', () => {
  /* One group over nothing reads a buffer a frame before streaming may not have bound, and
     "nothing to do" is the state every frame starts in. */
  const out = new Uint32Array(INDIRECT_DISPATCH_WORDS);
  writeDispatchArgs(out, 0, 0, 64);
  expect(out[0]).toBe(0);
});

test('an exact multiple is not rounded up to an extra group', () => {
  const out = new Uint32Array(INDIRECT_DISPATCH_WORDS);
  writeDispatchArgs(out, 0, 128, 64);
  expect(out[0]).toBe(2);
});

test('the vertex stage reads its slot, its triangle and its corner from the two builtins', () => {
  expect(clusterVertexCluster(0, 12, 128)).toEqual({
    slot: 12,
    triangle: 0,
    corner: 0,
    degenerate: false,
  });
  expect(clusterVertexCluster(5, 12, 128)).toEqual({
    slot: 12,
    triangle: 1,
    corner: 2,
    degenerate: false,
  });
});

test('A TRIANGLE PAST THE CLUSTER’S OWN COUNT IS DEGENERATE, not the last one drawn again', () => {
  /*
   * A cluster of forty triangles still runs the draw's full 128, and the remaining 88 have to
   * produce nothing. Clamping them onto triangle 39 draws it 89 times — which is one long sliver
   * on every cluster that is not exactly full, and every cluster at the edge of a mesh is not.
   */
  expect(clusterVertexCluster(40 * 3, 0, 40).degenerate).toBe(true);
  expect(clusterVertexCluster(40 * 3 - 1, 0, 40).degenerate).toBe(false);
  expect(clusterVertexCluster(CLUSTER_INDEX_CAP - 1, 0, 40)).toEqual({
    slot: 0,
    triangle: VIS_MAX_TRIANGLES - 1,
    corner: 2,
    degenerate: true,
  });
});

test('a full cluster has no degenerate corner at all', () => {
  for (let vertex = 0; vertex < CLUSTER_INDEX_CAP; vertex += 1) {
    expect(clusterVertexCluster(vertex, 0, VIS_MAX_TRIANGLES).degenerate).toBe(false);
  }
});
