/**
 * A network as a graph of the runtime's operators, checked before it runs and evaluated on the CPU.
 *
 * **Validation says what is wrong in words, and names what it is about**: an operator the runtime
 * lacks, a value read before anything writes it, a shape that does not fit the node that reads it,
 * an output nothing produces. A graph is checked when it is loaded — a model is refused then, with
 * the reason, rather than at its first frame with a picture of zeros.
 *
 * **The evaluator is the reference**, which the device runner is held to: it sizes every value and
 * its scratch once, when it is created, and a run writes into those buffers and allocates nothing.
 * What it gives up is memory: every intermediate value keeps its own buffer, which is the plainest
 * thing to compare against and the device runner's job to improve on.
 */
import { fromHalfBits } from '../half.ts';
import { OPERATORS, type Attributes } from './operators.ts';
import { planReuse } from '@driftengine/core';

export interface GraphValue {
  readonly name: string;
  readonly shape: readonly number[];
}

export interface GraphNode {
  readonly op: string;
  readonly inputs: readonly string[];
  readonly output: string;
  readonly attributes: Attributes;
}

export interface GraphTensor {
  readonly shape: readonly number[];
  readonly data: Float32Array;
}

export interface NetworkGraph {
  readonly inputs: readonly GraphValue[];
  readonly outputs: readonly string[];
  readonly nodes: readonly GraphNode[];
  readonly tensors: ReadonlyMap<string, GraphTensor>;
}

const size = (shape: readonly number[]): number => shape.reduce((total, d) => total * d, 1);

/** Every value's shape, or the first reason the graph cannot run. */
function inferShapes(graph: NetworkGraph): Map<string, readonly number[]> | string {
  const shapes = new Map<string, readonly number[]>();
  for (const input of graph.inputs) shapes.set(input.name, input.shape);
  for (const [name, tensor] of graph.tensors) {
    if (tensor.data.length !== size(tensor.shape)) {
      return `tensor "${name}" holds ${tensor.data.length} values and its shape [${tensor.shape.join(', ')}] needs ${size(tensor.shape)}`;
    }
    shapes.set(name, tensor.shape);
  }
  for (const node of graph.nodes) {
    const operator = OPERATORS.get(node.op);
    if (operator === undefined) {
      return `the runtime has no operator "${node.op}" (writing "${node.output}")`;
    }
    const [fewest, most] = operator.arity;
    if (node.inputs.length < fewest || node.inputs.length > most) {
      return `${node.op} writing "${node.output}" takes ${fewest} to ${most} inputs and was given ${node.inputs.length}`;
    }
    const inputShapes: (readonly number[])[] = [];
    for (const input of node.inputs) {
      const shape = shapes.get(input);
      if (shape === undefined)
        return `${node.op} writing "${node.output}" reads "${input}", which nothing writes`;
      inputShapes.push(shape);
    }
    if (shapes.has(node.output)) return `"${node.output}" is written twice`;
    const ranks = operator.ranks ?? [];
    for (let i = 0; i < inputShapes.length && i < ranks.length; i += 1) {
      const rank = (inputShapes[i] as readonly number[]).length;
      if (rank !== ranks[i]) {
        return `${node.op} writing "${node.output}": "${node.inputs[i]}" has rank ${rank} and this input takes rank ${ranks[i]}`;
      }
    }
    const shape = operator.shape(inputShapes, node.attributes);
    if (typeof shape === 'string') return `${node.op} writing "${node.output}": ${shape}`;
    shapes.set(node.output, shape);
  }
  for (const output of graph.outputs) {
    if (!shapes.has(output)) return `the output "${output}" is written by nothing`;
  }
  return shapes;
}

/**
 * A graph as a file stores it: its tensors in either precision, half as the bits a device uploads.
 * `@driftengine/drft`'s `DrftGraph` is one, structurally, which is how the two packages meet
 * without either importing the other.
 */
export interface StoredGraph {
  readonly inputs: readonly GraphValue[];
  readonly outputs: readonly string[];
  readonly nodes: readonly GraphNode[];
  readonly tensors: readonly {
    readonly name: string;
    readonly shape: readonly number[];
    readonly data: Float32Array | Uint16Array;
  }[];
}

/**
 * A stored graph as one the runtime runs, half-precision tensors decoded to single; validated, and
 * refused naming what is wrong — an operator the runtime lacks is a fact about the model, and this
 * is when a caller learns it.
 */
export function graphFromStored(stored: StoredGraph): NetworkGraph {
  const tensors = new Map<string, GraphTensor>();
  for (const tensor of stored.tensors) {
    const data =
      tensor.data instanceof Uint16Array
        ? Float32Array.from(tensor.data, (bits) => fromHalfBits(bits))
        : tensor.data;
    tensors.set(tensor.name, { shape: tensor.shape, data });
  }
  const graph: NetworkGraph = {
    inputs: stored.inputs,
    outputs: stored.outputs,
    nodes: stored.nodes,
    tensors,
  };
  const problem = validateGraph(graph);
  if (problem !== null) throw new Error(`network graph: ${problem}`);
  return graph;
}

/** Every value's shape — inputs, tensors and intermediates — refused, with the reason, if invalid. */
export function graphShapes(graph: NetworkGraph): ReadonlyMap<string, readonly number[]> {
  const shapes = inferShapes(graph);
  if (typeof shapes === 'string') throw new Error(`network graph: ${shapes}`);
  return shapes;
}

/**
 * A graph as `@driftengine/core`'s runner takes it: its tensors listed by name, and every value's
 * shape as inferred here — **nothing evaluated and nothing sized**, where asking an evaluator for its
 * shapes would allocate every intermediate value first. Structural, because core does not import
 * this package; the shapes are this module's, so there is one copy of every operator's rule.
 */
export function graphForDevice(graph: NetworkGraph): {
  readonly inputs: readonly GraphValue[];
  readonly outputs: readonly string[];
  readonly nodes: readonly GraphNode[];
  readonly tensors: readonly {
    readonly name: string;
    readonly shape: readonly number[];
    readonly data: Float32Array;
  }[];
  readonly shapes: ReadonlyMap<string, readonly number[]>;
} {
  return {
    inputs: graph.inputs,
    outputs: graph.outputs,
    nodes: graph.nodes,
    tensors: [...graph.tensors].map(([name, tensor]) => ({ name, ...tensor })),
    shapes: graphShapes(graph),
  };
}

/** Null when the graph can run; otherwise the reason, naming what it is about. */
export function validateGraph(graph: NetworkGraph): string | null {
  const shapes = inferShapes(graph);
  return typeof shapes === 'string' ? shapes : null;
}

export interface GraphEvaluator {
  /** Every value's shape, inputs, tensors and intermediates alike. */
  readonly shapes: ReadonlyMap<string, readonly number[]>;
  /**
   * Evaluate with these inputs. The returned arrays are the evaluator's own and are overwritten by
   * the next run.
   */
  run(inputs: ReadonlyMap<string, Float32Array>): Map<string, Float32Array>;
}

/**
 * Validate, size every value once, and return something that evaluates without allocating.
 *
 * **Values that cannot be alive at once share a buffer**, by `planReuse` — the rule the device's
 * runner plans by too. Weights and inputs stay in the caller's own arrays and are planned by
 * neither. What it buys is the difference between holding every value of a graph and holding the
 * few alive at any moment: OWLv2's image graph at 960² is 3,647 MB of values and 196 MB in ten buffers,
 * which is the difference between a reference that runs on an ordinary machine and one that is
 * killed for its memory.
 */
export function createGraphEvaluator(graph: NetworkGraph): GraphEvaluator {
  const shapes = inferShapes(graph);
  if (typeof shapes === 'string') throw new Error(`network graph: ${shapes}`);
  const buffers = new Map<string, Float32Array>();
  for (const [name, tensor] of graph.tensors) buffers.set(name, tensor.data);
  const plan = planReuse({ nodes: graph.nodes, held: [], outputs: graph.outputs }, (name) =>
    size(shapes.get(name) as readonly number[]),
  );
  const slots = plan.sizes.map((values) => new Float32Array(values));
  /* A buffer is as large as the largest value it holds, so each value takes a view of its own. */
  for (const [name, slot] of plan.slotOf) {
    const room = size(shapes.get(name) as readonly number[]);
    const held = slots[slot] as Float32Array;
    buffers.set(name, held.length === room ? held : held.subarray(0, room));
  }
  let scratchSize = 0;
  for (const node of graph.nodes) {
    const operator = OPERATORS.get(node.op);
    const inputShapes = node.inputs.map((input) => shapes.get(input) as readonly number[]);
    scratchSize = Math.max(scratchSize, operator?.scratch?.(inputShapes, node.attributes) ?? 0);
  }
  const scratch = new Float32Array(scratchSize);
  const outputs = new Map<string, Float32Array>();

  return {
    shapes,
    run(inputs) {
      for (const input of graph.inputs) {
        const data = inputs.get(input.name);
        if (data === undefined)
          throw new Error(`network graph: no value for the input "${input.name}"`);
        if (data.length !== size(input.shape)) {
          throw new Error(
            `network graph: "${input.name}" holds ${data.length} values and needs ${size(input.shape)}`,
          );
        }
        buffers.set(input.name, data);
      }
      for (const node of graph.nodes) {
        const operator = OPERATORS.get(node.op);
        if (operator === undefined) continue;
        const values = node.inputs.map((input) => buffers.get(input) as Float32Array);
        const inputShapes = node.inputs.map((input) => shapes.get(input) as readonly number[]);
        operator.evaluate(
          values,
          inputShapes,
          node.attributes,
          buffers.get(node.output) as Float32Array,
          scratch,
        );
      }
      outputs.clear();
      for (const output of graph.outputs) outputs.set(output, buffers.get(output) as Float32Array);
      return outputs;
    },
  };
}
