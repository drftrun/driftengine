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
  pixels: new Uint8ClampedArray(4),
  width: 1,
  height: 1,
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

describe('streaming chunks into the second pipeline', () => {
  /**
   * **The sandbox's port builds the same chunks and hands them somewhere else.** Generation, the
   * light flood, the mesher and the budget are this class's and do not change; what changes is
   * where a chunk's three meshes go — to `createMesh` and a scene node, or to the GPU-driven
   * pipeline's streaming scene, which culls them itself.
   */
  it('HANDS A BUILT CHUNK TO THE SINK AND UPLOADS NOTHING ITSELF', () => {
    let uploads = 0;
    const counting = {
      createMesh: () => ((uploads += 1), { bounds: createBounds() }),
      disposeMesh: () => {},
      height: 1,
    } as never;
    const added: string[] = [];
    const removed: string[] = [];
    const sink = {
      add: (cx: number, cz: number) => (added.push(`${cx},${cz}`), true),
      remove: (cx: number, cz: number) => void removed.push(`${cx},${cz}`),
    };
    const chunks = new ChunkRenderer(counting, new World(1337), atlas, { radius: 1, sink });
    chunks.update(0, 0);
    chunks.processQueue(Infinity, Infinity, Infinity);
    expect(uploads).toBe(0);
    expect(added.length).toBe(9);
    expect(chunks.activeCount).toBe(9);
    /* Nothing in the tree either: the frustum visit is the pipeline's now. */
    expect(chunks.root.children.length).toBe(0);

    /* An edit rebuilds: the chunk is let go and added again. */
    chunks.remesh(0, 0);
    expect(added.filter((key) => key === '0,0').length).toBe(2);
    expect(removed).toEqual(['0,0']);

    /* Walking away retires every chunk that falls outside the keep ring. */
    chunks.update(16 * 10, 0);
    expect(new Set(removed.slice(1)).size).toBe(9);
    expect(uploads).toBe(0);
  });
});
