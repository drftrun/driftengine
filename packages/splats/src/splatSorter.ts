/** The scheduler: one sort in flight, newest view wins, and the worker is a default not a mechanism. */

import { createSplatSortScratch, sortSplatsByDepth } from './splatSort.ts';
import { createSplatSortWorker } from './splatSortWorker.ts';
import type {
  SplatSortFn,
  SplatSortRequest,
  SplatSortResult,
  SplatSortScratch,
} from './splatSort.ts';
import type { SplatData } from './splatData.ts';
import type { SplatViewLocal } from './splatView.ts';

/**
 * How far the view may turn before the order is worth recomputing.
 *
 * A dot product, so 0.999 is about 2.6 degrees. Below that the change in ordering is a handful of
 * adjacent swaps among splats that overlap anyway, and re-sorting for it would mean a sort every
 * frame at any camera speed — which is the cost this whole arrangement exists to avoid. **A still
 * camera sorts zero times a second**, which is the property to preserve.
 */
const RESORT_DOT = 0.999;

/**
 * How far the camera may move, as a fraction of the capture's own radius, before a re-sort.
 *
 * **A fraction rather than a distance, because a distance means different things for a room and
 * for a landscape.** Only consulted when there is a budget: see `frame`.
 */
const RESORT_MOVE_FRACTION = 0.1;

export interface SplatSorterOptions {
  /** The capture. Its positions, extents and bounds are all read; its packed texels are not. */
  readonly splats: SplatData;
  /** Defaults to a `Blob` worker, falling back to the main thread. See `createDefaultSplatSort`. */
  readonly sort?: SplatSortFn;
  /**
   * The most splats to draw. Zero, or anything at or above the capture's count, draws all of them.
   *
   * `defaultSplatBudget` is what a consumer that has no number of its own should pass.
   */
  readonly budget?: number;
  /** Overrides `RESORT_MOVE_FRACTION`. Only consulted when there is a budget. */
  readonly moveFraction?: number;
  /**
   * How many of the capture's splats have actually arrived. Defaults to all of them.
   *
   * **A capability rather than a number, because it changes while a capture streams.** A
   * `SplatCapture` is allocated at its final count and filled block by block, so its unarrived
   * tail is zeroed — every phantom splat sitting at the origin with no size. Sorting those would
   * order a cloud of them into the middle of the capture and draw them, which reads as a corrupt
   * file rather than as a load in progress. Pass `() => capture.ready` and this follows the load.
   */
  readonly ready?: () => number;
}

/**
 * The sort, on the main thread, right now.
 *
 * The fallback when a worker cannot be built, and the implementation a test injects. Synchronous
 * inside a promise: there is nothing to await, and pretending otherwise would hide that this
 * blocks.
 *
 * **The scratch is cached across calls and grown when it has to be.** It is 384 KB of histogram
 * plus four bytes a splat, and allocating that per sort would make the fallback path generate more
 * garbage than the work it is doing. Sharing one scratch between two captures is safe because this
 * is synchronous: no second sort can start while one is running on this thread.
 */
let mainThreadScratch: SplatSortScratch | null = null;

export function sortOnMainThread(request: SplatSortRequest): Promise<SplatSortResult> {
  if (mainThreadScratch === null || mainThreadScratch.keys.length < request.count) {
    mainThreadScratch = createSplatSortScratch(request.count);
  }
  const count = sortSplatsByDepth(request, mainThreadScratch);
  return Promise.resolve({ order: request.out, count });
}

/**
 * The shipped capability: a worker over the same sort this module runs on the main thread.
 *
 * `sortSplatsByDepth.toString()` is what goes into the worker, so there is one implementation of
 * the decision and not two — the 2026-08-17 rule, which is about exactly this. It works because
 * that function closes over nothing: its scratch and its two bucket counts all arrive as
 * arguments.
 */
export function createDefaultSplatSort(): SplatSortFn {
  return createSplatSortWorker(sortSplatsByDepth.toString());
}

/**
 * Hold the newest order, ask for a new one when the view has changed enough, and never queue.
 *
 * **At most one sort in flight, and a request while one is running is dropped rather than
 * queued.** The newest view is the only one worth sorting for: a queue would sort for a camera
 * position the player has already left, and then sort again, so it converts a busy moment into a
 * backlog that never catches up.
 *
 * **Two buffers, ping-ponged.** One is being filled by the sorter and the other is what the pass
 * draws from, so a sort landing mid-frame never rewrites the order under a draw call.
 */
export class SplatSorter {
  private readonly splats: SplatData;
  private readonly sort: SplatSortFn;
  private readonly budget: number;
  private readonly moveFraction: number;
  private readonly ready: () => number;
  /** How many splats the standing order was computed over, so an arrival is a reason to re-sort. */
  private sortedReady = 0;
  /** Half the diagonal of the capture's own bounds. The scale the move gate is a fraction of. */
  private readonly radius: number;
  private readonly buffers: [Uint32Array, Uint32Array];
  /** Which buffer the sorter owns. The other is the one a caller may read. */
  private filling = 0;
  private inFlight = false;
  /** The view the standing order was computed for. Meaningless until `hasSorted`. */
  private sortedDirX = 0;
  private sortedDirY = 0;
  private sortedDirZ = 0;
  private sortedOriginX = 0;
  private sortedOriginY = 0;
  private sortedOriginZ = 0;
  private hasSorted = false;
  /** How many indices the standing order actually holds, which a budget makes smaller. */
  private kept = 0;
  /** Bumped by every sort that lands, so a caller can tell a new order from the one it has. */
  private generation = 0;

  constructor(options: SplatSorterOptions) {
    this.splats = options.splats;
    /*
     * The worker is the default and the main thread is the fallback, and neither is the mechanism:
     * a caller that supplies its own never reaches either. Built once per sorter rather than once
     * per module, so two captures do not share one worker and serialise behind each other.
     */
    this.sort = options.sort ?? createDefaultSplatSort();
    this.budget = options.budget ?? 0;
    this.moveFraction = options.moveFraction ?? RESORT_MOVE_FRACTION;
    this.ready = options.ready ?? ((): number => options.splats.count);
    const { boundsMin, boundsMax } = options.splats;
    this.radius =
      0.5 *
      Math.hypot(
        (boundsMax[0] ?? 0) - (boundsMin[0] ?? 0),
        (boundsMax[1] ?? 0) - (boundsMin[1] ?? 0),
        (boundsMax[2] ?? 0) - (boundsMin[2] ?? 0),
      );
    const size = Math.max(1, options.splats.count);
    this.buffers = [new Uint32Array(size), new Uint32Array(size)];
  }

  /** The standing order, or null until the first sort lands. */
  get order(): Uint32Array | null {
    return this.hasSorted ? (this.buffers[1 - this.filling] as Uint32Array) : null;
  }

  /** How many entries of `order` are real. Below the capture's count when a budget bit. */
  get drawCount(): number {
    return this.kept;
  }

  /** How many orders have landed. A caller uploads when this changes and not otherwise. */
  get version(): number {
    return this.generation;
  }

  /**
   * Whether a sort is in flight.
   *
   * **What a measuring page waits on, and it has to wait on more than `version`.** With a budget
   * the sort chooses *which* splats are drawn and not merely their order, so a capture
   * photographed at the first landed sort is a capture photographed at whichever sort the worker
   * happened to finish — and two backends that reach the held frame at different wall-clock times
   * then draw different splats. A held camera is settled when this is false and the standing
   * `version` has been uploaded: at a fixed direction `frame` asks for nothing further, so that
   * state is reached and then keeps.
   */
  get sorting(): boolean {
    return this.inFlight;
  }

  /**
   * Offer the current view, in the capture's own space. Starts a sort if one is wanted.
   *
   * `resolveSplatView` is what turns a camera and a model matrix into this. `force` is for the
   * first frame and for a capture whose transform moved, where the view in its own space may be
   * unchanged and the order is stale anyway.
   *
   * **Turning always matters; moving only matters when there is a budget.** Depth is measured
   * along the view axis, so translating the camera shifts every splat's depth by the same amount
   * and leaves the ordering exactly as it was — which is why this gate did not exist until a
   * budget did. A budget keeps the splats largest on screen, which is the extent over the
   * *distance*, so a camera that walks across a capture without turning changes which splats are
   * drawn. What that costs is a sort every tenth of a capture-radius while a viewer moves; what
   * would make it wrong is a budget so generous that nothing is ever dropped, where the gate spends
   * sorts to reach the same answer.
   */
  frame(local: SplatViewLocal, force = false): void {
    const count = Math.max(0, Math.min(this.ready(), this.splats.count));
    if (count <= 0) return;
    if (this.inFlight) return;

    /*
     * **An arrival is a reason to sort even from a camera that has not moved.** The order this
     * sorter holds is an order over fewer splats than the capture now has, so it is not the order
     * it wants — and a viewer watching a capture load is exactly the viewer who is standing
     * still. Without this a stream stops densifying the moment nobody moves.
     */
    let wanted = force || !this.hasSorted || count !== this.sortedReady;
    if (!wanted) {
      const turned =
        local.dirX * this.sortedDirX + local.dirY * this.sortedDirY + local.dirZ * this.sortedDirZ <
        RESORT_DOT;
      wanted = turned;
    }
    if (!wanted && this.budget > 0 && this.budget < count && this.radius > 0) {
      const moved = Math.hypot(
        local.originX - this.sortedOriginX,
        local.originY - this.sortedOriginY,
        local.originZ - this.sortedOriginZ,
      );
      wanted = moved > this.moveFraction * this.radius;
    }
    if (!wanted) return;

    this.inFlight = true;
    const target = this.buffers[this.filling] as Uint32Array;
    /*
     * Snapshotted before the call, because `local` belongs to the caller and is rewritten in place
     * every frame — so reading it again when the promise settles would record the view the camera
     * has *now* as the one this order was computed for, and the re-sort gates would then compare
     * against a lie. Six numbers on the stack rather than a copy of the object, so nothing is
     * allocated for it.
     */
    const dirX = local.dirX;
    const dirY = local.dirY;
    const dirZ = local.dirZ;
    const originX = local.originX;
    const originY = local.originY;
    const originZ = local.originZ;
    void this.sort({
      positions: this.splats.positions,
      extents: this.splats.extents,
      count,
      dirX,
      dirY,
      dirZ,
      originX,
      originY,
      originZ,
      budget: this.budget,
      out: target,
    })
      .then((result) => {
        /*
         * The buffer that comes back is the one that was handed out — a worker transfers it away
         * and transfers it back, so the array identity may differ even though the storage is the
         * same. Store what arrived rather than what was sent.
         */
        this.buffers[this.filling] = result.order;
        this.filling = 1 - this.filling;
        this.sortedDirX = dirX;
        this.sortedDirY = dirY;
        this.sortedDirZ = dirZ;
        this.sortedOriginX = originX;
        this.sortedOriginY = originY;
        this.sortedOriginZ = originZ;
        this.kept = result.count;
        this.sortedReady = count;
        this.hasSorted = true;
        this.generation++;
      })
      .catch(() => {
        /*
         * **A rejected sort leaves the previous order drawing**, which is the honest degradation:
         * a capture one camera step out of order is very slightly wrong at some silhouettes, and a
         * capture with no order at all is not drawn. Swallowed rather than rethrown because this
         * is reached from a frame and the loop may not throw.
         */
      })
      .finally(() => {
        this.inFlight = false;
      });
  }
}
