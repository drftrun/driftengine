/**
 * When each transient resource is first written and last read.
 *
 * Two numbers per identifier and one pass over the nodes, which is all the aliasing allocator
 * needs and is deliberately less than a general dependency graph would compute. There is no
 * topological sort here because there is no reordering here: the node order is the caller's,
 * exactly as `schedule.ts` requires for the fixed path and for the same reason — blending and
 * depth make *after* different from *before*.
 *
 * **A resource written and never read still has a lifetime**, ending at the node that writes
 * it. It has to: memory it is being written into cannot be handed to something else at the same
 * moment. Reporting an empty lifetime there is the bug this module's third test exists to catch.
 */
import type { Deps } from './deps.ts';
import { readsOf, writesOf } from './deps.ts';

export interface Lifetimes {
  /** Node index of the first write per identifier, or -1. */
  first: Int32Array;
  /** Node index of the last read per identifier, or the first write when nothing reads it. */
  last: Int32Array;
}

export function createLifetimes(capacity: number): Lifetimes {
  return { first: new Int32Array(capacity), last: new Int32Array(capacity) };
}

export function computeLifetimes(deps: Deps, count: number, out: Lifetimes): void {
  out.first.fill(-1);
  out.last.fill(-1);

  for (let node = 0; node < count; node += 1) {
    const writes = writesOf(deps, node);
    for (let i = 0; i < writes.length; i += 1) {
      const id = writes[i] ?? 0;
      if (out.first[id] === -1) {
        out.first[id] = node;
        out.last[id] = node;
      }
    }
    /*
     * Reads are folded in after this node's writes, so a node that reads and writes the same
     * identifier extends the lifetime rather than starting a second one. A read of something
     * nothing has written is ignored here and refused by `validate.ts`, which is where a
     * malformed frame belongs.
     */
    const reads = readsOf(deps, node);
    for (let i = 0; i < reads.length; i += 1) {
      const id = reads[i] ?? 0;
      if (out.first[id] !== -1) out.last[id] = node;
    }
  }
}

export function firstWrite(out: Lifetimes, id: number): number {
  return out.first[id] ?? -1;
}

export function lastRead(out: Lifetimes, id: number): number {
  return out.last[id] ?? -1;
}
