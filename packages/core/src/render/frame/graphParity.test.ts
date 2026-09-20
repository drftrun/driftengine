import { expect, test } from 'vitest';
import { createArena, recordNode } from './arena.ts';
import { createDeps, recordDeps } from './deps.ts';
import { createGraphPasses, scheduleGraph } from './graphSchedule.ts';
import { maskOf } from './resources.ts';
import { schedule } from './schedule.ts';
import type { ScheduledPass } from './schedule.ts';

/*
 * The two schedulers must agree on a frame both can express.
 *
 * This is the assertion that keeps the second representation honest. A fixed-composition frame
 * recorded both ways has to group into the same passes covering the same nodes — if it does not,
 * the graph is not a generalisation of the table, it is a different renderer, and the six
 * published scenes would say so in pixels rather than in a message.
 */
function masked(): ScheduledPass[] {
  return Array.from({ length: 32 }, () => ({
    writes: 0,
    first: 0,
    count: 0,
    clear: 0,
    discard: 0,
  }));
}

test('a fixed-composition frame groups identically through both schedulers', () => {
  const SCENE = maskOf('sceneColor', 'sceneDepth');
  const CANVAS = maskOf('canvas');

  const arena = createArena(8);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 1, SCENE, CANVAS, 0, 0);
  const maskPasses = masked();
  const maskCount = schedule(arena, 0, CANVAS, maskPasses);

  const SCENE_ID = 0;
  const CANVAS_ID = 1;
  const deps = createDeps(8, 32);
  recordDeps(deps, [], [SCENE_ID]);
  recordDeps(deps, [], [SCENE_ID]);
  recordDeps(deps, [SCENE_ID], [CANVAS_ID]);
  const graphPasses = createGraphPasses(32);
  const graphCount = scheduleGraph(deps, 3, [CANVAS_ID], new Uint8Array(3).fill(1), graphPasses);

  expect(graphCount).toBe(maskCount);
  expect(graphPasses[0]?.first).toBe(maskPasses[0]?.first);
  expect(graphPasses[0]?.count).toBe(maskPasses[0]?.count);
  expect(graphPasses[1]?.first).toBe(maskPasses[1]?.first);
  expect(graphPasses[1]?.count).toBe(maskPasses[1]?.count);
});

test('both schedulers drop the same unread pass', () => {
  const SCENE = maskOf('sceneColor');
  const MIRROR = maskOf('mirrorColor');
  const CANVAS = maskOf('canvas');

  const arena = createArena(8);
  recordNode(arena, 1, 0, MIRROR, 0, 0);
  recordNode(arena, 1, 0, SCENE, 0, 0);
  recordNode(arena, 1, SCENE, CANVAS, 0, 0);
  const maskPasses = masked();
  const maskCount = schedule(arena, 0, CANVAS, maskPasses);

  const deps = createDeps(8, 32);
  recordDeps(deps, [], [2]);
  recordDeps(deps, [], [0]);
  recordDeps(deps, [0], [1]);
  const graphPasses = createGraphPasses(32);
  const graphCount = scheduleGraph(deps, 3, [1], new Uint8Array(3).fill(1), graphPasses);

  expect(graphCount).toBe(maskCount);
  expect(graphPasses[0]?.first).toBe(maskPasses[0]?.first);
});
