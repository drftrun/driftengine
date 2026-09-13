/**
 * Chunk meshes streamed around the player, and only the ones the frustum keeps.
 *
 * **The hierarchy is the whole reason this class exists in the shape it does.** The reference
 * draws every loaded chunk every frame; here each chunk is a `SceneNode` carrying its meshes'
 * bounds, so `visitVisible` rejects everything behind the camera for one sphere test apiece. At
 * radius 6 that is 169 chunks of which roughly a third are ever in front of you.
 *
 * Meshing runs on the main thread under a per-frame budget, so streaming never stalls a frame.
 * Editing a block rebuilds the touched chunk plus a neighbour only when the edit is on their
 * shared seam — an interior edit cannot change how the chunk next door culls or shades.
 */
import {
  type Camera,
  type MeshHandle,
  type RendererApi,
  type VisitResult,
  SceneNode,
  StepBudget,
} from '../../packages/core/src/index';

import type { BlockAtlas } from './atlas';
import type { RenderMode } from './blocks';
import { ChunkDraw } from './chunkDraw';
import { CHUNK_SX, CHUNK_SZ, chunkKey } from './constants';
import { meshChunk } from './mesher';
import type { World } from './world';

const MODES = ['opaque', 'cutout', 'blend'] as const;

export interface ChunkRendererOptions {
  /** Horizontal render radius, in chunks. */
  radius: number;
  /** How many chunks may be meshed in one `processQueue`. */
  budgetPerFrame?: number;
  /**
   * How many light floods may run in one `processQueue`.
   *
   * Meshing a cold chunk reads light a block past its border, which cascades a flood for it and
   * all eight neighbours. This caps that burst and defers the build a frame instead.
   */
  computeBudgetPerFrame?: number;
  /**
   * How long one `processQueue` may spend building, in milliseconds.
   *
   * **A count is the wrong budget for this, and it is what made walking stutter.** Building one
   * chunk is generation, a light flood and a mesh — measured together at about 30 ms on a desktop
   * — and crossing a single chunk boundary queues the whole new edge of the render ring: sixteen
   * chunks at radius eight, twenty-four at twelve. At three chunks a frame that is ninety
   * milliseconds of blocking work per frame for eight frames, which does not read as a slow
   * frame, it reads as the game hanging.
   *
   * A clock cannot preempt a chunk half-built, so a frame still overruns by whatever the chunk in
   * hand costs. What it does is stop the *next* one starting, which turns a burst into a run of
   * merely slow frames.
   *
   * **Spent through `StepBudget`, which is stricter than the clock this used to read directly.**
   * Reading it directly starts a chunk whenever *any* budget remains, so a frame costs the budget
   * *plus* a whole chunk. The budget keeps an estimate of the worst chunk and refuses to begin one
   * there is no room for, which makes a call cost the larger of the two instead — six plus thirty
   * becomes thirty. Both of this class's existing properties survive: the first chunk is
   * unconditional, and an infinite budget still drains the queue.
   */
  msPerFrame?: number;
}

interface ActiveChunk {
  cx: number;
  cz: number;
  /** One group node per chunk. Its bounds are the union of its meshes', so it prunes as one. */
  node: SceneNode;
  /** A node per render mode, because a node carries one mesh's bounds. */
  parts: { mode: RenderMode; node: SceneNode; mesh: MeshHandle }[];
}

export class ChunkRenderer {
  /** The tree a caller hands to `visitVisible`. Public so a scene can parent it if it wants. */
  readonly root = new SceneNode();

  onChunkActivated: ((cx: number, cz: number) => void) | null = null;

  private readonly renderer: RendererApi;
  private readonly world: World;
  private readonly atlas: BlockAtlas;
  private readonly radius: number;
  private readonly budget: number;
  private readonly computeBudget: number;
  /** See `ChunkRendererOptions.msPerFrame`. */
  private readonly msBudget: number;

  /** How a frame is spent on chunks. See `processQueue`. */
  private readonly steps = new StepBudget<'chunk' | 'already here'>();

  private readonly active = new Map<string, ActiveChunk>();
  private readonly pending: { cx: number; cz: number; dist: number }[] = [];

  private readonly draws: ChunkDraw;

  constructor(
    renderer: RendererApi,
    world: World,
    atlas: BlockAtlas,
    options: ChunkRendererOptions,
  ) {
    this.renderer = renderer;
    this.world = world;
    this.atlas = atlas;
    this.radius = options.radius;
    this.budget = options.budgetPerFrame ?? 2;
    this.computeBudget = options.computeBudgetPerFrame ?? 4;
    this.msBudget = options.msPerFrame ?? 6;
    this.draws = new ChunkDraw(renderer, atlas);
  }

  /** Chunks with live meshes. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Chunks queued and not yet built, which is what a warm-up has left to do. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Decide which chunks should exist around a world position, dropping the rest.
   *
   * `pending` is rebuilt on every call rather than kept, so a chunk the budget did not reach
   * this frame is simply re-queued next frame. A persistent queued set would strand chunks the
   * budget never got to.
   */
  update(centerWx: number, centerWz: number): void {
    const ccx = Math.floor(centerWx / CHUNK_SX);
    const ccz = Math.floor(centerWz / CHUNK_SZ);
    /* One past the render radius, so a chunk at the edge is not dropped and rebuilt every time
       the player steps back and forth across a border. */
    const keep = this.radius + 1;

    for (const [key, chunk] of this.active) {
      if (Math.abs(chunk.cx - ccx) > keep || Math.abs(chunk.cz - ccz) > keep) {
        this.retire(chunk);
        this.active.delete(key);
        this.world.dropChunk(chunk.cx, chunk.cz);
      }
    }

    this.pending.length = 0;
    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        if (this.active.has(chunkKey(cx, cz))) continue;
        this.pending.push({ cx, cz, dist: dx * dx + dz * dz });
      }
    }
    /* Nearest first, so what the player is looking at arrives before what is behind them. */
    this.pending.sort((a, b) => a.dist - b.dist);
  }

  /**
   * Mesh queued chunks until either budget is spent. `Infinity` for both drains it, for a warm-up.
   *
   * **At least one chunk always goes through**, whatever the clock says. A time budget that could
   * refuse every chunk would stall the queue completely on a machine slow enough that one build
   * overruns it, and the world would stop arriving rather than arrive slowly.
   */
  processQueue(
    budget: number = this.budget,
    computeBudget: number = this.computeBudget,
    msBudget: number = this.msBudget,
  ): void {
    this.world.light.beginFrame();
    let done = 0;
    /*
     * The refusal itself is asserted where it lives, in `stepBudget.test.ts`, because proving it
     * here would mean handing this class a clock it has no other use for. What the two tests
     * below guard is that the migration kept the properties this class does own.
     */
    this.steps.spend(msBudget, () => {
      if (done >= budget || this.pending.length === 0) return null;
      const next = this.pending[0]!;
      /* Warm the light neighbourhood first. If the budget runs out, defer the build a frame
         rather than stall on a nine-flood burst. */
      if (!this.world.light.warmFor(next.cx, next.cz, computeBudget)) return null;
      this.pending.shift();
      if (this.active.has(chunkKey(next.cx, next.cz))) return 'already here';
      this.buildChunk(next.cx, next.cz);
      this.onChunkActivated?.(next.cx, next.cz);
      done++;
      return 'chunk';
    });
  }

  /** Draw whatever the frustum keeps. See `ChunkDraw`. */
  draw(camera: Camera): VisitResult {
    return this.draws.draw(this.root, camera);
  }

  /** Rebuild a chunk now. */
  remesh(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    const existing = this.active.get(key);
    if (existing !== undefined) {
      this.retire(existing);
      this.active.delete(key);
    }
    this.buildChunk(cx, cz);
  }

  /** Rebuild a chunk only if it currently has meshes. */
  remeshIfActive(cx: number, cz: number): void {
    if (this.active.has(chunkKey(cx, cz))) this.remesh(cx, cz);
  }

  /**
   * Rebuild what an edit at this world column can have changed.
   *
   * The chunk it landed in always, and a neighbour only when the edit sits on their shared
   * seam. An interior edit cannot change how the chunk next door culls or shades, and
   * rebuilding the whole 3×3 for every block dug is what made the reference hitch.
   */
  remeshEdit(wx: number, wz: number): void {
    const cx = Math.floor(wx / CHUNK_SX);
    const cz = Math.floor(wz / CHUNK_SZ);
    const lx = wx - cx * CHUNK_SX;
    const lz = wz - cz * CHUNK_SZ;
    const nx = lx === 0 ? -1 : lx === CHUNK_SX - 1 ? 1 : 0;
    const nz = lz === 0 ? -1 : lz === CHUNK_SZ - 1 ? 1 : 0;
    this.remeshIfActive(cx, cz);
    if (nx !== 0) this.remeshIfActive(cx + nx, cz);
    if (nz !== 0) this.remeshIfActive(cx, cz + nz);
    if (nx !== 0 && nz !== 0) this.remeshIfActive(cx + nx, cz + nz);
  }

  /** Drop every chunk. The next `update` and `processQueue` rebuild around the player. */
  reset(): void {
    for (const chunk of this.active.values()) this.retire(chunk);
    this.active.clear();
    this.pending.length = 0;
  }

  dispose(): void {
    this.reset();
  }

  private buildChunk(cx: number, cz: number): void {
    const data = meshChunk(this.world, cx, cz, this.atlas, this.world.light);
    const node = new SceneNode();
    node.setPosition(cx * CHUNK_SX, 0, cz * CHUNK_SZ);
    const parts: ActiveChunk['parts'] = [];

    for (const mode of MODES) {
      const geometry = data[mode];
      if (geometry === null) continue;
      const mesh = this.renderer.createMesh(geometry);
      const part = new SceneNode();
      /* The renderer measured these at upload, so the node prunes against the geometry it
         actually holds rather than against the chunk's full 16×96×16 box. */
      part.setBounds(mesh.bounds);
      node.attachChild(part);
      this.draws.register(part, mode, mesh);
      parts.push({ mode, node: part, mesh });
    }

    this.root.attachChild(node);
    /* World matrices and the bounds union are recomputed from the root, which is what makes a
       chunk's group node reject all three of its meshes on one test. */
    this.root.updateWorld();
    this.active.set(chunkKey(cx, cz), { cx, cz, node, parts });
  }

  private retire(chunk: ActiveChunk): void {
    for (const part of chunk.parts) {
      this.draws.forget(part.node);
      chunk.node.detachChild(part.node);
      this.renderer.disposeMesh(part.mesh);
    }
    this.root.detachChild(chunk.node);
  }
}
