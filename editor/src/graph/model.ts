/**
 * Nodes, links, and what makes a graph valid.
 *
 * **One model for three vocabularies.** Materials, particles and behaviour are three sets of node
 * kinds over one structure, because what differs between them is what a node *means* and not what a
 * graph *is*. A second graph model would be a second place for cycle detection, port compatibility
 * and undo to be got wrong.
 *
 * **A half-built graph is the normal state of a graph being built**, so validity has two levels.
 * An unconnected required input is an error at compile time and silence while editing — an editor
 * that refused every incomplete graph would refuse every graph somebody was in the middle of
 * making. What is wrong at both levels is structural: an unknown node kind, a cycle, a link
 * between ports that cannot carry each other's values.
 *
 * **A cycle is refused by name.** "Invalid graph" in a fifty-node material is a message somebody
 * reads and then has to go looking, which is the whole of the work the message was meant to save.
 */

/** What a port carries. Two ports may be joined only if their types are the same. */
export type PortType = 'number' | 'vector' | 'colour' | 'texture' | 'flow';

export interface PortSpec {
  readonly name: string;
  readonly type: PortType;
  /** An input that must be connected before the graph will compile. */
  readonly required?: boolean;
}

export interface NodeSpec {
  readonly kind: string;
  readonly inputs: readonly PortSpec[];
  readonly outputs: readonly PortSpec[];
}

/** What kinds of node a graph may contain. Materials, particles and behaviour each have one. */
export type Vocabulary = ReadonlyMap<string, NodeSpec>;

export function createVocabulary(specs: readonly NodeSpec[]): Vocabulary {
  return new Map(specs.map((spec) => [spec.kind, spec]));
}

export interface GraphNode {
  readonly id: number;
  kind: string;
  x: number;
  y: number;
  /** Values a node carries itself, for what is set rather than connected. */
  params: Record<string, number>;
}

export interface GraphLink {
  readonly from: number;
  readonly fromPort: number;
  readonly to: number;
  readonly toPort: number;
}

export interface Graph {
  readonly nodes: GraphNode[];
  readonly links: GraphLink[];
  /** The next identifier to hand out. Never reused, so a link can never resurrect onto a new node. */
  nextId: number;
}

export function createGraph(): Graph {
  return { nodes: [], links: [], nextId: 1 };
}

export function nodeOf(graph: Graph, id: number): GraphNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

export function linksOf(graph: Graph): readonly GraphLink[] {
  return graph.links;
}

/** The link feeding an input, or undefined. An input takes one value. */
export function inputLink(graph: Graph, node: number, port: number): GraphLink | undefined {
  return graph.links.find((link) => link.to === node && link.toPort === port);
}

/**
 * Add a node and return its identifier.
 *
 * The kind is not checked here. A palette that offered a kind the vocabulary lacks is a bug in the
 * palette, and `validateGraph` is where it is reported — in one place, with the node named, rather
 * than as a silent refusal at the point of a click.
 */
export function addNode(graph: Graph, kind: string, x: number, y: number): number {
  const id = graph.nextId;
  graph.nextId += 1;
  graph.nodes.push({ id, kind, x, y, params: {} });
  return id;
}

/** Remove a node **and every link touching it**. Returns whether it was there. */
export function removeNode(graph: Graph, id: number): boolean {
  const at = graph.nodes.findIndex((node) => node.id === id);
  if (at < 0) return false;
  graph.nodes.splice(at, 1);
  for (let i = graph.links.length - 1; i >= 0; i -= 1) {
    const link = graph.links[i] as GraphLink;
    if (link.from === id || link.to === id) graph.links.splice(i, 1);
  }
  return true;
}

export function portsCompatible(a: PortType, b: PortType): boolean {
  return a === b;
}

function portOf(
  vocabulary: Vocabulary,
  graph: Graph,
  id: number,
  port: number,
  side: 'inputs' | 'outputs',
): PortSpec | undefined {
  const node = nodeOf(graph, id);
  if (node === undefined) return undefined;
  return vocabulary.get(node.kind)?.[side][port];
}

/**
 * Join an output to an input. `false` where the two cannot be joined.
 *
 * **A link into an input that already has one replaces it**, because an input takes one value. The
 * alternative is two values arriving at a port that can use one, which every compiler downstream
 * would then have to decide about.
 */
export function addLink(graph: Graph, vocabulary: Vocabulary, link: GraphLink): boolean {
  const output = portOf(vocabulary, graph, link.from, link.fromPort, 'outputs');
  const input = portOf(vocabulary, graph, link.to, link.toPort, 'inputs');
  if (output === undefined || input === undefined) return false;
  if (!portsCompatible(output.type, input.type)) return false;

  const existing = graph.links.findIndex(
    (other) => other.to === link.to && other.toPort === link.toPort,
  );
  if (existing >= 0) graph.links.splice(existing, 1);
  graph.links.push({ ...link });
  return true;
}

export function removeLink(graph: Graph, link: GraphLink): boolean {
  const at = graph.links.findIndex(
    (other) =>
      other.from === link.from &&
      other.fromPort === link.fromPort &&
      other.to === link.to &&
      other.toPort === link.toPort,
  );
  if (at < 0) return false;
  graph.links.splice(at, 1);
  return true;
}

/**
 * Fill `out` with node identifiers so that every node follows what it depends on.
 *
 * **Returns fewer than the node count where there is a cycle**, rather than an order that is not
 * one. A partial order presented as complete is what makes a compiler emit half a program.
 *
 * Kahn's algorithm, taking ready nodes in identifier order so the result is the same every run —
 * which matters because a compiled material is content, and content that shuffles between builds
 * is content that cannot be diffed.
 */
export function topologicalOrder(graph: Graph, out: number[]): number {
  out.length = 0;
  const remaining = new Map<number, number>();
  for (const node of graph.nodes) remaining.set(node.id, 0);
  for (const link of graph.links) {
    if (!remaining.has(link.to) || !remaining.has(link.from)) continue;
    remaining.set(link.to, (remaining.get(link.to) as number) + 1);
  }

  const ready = [...remaining.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort((a, b) => a - b);

  while (ready.length > 0) {
    const id = ready.shift() as number;
    out.push(id);
    const freed: number[] = [];
    for (const link of graph.links) {
      if (link.from !== id || !remaining.has(link.to)) continue;
      const left = (remaining.get(link.to) as number) - 1;
      remaining.set(link.to, left);
      if (left === 0) freed.push(link.to);
    }
    for (const id of freed) ready.push(id);
    /* One sort and not two: sorting `freed` first as well was redundant, and a perturbation that
       reversed it changed nothing — which is how it was found. */
    ready.sort((a, b) => a - b);
  }
  return out.length;
}

export interface ValidateOptions {
  /** Whether unconnected required inputs are an error. False while editing. */
  readonly forCompile: boolean;
}

/** What is wrong with the graph, or null. The first problem found, not a list. */
export function validateGraph(
  graph: Graph,
  vocabulary: Vocabulary,
  options: ValidateOptions,
): string | null {
  for (const node of graph.nodes) {
    if (!vocabulary.has(node.kind)) {
      return `node ${node.id} has kind "${node.kind}", which is not in the vocabulary`;
    }
  }

  for (const link of graph.links) {
    const output = portOf(vocabulary, graph, link.from, link.fromPort, 'outputs');
    const input = portOf(vocabulary, graph, link.to, link.toPort, 'inputs');
    if (output === undefined || input === undefined) {
      return `a link joins ports that are not there: ${link.from}.${link.fromPort} to ${link.to}.${link.toPort}`;
    }
    if (!portsCompatible(output.type, input.type)) {
      return `node ${link.from} gives ${output.type} where node ${link.to} wants ${input.type}`;
    }
  }

  const order: number[] = [];
  if (topologicalOrder(graph, order) !== graph.nodes.length) {
    const placed = new Set(order);
    const onCycle = graph.nodes.find((node) => !placed.has(node.id));
    return `the graph has a cycle through node ${onCycle?.id ?? '?'} (${onCycle?.kind ?? '?'})`;
  }

  if (!options.forCompile) return null;

  for (const node of graph.nodes) {
    const spec = vocabulary.get(node.kind) as NodeSpec;
    for (let port = 0; port < spec.inputs.length; port += 1) {
      const input = spec.inputs[port] as PortSpec;
      if (input.required !== true) continue;
      if (inputLink(graph, node.id, port) === undefined) {
        return `node ${node.id} (${node.kind}) needs input "${input.name}" and nothing feeds it`;
      }
    }
  }
  return null;
}
