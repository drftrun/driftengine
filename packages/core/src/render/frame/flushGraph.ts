/**
 * A forward flush, scheduled by the identifier graph instead of by masks.
 *
 * **Wave 1A's exit criterion is that both pipelines are expressible in one graph and today's frames
 * are pixel-identical through it.** The second pipeline records its stages into a `Deps` table
 * (`gpudriven/pipeline.ts`); this is the forward renderer's half. A flush's arena is recorded as
 * identifier nodes — bit `n` of a mask is identifier `n` — scheduled by `scheduleGraph`, and the
 * load and store each attachment gets are derived from `lifetime.ts`. What comes out is the same
 * `ScheduledPass` the mask scheduler writes, so the executor reading it does not know which ran.
 *
 * **One difference, and the renderer never reaches it.** Culling here is transitive: a pass whose
 * only reader was dropped is dropped too, where `schedule.ts` keeps it. Every node the renderer
 * records writes something its live set holds, so no flush it makes has a dropped reader —
 * `flushGraph.test.ts` holds a random corpus of its own shapes to exact agreement and names the
 * frame where the two part.
 *
 * Allocates nothing once warm. The state is the caller's and grows only when a flush outgrows it,
 * the way the arena does.
 */
import type { Arena } from './arena.ts';
import { nodeCount, nodeReads, nodeWrites } from './arena.ts';
import type { Deps } from './deps.ts';
import { createDeps, recordMaskDeps, resetDeps } from './deps.ts';
import type { GraphPass, GraphScratch } from './graphSchedule.ts';
import { createGraphPasses, createGraphScratch, scheduleGraph } from './graphSchedule.ts';
import type { Lifetimes } from './lifetime.ts';
import { computeLifetimes, createLifetimes, lastRead } from './lifetime.ts';
import { RESOURCE_COUNT } from './resources.ts';
import type { ScheduledPass } from './schedule.ts';

export interface FlushSchedule {
  deps: Deps;
  scratch: GraphScratch;
  passes: GraphPass[];
  lifetimes: Lifetimes;
  /** Every node ordered: a forward draw's position is its meaning. Grown with the arena. */
  ordered: Uint8Array;
  /** The live identifiers of this flush, and how many of them there are. */
  live: Int32Array;
  liveCount: number;
}

export function createFlushSchedule(capacity: number): FlushSchedule {
  const nodes = Math.max(1, capacity);
  return {
    deps: createDeps(nodes, nodes * 4),
    scratch: createGraphScratch(nodes, RESOURCE_COUNT),
    passes: createGraphPasses(nodes),
    lifetimes: createLifetimes(RESOURCE_COUNT),
    ordered: new Uint8Array(nodes).fill(1),
    live: new Int32Array(RESOURCE_COUNT),
    liveCount: 0,
  };
}

/* Grown where allocation is allowed: a flush larger than any before it, once. */
function fit(state: FlushSchedule, nodes: number): void {
  if (state.ordered.length < nodes) {
    const size = Math.max(nodes, state.ordered.length * 2);
    state.ordered = new Uint8Array(size).fill(1);
    while (state.passes.length < size) state.passes.push({ first: 0, count: 0, ordered: true });
  }
}

/**
 * Schedule an arena's nodes through the identifier graph, into the mask scheduler's records.
 *
 * `clearMask` and `liveOut` mean what they mean to `schedule`: what this flush still owes a clear,
 * and what must survive it. Returns how many of `out` were filled.
 */
export function scheduleFlush(
  arena: Arena,
  clearMask: number,
  liveOut: number,
  state: FlushSchedule,
  out: ScheduledPass[],
): number {
  const total = nodeCount(arena);
  if (total === 0) return 0;
  fit(state, total);

  const deps = state.deps;
  resetDeps(deps);
  for (let node = 0; node < total; node += 1) {
    recordMaskDeps(deps, nodeReads(arena, node), nodeWrites(arena, node));
  }

  state.liveCount = 0;
  for (let bit = 0; bit < RESOURCE_COUNT; bit += 1) {
    if ((liveOut & (1 << bit)) === 0) continue;
    state.live[state.liveCount] = bit;
    state.liveCount += 1;
  }

  const scheduled = scheduleGraph(
    deps,
    total,
    state.live,
    state.ordered,
    state.passes,
    state.scratch,
    state.liveCount,
  );
  computeLifetimes(deps, total, state.lifetimes);

  let filled = 0;
  let cleared = 0;
  for (let p = 0; p < scheduled; p += 1) {
    const pass = state.passes[p] as GraphPass;
    const record = out[filled];
    if (record === undefined) return filled;
    /* An ordered run shares one write set, so its first node's mask is the run's. */
    const writes = nodeWrites(arena, pass.first);
    const end = pass.first + pass.count;
    /*
     * Discardable where nothing at or after the run's end reads it and nothing outside the flush
     * does either. `lastRead` is the last reader anywhere in the flush, culled or not, which is the
     * mask scheduler's rule: a dropped pass's read still happened as far as a store op knows.
     */
    let discard = 0;
    for (let bit = 0; bit < RESOURCE_COUNT; bit += 1) {
      const mask = 1 << bit;
      if ((writes & mask) === 0 || (liveOut & mask) !== 0) continue;
      if (lastRead(state.lifetimes, bit) < end) discard |= mask;
    }
    record.writes = writes;
    record.first = pass.first;
    record.count = pass.count;
    record.clear = clearMask & writes & ~cleared;
    record.discard = discard;
    cleared |= writes;
    filled += 1;
  }
  return filled;
}
