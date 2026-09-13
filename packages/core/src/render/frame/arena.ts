/**
 * Where a frame's draws are recorded, without allocating.
 *
 * A recorder is exactly the shape that wants an object per draw, and `AGENTS.md` forbids
 * allocating while a frame is running. So a node is six integers in one `Int32Array` and a
 * draw writes into it and returns: nothing constructed, nothing captured by a closure.
 * `InstanceData` and the particle pools already work this way, so the pattern is established
 * here rather than imported.
 *
 * Growth happens, and it happens where allocation is legal. A frame that records past
 * capacity must not silently drop a draw — that is the failure this is designed against — so
 * it grows, records `highWater`, and the next frame starts large enough for what the last one
 * needed.
 */
export const NODE_STRIDE = 6;

const VERB = 0;
const READS = 1;
const WRITES = 2;
const STATE = 3;
const MATRIX = 4;
/*
 * Slot 5 is reserved for the handle slice the executor will need. It is written as zero
 * until then so the stride does not change when it is used, and every offset above stays
 * where it is.
 */

export interface Arena {
  nodes: Int32Array;
  count: number;
  /** The most nodes any frame has recorded, so growth converges instead of repeating. */
  highWater: number;
}

export function createArena(capacity: number): Arena {
  return { nodes: new Int32Array(capacity * NODE_STRIDE), count: 0, highWater: 0 };
}

/** Empty the arena for a new frame. Keeps the storage; that is the whole point. */
export function resetArena(arena: Arena): void {
  arena.count = 0;
}

export function nodeCount(arena: Arena): number {
  return arena.count;
}

/** Record one node and return its index. */
export function recordNode(
  arena: Arena,
  verb: number,
  reads: number,
  writes: number,
  state: number,
  matrix: number,
): number {
  const at = arena.count;
  const need = (at + 1) * NODE_STRIDE;
  if (need > arena.nodes.length) {
    const grown = new Int32Array(Math.max(need, arena.nodes.length * 2));
    grown.set(arena.nodes);
    arena.nodes = grown;
  }
  const base = at * NODE_STRIDE;
  arena.nodes[base + VERB] = verb;
  arena.nodes[base + READS] = reads;
  arena.nodes[base + WRITES] = writes;
  arena.nodes[base + STATE] = state;
  arena.nodes[base + MATRIX] = matrix;
  arena.count = at + 1;
  if (arena.count > arena.highWater) arena.highWater = arena.count;
  return at;
}

export function nodeVerb(arena: Arena, at: number): number {
  return arena.nodes[at * NODE_STRIDE + VERB] ?? 0;
}

export function nodeReads(arena: Arena, at: number): number {
  return arena.nodes[at * NODE_STRIDE + READS] ?? 0;
}

export function nodeWrites(arena: Arena, at: number): number {
  return arena.nodes[at * NODE_STRIDE + WRITES] ?? 0;
}

export function nodeState(arena: Arena, at: number): number {
  return arena.nodes[at * NODE_STRIDE + STATE] ?? 0;
}

export function nodeMatrix(arena: Arena, at: number): number {
  return arena.nodes[at * NODE_STRIDE + MATRIX] ?? 0;
}
