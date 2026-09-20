/**
 * Grouping and culling for a frame whose composition is not fixed.
 *
 * **`schedule.ts` is not replaced.** It schedules the forward path, where the composition is
 * fixed and a mask is exactly right, and it stays. This is its counterpart for the other path,
 * and the two differences are the whole reason it exists.
 *
 * **Culling is transitive here and is not there.** The mask scheduler drops a pass whose writes
 * nothing later reads. Once it has, the pass whose only reader was the dropped one has become
 * dead too — and a single backward scan over masks never revisits it. A GPU-driven frame makes
 * that ordinary rather than exotic, because turning off one quality flag kills a consumer
 * several passes downstream. So liveness is propagated backwards to a fixed point first, and
 * grouping runs over what survives.
 *
 * **Some nodes may be reordered and most may not.** A node marked ordered carries meaning in its
 * position — blending and depth make *after* different from *before*, which is the rule
 * `schedule.ts` states and this does not weaken. An unordered node is a compute dispatch whose
 * result depends only on its declared reads, and two adjacent ones may merge whatever they write.
 */
import type { Deps } from './deps.ts';
import { readsOf, writesOf } from './deps.ts';

export interface GraphPass {
  /** Index of the first node in the run. */
  first: number;
  /** How many nodes the run holds. */
  count: number;
  /** Whether this pass's position carries meaning. */
  ordered: boolean;
}

export function createGraphPasses(capacity: number): GraphPass[] {
  return Array.from({ length: capacity }, () => ({ first: 0, count: 0, ordered: true }));
}

/**
 * What a schedule works in, owned by the caller so a flush allocates nothing.
 *
 * `keep` is a flag a node and `wanted` a flag an identifier. Both are cleared at the start of every
 * call, so a scratch carried from one frame to the next answers exactly as a fresh one would.
 */
export interface GraphScratch {
  keep: Uint8Array;
  wanted: Uint8Array;
}

export function createGraphScratch(nodes: number, identifiers: number): GraphScratch {
  return {
    keep: new Uint8Array(Math.max(1, nodes)),
    wanted: new Uint8Array(Math.max(1, identifiers)),
  };
}

/*
 * Make the scratch big enough for this frame, which is the one place it may allocate.
 *
 * A frame that outgrows it has to be scheduled somehow, and growing here once is what the arena
 * does too; the scratch the caller keeps is then large enough for every frame like it. Doubled, so
 * a frame that grows by one node at a time does not reallocate every frame.
 */
function fitScratch(scratch: GraphScratch, deps: Deps, count: number): void {
  if (scratch.keep.length < count) {
    scratch.keep = new Uint8Array(Math.max(count, scratch.keep.length * 2));
  }
  let ceiling = 0;
  for (let i = 0; i < deps.used; i += 1) ceiling = Math.max(ceiling, (deps.edges[i] ?? 0) + 1);
  if (scratch.wanted.length < ceiling) {
    scratch.wanted = new Uint8Array(Math.max(ceiling, scratch.wanted.length * 2));
  }
}

/*
 * Mark every node that contributes to something in `live`, to a fixed point.
 *
 * Backwards, because a node is needed exactly when something after it reads what it writes. One
 * backward sweep suffices for a chain; the outer repeat covers a node that writes a resource
 * read by an earlier-indexed node, which cannot happen in a well-formed frame but costs one
 * comparison to be safe about rather than one silently wrong picture to discover.
 *
 * `fitScratch` sized both flags for everything recorded, and this relies on it: a keep flag past
 * the end of `keep` would read 0 after being set, and the sweep would never settle.
 */
function markLive(
  deps: Deps,
  count: number,
  live: ArrayLike<number>,
  liveCount: number,
  scratch: GraphScratch,
): void {
  const { keep, wanted } = scratch;
  keep.fill(0, 0, count);
  wanted.fill(0);
  /* A live identifier past the end is one no node writes, and a typed array ignores the write. */
  for (let i = 0; i < liveCount; i += 1) wanted[live[i] ?? -1] = 1;
  let changed = true;
  while (changed) {
    changed = false;
    for (let node = count - 1; node >= 0; node -= 1) {
      if (keep[node] === 1) continue;
      const writes = writesOf(deps, node);
      let needed = false;
      for (let i = 0; i < writes.length; i += 1) {
        if (wanted[writes[i] ?? 0] === 1) {
          needed = true;
          break;
        }
      }
      if (!needed) continue;
      keep[node] = 1;
      changed = true;
      const reads = readsOf(deps, node);
      for (let i = 0; i < reads.length; i += 1) wanted[reads[i] ?? 0] = 1;
    }
  }
}

function sameWrites(deps: Deps, a: number, b: number): boolean {
  const left = writesOf(deps, a);
  const right = writesOf(deps, b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

/**
 * Group the live nodes of a frame into passes, and answer how many of `out` were filled.
 *
 * `live` is what must survive the frame, and only its first `liveCount` entries are read — so a
 * caller can keep one typed array and a count rather than build a list. `scratch` is the working
 * set; a caller that passes none gets one made for the call, which is what a test wants and what a
 * frame must not do.
 */
export function scheduleGraph(
  deps: Deps,
  count: number,
  live: ArrayLike<number>,
  ordered: Uint8Array,
  out: GraphPass[],
  scratch: GraphScratch = createGraphScratch(count, 1),
  liveCount: number = live.length,
): number {
  fitScratch(scratch, deps, count);
  markLive(deps, count, live, liveCount, scratch);
  const keep = scratch.keep;

  let passes = 0;
  let at = 0;
  while (at < count) {
    if (keep[at] === 0) {
      at += 1;
      continue;
    }
    const isOrdered = ordered[at] === 1;
    let end = at + 1;
    while (end < count && keep[end] === 1) {
      const nextOrdered = ordered[end] === 1;
      if (isOrdered !== nextOrdered) break;
      if (isOrdered && !sameWrites(deps, at, end)) break;
      end += 1;
    }
    const pass = out[passes];
    if (pass === undefined) return passes;
    pass.first = at;
    pass.count = end - at;
    pass.ordered = isOrdered;
    passes += 1;
    at = end;
  }
  return passes;
}
