import { expect, test } from 'vitest';

import { createArena, recordNode, resetArena } from './arena.ts';
import { readsOf, writesOf } from './deps.ts';
import { createFlushSchedule, scheduleFlush } from './flushGraph.ts';
import { RESOURCE_COUNT, maskOf } from './resources.ts';
import { schedule } from './schedule.ts';
import type { ScheduledPass } from './schedule.ts';

/**
 * **The forward renderer's flush, scheduled by the identifier graph, must be the flush the mask
 * scheduler gives.** That is Wave 1A's exit criterion in miniature: today's frames, through the
 * graph that can also express the second pipeline, with nothing different about them. These
 * frames are built from the shapes `webgpu/renderer.ts` actually records and the live sets it
 * actually passes, so an agreement here is an agreement about real flushes.
 */
const SCENE = maskOf('sceneColor', 'sceneDepth');
const CANVAS = maskOf('canvas');
const MIRROR = maskOf('mirrorColor', 'mirrorDepth');
const DEPTH = maskOf('sceneDepth');
const SNAPSHOT = maskOf('depthSnapshot');
const MIRROR_COLOUR = maskOf('mirrorColor');
const EVERY = (1 << RESOURCE_COUNT) - 1;

/** Every (reads, writes) pair the renderer records, from its verbs, scopes and passes. */
const SHAPES: ReadonlyArray<readonly [number, number]> = [
  [0, SCENE],
  [0, CANVAS],
  [0, MIRROR],
  [SCENE, SCENE],
  [CANVAS, CANVAS],
  [DEPTH, SNAPSHOT],
  [MIRROR_COLOUR, SCENE],
  [MIRROR_COLOUR, CANVAS],
  [SNAPSHOT, SCENE],
  [maskOf('aoTarget', 'depthSnapshot'), SCENE],
];

/** What `liveOutMidFrame` and `liveOutFinalFlush` answer, with and without a pass's reads. */
const LIVE_SETS = [
  EVERY & ~maskOf('mirrorDepth'),
  EVERY & ~maskOf('mirrorDepth', 'sceneDepth'),
  (EVERY & ~maskOf('mirrorDepth', 'sceneDepth')) | maskOf('mirrorDepth'),
];

const CLEARS = [0, SCENE, SCENE | MIRROR, maskOf('sceneColor')];

function passes(capacity: number): ScheduledPass[] {
  return Array.from({ length: capacity }, () => ({
    writes: 0,
    first: 0,
    count: 0,
    clear: 0,
    discard: 0,
  }));
}

/** A small deterministic generator, so a failure names a seed that reproduces it. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

test('every realistic flush schedules identically through both representations', () => {
  const arena = createArena(4);
  const state = createFlushSchedule(4);
  const byMask = passes(64);
  const byGraph = passes(64);
  let compared = 0;
  let dropped = 0;
  let discarded = 0;
  for (let seed = 1; seed <= 400; seed += 1) {
    const next = random(seed);
    resetArena(arena);
    const length = 1 + Math.floor(next() * 40);
    for (let i = 0; i < length; i += 1) {
      /* Runs, as a frame has them: a shape usually repeats, so passes hold more than one node. */
      const [reads, writes] = SHAPES[Math.floor(next() * SHAPES.length)] as [number, number];
      const repeat = 1 + Math.floor(next() * 4);
      for (let r = 0; r < repeat; r += 1) recordNode(arena, 1, reads, writes, 0, 0);
    }
    const live = LIVE_SETS[seed % LIVE_SETS.length] as number;
    const clear = CLEARS[seed % CLEARS.length] as number;

    const expected = schedule(arena, clear, live, byMask);
    const actual = scheduleFlush(arena, clear, live, state, byGraph);
    expect(actual, `seed ${seed}: pass count`).toBe(expected);
    for (let p = 0; p < expected; p += 1) {
      expect(byGraph[p], `seed ${seed}: pass ${p}`).toEqual(byMask[p]);
      if ((byMask[p] as ScheduledPass).discard !== 0) discarded += 1;
    }
    dropped += arena.count > 0 && expected === 0 ? 1 : 0;
    compared += 1;
  }
  expect(compared).toBe(400);
  /* The corpus reaches the derivations it is about, rather than agreeing about empty masks. */
  expect(discarded).toBeGreaterThan(100);
  expect(dropped).toBe(0);
});

test('a narrower live set drops a pass in both, and the same one', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, MIRROR, 0, 0);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 1, SCENE, CANVAS, 0, 0);
  const byMask = passes(8);
  const byGraph = passes(8);
  const expected = schedule(arena, SCENE, CANVAS, byMask);
  expect(expected).toBe(2);
  expect(scheduleFlush(arena, SCENE, CANVAS, createFlushSchedule(8), byGraph)).toBe(expected);
  expect(byGraph.slice(0, 2)).toEqual(byMask.slice(0, 2));
});

/*
 * **Where the two differ, and why the renderer never meets it.** The mask scheduler drops a pass
 * whose writes nothing later reads, once; the graph propagates that, so a pass whose only reader
 * was dropped goes too. Every node the renderer records writes something in its live set, so no
 * real flush has a dropped reader to propagate from — but a frame with a narrow live set does.
 */
test('culling is transitive in the graph and is not in the mask, which is the one difference', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, SNAPSHOT, 0, 0);
  recordNode(arena, 1, SNAPSHOT, MIRROR, 0, 0);
  recordNode(arena, 1, 0, CANVAS, 0, 0);
  const byMask = passes(8);
  const byGraph = passes(8);
  expect(schedule(arena, 0, CANVAS, byMask)).toBe(2);
  expect(scheduleFlush(arena, 0, CANVAS, createFlushSchedule(8), byGraph)).toBe(1);
  expect(byGraph[0]?.first).toBe(2);
});

test('a node is recorded with one identifier per bit, reads and writes apart', () => {
  const arena = createArena(4);
  recordNode(arena, 1, maskOf('aoTarget', 'depthSnapshot'), SCENE, 0, 0);
  const state = createFlushSchedule(4);
  scheduleFlush(arena, 0, EVERY, state, passes(4));
  const at = (name: Parameters<typeof maskOf>[0]) => Math.log2(maskOf(name));
  expect(Array.from(readsOf(state.deps, 0))).toEqual([at('aoTarget'), at('depthSnapshot')]);
  expect(Array.from(writesOf(state.deps, 0))).toEqual([at('sceneColor'), at('sceneDepth')]);
});

test('a state carried between flushes forgets the last one', () => {
  const arena = createArena(4);
  const state = createFlushSchedule(4);
  for (let i = 0; i < 6; i += 1) recordNode(arena, 1, 0, SCENE, 0, 0);
  scheduleFlush(arena, SCENE, EVERY, state, passes(8));
  resetArena(arena);
  recordNode(arena, 1, 0, CANVAS, 0, 0);
  const out = passes(8);
  expect(scheduleFlush(arena, SCENE, EVERY, state, out)).toBe(1);
  expect(state.deps.count).toBe(1);
  expect(out[0]).toEqual({ writes: CANVAS, first: 0, count: 1, clear: 0, discard: 0 });
});
