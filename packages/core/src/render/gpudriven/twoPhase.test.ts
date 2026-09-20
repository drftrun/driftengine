import { expect, test } from 'vitest';

import { createDeps, readsOf, writesOf } from '../frame/deps.ts';
import {
  clearHistory,
  createVisibilityHistories,
  createVisibilityHistory,
  historyCount,
  historyFor,
  historyHas,
  phaseOneClusters,
  phaseOnePasses,
  phaseTwoClusters,
  phaseTwoPasses,
  setHistory,
  updateHistory,
} from './twoPhase.ts';

const COUNT = 70;

test('A NEW HISTORY IS EMPTY, so the first frame draws nothing in phase one', () => {
  const history = createVisibilityHistory(COUNT);
  const out = new Uint32Array(COUNT);
  expect(phaseOneClusters(history, COUNT, out)).toBe(0);
  expect(historyCount(history, COUNT)).toBe(0);
});

test('AND PHASE TWO THEN TESTS EVERYTHING, so the first frame is still correct', () => {
  const history = createVisibilityHistory(COUNT);
  const out = new Uint32Array(COUNT);
  expect(phaseTwoClusters(history, COUNT, out)).toBe(COUNT);
  expect(Array.from(out.subarray(0, 4))).toEqual([0, 1, 2, 3]);
});

test('a cluster visible last frame is in phase one this frame', () => {
  const history = createVisibilityHistory(COUNT);
  setHistory(history, 5, true);
  setHistory(history, 33, true);
  setHistory(history, 69, true);
  const out = new Uint32Array(COUNT);
  expect(phaseOneClusters(history, COUNT, out)).toBe(3);
  expect(Array.from(out.subarray(0, 3))).toEqual([5, 33, 69]);
});

test('and everything else is in phase two, so nothing is in both and nothing is in neither', () => {
  const history = createVisibilityHistory(COUNT);
  for (const cluster of [0, 1, 40, 63, 64]) setHistory(history, cluster, true);
  const one = new Uint32Array(COUNT);
  const two = new Uint32Array(COUNT);
  const first = phaseOneClusters(history, COUNT, one);
  const second = phaseTwoClusters(history, COUNT, two);
  expect(first + second).toBe(COUNT);
  const seen = new Set([...one.subarray(0, first), ...two.subarray(0, second)]);
  expect(seen.size).toBe(COUNT);
});

test('THE TWO PHASES ALWAYS COVER EVERY CLUSTER, WHATEVER THE HISTORY SAYS', () => {
  /*
   * **This is the property a camera teleport rests on.** A single-phase implementation tests
   * against a pyramid built from last frame's camera, so a view that jumped drops whatever the old
   * depth happened to hide. Here the history only decides *which phase* a cluster is decided in;
   * every cluster is decided in one of them, so a stale history costs a little work and never a
   * hole. Asserted against a history that is deliberately nonsense for this frame.
   */
  const history = createVisibilityHistory(COUNT);
  for (let i = 0; i < COUNT; i += 3) setHistory(history, i, true);
  const one = new Uint32Array(COUNT);
  const two = new Uint32Array(COUNT);
  const first = phaseOneClusters(history, COUNT, one);
  const second = phaseTwoClusters(history, COUNT, two);
  const seen = new Set([...one.subarray(0, first), ...two.subarray(0, second)]);
  for (let i = 0; i < COUNT; i += 1) expect(seen.has(i)).toBe(true);
});

test('A CLUSTER CULLED IN PHASE TWO IS REMOVED FROM THE HISTORY', () => {
  const history = createVisibilityHistory(COUNT);
  for (const cluster of [2, 7, 20]) setHistory(history, cluster, true);
  const keep = new Uint32Array(COUNT);
  keep[2] = 1;
  keep[41] = 1;
  updateHistory(history, keep, COUNT);
  expect(historyHas(history, 2)).toBe(true);
  expect(historyHas(history, 7)).toBe(false);
  expect(historyHas(history, 20)).toBe(false);
  expect(historyHas(history, 41)).toBe(true);
  expect(historyCount(history, COUNT)).toBe(2);
});

test('a cluster past the capacity is not in the history, even where there is a bit for it', () => {
  /*
   * **Forty clusters is two words, so there are twenty-four bits nobody owns**, and that is where
   * the range check earns its place rather than at the end of the array. A write past the end of
   * a typed array is a silent no-op and a read past it is `undefined`, so an index of nine hundred
   * answers false with the guard and without it; an index of fifty does not. Fifty is a cluster
   * this view does not have, and "visible last frame" is not the answer for geometry that does not
   * exist — it would put a nonexistent cluster into phase one.
   */
  const store = createVisibilityHistories();
  const history = historyFor(store, 0, 40);
  setHistory(history, 50, true);
  expect(historyHas(history, 50)).toBe(false);
  setHistory(history, 900, true);
  expect(historyHas(history, 900)).toBe(false);
  expect(historyCount(history, 64)).toBe(0);
  /* And it stays refused after the view grows, which is where a bit written out of range would
     otherwise surface: widening keeps every word it already had. */
  const grown = historyFor(store, 0, 64);
  expect(historyHas(grown, 50)).toBe(false);
  expect(historyCount(grown, 64)).toBe(0);
});

test('clearing one is what a caller does when the cluster list itself changed', () => {
  const history = createVisibilityHistory(COUNT);
  for (let i = 0; i < COUNT; i += 1) setHistory(history, i, true);
  clearHistory(history);
  expect(historyCount(history, COUNT)).toBe(0);
});

test('THE HISTORY IS PER VIEW, so a shadow pass and the main view do not share one', () => {
  const store = createVisibilityHistories();
  const main = historyFor(store, 0, COUNT);
  const shadow = historyFor(store, 1, COUNT);
  setHistory(main, 9, true);
  expect(historyHas(shadow, 9)).toBe(false);
  expect(historyFor(store, 0, COUNT)).toBe(main);
  expect(historyFor(store, 1, COUNT)).toBe(shadow);
});

test('a view whose cluster count grew gets a wider history rather than a truncated one', () => {
  const store = createVisibilityHistories();
  const small = historyFor(store, 0, 8);
  setHistory(small, 3, true);
  const grown = historyFor(store, 0, 4096);
  expect(historyHas(grown, 3)).toBe(true);
  expect(historyHas(grown, 4000)).toBe(false);
  setHistory(grown, 4000, true);
  expect(historyHas(grown, 4000)).toBe(true);
});

/** The five virtual resources a two-phase frame moves between its halves. */
const RES = { colour: 0, depth: 1, hzb: 2, clusters: 3, keep: 4 } as const;

test('PHASE TWO TESTS AGAINST DEPTH THIS FRAME WROTE, which is the whole reason for two of them', () => {
  const deps = createDeps(8, 64);
  const one = phaseOnePasses(deps, RES);
  const two = phaseTwoPasses(deps, RES);
  /* The reduction writes the pyramid and phase two's cull reads it, so no schedule can put the
     cull before the reduction or run them together. That edge *is* the guarantee. */
  expect(Array.from(writesOf(deps, one.reduce))).toContain(RES.hzb);
  expect(Array.from(readsOf(deps, two.cull))).toContain(RES.hzb);
});

test('and the reduction reads the depth phase one drew rather than a held copy', () => {
  const deps = createDeps(8, 64);
  const one = phaseOnePasses(deps, RES);
  expect(Array.from(writesOf(deps, one.draw))).toContain(RES.depth);
  expect(Array.from(readsOf(deps, one.reduce))).toContain(RES.depth);
});

test('both halves draw into the same colour and depth, because they are one frame', () => {
  const deps = createDeps(8, 64);
  const one = phaseOnePasses(deps, RES);
  const two = phaseTwoPasses(deps, RES);
  for (const node of [one.draw, two.draw]) {
    expect(Array.from(writesOf(deps, node))).toContain(RES.colour);
    expect(Array.from(writesOf(deps, node))).toContain(RES.depth);
  }
});

test('the nodes come back in the order they were recorded', () => {
  const deps = createDeps(8, 64);
  const one = phaseOnePasses(deps, RES);
  const two = phaseTwoPasses(deps, RES);
  expect([one.draw, one.reduce, two.cull, two.draw]).toEqual([0, 1, 2, 3]);
});
