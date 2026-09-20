/**
 * A network's definition, written as a function of its weights, built into a graph the runtime runs.
 *
 * **One definition, run over two sources.** At conversion it reads a checkpoint; afterwards it reads
 * the converted file, whenever the runtime needs the graph at a new size — a vision transformer's
 * patch grid follows the image's aspect ratio, and every device kernel bakes its shapes, so a model
 * is one graph per size and not one graph. The two runs agree because of three rules:
 *
 * - **A weight is read by name, at the shape the definition expects**, and a name the source lacks
 *   or a shape it disagrees with is refused naming both.
 * - **A weight derived from others** — a batch norm folded into its convolution — is computed once,
 *   at conversion, and kept under its own name; a source that already holds that name answers with
 *   it and the computation never runs, which is why a converted file needs none of the parts.
 * - **A constant** — a table computed from the shapes, such as rotary angles — carries a name
 *   beginning `@`, is rebuilt on every run, and is never taken for a weight.
 *
 * **And every weight the source holds is read, derived from, or set aside by name.** A forgotten
 * bias or layer scale is a network that runs and answers wrongly — the one failure nothing later can
 * see — so a weight left over is refused. What that costs is an explicit `ignore` for every head a
 * definition does not run, which is the point.
 */
import { validateGraph, type GraphTensor, type GraphValue, type NetworkGraph } from './graph.ts';
import type { Attributes } from './operators.ts';

/** Where a definition's weights come from: a checkpoint being converted, or a converted file. */
export interface WeightSource {
  get(name: string): GraphTensor | undefined;
  names(): Iterable<string>;
}

/** What a constant's name begins with: a table of the shapes, never a weight. */
export const CONSTANT_PREFIX = '@';

export interface Weights {
  /** The weight `name` as a value of the graph; refused if absent or held at another shape. */
  read(name: string, shape?: readonly number[]): string;
  /**
   * A weight computed once from others, kept under `name`. `compute` reads its parts through
   * `values`, which counts each as read; a source already holding `name` answers with it instead.
   */
  derive(
    name: string,
    shape: readonly number[],
    compute: (values: (part: string, shape?: readonly number[]) => Float32Array) => Float32Array,
  ): string;
  /** A table computed from the graph's shapes, rebuilt on every run and never a weight. */
  constant(name: string, shape: readonly number[], data: Float32Array): string;
  /** Weights the definition deliberately does not read: a name, or a prefix ending in a dot. */
  ignore(nameOrPrefix: string): void;
}

export interface GraphBuilder {
  /** A node; its output is named `output` when given, and otherwise by the builder. */
  node(op: string, inputs: readonly string[], attributes?: Attributes, output?: string): string;
}

/** A definition: it reads its weights, adds its nodes, and says what goes in and comes out. */
export type Architecture = (
  weights: Weights,
  graph: GraphBuilder,
) => { readonly inputs: readonly GraphValue[]; readonly outputs: readonly string[] };

const shapeText = (shape: readonly number[]): string => `[${shape.join(', ')}]`;

export function graphFromWeights(source: WeightSource, architecture: Architecture): NetworkGraph {
  const tensors = new Map<string, GraphTensor>();
  const read = new Set<string>();
  const ignored: string[] = [];
  const nodes: NetworkGraph['nodes'][number][] = [];
  const take = (name: string, shape?: readonly number[]): GraphTensor => {
    const tensor = source.get(name);
    if (tensor === undefined) {
      throw new Error(`the source has no weight "${name}", which the definition reads`);
    }
    if (shape !== undefined && shapeText(shape) !== shapeText(tensor.shape)) {
      throw new Error(
        `"${name}" is ${shapeText(tensor.shape)} in the source and the definition reads it as ` +
          shapeText(shape),
      );
    }
    read.add(name);
    return tensor;
  };
  const weights: Weights = {
    read(name, shape) {
      if (!tensors.has(name)) tensors.set(name, take(name, shape));
      else take(name, shape);
      return name;
    },
    derive(name, shape, compute) {
      if (tensors.has(name)) return name;
      const held = source.get(name);
      const data =
        held === undefined
          ? compute((part, partShape) => take(part, partShape).data)
          : take(name, shape).data;
      if (data.length !== shape.reduce((total, d) => total * d, 1)) {
        throw new Error(
          `the derived weight "${name}" has ${data.length} values for ${shapeText(shape)}`,
        );
      }
      tensors.set(name, { shape, data });
      return name;
    },
    constant(name, shape, data) {
      const key = `${CONSTANT_PREFIX}${name}`;
      tensors.set(key, { shape, data });
      return key;
    },
    ignore(nameOrPrefix) {
      ignored.push(nameOrPrefix);
    },
  };
  let count = 0;
  const graph: GraphBuilder = {
    node(op, inputs, attributes = {}, output = `v${(count += 1)}`) {
      nodes.push({ op, inputs, output, attributes });
      return output;
    },
  };
  const { inputs, outputs } = architecture(weights, graph);

  const aside = (name: string): boolean =>
    name.startsWith(CONSTANT_PREFIX) ||
    ignored.some((rule) => (rule.endsWith('.') ? name.startsWith(rule) : name === rule));
  const unread = [...source.names()].filter((name) => !read.has(name) && !aside(name));
  if (unread.length > 0) {
    const named = unread.slice(0, 5).map((name) => `"${name}"`);
    throw new Error(
      `the definition never reads ${named.join(', ')}` +
        (unread.length > 5 ? ` and ${unread.length - 5} more` : '') +
        ': a weight left behind is a network that runs and answers wrongly, so read it or set it ' +
        'aside by name',
    );
  }
  const network: NetworkGraph = { inputs, outputs, nodes, tensors };
  const problem = validateGraph(network);
  if (problem !== null) throw new Error(`the definition's graph cannot run: ${problem}`);
  return network;
}
