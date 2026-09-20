/**
 * A texture's decoder, as data.
 *
 * **This is the file where the expensive mistake would be made, so the reasoning is here.** The
 * decode program is uploaded as a uniform buffer and walked by one shader. There is no code
 * generation, no `#define`, no shader per material and no variant — because `ARCHITECTURE.md` has
 * already measured what the other way costs, with the number: a fifth permutation flag took the
 * generated WGSL corpus from 914 KB to 1,906 KB and cost **196,910 gzipped bytes on every
 * consumer**, including those who never enabled it, because deflate's window is 32 KB and
 * near-identical permutations do not deduplicate. A decode graph as permutations would be that
 * mistake with a far larger exponent — per material rather than per feature.
 *
 * As data it costs bytes, linearly, and a new operation is one more case in one switch.
 *
 * **A node is four words: op, a, b, out.** Which of `a` and `b` name registers rather than
 * immediates is a property of the operation, held in `OP_ARGS` so that the validator and both
 * interpreters read one table rather than three copies of a convention.
 */

export const DECODE_OP = {
  /** a = latent slot. Samples it at (u, v). */
  SAMPLE_LATENT: 0,
  /** a = register holding the input vector, b = network slot. */
  EVAL_NETWORK: 1,
  /** a = block-compressed slot. The passthrough for content a network does not help. */
  SAMPLE_BLOCK: 2,
  /** a = seed, b = octaves. */
  PROCEDURAL_FBM: 3,
  /** a = frame count, b = frames per second. Writes the frame index into x. */
  FLIPBOOK_INDEX: 4,
  /** a, b = registers. Mixes them by the fractional part of the sample time. */
  LATENT_LERP: 5,
  /** a = register, b = packed channel spec. Applies the declared convention. */
  REMAP_CHANNEL: 6,
  /** a, b = registers. `a` over `b`. */
  COMPOSITE: 7,
  /**
   * a = constant slot. Writes that four-component value.
   *
   * **Added for Wave 4C, and the reason is the rule rather than the node.** A material graph
   * compiles to this vocabulary and not to a shader, so a node the vocabulary cannot express grows
   * the vocabulary — which costs bytes linearly, because an operation is data. A colour picker is
   * the first node anybody puts in a material graph and there was nothing here that could hold one.
   */
  CONSTANT: 8,
} as const;

export type DecodeOp = (typeof DECODE_OP)[keyof typeof DECODE_OP];

/** Whether each operation's `a` and `b` name registers. One table, three readers. */
const OP_ARGS: Readonly<Record<number, { a: boolean; b: boolean }>> = {
  [DECODE_OP.SAMPLE_LATENT]: { a: false, b: false },
  [DECODE_OP.EVAL_NETWORK]: { a: true, b: false },
  [DECODE_OP.SAMPLE_BLOCK]: { a: false, b: false },
  [DECODE_OP.PROCEDURAL_FBM]: { a: false, b: false },
  [DECODE_OP.FLIPBOOK_INDEX]: { a: false, b: false },
  [DECODE_OP.LATENT_LERP]: { a: true, b: true },
  [DECODE_OP.REMAP_CHANNEL]: { a: true, b: false },
  [DECODE_OP.COMPOSITE]: { a: true, b: true },
  [DECODE_OP.CONSTANT]: { a: false, b: false },
};

/**
 * Where a coordinate lands, and what happens outside the unit square.
 *
 * **Two conventions, because two kinds of data need them.** A *lattice* puts `u = 0` on the centre
 * of the first texel and `u = 1` on the centre of the last, which is what a height field sampled at
 * its own vertices wants — `terrainTexture.ts` reads `x / (width - 1)` and lands on texel `x`
 * exactly. A *centre* mode puts `u = 0` on the first texel's edge, which is what every GPU sampler
 * does and what a surface texture tiled across a mesh wants. Added 2026-09-17 so the device
 * interpreter has a reference to agree with; modes 0 and 1 did not move.
 *
 * Lattice wrap has a seam a tiling texture shows: `u = 0.999` reads the last texel and `u = 1`
 * the first. Centre wrap blends across it, as a repeating sampler does.
 */
export const ADDRESS_MODE = {
  LATTICE_CLAMP: 0,
  LATTICE_WRAP: 1,
  CENTRE_CLAMP: 2,
  CENTRE_WRAP: 3,
} as const;

/** How many address modes there are. A graph asking for this many or more is refused. */
export const ADDRESS_MODE_COUNT = 4;

/**
 * Registers the interpreter has, each a four-component vector.
 *
 * A budget rather than a limit discovered on one device: a graph that needs more is refused at
 * encode time, where a person can see it, rather than compiling to a shader that fails on the
 * hardware with the smallest uniform space.
 */
export const MAX_REGISTERS = 16;

/** Words per node: op, a, b, out. */
export const NODE_STRIDE = 4;

export interface DecodeGraph {
  /** Four words per node. */
  nodes: Uint32Array;
  count: number;
  /** Which register holds the finished channel vector. */
  result: number;
  /** One of `ADDRESS_MODE`. */
  addressMode: number;
}

export function createDecodeGraph(capacity: number): DecodeGraph {
  return { nodes: new Uint32Array(capacity * NODE_STRIDE), count: 0, result: 0, addressMode: 0 };
}

export function addDecodeNode(
  graph: DecodeGraph,
  op: number,
  a: number,
  b: number,
  out: number,
): number {
  const at = graph.count * NODE_STRIDE;
  graph.nodes[at] = op;
  graph.nodes[at + 1] = a;
  graph.nodes[at + 2] = b;
  graph.nodes[at + 3] = out;
  graph.count += 1;
  return graph.count - 1;
}

export function nodeOp(graph: DecodeGraph, index: number): number {
  return graph.nodes[index * NODE_STRIDE] as number;
}
export function nodeA(graph: DecodeGraph, index: number): number {
  return graph.nodes[index * NODE_STRIDE + 1] as number;
}
export function nodeB(graph: DecodeGraph, index: number): number {
  return graph.nodes[index * NODE_STRIDE + 2] as number;
}
export function nodeOut(graph: DecodeGraph, index: number): number {
  return graph.nodes[index * NODE_STRIDE + 3] as number;
}

/** The highest register the graph writes, plus one. */
export function graphRegisterCount(graph: DecodeGraph): number {
  let highest = graph.result;
  for (let i = 0; i < graph.count; i += 1) highest = Math.max(highest, nodeOut(graph, i));
  return highest + 1;
}

/**
 * Whether this graph is one an interpreter can run.
 *
 * Returns a message rather than throwing, matching `validateGraph` in the frame package and for
 * the same reason: whether a malformed graph is an assertion or a skipped material is the
 * caller's decision.
 */
export function validateDecodeGraph(graph: DecodeGraph): string | null {
  if (
    !Number.isInteger(graph.addressMode) ||
    graph.addressMode < 0 ||
    graph.addressMode >= ADDRESS_MODE_COUNT
  ) {
    return `address mode ${graph.addressMode} is not one of the ${ADDRESS_MODE_COUNT} the interpreter knows`;
  }
  const written = new Set<number>();
  for (let i = 0; i < graph.count; i += 1) {
    const op = nodeOp(graph, i);
    const args = OP_ARGS[op];
    if (args === undefined) return `node ${i} has unknown opcode ${op}`;

    const out = nodeOut(graph, i);
    if (out >= MAX_REGISTERS) {
      return `node ${i} writes register ${out}, past the ${MAX_REGISTERS} the interpreter has`;
    }
    if (args.a && !written.has(nodeA(graph, i))) {
      return `node ${i} reads register ${nodeA(graph, i)}, which nothing wrote`;
    }
    if (args.b && !written.has(nodeB(graph, i))) {
      return `node ${i} reads register ${nodeB(graph, i)}, which nothing wrote`;
    }
    written.add(out);
  }
  if (!written.has(graph.result)) {
    return `the result register ${graph.result} is never written`;
  }
  if (graphRegisterCount(graph) > MAX_REGISTERS) {
    return `the graph needs ${graphRegisterCount(graph)} registers, past the ${MAX_REGISTERS} available`;
  }
  return null;
}

/** `count`, `result`, `addressMode`, then the nodes. */
export function encodeDecodeGraph(graph: DecodeGraph): Uint8Array {
  const bytes = new Uint8Array(12 + graph.count * NODE_STRIDE * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, graph.count, true);
  view.setUint32(4, graph.result, true);
  view.setUint32(8, graph.addressMode, true);
  new Uint32Array(bytes.buffer, 12, graph.count * NODE_STRIDE).set(
    graph.nodes.subarray(0, graph.count * NODE_STRIDE),
  );
  return bytes;
}

export function decodeDecodeGraph(bytes: Uint8Array): DecodeGraph {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const graph = createDecodeGraph(Math.max(1, count));
  graph.count = count;
  graph.result = view.getUint32(4, true);
  graph.addressMode = view.getUint32(8, true);
  for (let i = 0; i < count * NODE_STRIDE; i += 1) {
    graph.nodes[i] = view.getUint32(12 + i * 4, true);
  }
  return graph;
}
