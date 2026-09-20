/**
 * What each node reads and writes, when there are too many resources for a mask.
 *
 * One flat identifier store with a span per node, which is the same shape `nav/navGraph.ts` uses
 * for adjacency and for the same reason: the spans are written once in order and read many
 * times, so an offset and a length beat an array per node by every measure that matters here.
 *
 * `readsOf` and `writesOf` return **views into the store**, not copies. A caller that keeps one
 * past the next `resetDeps` is reading somebody else's edges, which is why neither is exposed
 * outside `render/`.
 */
export interface Deps {
  /** Every read identifier then every write identifier, node by node. */
  edges: Int32Array;
  /** Four entries per node: read offset, read length, write offset, write length. */
  spans: Int32Array;
  /** How many identifiers of `edges` are in use. */
  used: number;
  /** How many nodes have been recorded. */
  count: number;
}

const SPAN_STRIDE = 4;

export function createDeps(nodeCapacity: number, edgeCapacity: number): Deps {
  return {
    edges: new Int32Array(edgeCapacity),
    spans: new Int32Array(nodeCapacity * SPAN_STRIDE),
    used: 0,
    count: 0,
  };
}

export function resetDeps(deps: Deps): void {
  deps.used = 0;
  deps.count = 0;
}

export function depsNodeCount(deps: Deps): number {
  return deps.count;
}

function growEdges(deps: Deps, need: number): void {
  let size = deps.edges.length === 0 ? 16 : deps.edges.length;
  while (size < need) size *= 2;
  const edges = new Int32Array(size);
  edges.set(deps.edges);
  deps.edges = edges;
}

function growSpans(deps: Deps): void {
  const size = deps.spans.length === 0 ? SPAN_STRIDE * 8 : deps.spans.length * 2;
  const spans = new Int32Array(size);
  spans.set(deps.spans);
  deps.spans = spans;
}

/*
 * Both stores are grown before either span is written. Growing between the read span and the
 * write span would copy a half-written node and silently drop its writes, which is the defect
 * the growth test in this module's suite exists to catch.
 */
export function recordDeps(
  deps: Deps,
  reads: readonly number[],
  writes: readonly number[],
): number {
  const need = deps.used + reads.length + writes.length;
  if (need > deps.edges.length) growEdges(deps, need);
  if ((deps.count + 1) * SPAN_STRIDE > deps.spans.length) growSpans(deps);

  const readAt = deps.used;
  for (let i = 0; i < reads.length; i += 1) deps.edges[deps.used + i] = reads[i] ?? 0;
  deps.used += reads.length;

  const writeAt = deps.used;
  for (let i = 0; i < writes.length; i += 1) deps.edges[deps.used + i] = writes[i] ?? 0;
  deps.used += writes.length;

  const node = deps.count;
  const base = node * SPAN_STRIDE;
  deps.spans[base] = readAt;
  deps.spans[base + 1] = reads.length;
  deps.spans[base + 2] = writeAt;
  deps.spans[base + 3] = writes.length;
  deps.count = node + 1;
  return node;
}

/*
 * Count the bits of a mask, which is how many identifiers it becomes.
 *
 * Kernighan's loop rather than a table: a mask here has at most `RESOURCE_COUNT` bits and usually
 * two, so this runs once or twice.
 */
function bitCount(mask: number): number {
  let count = 0;
  for (let rest = mask >>> 0; rest !== 0; rest &= rest - 1) count += 1;
  return count;
}

function writeBits(deps: Deps, mask: number, at: number): void {
  let offset = at;
  for (let bit = 0, rest = mask >>> 0; rest !== 0; bit += 1, rest >>>= 1) {
    if ((rest & 1) === 0) continue;
    deps.edges[offset] = bit;
    offset += 1;
  }
}

/**
 * Record a node whose reads and writes are masks, one identifier per set bit, lowest first.
 *
 * **What lets a fixed-composition flush be scheduled by identifiers without building a list.** The
 * forward renderer records masks, and `recordDeps` takes arrays; a flush converting one to the
 * other through arrays would allocate per node, on the path `AGENTS.md` forbids it on. Bit `n`
 * is identifier `n`, so `FRAME_RESOURCES` is the first `RESOURCE_COUNT` identifiers of any frame
 * that mixes the two.
 */
export function recordMaskDeps(deps: Deps, reads: number, writes: number): number {
  const readCount = bitCount(reads);
  const writeCount = bitCount(writes);
  const need = deps.used + readCount + writeCount;
  if (need > deps.edges.length) growEdges(deps, need);
  if ((deps.count + 1) * SPAN_STRIDE > deps.spans.length) growSpans(deps);

  const readAt = deps.used;
  writeBits(deps, reads, readAt);
  const writeAt = readAt + readCount;
  writeBits(deps, writes, writeAt);
  deps.used = writeAt + writeCount;

  const node = deps.count;
  const base = node * SPAN_STRIDE;
  deps.spans[base] = readAt;
  deps.spans[base + 1] = readCount;
  deps.spans[base + 2] = writeAt;
  deps.spans[base + 3] = writeCount;
  deps.count = node + 1;
  return node;
}

export function readsOf(deps: Deps, node: number): Int32Array {
  const base = node * SPAN_STRIDE;
  const at = deps.spans[base] ?? 0;
  const length = deps.spans[base + 1] ?? 0;
  return deps.edges.subarray(at, at + length);
}

export function writesOf(deps: Deps, node: number): Int32Array {
  const base = node * SPAN_STRIDE;
  const at = deps.spans[base + 2] ?? 0;
  const length = deps.spans[base + 3] ?? 0;
  return deps.edges.subarray(at, at + length);
}
