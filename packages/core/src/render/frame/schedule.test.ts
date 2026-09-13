import { expect, test } from 'vitest';
import { createArena, recordNode } from './arena.ts';
import { maskOf } from './resources.ts';
import { schedule } from './schedule.ts';
import type { ScheduledPass } from './schedule.ts';

const COLOR = maskOf('sceneColor');
const DEPTH = maskOf('sceneDepth');
const SCENE = COLOR | DEPTH;
const CANVAS = maskOf('canvas');
const MIRROR = maskOf('mirrorColor', 'mirrorDepth');

function out(): ScheduledPass[] {
  return Array.from({ length: 32 }, () => ({
    writes: 0,
    first: 0,
    count: 0,
    clear: 0,
    discard: 0,
  }));
}

test('adjacent nodes writing the same target collapse into one pass', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  const passes = out();
  expect(schedule(arena, 0, SCENE, passes)).toBe(1);
  expect(passes[0]?.count).toBe(3);
});

test('a differing write-set forces a boundary', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 2, 0, MIRROR, 0, 0);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  const passes = out();
  expect(schedule(arena, 0, SCENE | MIRROR, passes)).toBe(3);
});

/**
 * The assertion the whole design exists for.
 *
 * Today `terminal` is a boolean a person hands to `resolvedStoreOp`, and getting it wrong
 * renders perfectly on every machine available here and returns garbage on a tiler. Derived
 * from declared reads it is a computed fact instead of a judgement.
 */
test('a resource nothing later reads is safe to discard, while its neighbour is stored', () => {
  const arena = createArena(8);
  // The scene pass writes colour and depth; the composite reads only the colour.
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 2, COLOR, CANVAS, 0, 0);
  const passes = out();
  schedule(arena, 0, CANVAS, passes);

  expect((passes[0]?.discard ?? 0) & DEPTH).toBe(DEPTH);
  expect((passes[0]?.discard ?? 0) & COLOR).toBe(0);
});

test('a resource something later reads must be stored', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, MIRROR, 0, 0);
  recordNode(arena, 2, MIRROR, SCENE, 0, 0);
  const passes = out();
  schedule(arena, 0, SCENE, passes);
  expect((passes[0]?.discard ?? 0) & MIRROR).toBe(0);
});

test('a pass whose writes nothing reads and which is not presented is dropped', () => {
  const arena = createArena(8);
  recordNode(arena, 9, 0, maskOf('cascade0'), 0, 0);
  recordNode(arena, 1, 0, CANVAS, 0, 0);
  const passes = out();
  const n = schedule(arena, 0, CANVAS, passes);
  expect(n).toBe(1);
  expect(passes[0]?.writes).toBe(CANVAS);
});

test('the canvas is never discarded, because it is the thing a person looks at', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, CANVAS, 0, 0);
  const passes = out();
  schedule(arena, 0, CANVAS, passes);
  expect((passes[0]?.discard ?? 0) & CANVAS).toBe(0);
});

test('only the first write of a resource clears it', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 2, 0, MIRROR, 0, 0);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  const passes = out();
  schedule(arena, SCENE, SCENE | MIRROR, passes);
  expect(passes[0]?.clear).toBe(SCENE);
  expect(passes[2]?.clear).toBe(0);
});

test('an empty arena schedules nothing', () => {
  expect(schedule(createArena(4), 0, CANVAS, out())).toBe(0);
});

test('scheduling twice reuses the caller-supplied array and allocates nothing', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 2, SCENE, CANVAS, 0, 0);
  const passes = out();
  const first = passes[0];
  expect(schedule(arena, 0, CANVAS, passes)).toBe(2);
  expect(schedule(arena, 0, CANVAS, passes)).toBe(2);
  expect(passes[0]).toBe(first);
});

/**
 * The case the first run of these tests exposed.
 *
 * A flush schedules only what has accumulated, so a resource written now may be read after
 * the next flush — which this call cannot see. Told it is live, the scheduler must keep it;
 * told it is not, it may drop the pass entirely. Getting this wrong during the migration
 * would throw away a scene target between two flushes and nothing would say so.
 */
test('a resource live beyond this schedule is neither dropped nor discarded', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  const passes = out();

  expect(schedule(arena, 0, 0, passes)).toBe(0);

  expect(schedule(arena, 0, SCENE, passes)).toBe(1);
  expect((passes[0]?.discard ?? 0) & SCENE).toBe(0);
});

const VERB_SCOPE = 2;

/**
 * A reopen that loads is a read, and that is what keeps an attachment stored.
 *
 * The mirror ends the frame's pass and `endPlanarReflection` reopens it with `loadOp: 'load'`,
 * so the frame's colour has to survive the mirror. Recorded as a scope node reading it, the
 * scheduler derives that without being told.
 */
test('a scope node that loads a target keeps it stored', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, VERB_SCOPE, 0, MIRROR, 0, 0);
  recordNode(arena, VERB_SCOPE, COLOR, SCENE, 0, 0);
  const passes = out();
  schedule(arena, 0, CANVAS, passes);

  expect((passes[0]?.discard ?? 0) & COLOR).toBe(0);
});

/**
 * And the case that pays: nothing ever loads the frame's depth back, so it is stored every
 * frame for nothing. A scope node that reopens reading only the colour says so.
 */
test('depth is discardable even when colour is not', () => {
  const arena = createArena(8);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, VERB_SCOPE, 0, MIRROR, 0, 0);
  recordNode(arena, VERB_SCOPE, COLOR, SCENE, 0, 0);
  const passes = out();
  schedule(arena, 0, CANVAS, passes);

  expect((passes[0]?.discard ?? 0) & DEPTH).toBe(DEPTH);
});
