/**
 * Which values of a graph may share one buffer, as one rule both sides plan by: the device's
 * runner beside this file, and `@driftengine/texture`'s reference evaluator.
 *
 * **It lives here rather than beside that evaluator because of the direction of the arrow.**
 * `texture` peers on core and core does not peer on `texture` — `deviceGraph.ts` says so and is
 * built around it — so a rule both need has to sit on this side or be written twice. It was on the
 * other side for a day, where it made core's runtime import a devDependency and
 * `scripts/boundaries.test.mjs` refused it.
 *
 * **A value's buffer is given back after the last node that reads it, and not before** — so a
 * node's output never shares a buffer with any of its own inputs, since the inputs are read while
 * the output is written. What is `held` keeps a buffer of its own for the life of the plan, and so
 * does every output; a value that is neither written by a node nor held is not planned at all,
 * which is how the evaluator leaves weights and inputs in the caller's own arrays.
 *
 * **Two implementations of this would drift**, and the failure is a network that runs, validates
 * and answers wrongly — a value overwritten before its last reader reads it.
 *
 * What it gives up: a free buffer is taken first-come rather than by the size that fits best, so a
 * small value may hold a large buffer while a larger one waits. The transformers this runs repeat a
 * block of identically shaped values, where first-come and best-fit choose the same buffers.
 */

export interface BufferReuse {
  /** The buffer each planned value lives in. */
  readonly slotOf: ReadonlyMap<string, number>;
  /** Each buffer's size, in values: the largest value it ever holds. */
  readonly sizes: readonly number[];
}

export function planReuse(
  graph: {
    readonly nodes: readonly { readonly inputs: readonly string[]; readonly output: string }[];
    /** Values given a buffer each before any node runs, in this order. */
    readonly held: readonly string[];
    /** Values never given back, claimed where they are written. */
    readonly outputs: readonly string[];
  },
  sizeOf: (name: string) => number,
): BufferReuse {
  const slotOf = new Map<string, number>();
  const sizes: number[] = [];
  const pinned = new Set<string>([...graph.held, ...graph.outputs]);
  const claim = (name: string): number => {
    sizes.push(sizeOf(name));
    slotOf.set(name, sizes.length - 1);
    return sizes.length - 1;
  };
  for (const name of graph.held) claim(name);

  /* The last node reading each value; a value never read is last read where it is written. */
  const lastRead = new Map<string, number>();
  graph.nodes.forEach((node, at) => {
    lastRead.set(node.output, at);
    for (const input of node.inputs) lastRead.set(input, at);
  });

  const free: number[] = [];
  graph.nodes.forEach((node, at) => {
    if (pinned.has(node.output)) {
      claim(node.output);
    } else {
      const reuse = free.shift();
      if (reuse === undefined) claim(node.output);
      else {
        slotOf.set(node.output, reuse);
        sizes[reuse] = Math.max(sizes[reuse] as number, sizeOf(node.output));
      }
    }
    /* Only after the node has run: its inputs are read while its output is written. */
    for (const value of new Set([...node.inputs, node.output])) {
      const slot = slotOf.get(value);
      if (slot === undefined || pinned.has(value) || lastRead.get(value) !== at) continue;
      free.push(slot);
    }
  });
  return { slotOf, sizes };
}
