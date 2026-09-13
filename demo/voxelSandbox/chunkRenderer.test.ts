import { describe, expect, it } from 'vitest';

import { createBounds } from '../../packages/core/src/index';

import { ChunkRenderer } from './chunkRenderer';
import { World } from './world';
import type { BlockAtlas } from './atlas';

/** Everything `ChunkRenderer` asks of a renderer while it streams. */
const renderer = {
  createMesh: () => ({ bounds: createBounds() }),
  disposeMesh: () => {},
  setMaterial: () => {},
  drawMesh: () => {},
  drawTranslucentMesh: () => {},
} as never;

const atlas: BlockAtlas = {
  texture: null as never,
  rects: new Map(),
  fallback: { u0: 0, v0: 0, u1: 1, v1: 1 },
};

describe('streaming chunks under a frame budget', () => {
  /**
   * **A boundary crossing must not be spent in one frame.**
   *
   * Walking one chunk over queues the whole new edge of the render ring — sixteen chunks at
   * radius eight, twenty-four at twelve — and a chunk costs generation, a light flood and a mesh,
   * measured together at about 30 ms. A budget counted in chunks therefore spends 90 ms of
   * blocking work per frame until the queue drains, which does not read as a slow frame but as
   * the game hanging every few seconds, which is what a real session reported.
   *
   * The clock cannot preempt a chunk half-built, so one always overruns; what it must do is stop
   * the *next* one starting.
   */
  it('stops starting chunks once the millisecond budget is spent', () => {
    const chunks = new ChunkRenderer(renderer, new World(1337), atlas, {
      radius: 6,
      budgetPerFrame: 64,
      computeBudgetPerFrame: 64,
      /* Zero, so the budget is spent the moment the first chunk finishes. */
      msPerFrame: 0,
    });
    chunks.update(0, 0);
    chunks.processQueue();

    expect(chunks.activeCount, 'the clock refused every chunk, so nothing would ever arrive').toBe(
      1,
    );
  });

  it('drains the queue when the caller asks for no limit at all', () => {
    const chunks = new ChunkRenderer(renderer, new World(1337), atlas, {
      radius: 2,
      budgetPerFrame: 1,
      msPerFrame: 0,
    });
    chunks.update(0, 0);
    chunks.processQueue(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );

    /* The warm-up runs before the first frame, so it has no frame to protect. */
    expect(chunks.activeCount).toBeGreaterThan(1);
  });
});
