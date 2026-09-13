import type { Arena } from './arena.ts';
import { nodeCount, nodeReads, nodeWrites } from './arena.ts';

/**
 * One render pass: a contiguous run of nodes sharing a write-set, and what happens to the
 * attachments at each end of it.
 */
export interface ScheduledPass {
  /** The resources this pass writes. */
  writes: number;
  /** Index of the first node in the run. */
  first: number;
  /** How many nodes the run holds. */
  count: number;
  /** Resources this pass clears rather than loads. */
  clear: number;
  /** Resources safe to discard at the end, because nothing later in the frame reads them. */
  discard: number;
}

/**
 * Group a frame's nodes into passes, and derive what happens to each attachment.
 *
 * **The order is the caller's and is never changed.** Blending and depth make *after*
 * different from *before*, so an immediate-mode API's draw order carries meaning no
 * dependency analysis may override. All this does is group adjacent compatible nodes and work
 * out load and store from the reads that follow.
 *
 * **`liveOut` is what must survive this schedule**, and it is a parameter rather than a
 * constant because the scheduler does not necessarily see the whole frame. During the
 * migration a flush schedules only what has accumulated, so a resource written here may be
 * read after the next flush — invisible from inside this call. The caller knows what is still
 * live; this cannot work it out. The canvas belongs in it always, because nothing ever reads
 * the canvas (it is presented, not sampled) and a purely read-driven rule would conclude it
 * is safe to throw away.
 *
 * Allocates nothing: `out` is supplied by the caller and reused across frames, and the return
 * value says how many of its entries were filled.
 */
export function schedule(
  arena: Arena,
  clearMask: number,
  liveOut: number,
  out: ScheduledPass[],
): number {
  const total = nodeCount(arena);
  if (total === 0) return 0;

  let passes = 0;
  let at = 0;
  let cleared = 0;

  while (at < total) {
    const writes = nodeWrites(arena, at);
    let end = at + 1;
    while (end < total && nodeWrites(arena, end) === writes) end += 1;

    /*
     * Everything read between the end of this pass and the end of the frame. A resource in
     * this set has to survive; one outside it does not, and that is the whole derivation.
     *
     * Recomputed per pass rather than kept as a suffix scan. This runs over tens of passes
     * and hundreds of nodes, where the simple version is free and obviously correct. If a
     * profile ever says otherwise, replace it with a suffix-OR computed once — and put the
     * measurement in the commit, because this is the calculation the discard rests on.
     */
    let readLater = 0;
    for (let i = end; i < total; i += 1) readLater |= nodeReads(arena, i);

    const unread = (writes & readLater) === 0 && (writes & liveOut) === 0;
    if (!unread) {
      const pass = out[passes];
      if (pass === undefined) return passes;
      pass.writes = writes;
      pass.first = at;
      pass.count = end - at;
      pass.clear = clearMask & writes & ~cleared;
      pass.discard = writes & ~readLater & ~liveOut;
      cleared |= writes;
      passes += 1;
    }
    at = end;
  }
  return passes;
}
